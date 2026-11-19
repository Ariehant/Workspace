import type { Command } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import {
  driveFileOf,
  driveKind,
  driveOpenUrl,
  type DriveFileRef,
  type DriveFileStatus,
} from '@workspace/core';
import { cn } from '@workspace/ui';
import { File, FileImage, FileSpreadsheet, FileText, Folder, Presentation } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useEditorServices } from '../services';
import { atomBlock, dataAttr } from './atom';
import { formatBytes } from './media';

/**
 * A Google Drive file (Phase 8 N9): a pointer picked with Google's Picker. It keeps what Drive
 * last said (name, kind, size, date), so it shows offline and on the web; where Drive is
 * connected it asks again when shown and keeps the name current.
 */
export const DRIVE_FILE = 'driveFile';

export function driveFileNode(ref: DriveFileRef) {
  return {
    type: DRIVE_FILE,
    attrs: {
      fileId: ref.fileId,
      name: ref.name,
      mimeType: ref.mimeType,
      modifiedAt: ref.modifiedAt,
      size: ref.size,
    },
  };
}

/** Put one Drive block per file in place of the block at the cursor. */
export function replaceWithDriveFiles(refs: DriveFileRef[]): Command {
  return ({ state, tr, dispatch }) => {
    const { $from } = state.selection;
    if ($from.depth < 1 || refs.length === 0) return false;
    if (dispatch) {
      const nodes = Fragment.from(refs.map((ref) => state.schema.nodeFromJSON(driveFileNode(ref))));
      const start = $from.before($from.depth);
      tr.replaceWith(start, $from.after($from.depth), nodes);
      const after = start + nodes.size;
      if (after >= tr.doc.content.size) tr.insert(after, state.schema.nodes.paragraph!.create());
      tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
    }
    return true;
  };
}

function DriveIcon({ mimeType }: { mimeType: string }) {
  const props = { size: 18, className: 'shrink-0 text-muted' };
  if (mimeType === 'application/vnd.google-apps.folder') return <Folder {...props} />;
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return <FileSpreadsheet {...props} />;
  if (mimeType === 'application/vnd.google-apps.presentation') return <Presentation {...props} />;
  if (mimeType.startsWith('image/')) return <FileImage {...props} />;
  if (mimeType === 'application/vnd.google-apps.document' || mimeType === 'application/pdf')
    return <FileText {...props} />;
  return <File {...props} />;
}

const PROBLEMS: Partial<Record<DriveFileStatus['state'], string>> = {
  gone: 'Deleted from Google Drive (or in its trash).',
  noAccess: 'The Google account connected here can’t open it.',
  notConnected: 'Connect Google Drive to see it as it is now.',
  offline: 'Google Drive can’t be reached; this is how it was.',
};

function DriveFileView({ node, updateAttributes, editor, selected }: ReactNodeViewProps) {
  const services = useEditorServices();
  const drive = services.drive;
  const ref = driveFileOf(node.attrs);
  const fileId = ref?.fileId ?? null;
  const [status, setStatus] = useState<DriveFileStatus | null>(null);

  // What Drive says now: on show, when the window comes back, and when the connection changes.
  useEffect(() => {
    if (!drive || !fileId) return;
    let active = true;
    const check = () =>
      void drive.status(fileId).then((next) => {
        if (active) setStatus(next);
      });
    check();
    window.addEventListener('focus', check);
    const stop = drive.subscribe(check);
    return () => {
      active = false;
      window.removeEventListener('focus', check);
      stop();
    };
  }, [drive, fileId]);

  // Renamed or changed in Drive: the page keeps what it is now (for everyone, and offline).
  const found = status?.state === 'found' ? status.file : null;
  useEffect(() => {
    if (!found || !ref || !editor.isEditable) return;
    if (
      found.name !== ref.name ||
      found.modifiedAt !== ref.modifiedAt ||
      found.size !== ref.size ||
      found.mimeType !== ref.mimeType
    ) {
      updateAttributes(driveFileNode(found).attrs);
    }
  }, [found, ref, editor, updateAttributes]);

  if (!ref) {
    return (
      <NodeViewWrapper>
        <div className="ws-linked-file text-sm text-muted" contentEditable={false}>
          <File size={18} className="shrink-0" /> An empty Google Drive link
        </div>
      </NodeViewWrapper>
    );
  }

  const shown = found ?? ref;
  const problem = status ? PROBLEMS[status.state] : undefined;
  const details = [
    'Google Drive',
    driveKind(shown.mimeType),
    shown.size !== null ? formatBytes(shown.size) : null,
    shown.modifiedAt !== null
      ? new Date(shown.modifiedAt).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : null,
  ].filter(Boolean);

  return (
    <NodeViewWrapper>
      <div
        className={cn(
          'ws-linked-file',
          selected && 'is-selected',
          (status?.state === 'gone' || status?.state === 'noAccess') && 'is-missing',
        )}
        contentEditable={false}
        data-testid="drive-file"
        data-state={drive ? (status?.state ?? 'checking') : 'elsewhere'}
      >
        <a
          href={driveOpenUrl(ref.fileId)}
          target="_blank"
          rel="noopener noreferrer"
          draggable={false}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left text-fg no-underline hover:bg-hover"
          title="Open in Google Drive"
          data-testid="drive-file-open"
          onClick={(event) => {
            if (!drive) return;
            event.preventDefault();
            void drive.open(ref.fileId);
          }}
        >
          <DriveIcon mimeType={shown.mimeType} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate" data-testid="drive-file-name">
              {shown.name}
            </span>
            <span className="truncate text-xs text-faint" data-testid="drive-file-details">
              {details.join(' · ')}
            </span>
          </span>
        </a>
      </div>
      {problem && (
        <div className="ws-linked-file-problem" contentEditable={false} role="status">
          <span data-testid="drive-file-problem">{problem}</span>
          {status?.state === 'notConnected' && drive && (
            <button type="button" onClick={drive.setUp}>
              Connect…
            </button>
          )}
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const DriveFileBlock = atomBlock(DRIVE_FILE, DriveFileView, {
  fileId: dataAttr('fileId'),
  name: dataAttr('name'),
  mimeType: dataAttr('mimeType'),
  modifiedAt: dataAttr('modifiedAt'),
  size: dataAttr('size'),
});
