import {
  T,
  elementType,
  isDate,
  isPage,
  isPerson,
  typeOf,
  unify,
  type FDate,
  type FType,
  type FValue,
} from './types';
import {
  addUnits,
  compareValues,
  dateValue,
  formatDateTokens,
  formatValue,
  isEmptyValue,
  isoWeek,
  normalizeUnit,
  parseIsoDate,
  startOfDay,
  unitsBetween,
  valuesEqual,
} from './values';

/** What a function sees when it runs: lazily evaluated arguments. */
export interface CallContext {
  count: number;
  value(i: number): FValue;
  /** Evaluate a lambda argument with `current` (and `index`) bound. */
  lambda(i: number, current: FValue, index: number): FValue;
  fail(message: string): never;
  /** The row's page, for `id()`. */
  page: { id: string; title: string };
  now: number;
}

export type Category = 'Logic' | 'Text' | 'Math' | 'Date' | 'List' | 'People' | 'Special';

export interface FnDef {
  name: string;
  category: Category;
  /** Shown in the editor: `dateAdd(date, number, text) → date`. */
  signature: string;
  description: string;
  example: string;
  /** Parameter types (`number`, `list<text>`, `lambda`, `any`; `?` optional, `...` repeats). */
  params: string[];
  returns: FType | ((args: FType[]) => FType);
  run(c: CallContext): FValue;
}

// --- Argument helpers -------------------------------------------------------------------

const num = (c: CallContext, i: number): number => {
  const v = c.value(i);
  if (v === null) return 0;
  if (typeof v !== 'number') c.fail(`Expected a number, got ${formatValue(v)}`);
  return v as number;
};
const text = (c: CallContext, i: number): string => {
  const v = c.value(i);
  if (v === null) return '';
  if (typeof v !== 'string') return formatValue(v);
  return v;
};
const list = (c: CallContext, i: number): FValue[] => {
  const v = c.value(i);
  if (v === null) return [];
  if (!Array.isArray(v)) c.fail('Expected a list');
  return v as FValue[];
};
const date = (c: CallContext, i: number): FDate | null => {
  const v = c.value(i);
  if (v === null) return null;
  if (!isDate(v)) c.fail('Expected a date');
  return v as FDate;
};
const regex = (c: CallContext, pattern: string, flags = ''): RegExp => {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return c.fail(`Invalid regular expression: ${pattern}`);
  }
};
/** All numbers among the arguments, flattening lists: `max(1, [2, 3])`. */
const numbers = (c: CallContext): number[] => {
  const out: number[] = [];
  const add = (v: FValue) => {
    if (Array.isArray(v)) v.forEach(add);
    else if (typeof v === 'number') out.push(v);
    else if (v !== null) c.fail(`Expected numbers, got ${formatValue(v)}`);
  };
  for (let i = 0; i < c.count; i++) add(c.value(i));
  return out;
};
const unit = (c: CallContext, i: number): string =>
  normalizeUnit(text(c, i)) ?? c.fail(`Unknown unit "${text(c, i)}"`);

const arg0 = (args: FType[]) => args[0] ?? T.any;
const elem0 = (args: FType[]) => elementType(args[0] ?? T.any);
const listOfElem0 = (args: FType[]) => T.list(elem0(args));

// --- The library ------------------------------------------------------------------------

const F: FnDef[] = [];
const def = (
  name: string,
  category: Category,
  params: string[],
  returns: FnDef['returns'],
  description: string,
  example: string,
  run: FnDef['run'],
) => {
  const ret =
    typeof returns === 'function'
      ? 'any'
      : typeof returns === 'object' && 'of' in returns
        ? `list`
        : returns.kind;
  F.push({
    name,
    category,
    signature: `${name}(${params.join(', ')}) → ${ret}`,
    description,
    example,
    params,
    returns,
    run,
  });
};

// Logic
def(
  'if',
  'Logic',
  ['boolean', 'any', 'any'],
  (a) => unify(a[1] ?? T.any, a[2] ?? T.any),
  'The second value if the condition is true, else the third.',
  'if(prop("Done"), "✅", "⏳")',
  (c) => (c.value(0) === true ? c.value(1) : c.value(2)),
);
def(
  'ifs',
  'Logic',
  ['boolean', 'any', '...any'],
  (a) => a.filter((_, i) => i % 2 === 1 || i === a.length - 1).reduce(unify, T.empty),
  'The value after the first true condition; a final odd value is the default.',
  'ifs(prop("N") > 10, "big", prop("N") > 5, "medium", "small")',
  (c) => {
    for (let i = 0; i + 1 < c.count; i += 2) if (c.value(i) === true) return c.value(i + 1);
    return c.count % 2 === 1 ? c.value(c.count - 1) : null;
  },
);
def(
  'and',
  'Logic',
  ['boolean', '...boolean'],
  T.boolean,
  'True if every value is true.',
  'and(true, false) == false',
  (c) => {
    for (let i = 0; i < c.count; i++) if (c.value(i) !== true) return false;
    return true;
  },
);
def(
  'or',
  'Logic',
  ['boolean', '...boolean'],
  T.boolean,
  'True if any value is true.',
  'or(true, false) == true',
  (c) => {
    for (let i = 0; i < c.count; i++) if (c.value(i) === true) return true;
    return false;
  },
);
def(
  'not',
  'Logic',
  ['boolean'],
  T.boolean,
  'The opposite of a boolean.',
  'not(true) == false',
  (c) => c.value(0) !== true,
);
def(
  'empty',
  'Logic',
  ['any'],
  T.boolean,
  'True for empty values, "", 0, false and [].',
  'empty(prop("Notes"))',
  (c) => isEmptyValue(c.value(0)),
);
def(
  'equal',
  'Logic',
  ['any', 'any'],
  T.boolean,
  'True if both values are equal (like ==).',
  'equal(1, 1)',
  (c) => valuesEqual(c.value(0), c.value(1)),
);
def(
  'unequal',
  'Logic',
  ['any', 'any'],
  T.boolean,
  'True if the values differ (like !=).',
  'unequal(1, 2)',
  (c) => !valuesEqual(c.value(0), c.value(1)),
);
def(
  'larger',
  'Logic',
  ['any', 'any'],
  T.boolean,
  'True if the first is greater (like >).',
  'larger(2, 1)',
  (c) => compareValues(c.value(0), c.value(1)) > 0,
);
def(
  'largerEq',
  'Logic',
  ['any', 'any'],
  T.boolean,
  'True if the first is greater or equal (like >=).',
  'largerEq(2, 2)',
  (c) => compareValues(c.value(0), c.value(1)) >= 0,
);
def(
  'smaller',
  'Logic',
  ['any', 'any'],
  T.boolean,
  'True if the first is smaller (like <).',
  'smaller(1, 2)',
  (c) => compareValues(c.value(0), c.value(1)) < 0,
);
def(
  'smallerEq',
  'Logic',
  ['any', 'any'],
  T.boolean,
  'True if the first is smaller or equal (like <=).',
  'smallerEq(1, 1)',
  (c) => compareValues(c.value(0), c.value(1)) <= 0,
);

// Text
def(
  'length',
  'Text',
  ['any'],
  T.number,
  'Characters in a text, or items in a list.',
  'length("Notion") == 6',
  (c) => {
    const v = c.value(0);
    if (Array.isArray(v)) return v.length;
    return v === null ? 0 : formatValue(v).length;
  },
);
def(
  'substring',
  'Text',
  ['text', 'number', 'number?'],
  T.text,
  'The text from a start index up to (not including) an end index.',
  'substring("Notion", 0, 3) == "Not"',
  (c) => text(c, 0).substring(num(c, 1), c.count > 2 ? num(c, 2) : undefined),
);
def(
  'contains',
  'Text',
  ['any', 'any'],
  T.boolean,
  'True if the text (or list) contains the value.',
  'contains("Notion", "ion")',
  (c) => {
    const v = c.value(0);
    if (Array.isArray(v)) return v.some((x) => valuesEqual(x, c.value(1)));
    return text(c, 0).includes(text(c, 1));
  },
);
def(
  'test',
  'Text',
  ['text', 'text'],
  T.boolean,
  'True if the text matches a regular expression.',
  'test("Order #42", "\\\\d+")',
  (c) => regex(c, text(c, 1)).test(text(c, 0)),
);
def(
  'match',
  'Text',
  ['text', 'text'],
  T.list(T.text),
  'Every match of a regular expression.',
  'match("a1b22", "\\\\d+") == ["1", "22"]',
  (c) => text(c, 0).match(regex(c, text(c, 1), 'g')) ?? [],
);
def(
  'replace',
  'Text',
  ['text', 'text', 'text'],
  T.text,
  'Replace the first match of a regular expression.',
  'replace("a-b-c", "-", "+") == "a+b-c"',
  (c) => text(c, 0).replace(regex(c, text(c, 1)), text(c, 2)),
);
def(
  'replaceAll',
  'Text',
  ['text', 'text', 'text'],
  T.text,
  'Replace every match of a regular expression.',
  'replaceAll("a-b-c", "-", "+") == "a+b+c"',
  (c) => text(c, 0).replace(regex(c, text(c, 1), 'g'), text(c, 2)),
);
def('lower', 'Text', ['text'], T.text, 'Lowercase text.', 'lower("ABC") == "abc"', (c) =>
  text(c, 0).toLowerCase(),
);
def('upper', 'Text', ['text'], T.text, 'Uppercase text.', 'upper("abc") == "ABC"', (c) =>
  text(c, 0).toUpperCase(),
);
def(
  'trim',
  'Text',
  ['text'],
  T.text,
  'Text without spaces at either end.',
  'trim("  a  ") == "a"',
  (c) => text(c, 0).trim(),
);
def(
  'repeat',
  'Text',
  ['text', 'number'],
  T.text,
  'Text repeated a number of times.',
  'repeat("ab", 3) == "ababab"',
  (c) => text(c, 0).repeat(Math.max(0, Math.floor(num(c, 1)))),
);
def(
  'padStart',
  'Text',
  ['text', 'number', 'text'],
  T.text,
  'Pad the start of a text to a length.',
  'padStart("7", 3, "0") == "007"',
  (c) => text(c, 0).padStart(num(c, 1), text(c, 2)),
);
def(
  'padEnd',
  'Text',
  ['text', 'number', 'text'],
  T.text,
  'Pad the end of a text to a length.',
  'padEnd("7", 3, "0") == "700"',
  (c) => text(c, 0).padEnd(num(c, 1), text(c, 2)),
);
def(
  'split',
  'Text',
  ['text', 'text'],
  T.list(T.text),
  'Split a text into a list at a separator.',
  'split("a,b", ",") == ["a", "b"]',
  (c) => text(c, 0).split(text(c, 1)),
);
def(
  'join',
  'Text',
  ['list', 'text'],
  T.text,
  'Join a list into text with a separator.',
  'join(["a", "b"], "-") == "a-b"',
  (c) => list(c, 0).map(formatValue).join(text(c, 1)),
);
def('format', 'Text', ['any'], T.text, 'Any value as text.', 'format(42) == "42"', (c) =>
  formatValue(c.value(0)),
);
def(
  'toNumber',
  'Text',
  ['any'],
  T.number,
  'A value as a number (dates become timestamps).',
  'toNumber("42") == 42',
  (c) => {
    const v = c.value(0);
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v !== null && isDate(v)) return v.start;
    const n = Number(formatValue(v).replace(/,/g, '').trim());
    return formatValue(v).trim() === '' || Number.isNaN(n) ? null : n;
  },
);
def(
  'link',
  'Text',
  ['text', 'text'],
  T.text,
  'A link with a label (shown as the label).',
  'link("Notion", "https://notion.so")',
  (c) => text(c, 0),
);
def(
  'style',
  'Text',
  ['text', '...text'],
  T.text,
  'Styled text ("b", "i", "u", "s", "c", colors). Styles show as plain text here.',
  'style("Hi", "b", "red")',
  (c) => text(c, 0),
);
def('unstyle', 'Text', ['text', '...text'], T.text, 'Text without styles.', 'unstyle("Hi")', (c) =>
  text(c, 0),
);
def(
  'concat',
  'Text',
  ['any', '...any'],
  (a) =>
    a.every((t) => t.kind === 'list') ? T.list(a.map(elementType).reduce(unify, T.empty)) : T.text,
  'Join lists into one list (or texts into one text).',
  'concat([1, 2], [3]) == [1, 2, 3]',
  (c) => {
    const values = Array.from({ length: c.count }, (_, i) => c.value(i));
    if (values.every((v) => Array.isArray(v) || v === null))
      return values.flatMap((v) => (v === null ? [] : (v as FValue[])));
    return values.map(formatValue).join('');
  },
);

// Math
const math = (
  name: string,
  description: string,
  example: string,
  fn: (...n: number[]) => number,
  arity = 1,
) =>
  def(
    name,
    'Math',
    Array.from({ length: arity }, () => 'number'),
    T.number,
    description,
    example,
    (c) => fn(...Array.from({ length: arity }, (_, i) => num(c, i))),
  );
math('add', 'The sum of two numbers (like +).', 'add(1, 2) == 3', (a, b) => a + b, 2);
math(
  'subtract',
  'The difference of two numbers (like -).',
  'subtract(5, 2) == 3',
  (a, b) => a - b,
  2,
);
math('multiply', 'The product of two numbers (like *).', 'multiply(2, 3) == 6', (a, b) => a * b, 2);
math('divide', 'The quotient of two numbers (like /).', 'divide(6, 3) == 2', (a, b) => a / b, 2);
math('mod', 'The remainder of a division (like %).', 'mod(7, 3) == 1', (a, b) => a % b, 2);
math('pow', 'A number raised to a power (like ^).', 'pow(2, 3) == 8', (a, b) => a ** b, 2);
math('abs', 'The absolute value.', 'abs(-3) == 3', Math.abs);
math('ceil', 'Round up to an integer.', 'ceil(1.2) == 2', Math.ceil);
math('floor', 'Round down to an integer.', 'floor(1.8) == 1', Math.floor);
math('sqrt', 'The square root.', 'sqrt(16) == 4', Math.sqrt);
math('cbrt', 'The cube root.', 'cbrt(27) == 3', Math.cbrt);
math('exp', 'e raised to a power.', 'exp(0) == 1', Math.exp);
math('ln', 'The natural logarithm.', 'ln(e()) == 1', Math.log);
math('log10', 'The base-10 logarithm.', 'log10(100) == 2', Math.log10);
math('log2', 'The base-2 logarithm.', 'log2(8) == 3', Math.log2);
math('sign', '1 for positive numbers, -1 for negative, 0 for zero.', 'sign(-4) == -1', Math.sign);
def(
  'round',
  'Math',
  ['number', 'number?'],
  T.number,
  'Round to the nearest integer, or to a number of decimal places.',
  'round(1.234, 2) == 1.23',
  (c) => {
    const places = c.count > 1 ? num(c, 1) : 0;
    const f = 10 ** places;
    return Math.round(num(c, 0) * f) / f;
  },
);
def('pi', 'Math', [], T.number, 'The number π.', 'round(pi(), 2) == 3.14', () => Math.PI);
def('e', 'Math', [], T.number, "Euler's number e.", 'round(e(), 2) == 2.72', () => Math.E);
def(
  'min',
  'Math',
  ['any', '...any'],
  T.number,
  'The smallest of numbers or lists of numbers.',
  'min(3, [1, 2]) == 1',
  (c) => {
    const n = numbers(c);
    return n.length ? Math.min(...n) : null;
  },
);
def(
  'max',
  'Math',
  ['any', '...any'],
  T.number,
  'The largest of numbers or lists of numbers.',
  'max(3, [1, 5]) == 5',
  (c) => {
    const n = numbers(c);
    return n.length ? Math.max(...n) : null;
  },
);
def(
  'sum',
  'Math',
  ['any', '...any'],
  T.number,
  'The sum of numbers or lists of numbers.',
  'sum([1, 2, 3]) == 6',
  (c) => numbers(c).reduce((a, b) => a + b, 0),
);
def(
  'mean',
  'Math',
  ['any', '...any'],
  T.number,
  'The average of numbers or lists of numbers.',
  'mean([1, 2, 3]) == 2',
  (c) => {
    const n = numbers(c);
    return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
  },
);
def(
  'median',
  'Math',
  ['any', '...any'],
  T.number,
  'The middle value of numbers or lists of numbers.',
  'median([3, 1, 2]) == 2',
  (c) => {
    const n = numbers(c).sort((a, b) => a - b);
    if (!n.length) return null;
    const mid = Math.floor(n.length / 2);
    return n.length % 2 ? n[mid]! : (n[mid - 1]! + n[mid]!) / 2;
  },
);

// Dates
def('now', 'Date', [], T.date, 'The current date and time.', 'now()', (c) =>
  dateValue(c.now, true),
);
def('today', 'Date', [], T.date, "Today's date (no time).", 'today()', (c) =>
  dateValue(startOfDay(c.now), false),
);
const datePart = (
  name: string,
  description: string,
  example: string,
  fn: (d: Date, ms: number) => number,
) =>
  def(name, 'Date', ['date'], T.number, description, example, (c) => {
    const d = date(c, 0);
    return d ? fn(new Date(d.start), d.start) : null;
  });
datePart('minute', 'The minute (0–59).', 'minute(now())', (d) => d.getMinutes());
datePart('hour', 'The hour (0–23).', 'hour(now())', (d) => d.getHours());
datePart(
  'day',
  'The day of the week, 1 (Monday) to 7 (Sunday).',
  'day(parseDate("2026-10-05")) == 1',
  (d) => ((d.getDay() + 6) % 7) + 1,
);
datePart('date', 'The day of the month (1–31).', 'date(parseDate("2026-10-05")) == 5', (d) =>
  d.getDate(),
);
datePart(
  'week',
  'The ISO week of the year (1–53).',
  'week(parseDate("2026-01-05")) == 2',
  (_d, ms) => isoWeek(ms),
);
datePart(
  'month',
  'The month, 1 (January) to 12.',
  'month(parseDate("2026-10-05")) == 10',
  (d) => d.getMonth() + 1,
);
datePart('year', 'The year.', 'year(now())', (d) => d.getFullYear());
const shiftDate = (sign: number) => (c: CallContext) => {
  const d = date(c, 0);
  if (!d) return null;
  const n = num(c, 1) * sign;
  const u = unit(c, 2);
  return dateValue(
    addUnits(d.start, n, u),
    d.time || ['hours', 'minutes', 'seconds', 'milliseconds'].includes(u),
    d.end === null ? null : addUnits(d.end, n, u),
  );
};
def(
  'dateAdd',
  'Date',
  ['date', 'number', 'text'],
  T.date,
  'A date moved forward by an amount of "years", "quarters", "months", "weeks", "days", "hours" or "minutes".',
  'dateAdd(today(), 1, "weeks")',
  shiftDate(1),
);
def(
  'dateSubtract',
  'Date',
  ['date', 'number', 'text'],
  T.date,
  'A date moved back by an amount of a unit.',
  'dateSubtract(today(), 3, "days")',
  shiftDate(-1),
);
def(
  'dateBetween',
  'Date',
  ['date', 'date', 'text'],
  T.number,
  'Whole units from the second date to the first.',
  'dateBetween(dateAdd(today(), 2, "days"), today(), "days") == 2',
  (c) => {
    const a = date(c, 0);
    const b = date(c, 1);
    return a && b ? unitsBetween(a.start, b.start, unit(c, 2)) : null;
  },
);
def(
  'dateRange',
  'Date',
  ['date', 'date'],
  T.date,
  'A date range from a start and an end date.',
  'dateRange(today(), dateAdd(today(), 1, "weeks"))',
  (c) => {
    const a = date(c, 0);
    const b = date(c, 1);
    if (!a || !b) return a ?? b;
    return dateValue(a.start, a.time || b.time, b.end ?? b.start);
  },
);
def(
  'dateStart',
  'Date',
  ['date'],
  T.date,
  'The start of a date range.',
  'dateStart(prop("When"))',
  (c) => {
    const d = date(c, 0);
    return d ? dateValue(d.start, d.time) : null;
  },
);
def(
  'dateEnd',
  'Date',
  ['date'],
  T.date,
  'The end of a date range (the date itself if not a range).',
  'dateEnd(prop("When"))',
  (c) => {
    const d = date(c, 0);
    return d ? dateValue(d.end ?? d.start, d.time) : null;
  },
);
def(
  'timestamp',
  'Date',
  ['date'],
  T.number,
  'A date as milliseconds since 1970.',
  'timestamp(now())',
  (c) => date(c, 0)?.start ?? null,
);
def(
  'fromTimestamp',
  'Date',
  ['number'],
  T.date,
  'A date from milliseconds since 1970.',
  'fromTimestamp(0)',
  (c) => dateValue(num(c, 0), true),
);
def(
  'formatDate',
  'Date',
  ['date', 'text'],
  T.text,
  'A date as text in a format such as "YYYY-MM-DD" or "MMMM D, YYYY h:mm A".',
  'formatDate(now(), "dddd")',
  (c) => {
    const d = date(c, 0);
    return d ? formatDateTokens(d.start, text(c, 1)) : '';
  },
);
def(
  'parseDate',
  'Date',
  ['text'],
  T.date,
  'A date from ISO 8601 text ("2026-10-04" or "2026-10-04T15:30").',
  'parseDate("2026-10-04")',
  (c) => parseIsoDate(text(c, 0)) ?? c.fail(`Not an ISO date: "${text(c, 0)}"`),
);

// Lists
def(
  'at',
  'List',
  ['list', 'number'],
  elem0,
  'The item at an index (negative counts from the end).',
  'at([1, 2, 3], -1) == 3',
  (c) => list(c, 0).at(Math.trunc(num(c, 1))) ?? null,
);
def(
  'first',
  'List',
  ['list'],
  elem0,
  'The first item.',
  'first([1, 2, 3]) == 1',
  (c) => list(c, 0)[0] ?? null,
);
def(
  'last',
  'List',
  ['list'],
  elem0,
  'The last item.',
  'last([1, 2, 3]) == 3',
  (c) => list(c, 0).at(-1) ?? null,
);
def(
  'slice',
  'List',
  ['list', 'number', 'number?'],
  arg0,
  'Items from a start index up to (not including) an end index.',
  'slice([1, 2, 3], 1) == [2, 3]',
  (c) => list(c, 0).slice(num(c, 1), c.count > 2 ? num(c, 2) : undefined),
);
def(
  'sort',
  'List',
  ['list', 'lambda?'],
  arg0,
  'Items in order, optionally by an expression of current.',
  'sort([3, 1, 2]) == [1, 2, 3]',
  (c) => {
    const items = list(c, 0).map((v, i) => ({ v, key: c.count > 1 ? c.lambda(1, v, i) : v }));
    return items.sort((a, b) => compareValues(a.key, b.key)).map((x) => x.v);
  },
);
def(
  'reverse',
  'List',
  ['list'],
  arg0,
  'Items in reverse order.',
  'reverse([1, 2]) == [2, 1]',
  (c) => [...list(c, 0)].reverse(),
);
def(
  'includes',
  'List',
  ['list', 'any'],
  T.boolean,
  'True if the list contains the value.',
  'includes([1, 2], 2)',
  (c) => list(c, 0).some((v) => valuesEqual(v, c.value(1))),
);
def(
  'find',
  'List',
  ['list', 'lambda<boolean>'],
  elem0,
  'The first item for which the condition (on current) is true.',
  'find([1, 5, 9], current > 3) == 5',
  (c) => list(c, 0).find((v, i) => c.lambda(1, v, i) === true) ?? null,
);
def(
  'findIndex',
  'List',
  ['list', 'lambda<boolean>'],
  T.number,
  'The index of the first item for which the condition is true, or -1.',
  'findIndex([1, 5, 9], current > 3) == 1',
  (c) => list(c, 0).findIndex((v, i) => c.lambda(1, v, i) === true),
);
def(
  'filter',
  'List',
  ['list', 'lambda<boolean>'],
  arg0,
  'The items for which the condition (on current) is true.',
  'filter([1, 5, 9], current > 3) == [5, 9]',
  (c) => list(c, 0).filter((v, i) => c.lambda(1, v, i) === true),
);
def(
  'some',
  'List',
  ['list', 'lambda<boolean>'],
  T.boolean,
  'True if the condition is true for any item.',
  'some([1, 5], current > 3)',
  (c) => list(c, 0).some((v, i) => c.lambda(1, v, i) === true),
);
def(
  'every',
  'List',
  ['list', 'lambda<boolean>'],
  T.boolean,
  'True if the condition is true for every item.',
  'every([4, 5], current > 3)',
  (c) => list(c, 0).every((v, i) => c.lambda(1, v, i) === true),
);
def(
  'map',
  'List',
  ['list', 'lambda'],
  (a) => T.list(a[1] ?? T.any),
  'Each item transformed by an expression of current (and index).',
  'map([1, 2], current * 10) == [10, 20]',
  (c) => list(c, 0).map((v, i) => c.lambda(1, v, i)),
);
def(
  'flat',
  'List',
  ['list'],
  (a) => (elem0(a).kind === 'list' ? elem0(a) : listOfElem0(a)),
  'Nested lists flattened by one level.',
  'flat([[1], [2, 3]]) == [1, 2, 3]',
  (c) => list(c, 0).flatMap((v) => (Array.isArray(v) ? v : [v])),
);
def(
  'unique',
  'List',
  ['list'],
  arg0,
  'The list without repeated items.',
  'unique([1, 1, 2]) == [1, 2]',
  (c) => {
    const out: FValue[] = [];
    for (const v of list(c, 0)) if (!out.some((x) => valuesEqual(x, v))) out.push(v);
    return out;
  },
);

// People and pages
def('name', 'People', ['person'], T.text, "A person's name.", 'name(prop("Created by"))', (c) => {
  const v = c.value(0);
  return v !== null && isPerson(v) ? v.name : '';
});
def(
  'email',
  'People',
  ['person'],
  T.text,
  "A person's email address.",
  'email(prop("Created by"))',
  (c) => {
    const v = c.value(0);
    return v !== null && isPerson(v) ? v.email : '';
  },
);
def(
  'id',
  'Special',
  ['page?'],
  T.text,
  'The id of a page (this page without an argument).',
  'id()',
  (c) => {
    if (c.count === 0) return c.page.id;
    const v = c.value(0);
    return v !== null && isPage(v) ? v.id : '';
  },
);

export const FUNCTIONS: ReadonlyMap<string, FnDef> = new Map(F.map((f) => [f.name, f]));

/** Built-ins handled by the checker and evaluator themselves (they bind names). */
export const SPECIAL_FUNCTIONS: Omit<FnDef, 'run' | 'returns' | 'params'>[] = [
  {
    name: 'prop',
    category: 'Special',
    signature: 'prop(text) → value',
    description: 'The value of a property of this row.',
    example: 'prop("Due")',
  },
  {
    name: 'let',
    category: 'Special',
    signature: 'let(name, value, expression) → any',
    description: 'Name a value and use the name in the expression.',
    example: 'let(x, 2, x * x) == 4',
  },
  {
    name: 'lets',
    category: 'Special',
    signature: 'lets(name, value, …, expression) → any',
    description: 'Name several values (each can use the earlier ones).',
    example: 'lets(a, 1, b, a + 1, a + b) == 3',
  },
];

export { typeOf };
