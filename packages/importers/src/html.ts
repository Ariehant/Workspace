import type { PropertyType } from '@workspace/database';
import type { JSONContent } from '@workspace/editor';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { readable, type ConvertContext, type LinkTarget } from './markdown';

type Node = DefaultTreeAdapterMap['childNode'];
type Element = DefaultTreeAdapterMap['element'];

const isElement = (node: Node | DefaultTreeAdapterMap['parentNode']): node is Element =>
  'tagName' in node;
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value ?? null;
const classes = (el: Element) => new Set((attr(el, 'class') ?? '').split(/\s+/).filter(Boolean));
const kids = (el: Element | DefaultTreeAdapterMap['document']): Node[] => el.childNodes ?? [];

function textOf(node: Node): string {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterMap['textNode']).value;
  if (!isElement(node) || node.tagName === 'style' || node.tagName === 'script') return '';
  if (node.tagName === 'br') return '\n';
  return kids(node).map(textOf).join('');
}

function find(
  root: Node | DefaultTreeAdapterMap['document'],
  test: (el: Element) => boolean,
): Element | null {
  for (const child of 'childNodes' in root ? root.childNodes : []) {
    if (isElement(child)) {
      if (test(child)) return child;
      const inner = find(child, test);
      if (inner) return inner;
    }
  }
  return null;
}

function findAll(root: Node, test: (el: Element) => boolean, out: Element[] = []): Element[] {
  for (const child of 'childNodes' in root ? root.childNodes : []) {
    if (isElement(child)) {
      if (test(child)) out.push(child);
      else findAll(child, test, out);
    }
  }
  return out;
}

/** TeX of a rendered KaTeX equation (its annotation), or its text. */
const texOf = (el: Element) => {
  const annotation = find(el, (e) => e.tagName === 'annotation');
  return (annotation ? textOf(annotation) : textOf(el)).trim();
};

/** Notion's `highlight-red`, `block-color-red_background`; ours `color-red`, `bg-red`. */
function colorOf(el: Element): string | null {
  for (const c of classes(el)) {
    const m = /^(?:highlight|block-color|select-value-color)-([a-z]+(?:_background)?)$/.exec(c);
    if (m && m[1] !== 'default') return m[1]!;
    const ours = /^(color|bg)-([a-z]+)$/.exec(c);
    if (ours) return ours[1] === 'bg' ? `${ours[2]}_background` : ours[2]!;
  }
  return null;
}

const LANGUAGES: Record<string, string> = {
  'plain text': 'plaintext',
  'c++': 'cpp',
  'c#': 'csharp',
  shell: 'bash',
  'objective-c': 'objectivec',
  html: 'xml',
  'f#': 'fsharp',
  'vb.net': 'vbnet',
  protobuf: 'protobuf',
};

type Mark = { type: string; attrs?: Record<string, unknown> };

const INLINE_TAGS = new Set([
  'a',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'del',
  'strike',
  'code',
  'mark',
  'span',
  'br',
  'time',
  'sub',
  'sup',
  'small',
  'label',
  'img',
]);
const isInline = (node: Node) =>
  node.nodeName === '#text' || (isElement(node) && INLINE_TAGS.has(node.tagName));

export type HtmlContext = ConvertContext;

class Converter {
  constructor(private readonly ctx: HtmlContext) {}

  inline(nodes: Node[], marks: Mark[] = []): JSONContent[] {
    const out: JSONContent[] = [];
    for (const node of nodes) {
      if (node.nodeName === '#text') {
        const text = (node as DefaultTreeAdapterMap['textNode']).value;
        if (text) out.push({ type: 'text', text, ...(marks.length ? { marks } : {}) });
        continue;
      }
      if (!isElement(node)) continue;
      const tag = node.tagName;
      const cls = classes(node);
      if (tag === 'style' || tag === 'script' || tag === 'img') continue;
      if (tag === 'br') {
        out.push({ type: 'hardBreak' });
        continue;
      }
      if (cls.has('notion-text-equation-token') || (tag === 'code' && cls.has('equation'))) {
        out.push({ type: 'inlineMath', attrs: { latex: texOf(node) } });
        continue;
      }
      if (tag === 'a') {
        const href = attr(node, 'href') ?? '';
        const target = href ? this.ctx.link(href) : null;
        const text = textOf(node).trim();
        if (target?.kind === 'page') {
          if (!text || text === target.title.trim() || cls.has('mention')) {
            out.push({ type: 'mention', attrs: { kind: 'page', pageId: target.id } });
          } else {
            out.push(
              ...this.inline(kids(node), [
                ...marks,
                { type: 'link', attrs: { href: `workspace://page/${target.id}` } },
              ]),
            );
          }
          continue;
        }
        if (target) {
          out.push(...this.inline(kids(node), marks));
          continue;
        }
        out.push(
          ...this.inline(kids(node), href ? [...marks, { type: 'link', attrs: { href } }] : marks),
        );
        continue;
      }
      const add: Mark[] = [];
      if (tag === 'b' || tag === 'strong') add.push({ type: 'bold' });
      if (tag === 'i' || tag === 'em') add.push({ type: 'italic' });
      if (tag === 'u') add.push({ type: 'underline' });
      if (tag === 's' || tag === 'del' || tag === 'strike') add.push({ type: 'strike' });
      if (tag === 'code') add.push({ type: 'code' });
      const color = colorOf(node);
      if (color) add.push({ type: 'color', attrs: { color } });
      out.push(...this.inline(kids(node), [...marks, ...add]));
    }
    return out;
  }

  /** Children that mix inline content and blocks: inline runs become paragraphs. */
  mixed(nodes: Node[]): JSONContent[] {
    const out: JSONContent[] = [];
    let run: Node[] = [];
    const flush = () => {
      const content = this.inline(run);
      run = [];
      if (content.some((c) => c.type !== 'text' || c.text!.trim())) {
        out.push({ type: 'paragraph', content: trimEdges(content) });
      }
    };
    for (const node of nodes) {
      if (isInline(node) && !(isElement(node) && node.tagName === 'img')) run.push(node);
      else {
        flush();
        out.push(...this.block(node));
      }
    }
    flush();
    return out;
  }

  private media(target: LinkTarget | null, caption: string, src: string | null): JSONContent[] {
    if (target?.kind === 'file') {
      const attrs: Record<string, unknown> = { fileId: target.fileId, name: target.name };
      if (caption && target.media !== 'file') attrs.caption = caption;
      return [{ type: target.media, attrs }];
    }
    if (target?.kind === 'missing')
      this.ctx.warn(`A file wasn't in the export: ${readable(src ?? '')}`);
    if (!target && src && /^https?:/i.test(src)) {
      return [{ type: 'image', attrs: { src, caption } }];
    }
    return [];
  }

  private listItems(list: Element): JSONContent[] {
    return kids(list)
      .filter((n): n is Element => isElement(n) && n.tagName === 'li')
      .map((li) => {
        const content = this.mixed(kids(li));
        return {
          type: 'listItem',
          content: content[0]?.type === 'paragraph' ? content : [{ type: 'paragraph' }, ...content],
        };
      });
  }

  block(node: Node): JSONContent[] {
    if (node.nodeName === '#text') {
      const text = (node as DefaultTreeAdapterMap['textNode']).value;
      return text.trim() ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : [];
    }
    if (!isElement(node)) return [];
    const tag = node.tagName;
    const cls = classes(node);
    const color = colorOf(node);
    const colored = (block: JSONContent): JSONContent =>
      color ? { ...block, attrs: { ...block.attrs, color } } : block;

    if (tag === 'style' || tag === 'script' || tag === 'header') return [];
    if (tag === 'p') {
      if (cls.has('page-link')) {
        const a = find(node, (e) => e.tagName === 'a');
        if (a) return this.linkBlock(a);
      }
      const content = this.inline(kids(node));
      return [colored({ type: 'paragraph', ...(content.length ? { content } : {}) })];
    }
    if (/^h[1-6]$/.test(tag)) {
      const level = Math.min(Number(tag[1]), 3);
      return [colored({ type: 'heading', attrs: { level }, content: this.inline(kids(node)) })];
    }
    if (tag === 'ul' && (cls.has('to-do-list') || cls.has('todo'))) {
      return [
        {
          type: 'taskList',
          content: kids(node)
            .filter((n): n is Element => isElement(n) && n.tagName === 'li')
            .map((li) => {
              const box = find(
                li,
                (e) => classes(e).has('checkbox') || attr(e, 'type') === 'checkbox',
              );
              const checked = box
                ? classes(box).has('checkbox-on') || box.attrs.some((a) => a.name === 'checked')
                : false;
              const rest = kids(li).filter((n) => n !== box);
              const content = this.mixed(rest);
              return {
                type: 'taskItem',
                attrs: { checked },
                content:
                  content[0]?.type === 'paragraph' ? content : [{ type: 'paragraph' }, ...content],
              };
            }),
        },
      ];
    }
    if (tag === 'ul' && cls.has('toggle')) {
      return kids(node).flatMap((li) => (isElement(li) ? this.mixed(kids(li)) : []));
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = this.listItems(node);
      if (!items.length) return [];
      if (tag === 'ol') {
        const start = Number(attr(node, 'start') ?? 1) || 1;
        return [{ type: 'orderedList', attrs: { start }, content: items }];
      }
      return [{ type: 'bulletList', content: items }];
    }
    if (tag === 'details') {
      const summary = kids(node).find((n): n is Element => isElement(n) && n.tagName === 'summary');
      const heading = summary && find(summary, (e) => /^h[1-3]$/.test(e.tagName));
      const body = this.mixed(kids(node).filter((n) => n !== summary));
      return [
        {
          type: 'details',
          content: [
            {
              type: 'detailsSummary',
              attrs: { level: heading ? Number(heading.tagName[1]) : 0 },
              content: summary ? this.inline(kids(heading ?? summary)) : [],
            },
            { type: 'detailsContent', content: body.length ? body : [{ type: 'paragraph' }] },
          ],
        },
      ];
    }
    if ((tag === 'figure' || tag === 'aside') && cls.has('callout')) {
      const icon = find(node, (e) => classes(e).has('icon'));
      // The content is the last child that isn't (or doesn't hold) the icon.
      const bodyEl =
        kids(node)
          .filter(isElement)
          .filter((p) => p !== icon && !find(p, (e) => e === icon))
          .at(-1) ?? null;
      const body = bodyEl ? this.mixed(kids(bodyEl)) : [];
      return [
        {
          type: 'callout',
          attrs: {
            ...(icon ? { icon: textOf(icon).trim() || '💡' } : {}),
            ...(color ? { color } : {}),
          },
          content: body.length ? body : [{ type: 'paragraph' }],
        },
      ];
    }
    if (tag === 'blockquote') {
      const content = this.mixed(kids(node));
      return [{ type: 'blockquote', content: content.length ? content : [{ type: 'paragraph' }] }];
    }
    if (tag === 'pre') {
      if (cls.has('equation'))
        return [{ type: 'blockMath', attrs: { latex: textOf(node).trim() } }];
      const code = find(node, (e) => e.tagName === 'code') ?? node;
      const lang =
        [...classes(code)].find((c) => c.startsWith('language-'))?.slice(9) ?? 'plaintext';
      const language = LANGUAGES[lang.toLowerCase()] ?? lang.toLowerCase().replace(/\s+/g, '');
      const text = textOf(code).replace(/\n$/, '');
      return [
        {
          type: 'codeBlock',
          attrs: { language },
          ...(text ? { content: [{ type: 'text', text }] } : {}),
        },
      ];
    }
    if (tag === 'hr') return [{ type: 'horizontalRule' }];
    if (tag === 'figure') return this.figure(node);
    if (tag === 'img')
      return this.media(this.link(attr(node, 'src')), attr(node, 'alt') ?? '', attr(node, 'src'));
    if (tag === 'a' && cls.has('bookmark')) return this.bookmark(node);
    if (tag === 'div' && cls.has('column-list')) {
      const columns = kids(node)
        .filter((n): n is Element => isElement(n) && classes(n).has('column'))
        .map((col) => {
          const content = this.mixed(kids(col));
          return { type: 'column', content: content.length ? content : [{ type: 'paragraph' }] };
        });
      return columns.length > 1
        ? [{ type: 'columnList', content: columns }]
        : columns.flatMap((c) => c.content);
    }
    if (tag === 'table') {
      if (cls.has('collection-content') || cls.has('database') || cls.has('properties')) return [];
      return this.table(node);
    }
    if (tag === 'div' && cls.has('collection-content')) return [];
    // Wrappers (div.indented, section, unknown): their children.
    return this.mixed(kids(node));
  }

  private link(href: string | null): LinkTarget | null {
    return href ? this.ctx.link(href) : null;
  }

  private linkBlock(a: Element): JSONContent[] {
    const target = this.link(attr(a, 'href'));
    if (target?.kind === 'page')
      return [{ type: target.database ? 'database' : 'pageLink', attrs: { pageId: target.id } }];
    return [{ type: 'paragraph', content: this.inline([a]) }];
  }

  private bookmark(a: Element): JSONContent[] {
    const url = attr(a, 'href');
    if (!url) return [];
    const title = find(a, (e) => classes(e).has('bookmark-title') || e.tagName === 'strong');
    const description = find(
      a,
      (e) => classes(e).has('bookmark-description') || (e.tagName === 'span' && !classes(e).size),
    );
    return [
      {
        type: 'bookmark',
        attrs: {
          url,
          ...(title ? { title: textOf(title).trim() } : {}),
          ...(description ? { description: textOf(description).trim() } : {}),
        },
      },
    ];
  }

  private figure(fig: Element): JSONContent[] {
    const cls = classes(fig);
    const caption = find(fig, (e) => e.tagName === 'figcaption');
    const captionText = caption ? textOf(caption).trim() : '';
    if (cls.has('equation')) return [{ type: 'blockMath', attrs: { latex: texOf(fig) } }];
    if (cls.has('link-to-page')) {
      const a = find(fig, (e) => e.tagName === 'a');
      return a ? this.linkBlock(a) : [];
    }
    const bookmark = find(fig, (e) => e.tagName === 'a' && classes(e).has('bookmark'));
    if (bookmark) return this.bookmark(bookmark);
    const diagram = find(fig, (e) => e.tagName === 'img' && classes(e).has('diagram'));
    if (diagram) {
      // Our own export: the Mermaid source sits under the diagram.
      const pre = find(fig, (e) => e.tagName === 'pre');
      return pre ? this.block(pre) : [];
    }
    const img = find(fig, (e) => e.tagName === 'img');
    if (img) {
      const href = attr(find(fig, (e) => e.tagName === 'a') ?? img, 'href') ?? attr(img, 'src');
      return this.media(this.link(href), captionText, href);
    }
    const mediaEl = find(
      fig,
      (e) => e.tagName === 'video' || e.tagName === 'audio' || e.tagName === 'source',
    );
    const a = find(fig, (e) => e.tagName === 'a');
    const src = mediaEl ? attr(mediaEl, 'src') : a ? attr(a, 'href') : null;
    if (src) {
      const target = this.link(src);
      if (target || !/^https?:/i.test(src)) return this.media(target, captionText, src);
      return [{ type: 'embed', attrs: { url: src } }];
    }
    const pre = find(fig, (e) => e.tagName === 'pre');
    if (pre) return this.block(pre);
    return this.mixed(kids(fig).filter((n) => n !== caption));
  }

  private table(table: Element): JSONContent[] {
    const rows = findAll(table, (e) => e.tagName === 'tr');
    if (!rows.length) return [];
    const content = rows.map((tr) => ({
      type: 'tableRow',
      content: kids(tr)
        .filter((n): n is Element => isElement(n) && (n.tagName === 'td' || n.tagName === 'th'))
        .map((cell) => {
          const inner = this.mixed(kids(cell));
          return {
            type: cell.tagName === 'th' ? 'tableHeader' : 'tableCell',
            content: inner.length ? inner : [{ type: 'paragraph' }],
          };
        }),
    }));
    return [{ type: 'table', content }];
  }
}

function trimEdges(content: JSONContent[]): JSONContent[] {
  const out = [...content];
  const first = out[0];
  if (first?.type === 'text') out[0] = { ...first, text: first.text!.replace(/^\s+/, '') };
  const last = out[out.length - 1];
  if (last?.type === 'text')
    out[out.length - 1] = { ...last, text: last.text!.replace(/\s+$/, '') };
  return out.filter((c) => c.type !== 'text' || c.text);
}

/** Notion's property icons (`<svg class="typesSelect">`) → our types. */
const NOTION_TYPES: Record<string, PropertyType | 'formula' | 'rollup'> = {
  typesTitle: 'title',
  typesText: 'text',
  typesNumber: 'number',
  typesSelect: 'select',
  typesMultipleSelect: 'multiSelect',
  typesStatus: 'status',
  typesDate: 'date',
  typesPerson: 'text',
  typesFile: 'text',
  typesCheckbox: 'checkbox',
  typesUrl: 'url',
  typesEmail: 'email',
  typesPhoneNumber: 'phone',
  typesFormula: 'formula',
  typesRelation: 'relation',
  typesRollup: 'rollup',
  typesCreatedAt: 'date',
  typesLastEditedTime: 'date',
  typesCreatedBy: 'text',
  typesLastEditedBy: 'text',
};

export interface HtmlColumn {
  name: string;
  /** From Notion's property icon, when the export has one. */
  type: PropertyType | 'formula' | 'rollup' | null;
}

export interface HtmlTableRow {
  cells: string[];
  /** Link of the title cell (the row's page). */
  href: string | null;
  /** Select colors by value, from Notion's classes. */
  colors: Map<string, string>;
}

export interface HtmlPage {
  title: string | null;
  icon: string | null;
  coverHref: string | null;
  blocks: JSONContent[];
  /** A database page's table. */
  database: { columns: HtmlColumn[]; rows: HtmlTableRow[] } | null;
}

function readDatabaseTable(table: Element): HtmlPage['database'] {
  const headRow = find(table, (e) => e.tagName === 'tr');
  if (!headRow) return null;
  const columns = kids(headRow)
    .filter((n): n is Element => isElement(n) && n.tagName === 'th')
    .map((th) => {
      const svg = find(th, (e) => e.tagName === 'svg');
      const svgClass = svg ? [...classes(svg)].find((c) => c in NOTION_TYPES) : undefined;
      return { name: textOf(th).trim(), type: svgClass ? NOTION_TYPES[svgClass]! : null };
    });
  const body = find(table, (e) => e.tagName === 'tbody') ?? table;
  const rows = kids(body)
    .filter((n): n is Element => isElement(n) && n.tagName === 'tr' && n !== headRow)
    .map((tr) => {
      const colors = new Map<string, string>();
      const cells = kids(tr)
        .filter((n): n is Element => isElement(n) && n.tagName === 'td')
        .map((td) => {
          for (const value of findAll(td, (e) => classes(e).has('selected-value'))) {
            const color = colorOf(value);
            if (color) colors.set(textOf(value).trim(), color);
          }
          const values = findAll(td, (e) => classes(e).has('selected-value'));
          if (values.length) return values.map((v) => textOf(v).trim()).join(', ');
          const box = find(td, (e) => classes(e).has('checkbox'));
          if (box) return classes(box).has('checkbox-on') ? 'Yes' : 'No';
          return textOf(td).replace(/\s+/g, ' ').trim();
        });
      const titleLink = find(tr, (e) => e.tagName === 'a');
      return { cells, href: titleLink ? attr(titleLink, 'href') : null, colors };
    });
  return { columns, rows };
}

/** A page from Notion's HTML export (or ours): title, icon, cover, content, database table. */
export function notionHtmlPage(html: string, ctx: HtmlContext): HtmlPage {
  const document = parse(html);
  const article =
    find(document, (e) => e.tagName === 'article') ?? find(document, (e) => e.tagName === 'body');
  const titleEl =
    find(document, (e) => classes(e).has('page-title')) ??
    find(document, (e) => e.tagName === 'title');
  const iconEl = find(
    document,
    (e) => classes(e).has('page-header-icon') || classes(e).has('page-icon'),
  );
  const iconText = iconEl ? textOf(iconEl).trim() : '';
  const cover = find(
    document,
    (e) =>
      e.tagName === 'img' && (classes(e).has('page-cover-image') || classes(e).has('page-cover')),
  );
  const table = find(
    document,
    (e) =>
      e.tagName === 'table' && (classes(e).has('collection-content') || classes(e).has('database')),
  );
  const converter = new Converter(ctx);
  const bodyEl = find(document, (e) => classes(e).has('page-body'));
  let blocks: JSONContent[] = [];
  if (bodyEl) blocks = converter.mixed(kids(bodyEl));
  else if (article) {
    // Ours: the content follows the title (and the row properties) in the article.
    const rest = kids(article).filter(
      (n) =>
        !(isElement(n) && (n === titleEl || n === iconEl || n.tagName === 'dl' || n === cover)),
    );
    blocks = converter.mixed(rest);
  }
  return {
    title: titleEl ? textOf(titleEl).trim() : null,
    icon: iconText && [...iconText].length <= 4 ? iconText : null,
    coverHref: cover ? attr(cover, 'src') : null,
    blocks,
    database: table ? readDatabaseTable(table) : null,
  };
}
