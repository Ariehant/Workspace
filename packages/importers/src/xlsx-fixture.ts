/**
 * Writes small Excel workbooks, for the tests and the monday fixture (not part of the
 * package's exports). Cells: text (as shared strings, or inline with `{ inline }`), numbers,
 * booleans, and dates (`{ date: serial }`, stored as a number with a date style).
 */
import { strToU8, zipSync } from 'fflate';

export type FixtureCell =
  | string
  | number
  | boolean
  | null
  | { inline: string }
  | { date: number; format?: 'day' | 'time' | 'custom' };

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const column = (i: number) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
};

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function writeXlsx(sheets: { name: string; rows: FixtureCell[][] }[]): Uint8Array {
  const strings: string[] = [];
  const stringIndex = (s: string) => {
    const at = strings.indexOf(s);
    return at >= 0 ? at : strings.push(s) - 1;
  };
  // Styles: 0 general, 1 a day (built-in 14), 2 day and time (22), 3 a custom date format.
  const STYLE = { day: 1, time: 2, custom: 3 } as const;
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((sheet, s) => {
    const rows = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((cell, c) => {
            const ref = `${column(c)}${r + 1}`;
            if (cell === null || cell === '') return '';
            if (typeof cell === 'string')
              return `<c r="${ref}" t="s"><v>${stringIndex(cell)}</v></c>`;
            if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
            if (typeof cell === 'boolean') return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
            if ('inline' in cell) {
              return `<c r="${ref}" t="inlineStr"><is><t>${escape(cell.inline)}</t></is></c>`;
            }
            return `<c r="${ref}" s="${STYLE[cell.format ?? 'day']}"><v>${cell.date}</v></c>`;
          })
          .join('');
        return cells ? `<row r="${r + 1}">${cells}</row>` : '';
      })
      .join('');
    files[`xl/worksheets/sheet${s + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`,
    );
  });
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${sheets
      .map((sh, i) => `<sheet name="${escape(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('')}</Relationships>`,
  );
  files['xl/styles.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="d&quot; of &quot;mmm yyyy"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="22"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
  );
  files['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${NS}" count="${strings.length}">${strings
      .map((t) => `<si><t xml:space="preserve">${escape(t)}</t></si>`)
      .join('')}</sst>`,
  );
  files['[Content_Types].xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  // A fixed time, so the same workbook gives the same bytes.
  return zipSync(files, { mtime: new Date(2026, 0, 1) });
}

/** Excel's serial for a local day (and time). */
export const serial = (y: number, m: number, d: number, h = 0, min = 0) =>
  (Date.UTC(y, m - 1, d, h, min) - Date.UTC(1899, 11, 30)) / 86_400_000;

/** The monday.com board in `fixtures/monday/Arm_build.xlsx`. */
export function mondayBoard(): Uint8Array {
  const header = [
    'Name',
    'Subitems',
    'Person',
    'Status',
    'Priority',
    'Timeline',
    'Date',
    'Budget',
    'Item ID',
  ];
  return writeXlsx([
    {
      name: 'Arm build',
      rows: [
        ['Arm build'],
        [],
        ['Hardware'],
        header,
        [
          'Mount the base',
          'Drill holes, Level the plate',
          'Asha Rao',
          'Working on it',
          'High',
          '2026-11-02 - 2026-11-20',
          { date: serial(2026, 11, 20) },
          120,
          101,
        ],
        [null, 'Subitems', 'Name', 'Owner', 'Status'],
        [null, null, 'Drill holes', 'Lee Chen', 'Done'],
        [null, null, 'Level the plate', null, 'Working on it'],
        [
          'Order servos',
          null,
          'Asha Rao',
          'Done',
          'Low',
          null,
          { date: serial(2026, 11, 10) },
          40,
          102,
        ],
        [],
        ['Software'],
        header,
        ['Write the joint driver', null, 'Lee Chen', 'Stuck', 'Critical', null, null, null, 103],
        ['Tune the PID', null, null, null, null, null, null, null, 104],
      ],
    },
  ]);
}
