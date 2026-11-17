/**
 * Rich text for property values. Titles are plain strings (formatting sent in is dropped);
 * text properties keep bold, italic, strikethrough, underline, code, colour and links (as
 * `RichSpan`s beside their plain value). Page content's rich text is the blocks'.
 */
import type { RichSpan } from '@workspace/database';
import { invalid } from './errors';

/** Notion's limit per rich text item. */
export const MAX_TEXT = 2000;

export interface Annotations {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  color: string;
}

export interface RichTextItem {
  type: 'text';
  text: { content: string; link: { url: string } | null };
  annotations: Annotations;
  plain_text: string;
  href: string | null;
}

export const PLAIN: Annotations = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
};

/** A string as rich text: items of at most 2,000 characters (none for an empty string). */
export function richText(text: string): RichTextItem[] {
  const items: RichTextItem[] = [];
  for (let i = 0; i < text.length; i += MAX_TEXT) {
    const content = text.slice(i, i + MAX_TEXT);
    items.push({
      type: 'text',
      text: { content, link: null },
      annotations: { ...PLAIN },
      plain_text: content,
      href: null,
    });
  }
  return items;
}

/**
 * The text of rich text sent in: `text` items (their content), and mentions and
 * equations by their plain text, if given. Refuses what isn't rich text.
 */
export function readRichText(input: unknown, where: string): string {
  if (!Array.isArray(input)) throw invalid(`${where} should be an array of rich text.`);
  if (input.length > 100) throw invalid(`${where} should have at most 100 items.`);
  let out = '';
  input.forEach((item, i) => {
    if (!item || typeof item !== 'object') throw invalid(`${where}[${i}] should be an object.`);
    const it = item as {
      type?: unknown;
      text?: { content?: unknown };
      equation?: { expression?: unknown };
      plain_text?: unknown;
    };
    const type = it.type ?? (it.text ? 'text' : undefined);
    let piece: unknown;
    if (type === 'text') piece = it.text?.content;
    else if (type === 'equation') piece = it.equation?.expression;
    else if (type === 'mention') piece = it.plain_text ?? '';
    else throw invalid(`${where}[${i}].type should be "text", "mention" or "equation".`);
    if (typeof piece !== 'string') throw invalid(`${where}[${i}] should have text content.`);
    if (piece.length > MAX_TEXT) {
      throw invalid(`${where}[${i}].text.content.length should be ≤ ${MAX_TEXT}.`);
    }
    out += piece;
  });
  return out;
}

const COLORS = new Set(
  ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'].flatMap((c) => [
    c,
    `${c}_background`,
  ]),
);

/** Formatted text as rich text items (each at most 2,000 characters). */
export function richTextFromSpans(spans: readonly RichSpan[]): RichTextItem[] {
  return spans.flatMap((span) => {
    const annotations: Annotations = {
      bold: span.bold === true,
      italic: span.italic === true,
      strikethrough: span.strike === true,
      underline: span.underline === true,
      code: span.code === true,
      color: span.color && COLORS.has(span.color) ? span.color : 'default',
    };
    const link = span.link ?? null;
    return richText(span.text).map((item) => ({
      ...item,
      text: { content: item.text.content, link: link ? { url: link } : null },
      annotations,
      href: link,
    }));
  });
}

/**
 * Rich text sent in as formatted text: annotations and links kept, mentions and equations
 * as their plain text. Refuses what isn't rich text.
 */
export function readRichSpans(input: unknown, where: string): RichSpan[] {
  // Checks the shape (and gives the same errors) as the plain reading.
  readRichText(input, where);
  return (input as Record<string, unknown>[]).map((item) => {
    const type = item.type ?? (item.text ? 'text' : undefined);
    const text =
      type === 'text'
        ? String((item.text as { content: string }).content)
        : type === 'equation'
          ? String((item.equation as { expression: string }).expression)
          : String(item.plain_text ?? '');
    const span: RichSpan = { text };
    const a = (item.annotations ?? {}) as Partial<Record<keyof Annotations, unknown>>;
    if (a.bold === true) span.bold = true;
    if (a.italic === true) span.italic = true;
    if (a.strikethrough === true) span.strike = true;
    if (a.underline === true) span.underline = true;
    if (a.code === true || type === 'equation') span.code = true;
    if (typeof a.color === 'string' && COLORS.has(a.color)) span.color = a.color;
    const link =
      type === 'text' ? (item.text as { link?: { url?: unknown } | null }).link?.url : undefined;
    if (typeof link === 'string' && /^(https?:|mailto:)/i.test(link)) span.link = link;
    return span;
  });
}
