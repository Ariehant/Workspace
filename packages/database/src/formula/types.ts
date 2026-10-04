/** Static types of formula values. */
export type FType =
  | { kind: 'number' | 'text' | 'boolean' | 'date' | 'person' | 'page' | 'empty' | 'any' }
  | { kind: 'list'; of: FType };

export const T = {
  number: { kind: 'number' },
  text: { kind: 'text' },
  boolean: { kind: 'boolean' },
  date: { kind: 'date' },
  person: { kind: 'person' },
  page: { kind: 'page' },
  empty: { kind: 'empty' },
  any: { kind: 'any' },
  list: (of: FType): FType => ({ kind: 'list', of }),
} as const satisfies Record<string, FType | ((of: FType) => FType)>;

/** "number", "list of text", ... */
export function typeName(t: FType): string {
  return t.kind === 'list' ? `list of ${typeName(t.of)}` : t.kind;
}

/** Whether a value of type `from` can be used where `to` is expected. */
export function assignable(from: FType, to: FType): boolean {
  if (to.kind === 'any' || from.kind === 'any' || from.kind === 'empty') return true;
  if (to.kind === 'list') return from.kind === 'list' && assignable(from.of, to.of);
  return from.kind === to.kind;
}

/** The common type of two branches (`if`), or any. */
export function unify(a: FType, b: FType): FType {
  if (a.kind === 'empty') return b;
  if (b.kind === 'empty') return a;
  if (a.kind === 'list' && b.kind === 'list') return T.list(unify(a.of, b.of));
  return a.kind === b.kind ? a : T.any;
}

export const elementType = (t: FType): FType => (t.kind === 'list' ? t.of : T.any);

// --- Runtime values ------------------------------------------------------------------

/** A date or date range; times are local. */
export interface FDate {
  kind: 'date';
  start: number;
  end: number | null;
  /** Whether it includes a time of day. */
  time: boolean;
}

export interface FPerson {
  kind: 'person';
  id: string;
  name: string;
  email: string;
}

export interface FPage {
  kind: 'page';
  id: string;
  title: string;
}

export type FValue = number | string | boolean | FDate | FPerson | FPage | FValue[] | null;

export const isDate = (v: FValue): v is FDate =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && v.kind === 'date';
export const isPerson = (v: FValue): v is FPerson =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && v.kind === 'person';
export const isPage = (v: FValue): v is FPage =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && v.kind === 'page';

/** The runtime type of a value (lists by their first element). */
export function typeOf(v: FValue): FType {
  if (v === null) return T.empty;
  if (typeof v === 'number') return T.number;
  if (typeof v === 'string') return T.text;
  if (typeof v === 'boolean') return T.boolean;
  if (Array.isArray(v)) return T.list(v.length ? typeOf(v[0]!) : T.any);
  return { kind: v.kind };
}

/** A position in the formula text, for errors. */
export interface Span {
  start: number;
  end: number;
}

export class FormulaError extends Error {
  constructor(
    message: string,
    readonly span: Span,
  ) {
    super(message);
  }
}
