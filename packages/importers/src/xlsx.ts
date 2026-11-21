/**
 * A small reader for Excel workbooks (`.xlsx`): each sheet's cells as rows of text, enough to
 * import a table someone exported. Numbers come back as written, dates (by their cell's number
 * format) as local `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`, booleans as TRUE / FALSE; formulas as
 * their last computed value. Formatting, merged cells and charts are ignored.
 */
import { unzipSync } from 'fflate';
import { parseXml, type XmlElement, type XmlNode } from './xml';

/** The most a workbook may unpack to (its parts' declared sizes, checked before inflating). */
export const MAX_XLSX_BYTES = 200 * 1024 * 1024;

export interface Sheet {
  name: string;
  /** Row by row from the first; empty cells (and rows) are ''. */
  rows: string[][];
}

const local = (name: string) => name.slice(name.indexOf(':') + 1);
const isEl = (n: XmlNode): n is XmlElement => typeof n !== 'string';
const kids = (el: XmlElement | undefined, name: string) =>
  (el?.children ?? []).filter((n): n is XmlElement => isEl(n) && local(n.name) === name);
const kid = (el: XmlElement | undefined, name: string) => kids(el, name)[0];
const attr = (el: XmlElement, name: string) =>
  el.attrs[name] ?? Object.entries(el.attrs).find(([k]) => local(k) === name)?.[1];

/** The text of `<t>` elements under `el`, leaving out phonetic runs (`<rPh>`). */
function runText(el: XmlElement): string {
  let out = '';
  for (const n of el.children) {
    if (!isEl(n)) continue;
    const name = local(n.name);
    if (name === 't') out += n.children.filter((c): c is string => typeof c === 'string').join('');
    else if (name !== 'rPh') out += runText(n);
  }
  return out;
}

/** Built-in number formats that are dates or times. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Is a custom number format a date or time? (Quoted text, escapes and [colours] aside.) */
export function isDateFormat(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '');
  return /[dyh]/i.test(bare) || /\bm{1,2}:s/i.test(bare);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** An Excel date serial → local `YYYY-MM-DD`, with `THH:mm` when it has a time of day. */
export function excelDate(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  const days = serial + (date1904 ? 1462 : 0);
  // Day 25569 is 1970-01-01 (Excel counts a 29 February 1900 that never was).
  const ms = Math.round(((days - 25569) * 86_400_000) / 60_000) * 60_000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return minutes ? `${day}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
}

/** "C12" → its column (from 0) and row (from 1). */
function cellRef(ref: string): { col: number; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) };
}

/** A number as text, without float noise (0.30000000000000004 → 0.3). */
const numberText = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : v;
};

/** Read a workbook's sheets, in their order. Throws on something that isn't one. */
export function readXlsx(data: Uint8Array): Sheet[] {
  let total = 0;
  const parts = unzipSync(data, {
    filter: (file) => {
      if (!file.name.startsWith('xl/')) return false;
      total += file.originalSize;
      if (total > MAX_XLSX_BYTES) throw new Error('too large');
      return true;
    },
  });
  const xml = (path: string) => {
    const bytes = parts[path];
    return bytes ? parseXml(new TextDecoder().decode(bytes)) : null;
  };
  const workbook = kid(xml('xl/workbook.xml') ?? undefined, 'workbook');
  if (!workbook) throw new Error('Not an Excel workbook');
  const date1904 = ['1', 'true'].includes(
    attr(kid(workbook, 'workbookPr') ?? workbook, 'date1904') ?? '',
  );

  const rels = new Map(
    kids(kid(xml('xl/_rels/workbook.xml.rels') ?? undefined, 'Relationships'), 'Relationship').map(
      (r) => [attr(r, 'Id') ?? '', attr(r, 'Target') ?? ''],
    ),
  );
  const strings = kids(kid(xml('xl/sharedStrings.xml') ?? undefined, 'sst'), 'si').map(runText);

  const styles = kid(xml('xl/styles.xml') ?? undefined, 'styleSheet');
  const custom = new Map(
    kids(kid(styles, 'numFmts'), 'numFmt').map((f) => [
      Number(attr(f, 'numFmtId')),
      attr(f, 'formatCode') ?? '',
    ]),
  );
  const dateStyle = kids(kid(styles, 'cellXfs'), 'xf').map((xf) => {
    const id = Number(attr(xf, 'numFmtId') ?? 0);
    return DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!));
  });

  return kids(kid(workbook, 'sheets'), 'sheet').map((sheet) => {
    const name = attr(sheet, 'name') ?? 'Sheet';
    const target = rels.get(attr(sheet, 'id') ?? '') ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const data = kid(kid(xml(path) ?? undefined, 'worksheet'), 'sheetData');
    const rows: string[][] = [];
    let nextRow = 1;
    for (const row of kids(data, 'row')) {
      const r = Number(attr(row, 'r')) || nextRow;
      nextRow = r + 1;
      const cells: string[] = [];
      let nextCol = 0;
      for (const c of kids(row, 'c')) {
        const col = cellRef(attr(c, 'r') ?? '')?.col ?? nextCol;
        nextCol = col + 1;
        const v = kid(c, 'v');
        const raw = (v?.children ?? [])
          .filter((n): n is string => typeof n === 'string')
          .join('')
          .trim();
        const type = attr(c, 't') ?? 'n';
        let text = '';
        if (type === 's') text = strings[Number(raw)] ?? '';
        else if (type === 'inlineStr') text = runText(kid(c, 'is') ?? c);
        else if (type === 'str') text = raw;
        else if (type === 'b') text = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : '';
        else if (type === 'e') text = '';
        else if (raw && dateStyle[Number(attr(c, 's') ?? 0)])
          text = excelDate(Number(raw), date1904) ?? raw;
        else if (raw) text = numberText(raw);
        while (cells.length < col) cells.push('');
        cells[col] = text;
      }
      while (rows.length < r - 1) rows.push([]);
      rows[r - 1] = cells;
    }
    return { name, rows };
  });
}
