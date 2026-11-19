import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MAX_XLSX_BYTES, excelDate, isDateFormat, readXlsx } from './xlsx';
import { mondayBoard, serial, writeXlsx } from './xlsx-fixture';

describe('reading Excel workbooks', () => {
  it('text, numbers, booleans, dates by their format, gaps, and every sheet in order', () => {
    const sheets = readXlsx(
      writeXlsx([
        {
          name: 'Parts',
          rows: [
            ['Part', 'Count', 'In stock', 'Ordered', 'Arrives'],
            [
              'Servo',
              4,
              true,
              { date: serial(2026, 11, 2) },
              { date: serial(2026, 11, 20, 15, 30), format: 'time' },
            ],
            [
              { inline: 'Bolt <M8> & nut' },
              0.30000000000000004,
              false,
              { date: serial(2026, 1, 5), format: 'custom' },
            ],
            [],
            [null, null, 'gap before'],
          ],
        },
        { name: 'Notes', rows: [['Only one cell']] },
      ]),
    );
    expect(sheets.map((s) => s.name)).toEqual(['Parts', 'Notes']);
    expect(sheets[0]!.rows).toEqual([
      ['Part', 'Count', 'In stock', 'Ordered', 'Arrives'],
      ['Servo', '4', 'TRUE', '2026-11-02', '2026-11-20T15:30'],
      ['Bolt <M8> & nut', '0.3', 'FALSE', '2026-01-05'],
      [],
      ['', '', 'gap before'],
    ]);
    expect(sheets[1]!.rows).toEqual([['Only one cell']]);
  });

  it('reads parts with namespace prefixes, rich text runs, and no shared strings or styles', () => {
    const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const data = zipSync({
      'xl/workbook.xml': strToU8(
        `<x:workbook xmlns:x="${ns}" xmlns:r="rel"><x:sheets><x:sheet name="S" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/a.xml"/></Relationships>',
      ),
      'xl/worksheets/a.xml': strToU8(
        `<x:worksheet xmlns:x="${ns}"><x:sheetData><x:row><x:c t="inlineStr"><x:is><x:r><x:t>Gri</x:t></x:r><x:r><x:t>pper</x:t></x:r><x:rPh><x:t>ignored</x:t></x:rPh></x:is></x:c><x:c><x:v>7</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
      ),
    });
    expect(readXlsx(data)).toEqual([{ name: 'S', rows: [['Gripper', '7']] }]);
  });

  it('date formats and serials', () => {
    expect(isDateFormat('yyyy-mm-dd')).toBe(true);
    expect(isDateFormat('[$-409]d-mmm;@')).toBe(true);
    expect(isDateFormat('h:mm AM/PM')).toBe(true);
    expect(isDateFormat('0.00')).toBe(false);
    expect(isDateFormat('"days" 0')).toBe(false);
    expect(isDateFormat('[Red]#,##0')).toBe(false);
    expect(excelDate(serial(2026, 11, 19))).toBe('2026-11-19');
    expect(excelDate(serial(2026, 11, 19, 9, 5))).toBe('2026-11-19T09:05');
    expect(excelDate(serial(2026, 11, 19) - 1462, true)).toBe('2026-11-19');
    expect(excelDate(-1)).toBeNull();
  });

  it('refuses what isn’t a workbook, and one that would unpack too large', () => {
    expect(() => readXlsx(zipSync({ 'word/document.xml': strToU8('<w/>') }))).toThrow(
      'Not an Excel workbook',
    );
    // A tiny zip declaring a part over the limit: the guard reads the declared size.
    const data = zipSync({ 'xl/workbook.xml': strToU8('<workbook/>') }, { level: 0 });
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i + 4 <= data.length; i++) {
      const signature = view.getUint32(i, true);
      if (signature === 0x04034b50) view.setUint32(i + 22, MAX_XLSX_BYTES + 1, true);
      if (signature === 0x02014b50) view.setUint32(i + 24, MAX_XLSX_BYTES + 1, true);
    }
    expect(() => readXlsx(data)).toThrow('too large');
  });

  it('the committed monday fixture is the one the helper writes', () => {
    const committed = readFileSync(join(__dirname, '..', 'fixtures', 'monday', 'Arm_build.xlsx'));
    expect(Buffer.from(mondayBoard()).equals(committed)).toBe(true);
  });
});
