/**
 * Formatted text in text properties. The cell's value stays its plain text (filters, sorting,
 * search, formulas and CSV read that); the formatting is kept beside it as runs, and counts
 * only while their text is the value (a plain write anywhere drops it).
 */

/** A run of text with one formatting. */
export interface RichSpan {
  text: string;
  bold?: true;
  italic?: true;
  underline?: true;
  strike?: true;
  code?: true;
  /** A text or background colour, as the editor names them (`red`, `blue_background`). */
  color?: string;
  /** A link's address. */
  link?: string;
}

const FORMATS = ['bold', 'italic', 'underline', 'strike', 'code'] as const;

export const plainOf = (spans: readonly RichSpan[]): string => spans.map((s) => s.text).join('');

const sameFormat = (a: RichSpan, b: RichSpan) =>
  FORMATS.every((f) => a[f] === b[f]) && a.color === b.color && a.link === b.link;

/** Runs cleaned up: known fields only, empty runs dropped, neighbours alike joined. */
export function normalizeSpans(spans: readonly unknown[]): RichSpan[] {
  const out: RichSpan[] = [];
  for (const raw of spans) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.text !== 'string' || s.text === '') continue;
    const span: RichSpan = { text: s.text };
    for (const f of FORMATS) if (s[f] === true) span[f] = true;
    if (typeof s.color === 'string' && s.color && s.color !== 'default') span.color = s.color;
    if (typeof s.link === 'string' && s.link) span.link = s.link;
    const last = out.at(-1);
    if (last && sameFormat(last, span)) last.text += span.text;
    else out.push(span);
  }
  return out;
}

/** No formatting at all: plain text is enough. */
export const isPlain = (spans: readonly RichSpan[]) =>
  spans.every((s) => sameFormat(s, { text: '' }));

/**
 * A cell's formatted text: its runs when they still match the value, else the value as one
 * plain run (or none when empty).
 */
export function richOf(
  row: { values: Record<string, unknown>; rich?: Record<string, unknown> },
  propertyId: string,
): RichSpan[] {
  const value = row.values[propertyId];
  const text = typeof value === 'string' ? value : '';
  const stored = row.rich?.[propertyId];
  if (Array.isArray(stored)) {
    const spans = normalizeSpans(stored);
    if (plainOf(spans) === text && text) return spans;
  }
  return text ? [{ text }] : [];
}

const escapeMarkdown = (text: string) => text.replace(/([\\`*_[\]<>~])/g, '\\$1');

/** Markdown (Notion's flavour: `**`, `*`, `~~`, `` ` ``, links; underline and colours drop). */
export function spansToMarkdown(spans: readonly RichSpan[]): string {
  return spans
    .map((s) => {
      // Markers can't wrap surrounding spaces: keep them outside.
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.text)!;
      if (!core) return s.text;
      let text = s.code ? `\`${core!.replace(/`/g, 'ˋ')}\`` : escapeMarkdown(core!);
      if (s.bold) text = `**${text}**`;
      if (s.italic) text = `*${text}*`;
      if (s.strike) text = `~~${text}~~`;
      if (s.link) text = `[${text}](${s.link.replace(/[()\s]/g, encodeURIComponent)})`;
      return `${lead}${text}${trail}`;
    })
    .join('');
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** HTML, with the same classes the page export uses for colours (`color-red`, `bg-blue`). */
export function spansToHtml(spans: readonly RichSpan[]): string {
  return spans
    .map((s) => {
      let html = escapeHtml(s.text).replace(/\n/g, '<br>');
      if (s.code) html = `<code>${html}</code>`;
      if (s.bold) html = `<strong>${html}</strong>`;
      if (s.italic) html = `<em>${html}</em>`;
      if (s.underline) html = `<u>${html}</u>`;
      if (s.strike) html = `<s>${html}</s>`;
      if (s.color) {
        const bg = s.color.endsWith('_background');
        const name = s.color.replace(/_background$/, '');
        html = `<span class="${bg ? 'bg' : 'color'}-${escapeHtml(name)}">${html}</span>`;
      }
      if (s.link && /^(https?:|mailto:|workspace:)/i.test(s.link)) {
        html = `<a href="${escapeHtml(s.link)}">${html}</a>`;
      }
      return html;
    })
    .join('');
}
