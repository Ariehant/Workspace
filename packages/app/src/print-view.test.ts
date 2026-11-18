import type { PageMeta } from '@workspace/core';
import { describe, expect, it } from 'vitest';
import { printOrder } from './print-view';

const page = (id: string, parentId: string | null, sortKey: string): PageMeta => ({
  id,
  kind: 'page',
  parentId,
  title: id,
  icon: null,
  sortKey,
  createdAt: 0,
  updatedAt: 0,
  trashedAt: null,
  cover: null,
  fullWidth: false,
  smallText: false,
  font: 'default',
  locked: false,
});

// Handbook ─ Setup ─ Wiring; Handbook ─ Safety; Notes. ("Lost" has a parent that isn't printed.)
const all = [
  page('Notes', null, 'b'),
  page('Safety', 'Handbook', 'b'),
  page('Handbook', null, 'a'),
  page('Wiring', 'Setup', 'a'),
  page('Setup', 'Handbook', 'a'),
  page('Lost', 'Trashed', 'c'),
];
const titles = (entries: ReturnType<typeof printOrder>) =>
  entries.map(({ page: p, depth }) => `${'  '.repeat(depth)}${p.id}`);

describe('printOrder', () => {
  it('prints the whole workspace in the sidebar’s order, sub-pages under their pages', () => {
    expect(titles(printOrder(all, null, true))).toEqual([
      'Handbook',
      '  Setup',
      '    Wiring',
      '  Safety',
      'Notes',
      'Lost',
    ]);
  });

  it('prints a page with its sub-pages, or alone', () => {
    expect(titles(printOrder(all, 'Setup', true))).toEqual(['Setup', '  Wiring']);
    expect(titles(printOrder(all, 'Handbook', false))).toEqual(['Handbook']);
    expect(printOrder(all, 'Gone', true)).toEqual([]);
  });
});
