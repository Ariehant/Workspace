/**
 * A file's preview in the page (Phase 8 N9, #9): a Word document's text and tables, an Excel
 * workbook's sheets, a PDF in the viewer. Read with the importers' own readers, and shown from
 * their blocks (never as HTML from the file). Loaded only when a preview is opened.
 */
import type { JSONContent } from '@workspace/editor';
import type { PreviewKind } from '@workspace/core';
import { readDocx } from '@workspace/importers/docx';
import { readXlsx, type Sheet } from '@workspace/importers/xlsx';
import { cn } from '@workspace/ui';
import { ImageIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

/** Bigger than this isn't read for a preview (it opens in its app instead). */
const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 200;
const MAX_COLUMNS = 50;

type Loaded =
  | { kind: 'docx'; blocks: JSONContent[] }
  | { kind: 'xlsx'; sheets: Sheet[] }
  | { kind: 'error'; message: string };

async function load(url: string, kind: 'docx' | 'xlsx'): Promise<Loaded> {
  const response = await fetch(url);
  if (!response.ok) return { kind: 'error', message: 'The file isn’t here to preview.' };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PREVIEW_BYTES) {
    return { kind: 'error', message: 'Too large to preview; open it instead.' };
  }
  try {
    if (kind === 'xlsx') return { kind: 'xlsx', sheets: readXlsx(bytes) };
    const document = readDocx(bytes, {
      // Pictures aren't stored for a preview: each shows as a placeholder.
      file: (_bytes, name) => ({ kind: 'file', fileId: '', name, media: 'image' }),
      warn: () => {},
    });
    return { kind: 'docx', blocks: document.blocks };
  } catch {
    return { kind: 'error', message: 'This file couldn’t be read for a preview.' };
  }
}

export default function FilePreview({
  url,
  name,
  kind,
}: {
  url: string;
  name: string;
  kind: PreviewKind;
}) {
  // What was read, for which file (another file shows as loading until it's read).
  const [result, setResult] = useState<{ key: string; loaded: Loaded } | null>(null);
  const key = `${kind}\u0000${url}`;
  useEffect(() => {
    if (kind !== 'docx' && kind !== 'xlsx') return;
    let active = true;
    const done = (loaded: Loaded) => {
      if (active) setResult({ key, loaded });
    };
    load(url, kind).then(done, () =>
      done({ kind: 'error', message: 'The file isn’t here to preview.' }),
    );
    return () => {
      active = false;
    };
  }, [url, kind, key]);
  const loaded = result?.key === key ? result.loaded : null;

  if (kind === 'image') {
    return <img src={url} alt={name} className="ws-file-preview-image" draggable={false} />;
  }
  if (kind === 'pdf') return <iframe src={url} title={name} className="ws-pdf" />;
  return (
    <div className="ws-file-preview" data-testid="file-preview" aria-label={`Preview of ${name}`}>
      {!loaded ? (
        <p className="text-sm text-muted">Reading {name}…</p>
      ) : loaded.kind === 'error' ? (
        <p className="text-sm text-muted" role="status">
          {loaded.message}
        </p>
      ) : loaded.kind === 'docx' ? (
        <div className="ws-file-preview-doc">{renderBlocks(loaded.blocks)}</div>
      ) : (
        <Workbook sheets={loaded.sheets} />
      )}
    </div>
  );
}

// --- A workbook ---------------------------------------------------------------------------

function Workbook({ sheets }: { sheets: Sheet[] }) {
  const [index, setIndex] = useState(0);
  const sheet = sheets[Math.min(index, sheets.length - 1)];
  if (!sheet) return <p className="text-sm text-muted">The workbook has no sheets.</p>;
  const rows = sheet.rows.slice(0, MAX_ROWS);
  const width = Math.min(MAX_COLUMNS, Math.max(0, ...rows.map((r) => r.length)));
  return (
    <div className="flex flex-col gap-2">
      {sheets.length > 1 && (
        <div role="tablist" aria-label="Sheets" className="flex flex-wrap gap-1">
          {sheets.map((s, i) => (
            <button
              key={`${s.name}-${i}`}
              type="button"
              role="tab"
              aria-selected={i === index}
              onClick={() => setIndex(i)}
              className={cn(
                'rounded px-2 py-0.5 text-sm',
                i === index ? 'bg-active text-fg' : 'text-muted hover:bg-hover',
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="max-h-96 overflow-auto">
        <table className="ws-file-preview-sheet" aria-label={sheet.name}>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {Array.from({ length: width }, (_, c) => (
                  <td key={c}>{row[c] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(sheet.rows.length > MAX_ROWS || sheet.rows.some((row) => row.length > MAX_COLUMNS)) && (
        <p className="text-xs text-faint">
          The first {MAX_ROWS} rows and {MAX_COLUMNS} columns; open the file for the rest.
        </p>
      )}
    </div>
  );
}

// --- A document's blocks -------------------------------------------------------------------

const safeHref = (href: unknown) =>
  typeof href === 'string' && /^(https?:|mailto:)/i.test(href) ? href : undefined;

function renderText(node: JSONContent, key: number): ReactNode {
  let out: ReactNode = node.text ?? '';
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') out = <strong>{out}</strong>;
    else if (mark.type === 'italic') out = <em>{out}</em>;
    else if (mark.type === 'underline') out = <u>{out}</u>;
    else if (mark.type === 'strike') out = <s>{out}</s>;
    else if (mark.type === 'code') out = <code>{out}</code>;
    else if (mark.type === 'link') {
      const href = safeHref(mark.attrs?.href);
      out = href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {out}
        </a>
      ) : (
        out
      );
    }
  }
  return <span key={key}>{out}</span>;
}

function renderBlocks(nodes: readonly JSONContent[] | undefined): ReactNode[] {
  return (nodes ?? []).map((node, i) => renderBlock(node, i));
}

function renderBlock(node: JSONContent, key: number): ReactNode {
  const children = () => renderBlocks(node.content);
  switch (node.type) {
    case 'text':
      return renderText(node, key);
    case 'hardBreak':
      return <br key={key} />;
    case 'paragraph':
      return <p key={key}>{children()}</p>;
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 3);
      const Tag = (['h1', 'h2', 'h3'] as const)[level - 1]!;
      return <Tag key={key}>{children()}</Tag>;
    }
    case 'bulletList':
    case 'taskList':
      return <ul key={key}>{children()}</ul>;
    case 'orderedList':
      return <ol key={key}>{children()}</ol>;
    case 'listItem':
    case 'taskItem':
      return <li key={key}>{children()}</li>;
    case 'blockquote':
      return <blockquote key={key}>{children()}</blockquote>;
    case 'codeBlock':
      return (
        <pre key={key}>
          <code>{(node.content ?? []).map((t) => t.text ?? '').join('')}</code>
        </pre>
      );
    case 'horizontalRule':
      return <hr key={key} />;
    case 'table':
      return (
        <table key={key} className="ws-file-preview-sheet">
          <tbody>{children()}</tbody>
        </table>
      );
    case 'tableRow':
      return <tr key={key}>{children()}</tr>;
    case 'tableHeader':
      return <th key={key}>{children()}</th>;
    case 'tableCell':
      return <td key={key}>{children()}</td>;
    case 'image':
    case 'file':
      return (
        <p key={key} className="flex items-center gap-1 text-sm text-faint">
          <ImageIcon size={14} aria-hidden /> {String(node.attrs?.name ?? 'Picture')}
        </p>
      );
    default:
      return <div key={key}>{children()}</div>;
  }
}
