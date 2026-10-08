import {
  FILE_ICON_PREFIX,
  compareSiblings,
  getPage,
  isInTrash,
  listPages,
  pageUrl,
  type PageId,
  type PageMeta,
} from '@workspace/core';
import {
  ComputedCache,
  DatabaseHandle,
  cellText,
  isDatabaseDoc,
  type DatabaseSnapshot,
  type DisplayContext,
  type Row,
} from '@workspace/database';
import type * as Y from 'yjs';
import { flag, inlineText, readContent, walk, type ContentNode } from './content';
import type { RenderContext } from './context';
import { databaseCsv, exportedProperties, exportedRows } from './csv';
import { blocksHtml, escapeHtml, htmlDocument } from './html';
import { blocksMarkdown } from './markdown';

/** Where an export reads the workspace from. */
export interface ExportSource {
  workspace: Y.Doc;
  /** A doc's current state (pages, databases, rows, synced blocks), or null. */
  doc(id: string): Y.Doc | null;
  /** A stored file's bytes and original name, or null if it's missing. */
  file(id: string): { bytes: Uint8Array; name: string | null } | null;
  /** User id → name, for person and created/edited-by values. */
  users: ReadonlyMap<string, string>;
  now?: number;
}

export type ExportFormat = 'markdown' | 'html';

export interface ExportOptions {
  format: ExportFormat;
  /** Pages to export, or every page in the workspace (not those in the trash). */
  roots: readonly PageId[] | 'all';
  /** With their sub-pages (always for 'all'). */
  includeSubpages: boolean;
  /** Mermaid diagrams pre-rendered to SVG, for HTML. */
  mermaidSvg?(code: string): string | null;
  onProgress?(done: number, total: number): void;
}

/** A file in the export, at a path relative to the export's root. */
export interface ExportEntry {
  path: string;
  data: string | Uint8Array;
}

// Characters that can't (or shouldn't) be in file names, including control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[/\\:*?"<>|\u0000-\u001f]/g;

/** What gets exported: each item's file, and the folder its children and files go in. */
interface Item {
  id: string;
  kind: 'page' | 'database' | 'row';
  title: string;
  file: string;
  folder: string;
  page?: PageMeta;
  row?: Row;
  databaseId?: string;
}

/** A file or folder name: the title made safe, then the id without dashes (Notion's layout). */
export function exportName(title: string, id: string): string {
  const safe =
    title.replace(UNSAFE_NAME, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim() || 'Untitled';
  return `${safe} ${id.replace(/-/g, '')}`;
}

/** Path from the folder of `from` to `to` (both relative to the export root). */
export function relativePath(from: string, to: string): string {
  const a = from.split('/').slice(0, -1);
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

/** A unique, safe file name for an attachment within one folder. */
function attachmentName(name: string | null, fileId: string, taken: Set<string>): string {
  const base = (name || fileId).replace(UNSAFE_NAME, '_').slice(0, 120) || fileId;
  let candidate = base;
  const dot = base.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem} (${n})${ext}`;
  taken.add(candidate);
  return candidate;
}

/** Workspace pages to export, parents before children, in sidebar order. */
export function selectPages(
  workspace: Y.Doc,
  roots: readonly PageId[] | 'all',
  includeSubpages: boolean,
): { page: PageMeta; parentId: PageId | null }[] {
  const pages = listPages(workspace).filter((p) => !isInTrash(workspace, p.id));
  const children = new Map<PageId | null, PageMeta[]>();
  for (const page of pages) {
    const list = children.get(page.parentId) ?? [];
    list.push(page);
    children.set(page.parentId, list);
  }
  for (const list of children.values()) list.sort(compareSiblings);
  const out: { page: PageMeta; parentId: PageId | null }[] = [];
  const add = (page: PageMeta, parentId: PageId | null, deep: boolean) => {
    out.push({ page, parentId });
    if (deep) for (const child of children.get(page.id) ?? []) add(child, page.id, true);
  };
  if (roots === 'all') {
    for (const page of children.get(null) ?? []) add(page, null, true);
  } else {
    for (const id of roots) {
      const page = pages.find((p) => p.id === id);
      if (page) add(page, null, includeSubpages);
    }
  }
  return out;
}

/** Computed snapshots (formulas, relations, rollups) of the databases an export touches. */
class Databases {
  private readonly handles = new Map<string, DatabaseHandle>();
  private readonly caches = new Map<string, ComputedCache>();
  private readonly visiting = new Set<string>();

  constructor(
    private readonly source: ExportSource,
    private readonly ctx: DisplayContext,
  ) {}

  snapshot = (id: string, compute = true): DatabaseSnapshot | undefined => {
    let handle = this.handles.get(id);
    if (!handle) {
      const doc = this.source.doc(id);
      if (!doc || !isDatabaseDoc(doc)) return undefined;
      handle = new DatabaseHandle(id, doc);
      this.handles.set(id, handle);
    }
    const raw = handle.snapshot();
    if (!compute || this.visiting.has(id)) return raw;
    let cache = this.caches.get(id);
    if (!cache) this.caches.set(id, (cache = new ComputedCache()));
    this.visiting.add(id);
    try {
      return cache.apply(raw, this.ctx, this.snapshot, id);
    } finally {
      this.visiting.delete(id);
    }
  };

  destroy(): void {
    for (const handle of this.handles.values()) handle.destroy();
  }
}

/** Mermaid sources in the pages an export covers (to render them to SVG first). */
export function mermaidSources(source: ExportSource, options: ExportOptions): string[] {
  const found = new Set<string>();
  const scan = (doc: Y.Doc | null) => {
    if (!doc) return;
    for (const node of walk(readContent(doc))) {
      if (node.type === 'codeBlock' && node.attrs.language === 'mermaid') {
        const code = inlineText(node.inline);
        if (code.trim()) found.add(code);
      }
    }
  };
  for (const { page } of selectPages(source.workspace, options.roots, options.includeSubpages)) {
    const doc = source.doc(page.id);
    if (!doc) continue;
    if (isDatabaseDoc(doc)) {
      const handle = new DatabaseHandle(page.id, doc);
      for (const row of exportedRows(handle.snapshot())) scan(source.doc(row.id));
      handle.destroy();
    } else scan(doc);
  }
  return [...found];
}

/**
 * Export pages (with their databases' rows and attachments) as Markdown + CSV or HTML,
 * in Notion's layout: `Title <id>.md`, sub-pages in a `Title <id>/` folder next to it,
 * databases as `.csv` (or an `.html` table) with their rows in the folder.
 */
export function* exportPages(source: ExportSource, options: ExportOptions): Generator<ExportEntry> {
  const html = options.format === 'html';
  const ext = html ? '.html' : '.md';
  const display: DisplayContext = { users: source.users, now: source.now };
  const databases = new Databases(source, display);
  try {
    // Plan every file first, so links between exported pages can point at their files.
    const items = new Map<string, Item>();
    const order: Item[] = [];
    const add = (item: Item) => {
      items.set(item.id, item);
      order.push(item);
    };
    for (const { page, parentId } of selectPages(
      source.workspace,
      options.roots,
      options.includeSubpages,
    )) {
      const dir = parentId ? (items.get(parentId)?.folder ?? '') : '';
      const name = exportName(page.title, page.id);
      const isDatabase = page.kind === 'database';
      const item: Item = {
        id: page.id,
        kind: isDatabase ? 'database' : 'page',
        title: page.title || 'Untitled',
        file: `${dir}${name}${isDatabase && !html ? '.csv' : ext}`,
        folder: `${dir}${name}/`,
        page,
      };
      add(item);
      if (isDatabase) {
        const snapshot = databases.snapshot(page.id);
        for (const row of snapshot ? exportedRows(snapshot) : []) {
          const rowName = exportName(row.title, row.id);
          add({
            id: row.id,
            kind: 'row',
            title: row.title || 'Untitled',
            file: `${item.folder}${rowName}${ext}`,
            folder: `${item.folder}${rowName}/`,
            row,
            databaseId: page.id,
          });
        }
      }
    }

    const titleOf = (id: string) =>
      items.get(id)?.title ??
      getPage(source.workspace, id)?.title ??
      databases.snapshot(id, false)?.rows.find((r) => r.id === id)?.title ??
      'Untitled';
    const attachments = new Map<string, Set<string>>();
    const copied = new Map<string, string>();
    let pending: ExportEntry[] = [];

    const contextFor = (item: Item): RenderContext => ({
      pageHref: (id) => {
        const target = items.get(id);
        return target ? relativePath(item.file, target.file) : pageUrl(id);
      },
      pageTitle: titleOf,
      userName: (id) => source.users.get(id) ?? 'Someone',
      fileHref: (fileId, name) => {
        const key = `${item.folder}\u0000${fileId}`;
        let path = copied.get(key);
        if (!path) {
          const file = source.file(fileId);
          if (!file) return null;
          const taken = attachments.get(item.folder) ?? new Set<string>();
          attachments.set(item.folder, taken);
          path = `${item.folder}${attachmentName(name ?? file.name, fileId, taken)}`;
          copied.set(key, path);
          pending.push({ path, data: file.bytes });
        }
        return relativePath(item.file, path);
      },
      synced: (id) => {
        const doc = source.doc(id);
        return doc ? readContent(doc) : [];
      },
      mermaidSvg: options.mermaidSvg,
    });

    const contentOf = (id: string): ContentNode[] => {
      const doc = source.doc(id);
      return doc && !isDatabaseDoc(doc) ? readContent(doc) : [];
    };

    let done = 0;
    for (const item of order) {
      const ctx = contextFor(item);
      const cover = item.page?.cover ?? item.row?.cover ?? null;
      const coverUrl = cover?.kind === 'file' ? ctx.fileHref(cover.value, null) : null;
      const icon = item.page?.icon ?? item.row?.icon ?? null;
      const textIcon = icon && !icon.startsWith(FILE_ICON_PREFIX) ? icon : null;

      if (item.kind === 'database') {
        const snapshot = databases.snapshot(item.id);
        const cellCtx = { ...display, pages: snapshot?.related };
        if (!snapshot) continue;
        if (html) {
          const properties = exportedProperties(snapshot);
          const rows = exportedRows(snapshot)
            .map(
              (row) =>
                `<tr>${properties
                  .map((p, i) => {
                    const text = escapeHtml(cellText(row, p, cellCtx));
                    if (i > 0) return `<td>${text}</td>`;
                    const href = escapeHtml(ctx.pageHref(row.id));
                    return `<td class="title"><a href="${href}">${text || 'Untitled'}</a></td>`;
                  })
                  .join('')}</tr>`,
            )
            .join('\n');
          const head = properties.map((p) => `<th>${escapeHtml(p.name)}</th>`).join('');
          const description = snapshot.meta.description
            ? `<p>${escapeHtml(snapshot.meta.description)}</p>`
            : '';
          yield {
            path: item.file,
            data: htmlDocument({
              title: item.title,
              icon: textIcon,
              coverUrl,
              fullWidth: true,
              body: `${description}<table class="database"><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table>`,
            }),
          };
        } else {
          yield { path: item.file, data: databaseCsv(snapshot, cellCtx) };
        }
      } else {
        const content = contentOf(item.id);
        let properties: [string, string][] = [];
        if (item.kind === 'row') {
          const snapshot = databases.snapshot(item.databaseId!);
          const row = snapshot?.rows.find((r) => r.id === item.id);
          if (snapshot && row) {
            const cellCtx = { ...display, pages: snapshot.related };
            properties = exportedProperties(snapshot)
              .slice(1)
              .map((p): [string, string] => [p.name, cellText(row, p, cellCtx)])
              .filter(([, value]) => value !== '');
          }
        }
        if (html) {
          const header = properties.length
            ? `<dl class="properties">${properties
                .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
                .join('')}</dl>\n`
            : '';
          const body = blocksHtml(content, ctx);
          yield {
            path: item.file,
            data: htmlDocument({
              title: item.title,
              icon: textIcon,
              coverUrl,
              fullWidth: flag(item.page?.fullWidth ?? item.row?.fullWidth),
              header,
              body,
            }),
          };
        } else {
          const props = properties.map(([k, v]) => `${k}: ${v}`).join('\n');
          const body = blocksMarkdown(content, ctx);
          const parts = [`# ${item.title}`, props, body].filter(Boolean);
          yield { path: item.file, data: `${parts.join('\n\n')}\n` };
        }
      }
      // Attachments the page used, next to it.
      yield* pending;
      pending = [];
      options.onProgress?.(++done, order.length);
    }
  } finally {
    databases.destroy();
  }
}
