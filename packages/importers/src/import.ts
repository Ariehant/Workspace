import {
  createPage,
  newId,
  setPageIcon,
  setPageOptions,
  setPageTitle,
  type PageId,
  type PageTree,
} from '@workspace/core';
import {
  OPTION_COLORS,
  TITLE_PROPERTY_ID,
  addProperty,
  addRow,
  createRelation,
  deleteProperty,
  initDatabase,
  propertyKind,
  readDatabase,
  renameProperty,
  setRelation,
  type Property,
  type PropertyConfig,
  type PropertyType,
  type SelectOption,
} from '@workspace/database';
import { appendContent, type JSONContent } from '@workspace/editor';
import type * as Y from 'yjs';
import { parseCsv } from './csv';
import { notionHtmlPage, type HtmlColumn } from './html';
import { inferType, parseNumber, splitList } from './infer';
import { notionMarkdownPage, type ConvertContext, type LinkTarget } from './markdown';
import {
  basename,
  dirname,
  folderId,
  mediaType,
  mimeOf,
  parseName,
  resolvePath,
  type ArchiveFile,
} from './paths';

/** Where an import writes: the workspace and new docs for the pages it creates. */
export interface ImportTarget {
  workspace: PageTree;
  /** An empty doc for a new page, database or row. */
  doc(id: string): Y.Doc;
  /** Store an attachment; its file id (null if it couldn't be stored). */
  storeFile(bytes: Uint8Array, name: string, mime: string): string | null;
}

export interface ImportOptions {
  /** Title of the page everything is imported under. */
  title: string;
  parentId?: PageId | null;
  onProgress?(done: number, total: number): void;
}

export interface ImportReport {
  /** The page holding the import. */
  rootId: PageId;
  pages: number;
  databases: number;
  rows: number;
  files: number;
  /** What couldn't be brought over exactly (deduplicated). */
  warnings: string[];
}

type Kind = 'page' | 'database' | 'row';

interface Item {
  key: string;
  kind: Kind;
  title: string;
  /** The page's own file (.md, .html, .txt), if any. */
  file: string | null;
  /** A database's CSV (Notion's `_all.csv` preferred). */
  csv: string | null;
  /** The folder its children and attachments are in. */
  dir: string;
  parentKey: string | null;
  id: string;
}

const DOCUMENT = new Set(['md', 'markdown', 'html', 'htm', 'txt']);
const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/;
const decoder = new TextDecoder();
const COLORS = OPTION_COLORS.filter((c) => c !== 'default');
const norm = (s: string) => s.trim().toLowerCase();
const singular = (s: string) => norm(s).replace(/s$/, '');

/** Relation cells in Notion's CSV: `Title (path/to/Title%20id.md)`, comma separated. */
const NOTION_RELATION = /\s*([^,]*?)\s*\(([^()]*\.(?:md|html))\)\s*(?:,|$)/g;

function relationTokens(text: string): { title: string; path: string | null }[] {
  if (/\.(md|html)\)/.test(text)) {
    return [...text.matchAll(NOTION_RELATION)].map((m) => ({ title: m[1]!, path: m[2]! }));
  }
  return splitList(text).map((title) => ({ title, path: null }));
}

/**
 * Import files (a Notion export, or plain Markdown / HTML / CSV / text files) under a new
 * page. Pages keep their tree, databases come from their CSV (or HTML table) with row
 * pages, links between them point at the new pages, and attachments are stored.
 */
export function importFiles(
  input: readonly ArchiveFile[],
  target: ImportTarget,
  options: ImportOptions,
): ImportReport {
  const warnings = new Set<string>();
  const warn = (message: string) => warnings.add(message);
  const files = new Map<string, Uint8Array>();
  for (const file of input) {
    const path = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!JUNK.test(path) && !path.endsWith('/')) files.set(path, file.data);
  }
  // Drop a single wrapping folder without an id (e.g. a zip of a folder).
  const tops = new Set([...files.keys()].map((p) => (p.includes('/') ? p.split('/')[0] : '')));
  if (tops.size === 1 && !tops.has('') && !folderId([...tops][0]!)) {
    const prefix = `${[...tops][0]!}/`;
    for (const [path, data] of [...files]) {
      files.delete(path);
      files.set(path.slice(prefix.length), data);
    }
  }
  const text = (path: string) => decoder.decode(files.get(path)!);

  // --- Plan the tree ---------------------------------------------------------------------
  const items = new Map<string, Item>();
  const byPath = new Map<string, Item>();
  const itemFor = (key: string, title: string, dir: string): Item => {
    let item = items.get(key);
    if (!item) {
      item = { key, kind: 'page', title, file: null, csv: null, dir, parentKey: null, id: newId() };
      items.set(key, item);
    }
    return item;
  };
  const keyOfDir = (dir: string): string | null => {
    if (!dir) return null;
    return folderId(basename(dir)) ?? `path:${dir}`;
  };
  for (const path of [...files.keys()].sort()) {
    const name = parseName(basename(path));
    if (!DOCUMENT.has(name.ext) && name.ext !== 'csv') continue;
    const dir = dirname(path);
    const stem = path.slice(0, path.length - name.ext.length - 1).replace(/_all$/, '');
    const key = name.id ?? `path:${stem}`;
    const item = itemFor(key, name.title, stem);
    item.parentKey = keyOfDir(dir);
    if (name.ext === 'csv') {
      item.kind = 'database';
      if (!item.csv || name.all) item.csv = path;
    } else if (!item.file || name.ext === 'md') {
      item.file = path;
    }
    byPath.set(path, item);
    // Links may name any of an item's files (Notion links `Title id.csv` even when the
    // export only has `Title id_all.csv`).
    for (const alias of ['md', 'html', 'csv'].flatMap((e) => [
      `${stem}.${e}`,
      `${stem}_all.${e}`,
    ])) {
      if (!byPath.has(alias)) byPath.set(alias, item);
    }
  }
  // HTML pages holding a database table are databases (Notion's HTML export).
  for (const item of items.values()) {
    if (item.kind === 'page' && item.file && /\.html?$/.test(item.file)) {
      const html = text(item.file);
      if (
        /class="[^"]*\b(collection-content|database)\b/.test(html) &&
        /<table[^>]*class="[^"]*\b(collection-content|database)\b/.test(html)
      ) {
        // Only when the table is the page itself (not an inline one with content around it).
        if (!/class="page-body"[^>]*>\s*<(p|h[1-3]|ul|ol)\b/.test(html)) item.kind = 'database';
      }
    }
  }
  // Folders without a page of their own become pages; parents that aren't there, too.
  for (const item of [...items.values()]) {
    let child = item;
    while (child.parentKey && !items.has(child.parentKey)) {
      const dir = child.file
        ? dirname(child.file)
        : child.csv
          ? dirname(child.csv)
          : dirname(child.dir);
      const folder = itemFor(
        child.parentKey,
        parseName(basename(dir)).title.replace(/ ?[0-9a-f]{32}$/i, '') || basename(dir),
        dir,
      );
      folder.parentKey = keyOfDir(dirname(dir));
      child = folder;
    }
  }
  // Pages in a database's folder are its rows.
  for (const item of items.values()) {
    const parent = item.parentKey ? items.get(item.parentKey) : null;
    if (parent?.kind === 'database' && item.kind === 'page') item.kind = 'row';
  }
  const depth = (item: Item): number => {
    let d = 0;
    for (let p = item.parentKey; p && d < 100; p = items.get(p)?.parentKey ?? null) d++;
    return d;
  };
  const ordered = [...items.values()].sort(
    (a, b) => depth(a) - depth(b) || a.dir.localeCompare(b.dir),
  );

  // --- Links and attachments --------------------------------------------------------------
  const stored = new Map<string, LinkTarget>();
  let storedFiles = 0;
  const linkFrom =
    (from: string) =>
    (href: string): LinkTarget | null => {
      const path = resolvePath(from, href.trim());
      if (path === null) return null;
      const item = byPath.get(path);
      if (item)
        return { kind: 'page', id: item.id, title: item.title, database: item.kind === 'database' };
      const cached = stored.get(path);
      if (cached) return cached;
      const bytes = files.get(path);
      if (!bytes) {
        return /\.[a-z0-9]{1,5}$/i.test(path) || path.includes('/') ? { kind: 'missing' } : null;
      }
      const name = basename(path);
      const fileId = target.storeFile(bytes, name, mimeOf(path));
      if (!fileId) return { kind: 'missing' };
      storedFiles++;
      const link: LinkTarget = { kind: 'file', fileId, name, media: mediaType(path) };
      stored.set(path, link);
      return link;
    };
  const contextFor = (from: string): ConvertContext => ({ link: linkFrom(from), warn });

  // --- Workspace pages ----------------------------------------------------------------------
  const rootId = createPage(target.workspace, {
    title: options.title,
    parentId: options.parentId ?? null,
  });
  const ws = target.workspace;
  ws.transact(() => {
    for (const item of ordered) {
      if (item.kind === 'row') continue;
      let parentId = rootId;
      for (let p = item.parentKey; p; p = items.get(p)?.parentKey ?? null) {
        const parent = items.get(p)!;
        if (parent.kind !== 'row') {
          parentId = parent.id;
          break;
        }
        // Sub-pages of a row go next to its database.
      }
      createPage(ws, {
        id: item.id,
        parentId,
        title: item.title || 'Untitled',
        kind: item.kind === 'database' ? 'database' : 'page',
      });
    }
  });

  // The import's page links to what it holds.
  const topLevel = ordered.filter(
    (item) => item.kind !== 'row' && (!item.parentKey || !items.has(item.parentKey)),
  );
  appendContent(
    target.doc(rootId),
    topLevel.map((item) => ({ type: 'pageLink', attrs: { pageId: item.id } })),
  );

  // --- Content --------------------------------------------------------------------------
  const total = ordered.length;
  let done = 0;
  let pages = 0;
  let rows = 0;
  const write = (id: string, blocks: JSONContent[]) => {
    if (!blocks.length) return;
    for (const type of appendContent(target.doc(id), blocks)) {
      warn(`Some “${type}” blocks couldn't be imported`);
    }
  };
  /** A page's file: its title, icon, cover and blocks. */
  const readPage = (item: Item, row: boolean) => {
    const file = item.file!;
    const ctx = contextFor(file);
    if (/\.html?$/.test(file)) {
      const page = notionHtmlPage(text(file), ctx);
      const cover = page.coverHref ? ctx.link(page.coverHref) : null;
      return {
        title: page.title,
        icon: page.icon,
        cover: cover?.kind === 'file' ? cover.fileId : null,
        blocks: page.blocks,
        table: page.database,
      };
    }
    if (/\.txt$/.test(file)) {
      const blocks = text(file)
        .replace(/\r\n?/g, '\n')
        .split(/\n{2,}/)
        .filter((p) => p.trim())
        .map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] }));
      return { title: null, icon: null, cover: null, blocks, table: null };
    }
    const page = notionMarkdownPage(text(file), ctx, { row });
    return { title: page.title, icon: null, cover: null, blocks: page.blocks, table: null };
  };

  for (const item of ordered) {
    if (item.kind === 'page') {
      if (item.file) {
        const page = readPage(item, false);
        if (page.title && page.title !== item.title) setPageTitle(ws, item.id, page.title);
        if (page.icon) setPageIcon(ws, item.id, page.icon);
        if (page.cover)
          setPageOptions(ws, item.id, {
            cover: { kind: 'file', value: page.cover, positionY: 50 },
          });
        write(item.id, page.blocks);
      }
      pages++;
      options.onProgress?.(++done, total);
    }
  }

  // --- Databases ----------------------------------------------------------------------------
  interface Plan {
    item: Item;
    doc: Y.Doc;
    columns: {
      name: string;
      type: PropertyType | 'formula' | 'rollup' | 'relation' | null;
      values: string[];
    }[];
    rowIds: string[];
    titles: string[];
    colors: Map<string, string>;
    /** Where row cells' relative links resolve from. */
    base: string;
  }
  const plans: Plan[] = [];
  for (const item of ordered) {
    if (item.kind !== 'database') continue;
    let header: HtmlColumn[] = [];
    let cells: string[][] = [];
    let hrefs: (string | null)[] = [];
    const colors = new Map<string, string>();
    let base = item.csv ?? item.file ?? item.dir;
    if (item.csv) {
      const table = parseCsv(text(item.csv));
      header = (table[0] ?? ['Name']).map((name) => ({ name, type: null }));
      cells = table.slice(1);
      hrefs = cells.map(() => null);
    } else if (item.file) {
      const page = readPage(item, false);
      if (page.icon) setPageIcon(ws, item.id, page.icon);
      if (page.title && page.title !== item.title) setPageTitle(ws, item.id, page.title);
      header = page.table?.columns ?? [{ name: 'Name', type: 'title' }];
      cells = page.table?.rows.map((r) => r.cells) ?? [];
      hrefs = page.table?.rows.map((r) => r.href) ?? [];
      page.table?.rows.forEach((r) => r.colors.forEach((c, v) => colors.set(v, c)));
      base = item.file;
    }
    // Match rows with their pages: by link (HTML), else by title in order.
    const rowItems = ordered.filter((r) => r.kind === 'row' && r.parentKey === item.key);
    const unused = new Set(rowItems);
    const rowIds = cells.map((row, i) => {
      const href = hrefs[i];
      const linked = href ? byPath.get(resolvePath(base, href) ?? '') : undefined;
      const match =
        (linked && unused.has(linked) ? linked : undefined) ??
        rowItems.find((r) => unused.has(r) && norm(r.title) === norm(row[0] ?? ''));
      if (match) {
        unused.delete(match);
        return match.id;
      }
      return newId();
    });
    // Row pages with no line in the table still become rows.
    for (const extra of unused) {
      cells.push([extra.title]);
      rowIds.push(extra.id);
    }
    const columns = header.map((column, c) => ({
      name: column.name || `Column ${c + 1}`,
      type: c === 0 ? ('title' as const) : column.type,
      values: cells.map((row) => row[c] ?? ''),
    }));
    const doc = target.doc(item.id);
    initDatabase(doc, { databaseId: item.id });
    plans.push({ item, doc, columns, rowIds, titles: cells.map((r) => r[0] ?? ''), colors, base });
  }

  // Relations: columns whose values are rows of another imported database.
  const titleIndex = new Map(
    plans.map((p) => [p.item.id, new Map(p.titles.map((t, i) => [norm(t), p.rowIds[i]!]))]),
  );
  const relationOf = (plan: Plan, column: Plan['columns'][number]): Plan | null => {
    if (column.type && column.type !== 'relation') return null;
    const filled = column.values.filter((v) => v.trim());
    if (!filled.length) return null;
    const notionStyle = filled.some((v) => /\.(md|html)\)/.test(v));
    for (const other of plans) {
      const titles = titleIndex.get(other.item.id)!;
      const all = filled.every((v) =>
        relationTokens(v).every(
          (t) =>
            titles.has(norm(t.title)) ||
            (t.path &&
              byPath.get(resolvePath(plan.base, t.path) ?? '')?.parentKey === other.item.key),
        ),
      );
      if (!all) continue;
      const named =
        singular(column.name) === singular(other.item.title) ||
        other.columns.some((c) => singular(c.name) === singular(plan.item.title));
      if (notionStyle || named || column.type === 'relation') return other;
    }
    return null;
  };

  const resolve = (id: string) => plans.find((p) => p.item.id === id)?.doc;
  for (const plan of plans) {
    const { doc } = plan;
    doc.transact(() => {
      for (const p of readDatabase(doc).properties) {
        if (p.id !== TITLE_PROPERTY_ID) deleteProperty(doc, p.id);
      }
      renameProperty(doc, TITLE_PROPERTY_ID, plan.columns[0]?.name || 'Name');
    });
  }
  // Properties (relations last, once every database has its rows).
  const columnProperties = new Map<Plan, (Property | null)[]>();
  const relationColumns: { plan: Plan; column: Plan['columns'][number]; target: Plan }[] = [];
  for (const plan of plans) {
    const { doc } = plan;
    const ids: (Property | null)[] = [];
    columnProperties.set(plan, ids);
    doc.transact(() => {
      plan.columns.forEach((column, c) => {
        if (c === 0) {
          ids.push(readDatabase(doc).properties.find((p) => p.id === TITLE_PROPERTY_ID)!);
          return;
        }
        const relation = relationOf(plan, column);
        if (relation) {
          relationColumns.push({ plan, column, target: relation });
          ids.push(null);
          return;
        }
        let type = (column.type ?? inferType(column.values)) as
          PropertyType | 'formula' | 'rollup' | 'relation';
        if (type === 'formula' || type === 'rollup' || type === 'relation') {
          warn(`“${column.name}” in “${plan.item.title}” (a ${type}) was imported as text`);
          type = 'text';
        }
        let config: PropertyConfig | undefined;
        if (type === 'select' || type === 'multiSelect' || type === 'status') {
          const names = [
            ...new Set(
              column.values.flatMap((v) =>
                type === 'multiSelect' ? splitList(v) : v.trim() ? [v.trim()] : [],
              ),
            ),
          ];
          const base =
            type === 'status' ? (propertyKind('status').defaultConfig().options ?? []) : [];
          const options: SelectOption[] = [...base];
          names.forEach((name) => {
            if (options.some((o) => o.name === name)) return;
            options.push({
              id: newId(),
              name,
              color:
                (plan.colors.get(name) as SelectOption['color']) ??
                COLORS[options.length % COLORS.length]!,
              ...(type === 'status' ? { group: 'todo' as const } : {}),
            });
          });
          config = { options };
        }
        const id = addProperty(doc, { name: column.name, type: type as PropertyType, config });
        ids.push(readDatabase(doc).properties.find((p) => p.id === id)!);
      });
      const display = { users: new Map<string, string>() };
      plan.rowIds.forEach((rowId, r) => {
        const values: Record<string, unknown> = {};
        plan.columns.forEach((column, c) => {
          const property = ids[c];
          const raw = column.values[r]?.trim() ?? '';
          if (!property || c === 0 || !raw) return;
          let value: unknown;
          if (property.type === 'number') value = parseNumber(raw);
          else if (property.type === 'checkbox') value = /^(yes|true|1|x|✓)$/i.test(raw);
          else value = propertyKind(property.type).parse(raw, property, display).value;
          if (value !== null && value !== undefined) values[property.id] = value;
        });
        addRow(doc, { actor: null, id: rowId, title: plan.titles[r] ?? '', values });
        rows++;
      });
    });
  }
  const paired = new Set<Plan['columns'][number]>();
  for (const { plan, column, target: other } of relationColumns) {
    if (paired.has(column)) continue;
    // The other side, if it's there: a relation column back to this database.
    const back = relationColumns.find(
      (r) => r.plan === other && r.target === plan && !paired.has(r.column) && r.column !== column,
    );
    if (back) paired.add(back.column);
    paired.add(column);
    // In the column's place: after the property of the column before it.
    const props = columnProperties.get(plan)!;
    const at = plan.columns.indexOf(column);
    const afterId = props
      .slice(0, at)
      .reverse()
      .find((p) => p)?.id;
    const { propertyId } = createRelation(resolve, {
      afterId,
      databaseId: plan.item.id,
      name: column.name,
      targetId: other.item.id,
      twoWay: back ? { name: back.column.name } : null,
    });
    props[at] = readDatabase(plan.doc).properties.find((p) => p.id === propertyId) ?? null;
    const titles = titleIndex.get(other.item.id)!;
    plan.rowIds.forEach((rowId, r) => {
      const linked = relationTokens(column.values[r] ?? '')
        .map((t) => {
          const byFile = t.path ? byPath.get(resolvePath(plan.base, t.path) ?? '') : undefined;
          return byFile && other.rowIds.includes(byFile.id) ? byFile.id : titles.get(norm(t.title));
        })
        .filter((id): id is string => Boolean(id));
      if (linked.length) setRelation(resolve, plan.item.id, rowId, propertyId, linked, null);
    });
  }

  // Row pages' content.
  for (const plan of plans) {
    for (const item of ordered) {
      if (item.kind !== 'row' || item.parentKey !== plan.item.key || !item.file) continue;
      write(item.id, readPage(item, true).blocks);
    }
    options.onProgress?.(++done, total);
  }
  for (const item of ordered) if (item.kind === 'row') options.onProgress?.(++done, total);

  return {
    rootId,
    pages,
    databases: plans.length,
    rows,
    files: storedFiles,
    warnings: [...warnings],
  };
}
