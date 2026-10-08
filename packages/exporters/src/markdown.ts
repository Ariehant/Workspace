import { flag, inlineText, type ContentNode, type Inline } from './content';
import { formatDateMention, type RenderContext } from './context';

/** Characters that would read as Markdown syntax in plain text. */
const escapeText = (text: string) => text.replace(/([\\`*_[\]~|])/g, '\\$1');
const indent = (text: string, prefix = '    ') =>
  text
    .split('\n')
    .map((line) => (line ? prefix + line : line))
    .join('\n');

/** Inline content as Markdown: marks, links, mentions and equations. */
export function inlineMarkdown(inline: readonly Inline[], ctx: RenderContext): string {
  return inline
    .map((part) => {
      if ('node' in part) {
        const { attrs } = part;
        if (part.node === 'hardBreak') return '<br>';
        if (part.node === 'inlineMath') return `$${String(attrs.latex ?? '')}$`;
        if (attrs.kind === 'date') return `@${formatDateMention(String(attrs.date ?? ''))}`;
        if (attrs.kind === 'person') {
          return `@${escapeText(ctx.userName?.(String(attrs.userId ?? '')) ?? 'Someone')}`;
        }
        const pageId = String(attrs.pageId ?? '');
        return `[${escapeText(ctx.pageTitle(pageId))}](${encodeHref(ctx.pageHref(pageId))})`;
      }
      const { text, marks } = part;
      if (!text) return '';
      if (marks.code) return codeSpan(text);
      // Marks wrap the text but not its surrounding spaces ("** bold**" isn't bold).
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
      if (!core) return text;
      let out = escapeText(core!);
      if (marks.bold) out = `**${out}**`;
      if (marks.italic) out = `*${out}*`;
      if (marks.strike) out = `~~${out}~~`;
      const href = marks.link?.href;
      if (typeof href === 'string') out = `[${out}](${encodeHref(href)})`;
      return `${lead}${out}${trail}`;
    })
    .join('');
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Spaces in link targets (file names) as %20, as Notion's exports write them. */
export const encodeHref = (href: string) => href.replace(/ /g, '%20').replace(/\)/g, '%29');

function listItems(node: ContentNode, ctx: RenderContext): string {
  const start = Number(node.attrs.start ?? 1) || 1;
  return node.children
    .map((item, i) => {
      const marker =
        node.type === 'orderedList'
          ? `${start + i}.`
          : node.type === 'taskList'
            ? `- [${flag(item.attrs.checked) ? 'x' : ' '}]`
            : '-';
      const [first, ...rest] = item.children;
      const head = first?.type === 'paragraph' ? inlineMarkdown(first.inline, ctx) : '';
      const body = blocksMarkdown(first?.type === 'paragraph' ? rest : item.children, ctx);
      return `${marker} ${head}`.trimEnd() + (body ? `\n${indent(body)}` : '');
    })
    .join('\n');
}

function tableMarkdown(node: ContentNode, ctx: RenderContext): string {
  const rows = node.children.map((row) =>
    row.children.map((cell) =>
      cell.children
        .map((p) => inlineMarkdown(p.inline, ctx))
        .join('<br>')
        // (Text escapes `|` already.)
        .replace(/\n/g, ' '),
    ),
  );
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [line(rows[0]!), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
}

function mediaMarkdown(node: ContentNode, ctx: RenderContext): string {
  const { fileId, src, name, caption, url, title } = node.attrs as Record<string, string | null>;
  if (node.type === 'bookmark' || node.type === 'embed') {
    const target = url ?? '';
    return target ? `[${escapeText(title || target)}](${encodeHref(target)})` : '';
  }
  const href = fileId ? ctx.fileHref(fileId, name ?? null) : (src ?? null);
  if (!href) return '';
  const label = escapeText(caption || name || node.type);
  return node.type === 'image'
    ? `![${label}](${encodeHref(href)})`
    : `[${label}](${encodeHref(href)})`;
}

/** One block as Markdown ('' for blocks with no Markdown form). */
export function blockMarkdown(node: ContentNode, ctx: RenderContext): string {
  const { attrs } = node;
  switch (node.type) {
    case 'paragraph':
      return inlineMarkdown(node.inline, ctx);
    case 'heading':
      return `${'#'.repeat(Math.min(Math.max(Number(attrs.level) || 1, 1), 6))} ${inlineMarkdown(node.inline, ctx)}`;
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listItems(node, ctx);
    case 'blockquote':
      return blocksMarkdown(node.children, ctx)
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    case 'codeBlock': {
      const code = inlineText(node.inline);
      const lang = attrs.language && attrs.language !== 'plaintext' ? String(attrs.language) : '';
      const fence = code.includes('```') ? '````' : '```';
      return `${fence}${lang}\n${code}\n${fence}`;
    }
    case 'horizontalRule':
      return '---';
    case 'blockMath':
      return `$$\n${String(attrs.latex ?? '')}\n$$`;
    case 'callout': {
      const body = blocksMarkdown(node.children, ctx);
      return `<aside>\n${attrs.icon ? `${String(attrs.icon)} ` : ''}${body}\n</aside>`;
    }
    case 'details': {
      const summary = node.children.find((c) => c.type === 'detailsSummary');
      const content = node.children.find((c) => c.type === 'detailsContent');
      const level = Number(summary?.attrs.level) || 0;
      const head = `- ${level ? `${'#'.repeat(level)} ` : ''}${summary ? inlineMarkdown(summary.inline, ctx) : ''}`;
      const body = content ? blocksMarkdown(content.children, ctx) : '';
      return head.trimEnd() + (body ? `\n${indent(body)}` : '');
    }
    case 'table':
      return tableMarkdown(node, ctx);
    case 'columnList':
      return node.children.map((column) => blocksMarkdown(column.children, ctx)).join('\n\n');
    case 'pageLink':
    case 'database': {
      const pageId = String(attrs.pageId ?? '');
      return pageId
        ? `[${escapeText(ctx.pageTitle(pageId))}](${encodeHref(ctx.pageHref(pageId))})`
        : '';
    }
    case 'linkedDatabase': {
      const databaseId = String(attrs.databaseId ?? '');
      return databaseId
        ? `[${escapeText(ctx.pageTitle(databaseId))}](${encodeHref(ctx.pageHref(databaseId))})`
        : '';
    }
    case 'syncedBlock':
      return attrs.syncedId ? blocksMarkdown(ctx.synced(String(attrs.syncedId)), ctx) : '';
    case 'image':
    case 'video':
    case 'audio':
    case 'pdf':
    case 'file':
    case 'bookmark':
    case 'embed':
      return mediaMarkdown(node, ctx);
    case 'button':
    case 'breadcrumb':
    case 'tableOfContents':
      return '';
    default:
      // Unknown blocks keep their text.
      return node.inline.length
        ? inlineMarkdown(node.inline, ctx)
        : blocksMarkdown(node.children, ctx);
  }
}

const LISTS = new Set(['bulletList', 'orderedList', 'taskList']);

/** Blocks as Markdown, a blank line apart (consecutive lists of one kind stay tight). */
export function blocksMarkdown(nodes: readonly ContentNode[], ctx: RenderContext): string {
  let out = '';
  let previous: string | null = null;
  for (const node of nodes) {
    const text = blockMarkdown(node, ctx);
    if (!text && node.type !== 'paragraph') continue;
    if (previous !== null) out += previous === node.type && LISTS.has(node.type) ? '\n' : '\n\n';
    out += text;
    previous = node.type;
  }
  // Empty paragraphs leave runs of blank lines; keep at most one.
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
