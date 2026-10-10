/**
 * Comments in Notion's JSON (Phase 6 M6). A comment's body here is plain text, with
 * `<@userId>` for a mention of someone; Notion's is rich text.
 */
import { invalid } from './errors';
import {
  richTextIn,
  richTextOut,
  type BlockContext,
  type PMNode,
  type WriteContext,
} from './blocks';

const MENTION = /<@([0-9a-f-]{36})>/g;

/** A comment's body as rich text (mentions of people as mentions). */
export function commentRichText(body: string, ctx: BlockContext) {
  const inline: PMNode[] = [];
  let at = 0;
  for (const m of body.matchAll(MENTION)) {
    if (m.index > at) inline.push({ type: 'text', text: body.slice(at, m.index) });
    inline.push({ type: 'mention', attrs: { kind: 'user', userId: m[1] } });
    at = m.index + m[0].length;
  }
  if (at < body.length) inline.push({ type: 'text', text: body.slice(at) });
  return richTextOut(inline, ctx);
}

/** Rich text sent for a comment, as its body (formatting dropped; people's mentions kept). */
export function commentBodyIn(raw: unknown, ctx: WriteContext): string {
  const inline = richTextIn(raw, 'body.rich_text', ctx);
  const body = inline
    .map((n) => {
      if (n.type === 'text') return n.text ?? '';
      if (n.type === 'hardBreak') return '\n';
      if (n.type === 'mention' && n.attrs?.kind === 'user') return `<@${String(n.attrs.userId)}>`;
      if (n.type === 'mention' && n.attrs?.kind === 'date') return String(n.attrs.date);
      if (n.type === 'inlineMath') return String(n.attrs?.latex ?? '');
      return '';
    })
    .join('')
    .trim();
  if (!body) throw invalid('body.rich_text should have some text.');
  if (body.length > 10_000) throw invalid('body.rich_text is too long.');
  return body;
}
