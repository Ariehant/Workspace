/**
 * Page content in Notion's JSON, both ways (Phase 6 M6). Content here is the editor's
 * ProseMirror document (read from the page doc as JSON); Notion's is a list of blocks,
 * each with its rich text and its children.
 *
 * - **Out:** lists are taken apart into their items (`bulleted_list_item`…), a toggle
 *   with a heading level is a toggleable heading, the first paragraph of a quote or a
 *   callout is its text, and a table's rows are `table_row` blocks. What has no Notion
 *   counterpart (buttons) reads as `unsupported`.
 * - **In:** the reverse: list items next to each other make one list. A paragraph's
 *   children (paragraphs can't nest here) come after it.
 *
 * Block ids are the editor's (`id` on every block node). Rows of a table have none, so
 * theirs are made from the table's id and their place.
 */
import { invalid } from './errors';
import { parseId } from './ids';
import { MAX_TEXT, type Annotations } from './rich-text';

/** A ProseMirror node as JSON (`yXmlFragmentToProsemirrorJSON`, `appendContent`). */
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export type RichItem = {
  type: 'text' | 'mention' | 'equation';
  annotations: Annotations;
  plain_text: string;
  href: string | null;
  text?: { content: string; link: { url: string } | null };
  mention?: Record<string, unknown>;
  equation?: { expression: string };
};

export interface BlockContext {
  /** A stored file's URL, and when it stops working. */
  fileUrl(id: string, name: string): { url: string; expiry_time: string };
  /** A page's title (mentions, child databases), if known. */
  pageTitle(id: string): string | null;
  /** A person's name (mentions), if known. */
  userName(id: string): string | null;
  pageUrl(id: string): string;
}

/** A block as the API shows it, with its children (already as API blocks). */
export interface ApiBlock {
  id: string;
  type: string;
  value: Record<string, unknown>;
  children: ApiBlock[];
}

// --- Rich text out ----------------------------------------------------------------------

const PLAIN: Annotations = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
};

function annotationsOf(marks: PMNode['marks']): { a: Annotations; href: string | null } {
  const a = { ...PLAIN };
  let href: string | null = null;
  for (const m of marks ?? []) {
    if (m.type === 'bold') a.bold = true;
    else if (m.type === 'italic') a.italic = true;
    else if (m.type === 'strike') a.strikethrough = true;
    else if (m.type === 'underline') a.underline = true;
    else if (m.type === 'code') a.code = true;
    else if (m.type === 'color' && typeof m.attrs?.color === 'string') a.color = m.attrs.color;
    else if (m.type === 'link' && typeof m.attrs?.href === 'string') href = m.attrs.href;
  }
  return { a, href };
}

const textItem = (content: string, a: Annotations, href: string | null): RichItem => ({
  type: 'text',
  text: { content, link: href ? { url: href } : null },
  annotations: a,
  plain_text: content,
  href,
});

/** Inline content (text with marks, mentions, equations, line breaks) as rich text. */
export function richTextOut(inline: readonly PMNode[] | undefined, ctx: BlockContext): RichItem[] {
  const out: RichItem[] = [];
  const pushText = (content: string, a: Annotations, href: string | null) => {
    for (let i = 0; i < content.length; i += MAX_TEXT) {
      out.push(textItem(content.slice(i, i + MAX_TEXT), a, href));
    }
  };
  for (const node of inline ?? []) {
    if (node.type === 'text' && node.text) {
      const { a, href } = annotationsOf(node.marks);
      pushText(node.text, a, href);
    } else if (node.type === 'hardBreak') {
      pushText('\n', { ...PLAIN }, null);
    } else if (node.type === 'inlineMath') {
      const latex = String(node.attrs?.latex ?? '');
      out.push({
        type: 'equation',
        equation: { expression: latex },
        annotations: annotationsOf(node.marks).a,
        plain_text: latex,
        href: null,
      });
    } else if (node.type === 'mention') {
      const attrs = node.attrs ?? {};
      const a = annotationsOf(node.marks).a;
      if (attrs.kind === 'page' && typeof attrs.pageId === 'string') {
        out.push({
          type: 'mention',
          mention: { type: 'page', page: { id: attrs.pageId } },
          annotations: a,
          plain_text: ctx.pageTitle(attrs.pageId) ?? 'Untitled',
          href: ctx.pageUrl(attrs.pageId),
        });
      } else if (attrs.kind === 'user' && typeof attrs.userId === 'string') {
        out.push({
          type: 'mention',
          mention: { type: 'user', user: { object: 'user', id: attrs.userId } },
          annotations: a,
          plain_text: `@${ctx.userName(attrs.userId) ?? 'Someone'}`,
          href: null,
        });
      } else if (attrs.kind === 'date' && typeof attrs.date === 'string') {
        out.push({
          type: 'mention',
          mention: { type: 'date', date: { start: attrs.date, end: null, time_zone: null } },
          annotations: a,
          plain_text: attrs.date,
          href: null,
        });
      }
    }
  }
  return out;
}

const plainOf = (inline: readonly PMNode[] | undefined): string =>
  (inline ?? [])
    .map((n) => (n.type === 'text' ? (n.text ?? '') : n.type === 'hardBreak' ? '\n' : ''))
    .join('');

// --- Rich text in -----------------------------------------------------------------------

export interface WriteContext {
  /** Is this someone (mentions of people)? */
  isUser(id: string): boolean;
}

const asObject = (v: unknown, where: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw invalid(`${where} should be an object.`);
  return v as Record<string, unknown>;
};

const COLORS = new Set([
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
  ...['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'].map(
    (c) => `${c}_background`,
  ),
]);

function marksIn(raw: unknown, where: string, href: string | null): PMNode['marks'] {
  const marks: NonNullable<PMNode['marks']> = [];
  if (raw !== undefined) {
    const a = asObject(raw, `${where}.annotations`);
    if (a.bold === true) marks.push({ type: 'bold' });
    if (a.italic === true) marks.push({ type: 'italic' });
    if (a.strikethrough === true) marks.push({ type: 'strike' });
    if (a.underline === true) marks.push({ type: 'underline' });
    if (a.code === true) marks.push({ type: 'code' });
    if (typeof a.color === 'string' && a.color !== 'default') {
      if (!COLORS.has(a.color)) throw invalid(`${where}.annotations.color isn't a color.`);
      marks.push({ type: 'color', attrs: { color: a.color } });
    }
  }
  if (href) marks.push({ type: 'link', attrs: { href } });
  return marks.length ? marks : undefined;
}

/** Rich text sent in, as inline content. */
export function richTextIn(raw: unknown, where: string, ctx: WriteContext): PMNode[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw invalid(`${where} should be an array of rich text.`);
  if (raw.length > 100) throw invalid(`${where} should have at most 100 items.`);
  const out: PMNode[] = [];
  raw.forEach((item, i) => {
    const at = `${where}[${i}]`;
    const o = asObject(item, at);
    const type =
      o.type ?? (o.text ? 'text' : o.mention ? 'mention' : o.equation ? 'equation' : undefined);
    if (type === 'text') {
      const t = asObject(o.text, `${at}.text`);
      if (typeof t.content !== 'string') throw invalid(`${at}.text.content should be a string.`);
      if (t.content.length > MAX_TEXT)
        throw invalid(`${at}.text.content.length should be ≤ ${MAX_TEXT}.`);
      const link =
        t.link === null || t.link === undefined ? null : asObject(t.link, `${at}.text.link`).url;
      if (
        link !== null &&
        (typeof link !== 'string' || !/^(https?:|mailto:|workspace:)/.test(link))
      ) {
        throw invalid(`${at}.text.link.url should be a web address.`);
      }
      const marks = marksIn(o.annotations, at, link as string | null);
      t.content.split('\n').forEach((part, n) => {
        if (n > 0) out.push({ type: 'hardBreak' });
        if (part) out.push({ type: 'text', text: part, ...(marks && { marks }) });
      });
    } else if (type === 'equation') {
      const e = asObject(o.equation, `${at}.equation`);
      if (typeof e.expression !== 'string')
        throw invalid(`${at}.equation.expression should be a string.`);
      out.push({ type: 'inlineMath', attrs: { latex: e.expression } });
    } else if (type === 'mention') {
      const m = asObject(o.mention, `${at}.mention`);
      const kind = m.type ?? (m.page ? 'page' : m.user ? 'user' : m.date ? 'date' : undefined);
      if (kind === 'page' || kind === 'database') {
        const id = parseId(asObject(m[kind], `${at}.mention.${kind}`).id);
        if (!id) throw invalid(`${at}.mention.${kind}.id should be a valid uuid.`);
        out.push({ type: 'mention', attrs: { kind: 'page', pageId: id } });
      } else if (kind === 'user') {
        const id = parseId(asObject(m.user, `${at}.mention.user`).id);
        if (!id || !ctx.isUser(id))
          throw invalid(`${at}.mention.user.id should be a user of the workspace.`);
        out.push({ type: 'mention', attrs: { kind: 'user', userId: id } });
      } else if (kind === 'date') {
        const start = asObject(m.date, `${at}.mention.date`).start;
        if (typeof start !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(start)) {
          throw invalid(`${at}.mention.date.start should be an ISO 8601 date.`);
        }
        out.push({
          type: 'mention',
          attrs: { kind: 'date', date: start.slice(0, 10), reminder: false },
        });
      } else throw invalid(`${at}.mention should be a page, database, user or date mention.`);
    } else throw invalid(`${at}.type should be "text", "mention" or "equation".`);
  });
  return out;
}

// --- Code languages -------------------------------------------------------------------

const LANGUAGES_OUT: Record<string, string> = {
  '': 'plain text',
  plaintext: 'plain text',
  text: 'plain text',
  cpp: 'c++',
  csharp: 'c#',
  fsharp: 'f#',
  objectivec: 'objective-c',
  vbnet: 'visual basic',
  sh: 'shell',
  js: 'javascript',
  ts: 'typescript',
};
const LANGUAGES_IN = new Map(Object.entries(LANGUAGES_OUT).map(([ours, theirs]) => [theirs, ours]));
LANGUAGES_IN.set('plain text', '');

export const languageOut = (ours: unknown) => {
  const id = typeof ours === 'string' ? ours.toLowerCase() : '';
  return LANGUAGES_OUT[id] ?? id;
};
export const languageIn = (theirs: unknown) => {
  const name = typeof theirs === 'string' ? theirs.toLowerCase() : 'plain text';
  return LANGUAGES_IN.get(name) ?? name.replace(/[^a-z0-9+#-]/g, '');
};

// --- Blocks out -------------------------------------------------------------------------

/** A stable id from a parent id and a position (table rows have none of their own). */
export function derivedId(parent: string, index: number): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = `${parent}:${index}`;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  const p = parent.replace(/-/g, '').slice(0, 16).padEnd(16, '0');
  const all = `${p}${hex(h1)}${hex(h2)}`;
  return `${all.slice(0, 8)}-${all.slice(8, 12)}-8${all.slice(13, 16)}-9${all.slice(17, 20)}-${all.slice(20, 32)}`;
}

const idOf = (node: PMNode) => (typeof node.attrs?.id === 'string' ? node.attrs.id : '');
const colorOf = (node: PMNode) =>
  typeof node.attrs?.color === 'string' && node.attrs.color ? node.attrs.color : 'default';

function fileValue(node: PMNode, ctx: BlockContext) {
  const a = node.attrs ?? {};
  const name = typeof a.name === 'string' ? a.name : '';
  const caption = richTextOut(
    typeof a.caption === 'string' && a.caption ? [{ type: 'text', text: a.caption }] : [],
    ctx,
  );
  if (typeof a.fileId === 'string' && a.fileId) {
    return { type: 'file', file: ctx.fileUrl(a.fileId, name), caption, name };
  }
  return {
    type: 'external',
    external: { url: typeof a.src === 'string' ? a.src : '' },
    caption,
    name,
  };
}

/** The first paragraph's text, and the rest as children (quotes, callouts, list items). */
function split(node: PMNode, ctx: BlockContext) {
  const [first, ...rest] = node.content ?? [];
  if (first?.type === 'paragraph') {
    return { rich: richTextOut(first.content, ctx), children: blocksOut(rest, ctx) };
  }
  return { rich: [], children: blocksOut(node.content ?? [], ctx) };
}

function block(
  id: string,
  type: string,
  value: Record<string, unknown>,
  children: ApiBlock[] = [],
): ApiBlock {
  return { id, type, value, children };
}

/** Content as API blocks (lists taken apart into their items). */
export function blocksOut(nodes: readonly PMNode[], ctx: BlockContext): ApiBlock[] {
  const out: ApiBlock[] = [];
  for (const node of nodes) {
    const id = idOf(node);
    switch (node.type) {
      case 'paragraph':
        out.push(
          block(id, 'paragraph', {
            rich_text: richTextOut(node.content, ctx),
            color: colorOf(node),
          }),
        );
        break;
      case 'heading': {
        const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1));
        out.push(
          block(id, `heading_${level}`, {
            rich_text: richTextOut(node.content, ctx),
            is_toggleable: false,
            color: colorOf(node),
          }),
        );
        break;
      }
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        for (const item of node.content ?? []) {
          const { rich, children } = split(item, ctx);
          const itemId = idOf(item);
          if (node.type === 'taskList') {
            out.push(
              block(
                itemId,
                'to_do',
                { rich_text: rich, checked: item.attrs?.checked === true, color: colorOf(node) },
                children,
              ),
            );
          } else {
            const type = node.type === 'bulletList' ? 'bulleted_list_item' : 'numbered_list_item';
            out.push(block(itemId, type, { rich_text: rich, color: colorOf(node) }, children));
          }
        }
        break;
      case 'blockquote': {
        const { rich, children } = split(node, ctx);
        out.push(block(id, 'quote', { rich_text: rich, color: colorOf(node) }, children));
        break;
      }
      case 'callout': {
        const { rich, children } = split(node, ctx);
        const icon =
          typeof node.attrs?.icon === 'string' && node.attrs.icon
            ? { type: 'emoji', emoji: node.attrs.icon }
            : null;
        out.push(block(id, 'callout', { rich_text: rich, icon, color: colorOf(node) }, children));
        break;
      }
      case 'details': {
        const summary = node.content?.find((c) => c.type === 'detailsSummary');
        const body = node.content?.find((c) => c.type === 'detailsContent');
        const level = Number(summary?.attrs?.level) || 0;
        const rich = richTextOut(summary?.content, ctx);
        const children = blocksOut(body?.content ?? [], ctx);
        if (level >= 1 && level <= 3) {
          out.push(
            block(
              id,
              `heading_${level}`,
              { rich_text: rich, is_toggleable: true, color: colorOf(node) },
              children,
            ),
          );
        } else out.push(block(id, 'toggle', { rich_text: rich, color: colorOf(node) }, children));
        break;
      }
      case 'codeBlock': {
        const caption = typeof node.attrs?.caption === 'string' ? node.attrs.caption : '';
        out.push(
          block(id, 'code', {
            rich_text: richTextOut([{ type: 'text', text: plainOf(node.content) }], ctx),
            caption: richTextOut(caption ? [{ type: 'text', text: caption }] : [], ctx),
            language: languageOut(node.attrs?.language),
          }),
        );
        break;
      }
      case 'horizontalRule':
        out.push(block(id, 'divider', {}));
        break;
      case 'blockMath':
        out.push(block(id, 'equation', { expression: String(node.attrs?.latex ?? '') }));
        break;
      case 'table': {
        const rows = node.content ?? [];
        const width = Math.max(0, ...rows.map((r) => r.content?.length ?? 0));
        const header =
          (rows[0]?.content ?? []).length > 0 &&
          (rows[0]?.content ?? []).every((c) => c.type === 'tableHeader');
        const children = rows.map((row, i) =>
          block(derivedId(id, i), 'table_row', {
            cells: (row.content ?? []).map((cell) =>
              richTextOut(
                (cell.content ?? []).flatMap((p, n) => [
                  ...(n > 0 ? [{ type: 'hardBreak' }] : []),
                  ...(p.content ?? []),
                ]),
                ctx,
              ),
            ),
          }),
        );
        out.push(
          block(
            id,
            'table',
            { table_width: width, has_column_header: header, has_row_header: false },
            children,
          ),
        );
        break;
      }
      case 'columnList':
        out.push(
          block(
            id,
            'column_list',
            {},
            (node.content ?? []).map((col) =>
              block(idOf(col), 'column', {}, blocksOut(col.content ?? [], ctx)),
            ),
          ),
        );
        break;
      case 'pageLink':
        out.push(
          block(id, 'link_to_page', { type: 'page_id', page_id: String(node.attrs?.pageId ?? '') }),
        );
        break;
      case 'database': {
        const dbId = String(node.attrs?.pageId ?? '');
        out.push(
          block(id, 'child_database', { title: ctx.pageTitle(dbId) ?? '', database_id: dbId }),
        );
        break;
      }
      case 'linkedDatabase':
        out.push(
          block(id, 'link_to_page', {
            type: 'database_id',
            database_id: String(node.attrs?.databaseId ?? ''),
          }),
        );
        break;
      case 'syncedBlock':
        out.push(
          block(id, 'synced_block', {
            synced_from: { type: 'block_id', block_id: String(node.attrs?.syncedId ?? '') },
          }),
        );
        break;
      case 'breadcrumb':
        out.push(block(id, 'breadcrumb', {}));
        break;
      case 'tableOfContents':
        out.push(block(id, 'table_of_contents', { color: 'default' }));
        break;
      case 'image':
      case 'video':
      case 'audio':
      case 'pdf':
      case 'file':
        out.push(block(id, node.type, fileValue(node, ctx)));
        break;
      case 'bookmark': {
        const title = typeof node.attrs?.title === 'string' ? node.attrs.title : '';
        out.push(
          block(id, 'bookmark', {
            url: String(node.attrs?.url ?? ''),
            caption: richTextOut(title ? [{ type: 'text', text: title }] : [], ctx),
          }),
        );
        break;
      }
      case 'embed':
        out.push(block(id, 'embed', { url: String(node.attrs?.url ?? ''), caption: [] }));
        break;
      default:
        out.push(block(id, 'unsupported', {}));
    }
  }
  return out;
}

/** A block anywhere in a tree of API blocks, and its parent's id (null: top level). */
export function findBlock(
  blocks: readonly ApiBlock[],
  id: string,
  parent: string | null = null,
): { block: ApiBlock; parent: string | null } | null {
  for (const b of blocks) {
    if (b.id === id) return { block: b, parent };
    const inner = findBlock(b.children, id, b.id);
    if (inner) return inner;
  }
  return null;
}

/** A block's JSON (Notion's block object, without the common fields the caller adds). */
export const blockValue = (b: ApiBlock) => ({
  type: b.type,
  has_children: b.children.length > 0,
  [b.type]: b.value,
});

// --- Blocks in --------------------------------------------------------------------------

/** Limits per request, as Notion's. */
export const MAX_BLOCKS = 100;
export const MAX_ELEMENTS = 1000;
const MAX_DEPTH = 2;

interface Counter {
  n: number;
}

const paragraph = (inline: PMNode[], color?: string): PMNode => ({
  type: 'paragraph',
  attrs: { ...(color && color !== 'default' && { color }) },
  ...(inline.length && { content: inline }),
});

function colorIn(value: Record<string, unknown>, where: string): string | undefined {
  const c = value.color;
  if (c === undefined || c === 'default') return undefined;
  if (typeof c !== 'string' || !COLORS.has(c)) throw invalid(`${where}.color isn't a color.`);
  return c;
}

function fileIn(
  type: string,
  value: Record<string, unknown>,
  where: string,
  ctx: WriteContext,
): PMNode {
  const ext = value.external as { url?: unknown } | undefined;
  const url = ext?.url;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url) || url.length > 2000) {
    throw invalid(`${where}.external.url should be an http(s) URL (uploads aren't supported).`);
  }
  const caption = richTextIn(value.caption, `${where}.caption`, ctx)
    .map((n) => n.text ?? '')
    .join('');
  const name = typeof value.name === 'string' ? value.name : (url.split('/').pop() ?? '');
  return { type, attrs: { src: url, name, ...(caption && { caption }) } };
}

/** Blocks sent in, as editor nodes (list items next to each other become one list). */
export function blocksIn(
  raw: unknown,
  where: string,
  ctx: WriteContext,
  depth = 0,
  count: Counter = { n: 0 },
): PMNode[] {
  if (!Array.isArray(raw)) throw invalid(`${where} should be an array of blocks.`);
  if (raw.length > MAX_BLOCKS) throw invalid(`${where} should have at most ${MAX_BLOCKS} blocks.`);
  const out: PMNode[] = [];
  const pushItem = (list: 'bulletList' | 'orderedList' | 'taskList', item: PMNode) => {
    const last = out[out.length - 1];
    if (last?.type === list) last.content!.push(item);
    else out.push({ type: list, content: [item] });
  };
  raw.forEach((item, i) => {
    const at = `${where}[${i}]`;
    count.n++;
    if (count.n > MAX_ELEMENTS) throw invalid(`body has more than ${MAX_ELEMENTS} block elements.`);
    const o = asObject(item, at);
    const type =
      typeof o.type === 'string'
        ? o.type
        : Object.keys(o).find((k) => k !== 'object' && k !== 'children');
    if (!type) throw invalid(`${at} should have a block type.`);
    const value = o[type] === undefined ? {} : asObject(o[type], `${at}.${type}`);
    const childrenRaw = value.children ?? o.children;
    const kids = (): PMNode[] => {
      if (childrenRaw === undefined) return [];
      if (depth + 1 > MAX_DEPTH)
        throw invalid(`${at}: blocks nest at most ${MAX_DEPTH} levels deep in one request.`);
      return blocksIn(childrenRaw, `${at}.${type}.children`, ctx, depth + 1, count);
    };
    const rich = () => richTextIn(value.rich_text, `${at}.${type}.rich_text`, ctx);
    const color = () => colorIn(value, `${at}.${type}`);
    switch (type) {
      case 'paragraph':
        out.push(paragraph(rich(), color()), ...kids());
        break;
      case 'heading_1':
      case 'heading_2':
      case 'heading_3': {
        const level = Number(type.slice(-1));
        const c = color();
        if (value.is_toggleable === true) {
          const inner = kids();
          out.push({
            type: 'details',
            attrs: { ...(c && { color: c }) },
            content: [
              {
                type: 'detailsSummary',
                attrs: { level },
                content: rich().filter((n) => n.type === 'text'),
              },
              { type: 'detailsContent', content: inner.length ? inner : [paragraph([])] },
            ],
          });
        } else {
          out.push(
            {
              type: 'heading',
              attrs: { level, ...(c && { color: c }) },
              ...(rich().length && { content: rich() }),
            },
            ...kids(),
          );
        }
        break;
      }
      case 'bulleted_list_item':
      case 'numbered_list_item':
        pushItem(type === 'bulleted_list_item' ? 'bulletList' : 'orderedList', {
          type: 'listItem',
          content: [paragraph(rich()), ...kids()],
        });
        break;
      case 'to_do':
        pushItem('taskList', {
          type: 'taskItem',
          attrs: { checked: value.checked === true },
          content: [paragraph(rich()), ...kids()],
        });
        break;
      case 'toggle': {
        const inner = kids();
        const c = color();
        out.push({
          type: 'details',
          attrs: { ...(c && { color: c }) },
          content: [
            { type: 'detailsSummary', content: rich().filter((n) => n.type === 'text') },
            { type: 'detailsContent', content: inner.length ? inner : [paragraph([])] },
          ],
        });
        break;
      }
      case 'quote':
      case 'callout': {
        const c = color();
        const icon = (value.icon as { emoji?: unknown } | null | undefined)?.emoji;
        out.push({
          type: type === 'quote' ? 'blockquote' : 'callout',
          attrs: {
            ...(c && { color: c }),
            ...(type === 'callout' && { icon: typeof icon === 'string' ? icon : '💡' }),
          },
          content: [paragraph(rich()), ...kids()],
        });
        break;
      }
      case 'code': {
        const text = rich()
          .map((n) => (n.type === 'hardBreak' ? '\n' : (n.text ?? '')))
          .join('');
        const caption = richTextIn(value.caption, `${at}.code.caption`, ctx)
          .map((n) => n.text ?? '')
          .join('');
        out.push({
          type: 'codeBlock',
          attrs: { language: languageIn(value.language), ...(caption && { caption }) },
          ...(text && { content: [{ type: 'text', text }] }),
        });
        break;
      }
      case 'divider':
        out.push({ type: 'horizontalRule' });
        break;
      case 'equation': {
        if (typeof value.expression !== 'string')
          throw invalid(`${at}.equation.expression should be a string.`);
        out.push({ type: 'blockMath', attrs: { latex: value.expression } });
        break;
      }
      case 'table': {
        const rows = childrenRaw;
        if (!Array.isArray(rows) || rows.length === 0)
          throw invalid(`${at}.table.children should be table rows.`);
        const width = Number(value.table_width);
        const header = value.has_column_header === true;
        out.push({
          type: 'table',
          content: rows.map((r, n) => {
            const row = asObject(r, `${at}.table.children[${n}]`);
            const cells = asObject(row.table_row, `${at}.table.children[${n}].table_row`).cells;
            if (!Array.isArray(cells))
              throw invalid(`${at}.table.children[${n}].table_row.cells should be an array.`);
            if (Number.isInteger(width) && width > 0 && cells.length !== width) {
              throw invalid(
                `${at}.table.children[${n}]: each row should have table_width (${width}) cells.`,
              );
            }
            count.n++;
            return {
              type: 'tableRow',
              content: cells.map((cell, c) => ({
                type: header && n === 0 ? 'tableHeader' : 'tableCell',
                content: [
                  paragraph(
                    richTextIn(cell, `${at}.table.children[${n}].table_row.cells[${c}]`, ctx),
                  ),
                ],
              })),
            };
          }),
        });
        break;
      }
      case 'column_list': {
        const cols = childrenRaw;
        if (!Array.isArray(cols) || cols.length < 2)
          throw invalid(`${at}.column_list.children should be at least two columns.`);
        if (depth + 1 > MAX_DEPTH)
          throw invalid(`${at}: blocks nest at most ${MAX_DEPTH} levels deep in one request.`);
        out.push({
          type: 'columnList',
          content: cols.map((c, n) => {
            const col = asObject(c, `${at}.column_list.children[${n}]`);
            const inner = blocksIn(
              (col.column as { children?: unknown } | undefined)?.children ?? col.children ?? [],
              `${at}.column_list.children[${n}].column.children`,
              ctx,
              depth + 1,
              count,
            );
            return { type: 'column', content: inner.length ? inner : [paragraph([])] };
          }),
        });
        break;
      }
      case 'link_to_page': {
        const id = parseId(value.page_id ?? value.database_id);
        if (!id) throw invalid(`${at}.link_to_page should have a page_id or database_id.`);
        out.push(
          value.database_id
            ? { type: 'linkedDatabase', attrs: { databaseId: id, viewSet: id } }
            : { type: 'pageLink', attrs: { pageId: id } },
        );
        break;
      }
      case 'breadcrumb':
        out.push({ type: 'breadcrumb' });
        break;
      case 'table_of_contents':
        out.push({ type: 'tableOfContents' });
        break;
      case 'image':
      case 'video':
      case 'audio':
      case 'pdf':
      case 'file':
        out.push(fileIn(type, value, `${at}.${type}`, ctx));
        break;
      case 'bookmark':
      case 'embed': {
        const url = value.url;
        if (typeof url !== 'string' || !/^https?:\/\//.test(url))
          throw invalid(`${at}.${type}.url should be an http(s) URL.`);
        out.push(
          type === 'bookmark'
            ? { type: 'bookmark', attrs: { url, title: '' } }
            : { type: 'embed', attrs: { url } },
        );
        break;
      }
      case 'child_page':
      case 'child_database':
        throw invalid(
          `${at}: make ${type === 'child_page' ? 'pages with POST /v1/pages' : 'databases with POST /v1/databases'}.`,
        );
      default:
        throw invalid(`${at}.type "${type}" can't be added through the API.`);
    }
  });
  return out;
}

// --- Updating one block -----------------------------------------------------------------

/** What a block update changes: its text and its settings (the block keeps its children). */
export interface BlockChange {
  /** New inline content for the block's text (absent: unchanged). */
  inline?: PMNode[];
  /** Attributes to set on the block node (or, for list items, on the item). */
  attrs?: Record<string, unknown>;
}

/** An update sent for a block of API type `type` (`{<type>: {...}}`). */
export function blockChangeIn(
  type: string,
  body: Record<string, unknown>,
  ctx: WriteContext,
): BlockChange {
  const value = body[type];
  if (value === undefined) return {};
  const v = asObject(value, `body.${type}`);
  const change: BlockChange = {};
  if (v.rich_text !== undefined) {
    change.inline = richTextIn(v.rich_text, `body.${type}.rich_text`, ctx);
    if (type === 'code') {
      const text = change.inline
        .map((n) => (n.type === 'hardBreak' ? '\n' : (n.text ?? '')))
        .join('');
      change.inline = text ? [{ type: 'text', text }] : [];
    }
  }
  const attrs: Record<string, unknown> = {};
  if (v.color !== undefined) attrs.color = colorIn(v, `body.${type}`) ?? null;
  if (type === 'to_do' && v.checked !== undefined) {
    if (typeof v.checked !== 'boolean') throw invalid(`body.to_do.checked should be a boolean.`);
    attrs.checked = v.checked;
  }
  if (type === 'code' && v.language !== undefined) attrs.language = languageIn(v.language);
  if (type === 'callout' && v.icon !== undefined) {
    const emoji = (v.icon as { emoji?: unknown } | null)?.emoji;
    if (typeof emoji !== 'string') throw invalid('body.callout.icon should be an emoji.');
    attrs.icon = emoji;
  }
  if (type === 'equation' && v.expression !== undefined) {
    if (typeof v.expression !== 'string')
      throw invalid('body.equation.expression should be a string.');
    attrs.latex = v.expression;
  }
  if (Object.keys(attrs).length) change.attrs = attrs;
  return change;
}
