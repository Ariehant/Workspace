import type { Command } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import {
  linkedFileLocation,
  linkedFileOf,
  type LinkedFileRef,
  type LinkedFileStatus,
} from '@workspace/core';
import { cn } from '@workspace/ui';
import { FileSymlink, FolderOpen, FolderSymlink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useEditorServices } from '../services';
import { atomBlock, dataAttr } from './atom';
import { FilePreviewToggle, formatBytes } from './media';

/**
 * A linked file (Phase 8 N9): a pointer to a file on the computer, not a copy. It opens with
 * the default app where it's found; elsewhere it says why not (moved, or its linked folder
 * isn't linked on this computer) and how to fix that.
 */
export const LINKED_FILE = 'linkedFile';

/** Block JSON for a pointer. */
export function linkedFileNode(ref: LinkedFileRef) {
  return {
    type: LINKED_FILE,
    attrs: {
      folder: ref.folder,
      path: ref.path,
      name: ref.name,
      size: ref.size,
      modifiedAt: ref.modifiedAt,
    },
  };
}

/**
 * Put one linked-file block per pointer in place of the block at the cursor (the slash
 * menu's empty one), and the cursor in a block after them.
 */
export function replaceWithLinkedFiles(refs: LinkedFileRef[]): Command {
  return ({ state, tr, dispatch }) => {
    const { $from } = state.selection;
    if ($from.depth < 1 || refs.length === 0) return false;
    if (dispatch) {
      const nodes = Fragment.from(
        refs.map((ref) => state.schema.nodeFromJSON(linkedFileNode(ref))),
      );
      const start = $from.before($from.depth);
      tr.replaceWith(start, $from.after($from.depth), nodes);
      const after = start + nodes.size;
      if (after >= tr.doc.content.size) tr.insert(after, state.schema.nodes.paragraph!.create());
      tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
    }
    return true;
  };
}

function when(ms: number | null): string {
  if (ms === null) return '';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function LinkedFileView({ node, updateAttributes, editor, selected }: ReactNodeViewProps) {
  const services = useEditorServices();
  const linked = services.linkedFiles;
  const ref = linkedFileOf(node.attrs);
  const key = ref ? `${ref.folder ?? ''}\u0000${ref.path}` : '';
  const [status, setStatus] = useState<LinkedFileStatus | null>(null);

  // What it is here now: on show, and whenever the window comes back (it may have moved).
  useEffect(() => {
    if (!linked || !ref) return;
    let active = true;
    const check = () =>
      void linked.status(ref).then((next) => {
        if (active) setStatus(next);
      });
    check();
    window.addEventListener('focus', check);
    return () => {
      active = false;
      window.removeEventListener('focus', check);
    };
    // `key` is the pointer; `ref` is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, key]);

  if (!ref) {
    return (
      <NodeViewWrapper>
        <div className="ws-linked-file text-sm text-muted" contentEditable={false}>
          <FileSymlink size={18} className="shrink-0" /> An empty file link
        </div>
      </NodeViewWrapper>
    );
  }

  const found = status?.state === 'found' ? status : null;
  const size = found ? found.size : ref.size;
  const modified = found ? found.modifiedAt : ref.modifiedAt;
  const Icon = found?.folder ? FolderSymlink : FileSymlink;
  const editable = editor.isEditable;
  let problem: string | null = null;
  if (!linked) problem = 'A file on a computer: open this page in the desktop app to open it.';
  else if (status?.state === 'missing') problem = 'Not found on this computer.';
  else if (status?.state === 'noFolder')
    problem = `The “${ref.folder}” folder isn’t linked on this computer.`;

  const locate = async () => {
    const next = await linked?.locate();
    if (next) updateAttributes(linkedFileNode(next).attrs);
  };

  return (
    <NodeViewWrapper>
      <div
        className={cn('ws-linked-file', selected && 'is-selected', problem && 'is-missing')}
        contentEditable={false}
        data-testid="linked-file"
        data-state={linked ? (status?.state ?? 'checking') : 'elsewhere'}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-hover disabled:hover:bg-transparent"
          disabled={!found}
          onClick={() => ref && void linked?.open(ref)}
          title={found ? 'Open with the default app' : undefined}
          data-testid="linked-file-open"
        >
          <Icon size={18} className="shrink-0 text-muted" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate" data-testid="linked-file-name">
              {ref.name}
            </span>
            <span className="truncate text-xs text-faint" data-testid="linked-file-location">
              {linkedFileLocation(ref)}
              {size !== null && ` · ${formatBytes(size)}`}
              {modified !== null && ` · ${when(modified)}`}
            </span>
          </span>
        </button>
        {found && (
          <button
            type="button"
            className="shrink-0 rounded p-1 text-muted hover:bg-hover"
            aria-label="Show in folder"
            title="Show in folder"
            onClick={() => void linked?.reveal(ref)}
          >
            <FolderOpen size={16} />
          </button>
        )}
      </div>
      {problem && (
        <div className="ws-linked-file-problem" contentEditable={false} role="status">
          <span data-testid="linked-file-problem">{problem}</span>
          {status?.state === 'noFolder' && linked && (
            <button type="button" onClick={linked.setUpFolders}>
              Link it…
            </button>
          )}
          {status?.state === 'missing' && linked && editable && (
            <button type="button" onClick={() => void locate()}>
              Locate…
            </button>
          )}
        </div>
      )}
      {found &&
        linked &&
        services.renderFilePreview &&
        found.preview &&
        found.preview !== 'image' && (
          <FilePreviewToggle
            preview={node.attrs.preview === true}
            editable={editor.isEditable}
            onChange={(preview) => updateAttributes({ preview: preview || null })}
            render={() =>
              services.renderFilePreview!({
                url: linked.previewUrl(ref),
                name: ref.name,
                kind: found.preview!,
              })
            }
          >
            {null}
          </FilePreviewToggle>
        )}
      {found?.preview === 'image' && linked && (
        <img
          src={linked.previewUrl(ref)}
          alt={ref.name}
          className="ws-linked-file-preview"
          draggable={false}
          onError={(e) => (e.currentTarget.style.display = 'none')}
        />
      )}
    </NodeViewWrapper>
  );
}

export const LinkedFileBlock = atomBlock(LINKED_FILE, LinkedFileView, {
  folder: dataAttr('folder'),
  path: dataAttr('path'),
  name: dataAttr('name'),
  size: dataAttr('size'),
  modifiedAt: dataAttr('modifiedAt'),
  preview: { default: null },
});
