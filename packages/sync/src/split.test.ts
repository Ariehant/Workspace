import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { splitDocState, splitUpdate } from './split';

/** Two clients' edits: map entries with nested types, text, and deletions. */
function sampleDoc(): Y.Doc {
  const a = new Y.Doc();
  const rows = a.getMap<Y.Map<unknown>>('rows');
  a.transact(() => {
    for (let i = 0; i < 2000; i++) {
      const row = new Y.Map<unknown>();
      const title = new Y.Text();
      title.insert(0, `Row ${i}: ${'x'.repeat(i % 40)}`);
      row.set('title', title);
      row.set('n', i);
      rows.set(`r${i}`, row);
    }
  });
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  b.transact(() => {
    for (let i = 0; i < 300; i++) b.getMap<Y.Map<unknown>>('rows').delete(`r${i * 3}`);
    b.getText('notes').insert(0, 'from b '.repeat(500));
  });
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  b.destroy();
  return a;
}

const same = (x: Y.Doc, y: Y.Doc) => {
  expect(y.getMap('rows').toJSON()).toEqual(x.getMap('rows').toJSON());
  expect(y.getText('notes').toString()).toBe(x.getText('notes').toString());
  expect(Y.encodeStateVector(y)).toEqual(Y.encodeStateVector(x));
};

describe('splitting large updates', () => {
  it('leaves an update within the limit alone', () => {
    const update = Y.encodeStateAsUpdate(sampleDoc());
    expect(splitUpdate(update, update.byteLength)).toEqual([update]);
  });

  it('splits a doc into parts under the limit that make the same doc, in order', () => {
    const doc = sampleDoc();
    const whole = Y.encodeStateAsUpdate(doc);
    const max = 8 * 1024;
    const parts = splitUpdate(whole, max)!;
    expect(parts.length).toBeGreaterThan(4);
    for (const part of parts) expect(part.byteLength).toBeLessThanOrEqual(max);
    const rebuilt = new Y.Doc();
    for (const part of parts) Y.applyUpdate(rebuilt, part);
    same(doc, rebuilt);
    expect(rebuilt.getMap('rows').has('r0')).toBe(false);
  });

  it('makes the same doc whatever order the parts arrive in', () => {
    const doc = sampleDoc();
    const parts = splitDocState(doc, 8 * 1024).reverse();
    const rebuilt = new Y.Doc();
    for (const part of parts) Y.applyUpdate(rebuilt, part);
    same(doc, rebuilt);
  });

  it("merges with a copy that already has some of it (the server's)", () => {
    const doc = sampleDoc();
    const server = new Y.Doc();
    const parts = splitDocState(doc, 8 * 1024);
    for (const part of parts.slice(0, 3)) Y.applyUpdate(server, part);
    for (const part of parts) Y.applyUpdate(server, part);
    same(doc, server);
  });

  it("can't split an update that builds on structs it doesn't hold", () => {
    const doc = sampleDoc();
    const before = Y.encodeStateVector(doc);
    doc.getText('notes').insert(0, 'y'.repeat(20_000));
    const change = Y.encodeStateAsUpdate(doc, before);
    expect(splitUpdate(change, 4 * 1024)).toBeNull();
  });
});
