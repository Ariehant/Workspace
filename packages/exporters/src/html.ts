import { flag, inlineText, type ContentNode, type Inline } from './content';
import { formatDateMention, type RenderContext } from './context';

export const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `red` → class for text color, `red_background` → background (Notion's palette). */
function colorClass(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z]+(_background)?$/.test(value)) return '';
  return value.endsWith('_background')
    ? `bg-${value.replace('_background', '')}`
    : `color-${value}`;
}
const classAttr = (...names: string[]) => {
  const list = names.filter(Boolean).join(' ');
  return list ? ` class="${list}"` : '';
};

/** Inline content as HTML. */
export function inlineHtml(inline: readonly Inline[], ctx: RenderContext): string {
  return inline
    .map((part) => {
      if ('node' in part) {
        const { attrs } = part;
        if (part.node === 'hardBreak') return '<br>';
        if (part.node === 'inlineMath')
          return `<code class="equation">${escapeHtml(String(attrs.latex ?? ''))}</code>`;
        if (attrs.kind === 'person') {
          const name = ctx.userName?.(String(attrs.userId ?? '')) ?? 'Someone';
          return `<span class="mention person">@${escapeHtml(name)}</span>`;
        }
        if (attrs.kind === 'date')
          return `<time datetime="${escapeHtml(String(attrs.date ?? ''))}">@${escapeHtml(formatDateMention(String(attrs.date ?? '')))}</time>`;
        const pageId = String(attrs.pageId ?? '');
        return `<a class="mention" href="${escapeHtml(ctx.pageHref(pageId))}">${escapeHtml(ctx.pageTitle(pageId))}</a>`;
      }
      const { marks } = part;
      let out = escapeHtml(part.text).replace(/\n/g, '<br>');
      if (marks.code) out = `<code>${out}</code>`;
      if (marks.bold) out = `<strong>${out}</strong>`;
      if (marks.italic) out = `<em>${out}</em>`;
      if (marks.underline) out = `<u>${out}</u>`;
      if (marks.strike) out = `<s>${out}</s>`;
      const color = colorClass(marks.color?.color);
      if (color) out = `<span class="${color}">${out}</span>`;
      const href = marks.link?.href;
      if (typeof href === 'string') out = `<a href="${escapeHtml(href)}">${out}</a>`;
      return out;
    })
    .join('');
}

function listHtml(node: ContentNode, ctx: RenderContext): string {
  const tag = node.type === 'orderedList' ? 'ol' : 'ul';
  const start =
    node.type === 'orderedList' && Number(node.attrs.start) > 1
      ? ` start="${Number(node.attrs.start)}"`
      : '';
  const items = node.children
    .map((item) => {
      const check =
        node.type === 'taskList'
          ? `<input type="checkbox" disabled${flag(item.attrs.checked) ? ' checked' : ''}> `
          : '';
      return `<li${classAttr(flag(item.attrs.checked) ? 'checked' : '')}>${check}${blocksHtml(item.children, ctx)}</li>`;
    })
    .join('');
  return `<${tag}${classAttr(node.type === 'taskList' ? 'todo' : '')}${start}>${items}</${tag}>`;
}

function mediaHtml(node: ContentNode, ctx: RenderContext): string {
  const { fileId, src, name, caption, url, title, description } = node.attrs as Record<
    string,
    string | null
  >;
  if (node.type === 'bookmark') {
    if (!url) return '';
    return `<a class="bookmark" href="${escapeHtml(url)}"><strong>${escapeHtml(title || url)}</strong>${description ? `<span>${escapeHtml(description)}</span>` : ''}<small>${escapeHtml(url)}</small></a>`;
  }
  if (node.type === 'embed') {
    return url ? `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` : '';
  }
  const href = fileId ? ctx.fileHref(fileId, name ?? null) : (src ?? null);
  if (!href) return '';
  const e = escapeHtml(href);
  const label = escapeHtml(caption || name || node.type);
  const media =
    node.type === 'image'
      ? `<img src="${e}" alt="${label}">`
      : node.type === 'video'
        ? `<video controls src="${e}"></video>`
        : node.type === 'audio'
          ? `<audio controls src="${e}"></audio>`
          : `<a class="file" href="${e}">${escapeHtml(name || href)}</a>`;
  return `<figure>${media}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`;
}

function codeHtml(node: ContentNode, ctx: RenderContext): string {
  const code = inlineText(node.inline);
  const language = String(node.attrs.language ?? 'plaintext');
  const caption =
    typeof node.attrs.caption === 'string' && node.attrs.caption
      ? `<figcaption>${escapeHtml(node.attrs.caption)}</figcaption>`
      : '';
  const pre = `<pre class="code"><code class="language-${escapeHtml(language)}">${escapeHtml(code)}</code></pre>`;
  const svg = language === 'mermaid' ? ctx.mermaidSvg?.(code) : null;
  if (svg) {
    // The diagram, with its source folded away.
    const img = `<img class="diagram" alt="Diagram" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}">`;
    return `<figure>${img}<details><summary>Mermaid source</summary>${pre}</details>${caption}</figure>`;
  }
  return caption ? `<figure>${pre}${caption}</figure>` : pre;
}

/** One block as HTML. */
export function blockHtml(node: ContentNode, ctx: RenderContext): string {
  const { attrs } = node;
  const color = colorClass(attrs.color);
  switch (node.type) {
    case 'paragraph':
      return `<p${classAttr(color)}>${inlineHtml(node.inline, ctx)}</p>`;
    case 'heading': {
      const level = Math.min(Math.max(Number(attrs.level) || 1, 1), 3);
      return `<h${level}${classAttr(color)}>${inlineHtml(node.inline, ctx)}</h${level}>`;
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listHtml(node, ctx);
    case 'blockquote':
      return `<blockquote${classAttr(color)}>${blocksHtml(node.children, ctx)}</blockquote>`;
    case 'codeBlock':
      return codeHtml(node, ctx);
    case 'horizontalRule':
      return '<hr>';
    case 'blockMath':
      return `<pre class="equation">${escapeHtml(String(attrs.latex ?? ''))}</pre>`;
    case 'callout':
      return `<aside class="callout ${colorClass(attrs.color) || 'bg-gray'}"><span class="icon">${escapeHtml(String(attrs.icon ?? ''))}</span><div>${blocksHtml(node.children, ctx)}</div></aside>`;
    case 'details': {
      const summary = node.children.find((c) => c.type === 'detailsSummary');
      const content = node.children.find((c) => c.type === 'detailsContent');
      const level = Number(summary?.attrs.level) || 0;
      const head = summary ? inlineHtml(summary.inline, ctx) : '';
      return `<details open><summary>${level ? `<h${level}>${head}</h${level}>` : head}</summary>${content ? blocksHtml(content.children, ctx) : ''}</details>`;
    }
    case 'table':
      return `<table>${node.children
        .map(
          (row) =>
            `<tr>${row.children
              .map((cell) => {
                const tag = cell.type === 'tableHeader' ? 'th' : 'td';
                return `<${tag}>${blocksHtml(cell.children, ctx)}</${tag}>`;
              })
              .join('')}</tr>`,
        )
        .join('')}</table>`;
    case 'columnList':
      return `<div class="columns">${node.children
        .map((column) => `<div class="column">${blocksHtml(column.children, ctx)}</div>`)
        .join('')}</div>`;
    case 'pageLink':
    case 'database':
    case 'linkedDatabase': {
      const id = String(attrs.pageId ?? attrs.databaseId ?? '');
      return id
        ? `<p class="page-link"><a href="${escapeHtml(ctx.pageHref(id))}">${escapeHtml(ctx.pageTitle(id))}</a></p>`
        : '';
    }
    case 'syncedBlock':
      return attrs.syncedId ? blocksHtml(ctx.synced(String(attrs.syncedId)), ctx) : '';
    case 'image':
    case 'video':
    case 'audio':
    case 'pdf':
    case 'file':
    case 'bookmark':
    case 'embed':
      return mediaHtml(node, ctx);
    case 'button':
    case 'breadcrumb':
    case 'tableOfContents':
      return '';
    default:
      return node.inline.length
        ? `<p>${inlineHtml(node.inline, ctx)}</p>`
        : blocksHtml(node.children, ctx);
  }
}

export function blocksHtml(nodes: readonly ContentNode[], ctx: RenderContext): string {
  return nodes.map((node) => blockHtml(node, ctx)).join('\n');
}

const PALETTE: Record<string, [string, string]> = {
  gray: ['#787774', '#f1f1ef'],
  brown: ['#9f6b53', '#f4eeee'],
  orange: ['#d9730d', '#fbecdd'],
  yellow: ['#cb912f', '#fbf3db'],
  green: ['#448361', '#edf3ec'],
  blue: ['#337ea9', '#e7f3f8'],
  purple: ['#9065b0', '#f6f3f9'],
  pink: ['#c14c8a', '#faf1f5'],
  red: ['#d44c47', '#fdebec'],
};

/** Styles of an exported page, inlined in each file so it stands alone. */
export const PAGE_CSS = `
body { margin: 0; color: #37352f; background: #fff; font: 16px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
article { max-width: 720px; margin: 0 auto; padding: 48px 24px 96px; }
article.full-width { max-width: none; }
h1.page-title { font-size: 40px; line-height: 1.2; margin: 0 0 24px; }
.page-icon { font-size: 64px; line-height: 1; margin-bottom: 8px; }
.page-cover { width: 100%; height: 30vh; object-fit: cover; display: block; }
h1, h2, h3 { margin: 1.4em 0 0.3em; line-height: 1.3; }
p { margin: 0.25em 0; min-height: 1.5em; }
a { color: inherit; text-decoration: underline; text-decoration-color: rgba(55, 53, 47, 0.4); }
code { background: rgba(135, 131, 120, 0.15); color: #eb5757; border-radius: 4px; padding: 0.1em 0.3em; font: 85% ui-monospace, SFMono-Regular, Menlo, monospace; }
pre.code { background: #f7f6f3; border-radius: 4px; padding: 24px; overflow-x: auto; }
pre.code code { background: none; color: inherit; padding: 0; font-size: 85%; }
pre.equation { text-align: center; font: 15px ui-monospace, monospace; }
blockquote { margin: 0.5em 0; padding-left: 14px; border-left: 3px solid currentColor; }
aside.callout { display: flex; gap: 10px; border-radius: 4px; padding: 16px 16px 16px 12px; margin: 4px 0; }
aside.callout .icon { font-size: 20px; line-height: 1.2; }
ul.todo { list-style: none; padding-left: 4px; }
ul.todo li.checked > p { text-decoration: line-through; opacity: 0.6; }
details summary { cursor: pointer; }
details summary h1, details summary h2, details summary h3 { display: inline; }
table { border-collapse: collapse; margin: 8px 0; }
th, td { border: 1px solid #e9e9e7; padding: 6px 8px; text-align: left; vertical-align: top; }
th { background: #f7f6f3; font-weight: 500; }
td p, th p { margin: 0; min-height: 0; }
.columns { display: flex; gap: 24px; }
.columns .column { flex: 1; min-width: 0; }
figure { margin: 8px 0; }
figure img, figure video { max-width: 100%; }
img.diagram { display: block; margin: 0 auto; }
figcaption { color: rgba(55, 53, 47, 0.65); font-size: 14px; }
.bookmark { display: flex; flex-direction: column; border: 1px solid #e9e9e7; border-radius: 4px; padding: 12px 14px; text-decoration: none; }
.bookmark small { color: rgba(55, 53, 47, 0.65); }
.page-link a, a.mention { font-weight: 500; }
table.database td.title { font-weight: 500; }
dl.properties { display: grid; grid-template-columns: 160px 1fr; gap: 6px 12px; margin: 0 0 24px; padding-bottom: 16px; border-bottom: 1px solid #e9e9e7; }
dl.properties dt { color: rgba(55, 53, 47, 0.65); }
dl.properties dd { margin: 0; }
${Object.entries(PALETTE)
  .map(([name, [fg, bg]]) => `.color-${name} { color: ${fg}; } .bg-${name} { background: ${bg}; }`)
  .join('\n')}
@media print { article { padding: 0; } }
`.trim();

/** A complete HTML page around rendered content. */
export function htmlDocument(options: {
  title: string;
  icon: string | null;
  body: string;
  /** Rendered above the content (row properties). */
  header?: string;
  coverUrl?: string | null;
  fullWidth?: boolean;
}): string {
  const icon =
    options.icon && !options.icon.startsWith('file:')
      ? `<div class="page-icon">${escapeHtml(options.icon)}</div>`
      : '';
  const cover = options.coverUrl
    ? `<img class="page-cover" src="${escapeHtml(options.coverUrl)}" alt="">`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>
${PAGE_CSS}
</style>
</head>
<body>
${cover}<article${options.fullWidth ? ' class="full-width"' : ''}>
${icon}<h1 class="page-title">${escapeHtml(options.title)}</h1>
${options.header ?? ''}${options.body}
</article>
</body>
</html>
`;
}
