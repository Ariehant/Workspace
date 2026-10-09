/**
 * Rich text for property values (titles and text properties). Their values here are
 * plain strings, so formatting sent in is dropped and none comes out; page content's
 * rich text (marks, mentions, equations) is the blocks' (M6).
 */
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
