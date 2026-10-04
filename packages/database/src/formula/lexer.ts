import { FormulaError } from './types';

export type TokenType = 'number' | 'string' | 'ident' | 'op' | 'punct' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
}

const OPERATORS = [
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '<',
  '>',
  '!',
  '?',
  ':',
];
const PUNCT = ['(', ')', '[', ']', ',', '.'];

/** Split formula text into tokens; comments and whitespace are skipped. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (type: TokenType, value: string, start: number) =>
    tokens.push({ type, value, start, end: i });

  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(source.slice(i))!;
      i += m[0].length;
      push('number', m[0], start);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '“' || ch === '”') {
      const quote = ch === '“' || ch === '”' ? '”' : ch;
      i++;
      let value = '';
      while (i < source.length && source[i] !== quote && !(quote === '”' && source[i] === '“')) {
        if (source[i] === '\\' && i + 1 < source.length) {
          const next = source[i + 1]!;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
        } else value += source[i++];
      }
      if (i >= source.length) throw new FormulaError('Missing closing quote', { start, end: i });
      i++;
      push('string', value, start);
      continue;
    }
    if (/[\p{L}_$]/u.test(ch)) {
      const m = /^[\p{L}\p{N}_$]+/u.exec(source.slice(i))!;
      i += m[0].length;
      push('ident', m[0], start);
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      i += op.length;
      push('op', op, start);
      continue;
    }
    if (PUNCT.includes(ch)) {
      i++;
      push('punct', ch, start);
      continue;
    }
    throw new FormulaError(`Unexpected character "${ch}"`, { start, end: start + 1 });
  }
  tokens.push({ type: 'eof', value: '', start: i, end: i });
  return tokens;
}
