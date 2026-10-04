import { expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  DatabaseHandle,
  addProperty,
  initDatabase,
  readDatabase,
  rowsMap,
  runView,
  setCell,
} from './index';
import { PageField } from '@workspace/core';
import { RowField } from './schema';

const ROWS = 50_000;

/**
 * Scale check for keeping all rows in one doc (docs/PHASE2.md). Prints timings; the
 * limits are loose so it only fails on a real regression.
 */
it(`handles ${ROWS.toLocaleString('en-US')} rows`, { timeout: 120_000 }, () => {
  const t = () => performance.now();
  const doc = new Y.Doc();
  initDatabase(doc, { databaseId: 'db' });
  const num = addProperty(doc, { name: 'Estimate', type: 'number' });
  const text = addProperty(doc, { name: 'Notes', type: 'text' });
  const date = addProperty(doc, { name: 'Due', type: 'date' });
  let start = t();
  doc.transact(() => {
    const rows = rowsMap(doc);
    for (let i = 0; i < ROWS; i++) {
      const row = new Y.Map<unknown>();
      const title = new Y.Text();
      title.insert(0, `Task ${i}`);
      const values = new Y.Map<unknown>();
      values.set(num, (i * 7919) % 1000);
      values.set(text, `Note for task ${i}`);
      values.set(date, { start: `2026-${String((i % 12) + 1).padStart(2, '0')}-15` });
      row.set(PageField.id, `r${i}`);
      row.set(PageField.title, title);
      row.set(PageField.sortKey, `a${String(i).padStart(6, '0')}`);
      row.set(PageField.createdAt, i);
      row.set(PageField.updatedAt, i);
      row.set(RowField.uid, i + 1);
      row.set(RowField.values, values);
      rows.set(`r${i}`, row);
    }
  });
  const build = t() - start;

  start = t();
  const update = Y.encodeStateAsUpdate(doc);
  const encode = t() - start;

  start = t();
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, update);
  const decode = t() - start;

  const handle = new DatabaseHandle('db', loaded);
  start = t();
  const snapshot = handle.snapshot();
  const firstSnapshot = t() - start;
  expect(snapshot.rows).toHaveLength(ROWS);

  const view = readDatabase(loaded).views[0]!;
  const ctx = { users: new Map<string, string>() };
  start = t();
  runView(snapshot, { ...view, sorts: [{ propertyId: num, direction: 'asc' }] }, ctx);
  const sorted = t() - start;

  start = t();
  setCell(loaded, 'r123', num, 1, null);
  handle.snapshot();
  const editSnapshot = t() - start;

  const timings = {
    build,
    encode,
    decode,
    firstSnapshot,
    sorted,
    editSnapshot,
    sizeMB: update.byteLength / 1e6,
  };
  console.log(
    Object.entries(timings)
      .map(([k, v]) => `${k}=${v.toFixed(k === 'sizeMB' ? 1 : 0)}`)
      .join(' '),
  );
  expect(editSnapshot).toBeLessThan(500);
  expect(decode).toBeLessThan(15_000);
  handle.destroy();
});
