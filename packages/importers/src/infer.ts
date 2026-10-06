import type { PropertyType } from '@workspace/database';

const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const TIME = '(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2})?(?: ?[ap]m)?(?: \\(?[A-Z]{2,5}\\)?)?)?';
const ONE_DATE = `(?:\\d{4}-\\d{2}-\\d{2}|\\d{4}/\\d{1,2}/\\d{1,2}|${MONTH} \\d{1,2}, \\d{4})${TIME}`;
/** A date or a range, as Notion and ISO write them (strict: `Date` accepts too much). */
export const DATE_TEXT = new RegExp(`^${ONE_DATE}(?: ?(?:→|->) ?${ONE_DATE})?$`, 'i');
const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?%?$/;
const URL = /^https?:\/\/\S+$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHECKBOX = /^(yes|no|true|false)$/i;

/** Numbers as exported: `1,234.5`, `12%`. */
export function parseNumber(text: string): number | null {
  const t = text.trim();
  if (!t || !NUMBER.test(t) || !/\d/.test(t)) return null;
  const n = Number(t.replace(/[,%]/g, ''));
  return Number.isFinite(n) ? (t.endsWith('%') ? n / 100 : n) : null;
}

/** Values of a multi-select cell (`a, b`). */
export const splitList = (text: string) =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

/**
 * The property type a CSV column most likely had, from its values. Relations are found
 * separately (they need the other databases).
 */
export function inferType(values: readonly string[]): PropertyType {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (filled.length === 0) return 'text';
  const all = (test: (v: string) => boolean) => filled.every(test);
  if (all((v) => CHECKBOX.test(v)) && values.length === filled.length) return 'checkbox';
  if (all((v) => parseNumber(v) !== null)) return 'number';
  if (all((v) => DATE_TEXT.test(v))) return 'date';
  if (all((v) => URL.test(v))) return 'url';
  if (all((v) => EMAIL.test(v))) return 'email';
  if (filled.some((v) => v.length > 60)) return 'text';
  const tokens = filled.flatMap(splitList);
  const distinct = new Set(tokens);
  const repeats = distinct.size < tokens.length;
  if (filled.some((v) => v.includes(',')) && repeats && distinct.size <= 40) return 'multiSelect';
  if (
    !filled.some((v) => v.includes(',')) &&
    distinct.size <= 15 &&
    (repeats || filled.length <= 3)
  )
    return 'select';
  return 'text';
}
