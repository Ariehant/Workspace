/**
 * Word documents (`.docx`), and Google Docs (which download as `.docx`): Phase 8 N5.
 *
 * A `.docx` is a zip of XML parts. The document's paragraphs, with their styles (headings,
 * quotes, code), numbering (bullet and numbered lists, nested), runs (bold, italic, underline,
 * strikethrough, code, colours, links), pictures, tables and footnotes become the editor's
 * blocks. What doesn't fit (equations, comments, text boxes, tracked deletions) is said in the
 * report's warnings.
 */
import { setPageTitle } from '@workspace/core';
import type { JSONContent } from '@workspace/editor';
import { unzipSync } from 'fflate';
import { ImportBuilder } from './build';
import type { ImportOptions, ImportReport, ImportTarget } from './import';
import type { LinkTarget } from './markdown';
import { mimeOf, resolvePath, type ArchiveFile } from './paths';
import {
  child,
  childElements,
  descendants,
  isElement,
  parseXml,
  textContent,
  type XmlElement,
} from './xml';

/** The most a document may hold uncompressed (a zip can claim far more than it is). */
export const MAX_DOCX_BYTES = 200 * 1024 * 1024;

export interface DocxContext {
  /** Store a picture; a link target to it. */
  file(bytes: Uint8Array, name: string, mime: string): LinkTarget;
  warn(message: string): void;
}

export interface DocxDocument {
  /** From a Title paragraph at the top, else the document's properties; null if neither. */
  title: string | null;
  blocks: JSONContent[];
}

type Mark = NonNullable<JSONContent['marks']>[number];

interface Style {
  name: string;
  basedOn: string | null;
  outline: number | null;
  /** Its runs are in a monospace font. */
  mono: boolean;
}

type ParagraphKind =
  | { kind: 'title' }
  | { kind: 'heading'; level: number }
  | { kind: 'quote' }
  | { kind: 'code' }
  | { kind: 'caption' }
  | { kind: 'text' };

interface ListInfo {
  numId: string;
  level: number;
  ordered: boolean;
}

/** One paragraph, read: what it is, its text, and pictures that follow it. */
interface Para {
  type: ParagraphKind;
  list: ListInfo | null;
  inline: JSONContent[];
  /** Pictures and text boxes, as blocks after it. */
  after: JSONContent[];
}

type Item = { para: Para } | { block: JSONContent };

// --- Colours: Word's are any RGB; the app's are Notion's named palette. -------------------

const PALETTE: [string, number, number, number][] = [
  ['gray', 0x78, 0x77, 0x74],
  ['brown', 0x9f, 0x6b, 0x53],
  ['orange', 0xd9, 0x73, 0x0d],
  ['yellow', 0xcb, 0x91, 0x2f],
  ['green', 0x44, 0x83, 0x61],
  ['blue', 0x33, 0x7e, 0xa9],
  ['purple', 0x90, 0x65, 0xb0],
  ['pink', 0xc1, 0x4c, 0x8a],
  ['red', 0xd4, 0x4c, 0x47],
];

/** Word's named highlight colours. */
const HIGHLIGHTS: Record<string, string> = {
  yellow: 'yellow',
  green: 'green',
  cyan: 'blue',
  magenta: 'pink',
  blue: 'blue',
  red: 'red',
  darkBlue: 'blue',
  darkCyan: 'blue',
  darkGreen: 'green',
  darkMagenta: 'purple',
  darkRed: 'red',
  darkYellow: 'brown',
  darkGray: 'gray',
  lightGray: 'gray',
};

/** The palette colour nearest an RGB hex; null for black-ish or white-ish (no colour). */
export function nearestColor(hex: string): string | null {
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  // Text that's (nearly) black or white, and greys, aren't colours worth keeping as such.
  if (max < 60 || min > 235) return null;
  if (max - min < 24) return max < 200 ? 'gray' : null;
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const [name, pr, pg, pb] of PALETTE) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestDistance) [best, bestDistance] = [name, d];
  }
  return best;
}

const MONOSPACE =
  /consolas|courier|menlo|monaco|mono|source code|inconsolata|fira code|lucida console|verbatim/i;
const on = (el: XmlElement | undefined) =>
  el !== undefined && !['0', 'false', 'off'].includes(el.attrs['w:val'] ?? '');

// --- The package --------------------------------------------------------------------------

/** Unzip a `.docx`'s parts (only what's read), refusing more than `MAX_DOCX_BYTES`. */
function unpack(data: Uint8Array): Map<string, Uint8Array> {
  let total = 0;
  const parts = unzipSync(data, {
    filter: (file) => {
      if (!file.name.startsWith('word/') && file.name !== 'docProps/core.xml') return false;
      total += file.originalSize;
      if (total > MAX_DOCX_BYTES) throw new Error('too large');
      return true;
    },
  });
  return new Map(Object.entries(parts));
}

const decoder = new TextDecoder();

/** Read a Word document into blocks. Throws if it isn't one. */
export function readDocx(data: Uint8Array, ctx: DocxContext): DocxDocument {
  const parts = unpack(data);
  const xml = (path: string) => {
    const bytes = parts.get(path);
    return bytes ? parseXml(decoder.decode(bytes)) : null;
  };
  const document = xml('word/document.xml');
  const body = document && child(child(document, 'w:document'), 'w:body');
  if (!body) throw new Error('Not a Word document');
  return new DocxReader(ctx, parts, {
    styles: xml('word/styles.xml'),
    numbering: xml('word/numbering.xml'),
    rels: xml('word/_rels/document.xml.rels'),
    footnotes: xml('word/footnotes.xml'),
    core: xml('docProps/core.xml'),
    // (Some writers always include the part, empty.)
    comments: /<w:comment[\s>]/.test(
      decoder.decode(parts.get('word/comments.xml') ?? new Uint8Array()),
    ),
  }).read(body);
}

class DocxReader {
  private readonly styles = new Map<string, Style>();
  /** numId -> level -> ordered */
  private readonly lists = new Map<string, Map<number, boolean>>();
  private readonly rels = new Map<string, { target: string; external: boolean }>();
  private readonly footnoteText = new Map<string, XmlElement>();
  /** Footnotes in the order they're first referenced. */
  private readonly footnotes: string[] = [];
  private readonly pictures = new Map<string, LinkTarget>();
  private readonly coreTitle: string | null;

  constructor(
    private readonly ctx: DocxContext,
    private readonly parts: Map<string, Uint8Array>,
    xml: {
      styles: XmlElement | null;
      numbering: XmlElement | null;
      rels: XmlElement | null;
      footnotes: XmlElement | null;
      core: XmlElement | null;
      comments: boolean;
    },
  ) {
    for (const s of descendants(xml.styles ?? EMPTY, 'w:style')) {
      const id = s.attrs['w:styleId'];
      if (!id) continue;
      const fonts = child(child(s, 'w:rPr'), 'w:rFonts');
      this.styles.set(id, {
        name: (child(s, 'w:name')?.attrs['w:val'] ?? id).toLowerCase(),
        basedOn: child(s, 'w:basedOn')?.attrs['w:val'] ?? null,
        outline: numberOr(child(child(s, 'w:pPr'), 'w:outlineLvl')?.attrs['w:val']),
        mono: MONOSPACE.test(fonts?.attrs['w:ascii'] ?? fonts?.attrs['w:hAnsi'] ?? ''),
      });
    }
    const abstract = new Map<string, Map<number, boolean>>();
    for (const a of descendants(xml.numbering ?? EMPTY, 'w:abstractNum')) {
      const levels = new Map<number, boolean>();
      for (const lvl of childElements(a, 'w:lvl')) {
        const format = child(lvl, 'w:numFmt')?.attrs['w:val'] ?? 'bullet';
        levels.set(Number(lvl.attrs['w:ilvl'] ?? 0), format !== 'bullet' && format !== 'none');
      }
      abstract.set(a.attrs['w:abstractNumId'] ?? '', levels);
    }
    for (const n of descendants(xml.numbering ?? EMPTY, 'w:num')) {
      const id = child(n, 'w:abstractNumId')?.attrs['w:val'] ?? '';
      const levels = new Map(abstract.get(id) ?? []);
      // A list may redefine levels of its own (LibreOffice does).
      for (const override of childElements(n, 'w:lvlOverride')) {
        const lvl = child(override, 'w:lvl');
        const format = child(lvl, 'w:numFmt')?.attrs['w:val'];
        if (format) {
          levels.set(
            Number(override.attrs['w:ilvl'] ?? 0),
            format !== 'bullet' && format !== 'none',
          );
        }
      }
      this.lists.set(n.attrs['w:numId'] ?? '', levels);
    }
    for (const r of descendants(xml.rels ?? EMPTY, 'Relationship')) {
      const id = r.attrs.Id;
      if (id && r.attrs.Target) {
        this.rels.set(id, { target: r.attrs.Target, external: r.attrs.TargetMode === 'External' });
      }
    }
    for (const f of descendants(xml.footnotes ?? EMPTY, 'w:footnote')) {
      // Word's separators are footnotes too, typed as such.
      if (!f.attrs['w:type'] && f.attrs['w:id']) this.footnoteText.set(f.attrs['w:id'], f);
    }
    const title = xml.core ? descendants(xml.core, 'dc:title')[0] : undefined;
    this.coreTitle = title ? textContent(title).trim() || null : null;
    if (xml.comments) ctx.warn('Comments in Word documents weren’t imported');
  }

  read(body: XmlElement): DocxDocument {
    const items = this.items(body.children.filter(isElement));
    // A Title paragraph at the top is the page's title.
    let title: string | null = null;
    const first = items.findIndex((i) => !('para' in i) || !isEmpty(i.para));
    const head = items[first];
    if (head && 'para' in head && head.para.type.kind === 'title') {
      title = plain(head.para.inline).trim() || null;
      items.splice(first, 1);
    }
    const blocks = this.blocks(items);
    if (this.footnotes.length) {
      blocks.push(
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Footnotes' }] },
        {
          type: 'orderedList',
          attrs: { start: 1 },
          content: this.footnotes.map((id) => ({
            type: 'listItem',
            content: [this.footnoteParagraph(id)],
          })),
        },
      );
    }
    return { title: title ?? this.coreTitle, blocks };
  }

  // --- Paragraphs and their kinds ---------------------------------------------------------

  /** What a style is (following what it's based on). */
  private styleKind(id: string | undefined): ParagraphKind {
    const seen = new Set<string>();
    for (let s = id ? this.styles.get(id) : undefined; s;) {
      const name = s.name;
      if (name === 'title') return { kind: 'title' };
      const heading = /^heading (\d)$/.exec(name);
      if (heading) return { kind: 'heading', level: Math.min(Number(heading[1]), 3) };
      if (s.outline !== null && s.outline < 9) {
        return { kind: 'heading', level: Math.min(s.outline + 1, 3) };
      }
      if (/quot|block text/.test(name)) return { kind: 'quote' };
      if (/caption/.test(name)) return { kind: 'caption' };
      if (/code|preformatted|source/.test(name) || s.mono) return { kind: 'code' };
      if (!s.basedOn || seen.has(s.basedOn)) break;
      seen.add(s.basedOn);
      s = this.styles.get(s.basedOn);
    }
    return { kind: 'text' };
  }

  /** The body's (or a cell's) elements, as paragraphs and tables in order. */
  private items(elements: XmlElement[]): Item[] {
    const out: Item[] = [];
    for (const el of elements) {
      if (el.name === 'w:p') out.push({ para: this.paragraph(el) });
      else if (el.name === 'w:tbl') out.push({ block: this.table(el) });
      // Content controls, and things wrapped in them: what's inside.
      else if (el.name === 'w:sdt') {
        out.push(...this.items(childElements(child(el, 'w:sdtContent') ?? EMPTY)));
      } else if (el.name === 'w:customXml' || el.name === 'w:ins' || el.name === 'w:moveTo') {
        out.push(...this.items(childElements(el)));
      } else if (el.name === 'w:del' || el.name === 'w:moveFrom') {
        this.ctx.warn('Tracked changes: the current text was kept');
      }
    }
    return out;
  }

  private paragraph(p: XmlElement): Para {
    const props = child(p, 'w:pPr');
    let type = this.styleKind(child(props, 'w:pStyle')?.attrs['w:val']);
    const outline = numberOr(child(props, 'w:outlineLvl')?.attrs['w:val']);
    if (type.kind === 'text' && outline !== null && outline < 9) {
      type = { kind: 'heading', level: Math.min(outline + 1, 3) };
    }
    const numPr = child(props, 'w:numPr');
    const numId = child(numPr, 'w:numId')?.attrs['w:val'];
    let list: ListInfo | null = null;
    // (Numbered headings stay headings.)
    if (numId && numId !== '0' && type.kind !== 'heading' && type.kind !== 'title') {
      const level = Number(child(numPr, 'w:ilvl')?.attrs['w:val'] ?? 0);
      list = { numId, level, ordered: this.lists.get(numId)?.get(level) ?? false };
    }
    const after: JSONContent[] = [];
    const inline = this.inline(p.children.filter(isElement), [], after);
    return { type, list, inline: tidy(inline), after };
  }

  // --- Runs ---------------------------------------------------------------------------------

  private marksOf(props: XmlElement | undefined): Mark[] {
    if (!props) return [];
    const marks: Mark[] = [];
    if (on(child(props, 'w:b'))) marks.push({ type: 'bold' });
    if (on(child(props, 'w:i'))) marks.push({ type: 'italic' });
    const u = child(props, 'w:u')?.attrs['w:val'];
    if (u && u !== 'none') marks.push({ type: 'underline' });
    if (on(child(props, 'w:strike')) || on(child(props, 'w:dstrike'))) {
      marks.push({ type: 'strike' });
    }
    const fonts = child(props, 'w:rFonts');
    const style = this.styles.get(child(props, 'w:rStyle')?.attrs['w:val'] ?? '');
    if (
      MONOSPACE.test(fonts?.attrs['w:ascii'] ?? fonts?.attrs['w:hAnsi'] ?? '') ||
      style?.mono ||
      /verbatim|code/.test(style?.name ?? '')
    ) {
      marks.push({ type: 'code' });
    }
    const highlight = child(props, 'w:highlight')?.attrs['w:val'];
    const fill = child(props, 'w:shd')?.attrs['w:fill'];
    const background = highlight ? HIGHLIGHTS[highlight] : fill ? nearestColor(fill) : null;
    const text = nearestColor(child(props, 'w:color')?.attrs['w:val'] ?? '');
    // One colour mark: a background shows more than a text colour.
    if (background) marks.push({ type: 'color', attrs: { color: `${background}_background` } });
    else if (text) marks.push({ type: 'color', attrs: { color: text } });
    return marks;
  }

  /** A paragraph's (or a link's) children as inline content; pictures go to `after`. */
  private inline(nodes: XmlElement[], marks: Mark[], after: JSONContent[]): JSONContent[] {
    const out: JSONContent[] = [];
    const text = (t: string, m: Mark[]) => {
      if (t) out.push({ type: 'text', text: t, ...(m.length ? { marks: m } : {}) });
    };
    for (const node of nodes) {
      switch (node.name) {
        case 'w:r': {
          const runMarks = [...marks, ...this.marksOf(child(node, 'w:rPr'))];
          for (const part of node.children.filter(isElement)) {
            if (part.name === 'w:t') text(textContent(part), runMarks);
            else if (part.name === 'w:tab') text(' ', runMarks);
            else if (part.name === 'w:noBreakHyphen') text('‑', runMarks);
            else if (part.name === 'w:br' || part.name === 'w:cr') {
              if (part.attrs['w:type'] !== 'page' && part.attrs['w:type'] !== 'column') {
                out.push({ type: 'hardBreak' });
              }
            } else if (
              part.name === 'w:drawing' ||
              part.name === 'w:pict' ||
              part.name === 'mc:AlternateContent'
            ) {
              this.picture(part, after);
            } else if (part.name === 'w:footnoteReference') {
              text(`[${this.footnoteNumber(part.attrs['w:id'] ?? '')}]`, marks);
            } else if (part.name === 'w:sym') {
              const code = part.attrs['w:char'];
              if (code) text(String.fromCharCode(parseInt(code, 16) & 0xfff), runMarks);
            }
            // Field codes (`w:instrText`) aren't text: the field's shown result follows them.
          }
          break;
        }
        case 'w:hyperlink': {
          const rel = node.attrs['r:id'] ? this.rels.get(node.attrs['r:id']) : undefined;
          const href = rel?.external && /^(https?|mailto):/i.test(rel.target) ? rel.target : null;
          const link: Mark[] = href ? [{ type: 'link', attrs: { href } }] : [];
          out.push(...this.inline(node.children.filter(isElement), [...marks, ...link], after));
          break;
        }
        case 'w:ins':
        case 'w:moveTo':
        case 'w:smartTag':
        case 'w:customXml':
        case 'w:fldSimple':
        case 'w:bdo':
        case 'w:dir':
          out.push(...this.inline(node.children.filter(isElement), marks, after));
          break;
        case 'w:sdt':
          out.push(
            ...this.inline(childElements(child(node, 'w:sdtContent') ?? EMPTY), marks, after),
          );
          break;
        case 'w:del':
        case 'w:moveFrom':
          this.ctx.warn('Tracked changes: the current text was kept');
          break;
        case 'm:oMath':
        case 'm:oMathPara':
          this.ctx.warn('Equations came over as plain text');
          text(descendants(node, 'm:t').map(textContent).join(''), marks);
          break;
      }
    }
    return out;
  }

  /** A picture (stored, as an image block after its paragraph), or a text box's text. */
  private picture(el: XmlElement, after: JSONContent[]): void {
    // A text box: its paragraphs, after this one.
    const box = descendants(el, 'w:txbxContent')[0];
    if (box) {
      this.ctx.warn('Text boxes came over as plain paragraphs');
      for (const item of this.items(childElements(box))) {
        if ('para' in item && !isEmpty(item.para)) after.push(paragraphNode(item.para.inline));
      }
      return;
    }
    // DrawingML (`a:blip r:embed`), or VML (`v:imagedata r:id`) in older documents.
    const blip = descendants(el, 'a:blip')[0]?.attrs['r:embed'];
    const vml = descendants(el, 'v:imagedata')[0]?.attrs['r:id'];
    const id = blip ?? vml;
    if (!id) return;
    const target = this.pictureTarget(id);
    if (!target || target.kind !== 'file') {
      if (target?.kind === 'missing') this.ctx.warn('A picture in the document couldn’t be read');
      return;
    }
    const alt = descendants(el, 'wp:docPr')[0]?.attrs.descr ?? '';
    after.push({
      type: target.media === 'image' ? 'image' : 'file',
      attrs: { fileId: target.fileId, name: target.name, ...(alt ? { caption: alt } : {}) },
    });
  }

  private pictureTarget(relId: string): LinkTarget | null {
    const known = this.pictures.get(relId);
    if (known) return known;
    const rel = this.rels.get(relId);
    if (!rel || rel.external) return null;
    const path = rel.target.startsWith('/')
      ? rel.target.slice(1)
      : (resolvePath('word/document.xml', rel.target) ?? rel.target);
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (/\.(emf|wmf)$/i.test(name)) {
      this.ctx.warn('Pictures in Windows metafile format (EMF, WMF) weren’t imported');
      return null;
    }
    const bytes = this.parts.get(path);
    const target: LinkTarget = bytes
      ? this.ctx.file(bytes, name, mimeOf(name))
      : { kind: 'missing' };
    this.pictures.set(relId, target);
    return target;
  }

  private footnoteNumber(id: string): number {
    let n = this.footnotes.indexOf(id);
    if (n < 0) n = this.footnotes.push(id) - 1;
    return n + 1;
  }

  private footnoteParagraph(id: string): JSONContent {
    const note = this.footnoteText.get(id);
    const inline = note
      ? childElements(note, 'w:p').flatMap((p, i) => [
          ...(i ? [{ type: 'hardBreak' }] : []),
          ...tidy(this.inline(p.children.filter(isElement), [], [])),
        ])
      : [];
    // Word puts a space after the footnote's own number.
    if (inline[0]?.type === 'text') inline[0] = { ...inline[0], text: inline[0].text?.trimStart() };
    return paragraphNode(inline.filter((n) => n.type !== 'text' || n.text));
  }

  // --- Blocks -------------------------------------------------------------------------------

  /** Paragraphs and tables as blocks: lists nested, code joined, empty lines dropped. */
  private blocks(items: Item[]): JSONContent[] {
    const out: JSONContent[] = [];
    for (let i = 0; i < items.length;) {
      const item = items[i]!;
      if ('block' in item) {
        out.push(item.block);
        i++;
        continue;
      }
      const para = item.para;
      if (para.list) {
        const [lists, next] = this.listsAt(items, i, para.list.level);
        out.push(...lists);
        i = next;
        continue;
      }
      if (para.type.kind === 'code') {
        const lines: string[] = [];
        while (i < items.length) {
          const p = items[i]!;
          if (!('para' in p) || p.para.type.kind !== 'code' || p.para.list) break;
          lines.push(plain(p.para.inline));
          i++;
        }
        out.push({ type: 'codeBlock', content: [{ type: 'text', text: lines.join('\n') }] });
        continue;
      }
      i++;
      // A picture's caption (Word's "Caption" style, right after it): the picture's own.
      const last = out.at(-1);
      if (
        para.type.kind === 'caption' &&
        (last?.type === 'image' || last?.type === 'file') &&
        !last.attrs?.caption
      ) {
        last.attrs = { ...last.attrs, caption: plain(para.inline).trim() };
        continue;
      }
      if (
        para.type.kind === 'caption' &&
        last?.type === 'image' &&
        last.attrs?.caption === plain(para.inline).trim()
      ) {
        continue;
      }
      // (A paragraph that only holds a picture or a text box is just what it holds.)
      if (plain(para.inline).trim()) out.push(this.paragraphBlock(para));
      out.push(...para.after);
    }
    return out;
  }

  private paragraphBlock(para: Para): JSONContent {
    const content = para.inline.length ? { content: para.inline } : {};
    switch (para.type.kind) {
      case 'heading':
        return { type: 'heading', attrs: { level: para.type.level }, ...content };
      case 'title':
        return { type: 'heading', attrs: { level: 1 }, ...content };
      case 'quote':
        return { type: 'blockquote', content: [paragraphNode(para.inline)] };
      default:
        return paragraphNode(para.inline);
    }
  }

  /**
   * The lists starting at `items[start]`, at `level`: consecutive list paragraphs, nested by
   * their level. Returns the lists and the index after them.
   */
  private listsAt(items: Item[], start: number, level: number): [JSONContent[], number] {
    const lists: JSONContent[] = [];
    let current: JSONContent | null = null;
    let kind: string | null = null;
    let i = start;
    while (i < items.length) {
      const item = items[i]!;
      if (!('para' in item) || !item.para.list || item.para.list.level < level) break;
      const para = item.para;
      const list = para.list!;
      if (list.level > level) {
        // Deeper: nested inside the last item (or a list of its own if there's none yet).
        const [nested, next] = this.listsAt(items, i, list.level);
        const last = current?.content?.at(-1);
        if (last) last.content = [...(last.content ?? []), ...nested];
        else lists.push(...nested);
        i = next;
        continue;
      }
      const check = /^\s*([☐☑☒])\s*/.exec(plain(para.inline));
      const itemKind = check ? 'taskList' : list.ordered ? 'orderedList' : 'bulletList';
      if (!current || kind !== itemKind) {
        current = {
          type: itemKind,
          ...(itemKind === 'orderedList' ? { attrs: { start: 1 } } : {}),
          content: [],
        };
        kind = itemKind;
        lists.push(current);
      }
      const inline = check ? dropPrefix(para.inline, check[0].length) : para.inline;
      current.content!.push({
        type: check ? 'taskItem' : 'listItem',
        ...(check ? { attrs: { checked: check[1] !== '☐' } } : {}),
        content: [paragraphNode(inline), ...para.after],
      });
      i++;
    }
    return [lists, i];
  }

  private table(tbl: XmlElement): JSONContent {
    const rows: JSONContent[] = [];
    childElements(tbl, 'w:tr').forEach((tr, r) => {
      const header = r === 0 && child(child(tr, 'w:trPr'), 'w:tblHeader') !== undefined;
      const cells: JSONContent[] = [];
      for (const tc of childElements(tr, 'w:tc')) {
        const props = child(tc, 'w:tcPr');
        const span = Number(child(props, 'w:gridSpan')?.attrs['w:val'] ?? 1);
        const merge = child(props, 'w:vMerge');
        const continued = merge !== undefined && merge.attrs['w:val'] !== 'restart';
        const content = continued ? [] : this.cellBlocks(childElements(tc));
        cells.push({
          type: header ? 'tableHeader' : 'tableCell',
          ...(span > 1 ? { attrs: { colspan: span } } : {}),
          content: content.length ? content : [{ type: 'paragraph' }],
        });
      }
      if (cells.length) rows.push({ type: 'tableRow', content: cells });
    });
    return { type: 'table', content: rows };
  }

  /** A cell's content: paragraphs (lists as plain paragraphs, nested tables as text). */
  private cellBlocks(elements: XmlElement[]): JSONContent[] {
    const out: JSONContent[] = [];
    for (const item of this.items(elements)) {
      if ('block' in item) {
        out.push(paragraphNode([{ type: 'text', text: tableText(item.block) }]));
        continue;
      }
      if (!isEmpty(item.para)) {
        const prefix = item.para.list ? (item.para.list.ordered ? '' : '• ') : '';
        const inline = prefix
          ? [{ type: 'text', text: prefix }, ...item.para.inline]
          : item.para.inline;
        out.push(paragraphNode(inline));
      }
      out.push(...item.para.after.filter((b) => b.type === 'paragraph' || b.type === 'image'));
    }
    return out;
  }
}

const EMPTY: XmlElement = { name: '#empty', attrs: {}, children: [] };

const numberOr = (value: string | undefined) =>
  value !== undefined && /^\d+$/.test(value) ? Number(value) : null;

const plain = (inline: JSONContent[]) =>
  inline
    .map((n) => (n.type === 'text' ? (n.text ?? '') : n.type === 'hardBreak' ? '\n' : ''))
    .join('');

const isEmpty = (para: Para) => !plain(para.inline).trim() && para.after.length === 0;

const paragraphNode = (inline: JSONContent[]): JSONContent =>
  inline.length ? { type: 'paragraph', content: inline } : { type: 'paragraph' };

/** Join neighbouring text with the same marks; drop empty text. */
function tidy(inline: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const node of inline) {
    const last = out.at(-1);
    if (
      node.type === 'text' &&
      last?.type === 'text' &&
      JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])
    ) {
      last.text = (last.text ?? '') + (node.text ?? '');
    } else if (node.type !== 'text' || node.text) out.push({ ...node });
  }
  // No line break at either end.
  while (out[0]?.type === 'hardBreak') out.shift();
  while (out.at(-1)?.type === 'hardBreak') out.pop();
  return out;
}

/** Inline content without its first `count` characters (a checklist's box). */
function dropPrefix(inline: JSONContent[], count: number): JSONContent[] {
  const out: JSONContent[] = [];
  let left = count;
  for (const node of inline) {
    if (left > 0 && node.type === 'text') {
      const text = node.text ?? '';
      if (text.length <= left) {
        left -= text.length;
        continue;
      }
      out.push({ ...node, text: text.slice(left) });
      left = 0;
    } else out.push(node);
  }
  return out;
}

const tableText = (table: JSONContent): string =>
  (table.content ?? [])
    .map((row) =>
      (row.content ?? [])
        .map((cell) => (cell.content ?? []).map((p) => plain(p.content ?? [])).join(' '))
        .join(' | '),
    )
    .join('\n');

// --- The import -----------------------------------------------------------------------------

const baseName = (path: string) =>
  path
    .slice(path.lastIndexOf('/') + 1)
    .replace(/\.docx$/i, '')
    .trim();

/**
 * Import Word documents: one becomes the page made for the import; several, a page each under
 * it. A file that isn't a readable document is said in the warnings.
 */
export function importDocx(
  files: readonly ArchiveFile[],
  target: ImportTarget,
  options: ImportOptions,
): ImportReport {
  const build = new ImportBuilder(target, options);
  const ctx: DocxContext = {
    file: (bytes, name, mime) => build.file(bytes, name, mime),
    warn: (message) => build.warn(message),
  };
  files.forEach((file, i) => {
    let doc: DocxDocument | null = null;
    try {
      doc = readDocx(file.data, ctx);
    } catch (error) {
      build.warn(
        error instanceof Error && error.message === 'too large'
          ? `“${baseName(file.path)}” is too large to import`
          : `“${baseName(file.path)}” couldn’t be read as a Word document`,
      );
    }
    const title = doc?.title || baseName(file.path) || 'Untitled';
    if (files.length === 1) {
      const id = build.usePage();
      if (doc?.title) setPageTitle(target.workspace, id, title);
      build.content(id, doc?.blocks ?? []);
    } else if (doc) {
      build.content(build.page(title), doc.blocks);
    }
    options.onProgress?.(i + 1, files.length);
  });
  return build.done();
}
