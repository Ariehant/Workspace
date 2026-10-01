import type { Editor, JSONContent } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { cn } from '@workspace/ui';
import {
  Bookmark,
  FileText,
  FileVideo,
  Globe,
  Image as ImageIcon,
  Link as LinkIcon,
  Music,
  Paperclip,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useEditorServices, type EditorServices, type FileRef } from '../services';
import { atomBlock, dataAttr } from './atom';
import { isUrl, toEmbedUrl } from './embeds';

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'file';

export function kindForMime(mime: string, name = ''): MediaKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  return 'file';
}

/** Block JSON for a stored file. */
export function mediaNodeFor(file: FileRef): JSONContent {
  const kind = kindForMime(file.mime, file.name);
  return {
    type: kind,
    attrs: { fileId: file.id, name: file.name, ...(kind !== 'image' && { size: file.size }) },
  };
}

/**
 * Upload files (pasted or dropped) and insert one block per file at `pos`, or in
 * place of the empty block at the cursor (else below the block at the cursor).
 */
export async function insertFiles(editor: Editor, files: File[], pos?: number): Promise<void> {
  const services = editor.storage.uiBridge.ref.current.services;
  if (!services || files.length === 0) return;
  const stored = await Promise.all(files.map((file) => services.uploadFile(file)));
  if (editor.isDestroyed) return;

  editor
    .chain()
    .focus()
    .command(({ state, tr }) => {
      const { schema } = state;
      const nodes = Fragment.from(stored.map((file) => schema.nodeFromJSON(mediaNodeFor(file))));
      const { $from } = state.selection;
      let from: number;
      let to: number;
      if (pos !== undefined) {
        from = to = pos;
      } else if ($from.depth > 0 && $from.parent.isTextblock && $from.parent.content.size === 0) {
        // Replace the empty block the cursor is in.
        from = $from.before($from.depth);
        to = $from.after($from.depth);
      } else {
        from = to = $from.depth > 0 ? $from.after($from.depth) : $from.pos;
      }
      tr.replaceWith(from, to, nodes);
      // Continue typing below the new blocks, adding an empty block at the end of the page.
      const end = from + nodes.size;
      if (end >= tr.doc.content.size) tr.insert(end, schema.nodes.paragraph!.create());
      tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1)));
      return true;
    })
    .run();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function sourceOf(services: EditorServices, attrs: Record<string, unknown>): string | null {
  if (typeof attrs.fileId === 'string') return services.fileUrl(attrs.fileId);
  return typeof attrs.src === 'string' ? attrs.src : null;
}

// --- Empty state: upload or link ---------------------------------------------------

interface PlaceholderProps {
  icon: LucideIcon;
  label: string;
  /** File input `accept`; omit for link-only blocks (bookmark, embed). */
  accept?: string;
  linkLabel: string;
  onFile?(file: File): Promise<void>;
  onLink(url: string): void;
  editable: boolean;
}

function Placeholder({
  icon: Icon,
  label,
  accept,
  linkLabel,
  onFile,
  onLink,
  editable,
}: PlaceholderProps) {
  // Empty media blocks show their upload / link panel until filled.
  const [open, setOpen] = useState(editable);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file || !onFile) return;
    setBusy(true);
    setError(null);
    try {
      await onFile(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div contentEditable={false} className="ws-media-placeholder" data-testid="media-placeholder">
      <button
        type="button"
        disabled={!editable}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded px-3 py-3 text-left text-muted hover:bg-hover"
      >
        <Icon size={20} strokeWidth={1.6} />
        <span>{busy ? 'Uploading…' : label}</span>
      </button>
      {open && !busy && (
        <div className="flex flex-col gap-2 border-t border-line p-3 text-sm">
          {onFile && (
            <label className="flex h-8 cursor-pointer items-center justify-center rounded border border-line hover:bg-hover">
              Upload file
              <input
                type="file"
                accept={accept}
                aria-label="Upload file"
                className="sr-only"
                onChange={(event) => void pick(event.target.files?.[0])}
              />
            </label>
          )}
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = url.trim();
              if (isUrl(value)) onLink(value);
              else setError('Enter a full link starting with https://');
            }}
          >
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="Paste in https://…"
              aria-label={linkLabel}
              className="h-8 min-w-0 flex-1 rounded border border-line bg-surface px-2 outline-none focus:border-accent"
            />
            <button type="submit" className="h-8 rounded bg-accent px-3 text-accent-fg">
              {onFile ? 'Embed link' : 'Create'}
            </button>
          </form>
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}

function Caption({
  value,
  onChange,
  editable,
}: {
  value: string;
  onChange(v: string): void;
  editable: boolean;
}) {
  if (!editable && !value) return null;
  return (
    <input
      value={value}
      readOnly={!editable}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Write a caption"
      aria-label="Caption"
      className={cn('ws-media-caption', !value && 'ws-media-caption-empty')}
    />
  );
}

// --- Image -------------------------------------------------------------------------

const MIN_IMAGE_WIDTH = 80;

function ImageView({ node, updateAttributes, editor, selected }: ReactNodeViewProps) {
  const services = useEditorServices();
  const src = sourceOf(services, node.attrs);
  const figure = useRef<HTMLElement>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? (node.attrs.width as number | null);

  if (!src) {
    return (
      <NodeViewWrapper>
        <Placeholder
          icon={ImageIcon}
          label="Add an image"
          accept="image/*"
          linkLabel="Image link"
          editable={editor.isEditable}
          onFile={async (file) => {
            const stored = await services.uploadFile(file);
            updateAttributes({ fileId: stored.id, name: stored.name });
          }}
          onLink={(url) => updateAttributes({ src: url })}
        />
      </NodeViewWrapper>
    );
  }

  /** Drag a side handle; images are centred, so the width changes by twice the delta. */
  const startResize = (side: 'left' | 'right') => (down: React.PointerEvent) => {
    down.preventDefault();
    const el = figure.current;
    const container = el?.parentElement;
    if (!el || !container) return;
    const startX = down.clientX;
    const startWidth = el.getBoundingClientRect().width;
    const max = container.getBoundingClientRect().width;
    let next = startWidth;
    const move = (e: PointerEvent) => {
      const delta = (e.clientX - startX) * (side === 'right' ? 2 : -2);
      next = Math.round(Math.min(max, Math.max(MIN_IMAGE_WIDTH, startWidth + delta)));
      setDragWidth(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      updateAttributes({ width: next >= max ? null : next });
      setDragWidth(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <NodeViewWrapper className="ws-image-block">
      <figure
        ref={figure}
        className={cn('ws-image group', selected && 'is-selected')}
        style={{ width: width ? `${width}px` : undefined }}
      >
        <img
          src={src}
          alt={(node.attrs.caption as string) || ''}
          draggable={false}
          data-drag-handle
        />
        {editor.isEditable &&
          (['left', 'right'] as const).map((side) => (
            <span
              key={side}
              role="separator"
              aria-label={`Resize image from the ${side}`}
              className={`ws-image-resize ws-image-resize-${side}`}
              onPointerDown={startResize(side)}
            />
          ))}
        <Caption
          value={(node.attrs.caption as string) ?? ''}
          editable={editor.isEditable}
          onChange={(caption) => updateAttributes({ caption })}
        />
      </figure>
    </NodeViewWrapper>
  );
}

const fileAttrs = {
  fileId: dataAttr('fileId'),
  src: dataAttr('src'),
  name: dataAttr('name'),
  caption: dataAttr('caption', ''),
};

export const ImageBlock = atomBlock('image', ImageView, {
  ...fileAttrs,
  width: dataAttr('width'),
});

// --- Video, audio, PDF, file --------------------------------------------------------

const MEDIA_UI: Record<
  Exclude<MediaKind, 'image'>,
  { icon: LucideIcon; label: string; accept: string }
> = {
  video: { icon: FileVideo, label: 'Embed or upload a video', accept: 'video/*' },
  audio: { icon: Music, label: 'Embed or upload audio', accept: 'audio/*' },
  pdf: { icon: FileText, label: 'Embed or upload a PDF', accept: 'application/pdf,.pdf' },
  file: { icon: Paperclip, label: 'Upload or embed a file', accept: '' },
};

function mediaView(kind: Exclude<MediaKind, 'image'>) {
  return function MediaView({ node, updateAttributes, editor, selected }: ReactNodeViewProps) {
    const services = useEditorServices();
    const src = sourceOf(services, node.attrs);
    const ui = MEDIA_UI[kind];
    const name =
      (node.attrs.name as string | null) ??
      (src ? decodeURIComponent(src.split('/').pop() ?? '') : '');

    if (!src) {
      return (
        <NodeViewWrapper>
          <Placeholder
            icon={ui.icon}
            label={ui.label}
            accept={ui.accept || undefined}
            linkLabel={`${kind} link`}
            editable={editor.isEditable}
            onFile={async (file) => {
              const stored = await services.uploadFile(file);
              updateAttributes({ fileId: stored.id, name: stored.name, size: stored.size });
            }}
            onLink={(url) => updateAttributes({ src: url })}
          />
        </NodeViewWrapper>
      );
    }

    let body: ReactNode;
    if (kind === 'video')
      body = <video controls preload="metadata" src={src} className="w-full rounded" />;
    else if (kind === 'audio')
      body = <audio controls preload="metadata" src={src} className="w-full" />;
    else if (kind === 'pdf') body = <iframe src={src} title={name || 'PDF'} className="ws-pdf" />;
    else {
      body = (
        <button
          type="button"
          contentEditable={false}
          onClick={() =>
            typeof node.attrs.fileId === 'string'
              ? services.openFile(node.attrs.fileId)
              : window.open(src, '_blank', 'noopener')
          }
          className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left hover:bg-hover"
          title="Open with the default app"
        >
          <Paperclip size={18} className="shrink-0 text-muted" />
          <span className="truncate">{name || 'File'}</span>
          {typeof node.attrs.size === 'number' && (
            <span className="shrink-0 text-sm text-faint">{formatBytes(node.attrs.size)}</span>
          )}
        </button>
      );
    }

    return (
      <NodeViewWrapper className={cn('ws-media', selected && 'is-selected')} data-kind={kind}>
        {body}
        {kind !== 'file' && (
          <Caption
            value={(node.attrs.caption as string) ?? ''}
            editable={editor.isEditable}
            onChange={(caption) => updateAttributes({ caption })}
          />
        )}
      </NodeViewWrapper>
    );
  };
}

export const VideoBlock = atomBlock('video', mediaView('video'), fileAttrs);
export const AudioBlock = atomBlock('audio', mediaView('audio'), fileAttrs);
export const PdfBlock = atomBlock('pdf', mediaView('pdf'), fileAttrs);
export const FileBlock = atomBlock('file', mediaView('file'), {
  ...fileAttrs,
  size: dataAttr('size'),
});

// --- Web bookmark --------------------------------------------------------------------

function BookmarkView({ node, updateAttributes, editor, selected }: ReactNodeViewProps) {
  const services = useEditorServices();
  const url = node.attrs.url as string | null;
  const title = node.attrs.title as string | null;

  // Fetch the preview once for a new bookmark (cached by the host afterwards).
  useEffect(() => {
    if (!url || title) return;
    let active = true;
    void services.linkPreview(url).then((preview) => {
      if (!active || !preview || !editor.isEditable) return;
      updateAttributes({
        title: preview.title,
        description: preview.description,
        image: preview.image,
        icon: preview.icon,
      });
    });
    return () => {
      active = false;
    };
  }, [url, title, services, editor, updateAttributes]);

  if (!url) {
    return (
      <NodeViewWrapper>
        <Placeholder
          icon={Bookmark}
          label="Add a web bookmark"
          linkLabel="Bookmark link"
          editable={editor.isEditable}
          onLink={(link) => updateAttributes({ url: link })}
        />
      </NodeViewWrapper>
    );
  }

  const host = new URL(url).hostname;
  return (
    <NodeViewWrapper>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        contentEditable={false}
        draggable={false}
        data-testid="bookmark"
        className={cn('ws-bookmark', selected && 'is-selected')}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1 p-3">
          <span className="truncate text-sm text-fg">{title || host}</span>
          {node.attrs.description && (
            <span className="line-clamp-2 text-xs text-muted">
              {node.attrs.description as string}
            </span>
          )}
          <span className="mt-1 flex items-center gap-1.5 text-xs text-fg">
            {node.attrs.icon ? (
              <img
                src={node.attrs.icon as string}
                alt=""
                className="size-4"
                onError={(e) => (e.currentTarget.style.display = 'none')}
              />
            ) : (
              <Globe size={14} />
            )}
            <span className="truncate">{url}</span>
          </span>
        </span>
        {node.attrs.image && (
          <img
            src={node.attrs.image as string}
            alt=""
            className="ws-bookmark-image"
            onError={(e) => (e.currentTarget.style.display = 'none')}
          />
        )}
      </a>
    </NodeViewWrapper>
  );
}

export const BookmarkBlock = atomBlock('bookmark', BookmarkView, {
  url: dataAttr('url'),
  title: dataAttr('title'),
  description: dataAttr('description'),
  image: dataAttr('image'),
  icon: dataAttr('icon'),
});

// --- Embed ---------------------------------------------------------------------------

function EmbedView({ node, updateAttributes, editor, getPos, selected }: ReactNodeViewProps) {
  const url = node.attrs.url as string | null;
  if (!url) {
    return (
      <NodeViewWrapper>
        <Placeholder
          icon={LinkIcon}
          label="Embed a YouTube, Vimeo, Loom, Figma, CodePen or Google Maps link"
          linkLabel="Embed link"
          editable={editor.isEditable}
          onLink={(link) => updateAttributes({ url: link })}
        />
      </NodeViewWrapper>
    );
  }

  const embed = toEmbedUrl(url);
  if (!embed) {
    // Not an embeddable site: offer a bookmark instead.
    const toBookmark = () => {
      const pos = getPos();
      if (typeof pos !== 'number') return;
      editor
        .chain()
        .focus()
        .insertContentAt(
          { from: pos, to: pos + node.nodeSize },
          { type: 'bookmark', attrs: { url } },
        )
        .run();
    };
    return (
      <NodeViewWrapper>
        <div
          contentEditable={false}
          className="ws-media-placeholder flex items-center gap-2 p-3 text-sm text-muted"
        >
          <LinkIcon size={16} />
          <span className="min-w-0 flex-1 truncate">This link can't be embedded: {url}</span>
          {editor.isEditable && (
            <button
              type="button"
              onClick={toBookmark}
              className="rounded px-2 py-1 text-fg hover:bg-hover"
            >
              Create bookmark
            </button>
          )}
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className={cn('ws-embed', selected && 'is-selected')}>
      <iframe
        src={embed.src}
        title={`${embed.provider} embed`}
        data-provider={embed.provider}
        style={{ height: node.attrs.height as number }}
        sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-forms"
        allow="fullscreen; picture-in-picture; clipboard-write; encrypted-media"
        referrerPolicy="strict-origin-when-cross-origin"
        loading="lazy"
      />
    </NodeViewWrapper>
  );
}

export const EmbedBlock = atomBlock('embed', EmbedView, {
  url: dataAttr('url'),
  height: dataAttr('height', 400),
});

export const MediaBlocks = [
  ImageBlock,
  VideoBlock,
  AudioBlock,
  PdfBlock,
  FileBlock,
  BookmarkBlock,
  EmbedBlock,
];
