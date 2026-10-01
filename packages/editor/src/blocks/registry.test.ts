import { describe, expect, it } from 'vitest';
import { BLOCKS, BLOCK_GROUP_LABELS, CONVERTIBLE_BLOCKS, getBlock, searchBlocks } from './registry';

const ids = (query: string) => searchBlocks(query).map((b) => b.id);

describe('block registry', () => {
  it('has unique ids and a label for every group', () => {
    expect(new Set(BLOCKS.map((b) => b.id)).size).toBe(BLOCKS.length);
    expect(getBlock('heading2')?.title).toBe('Heading 2');
    for (const block of BLOCKS) expect(BLOCK_GROUP_LABELS[block.group]).toBeTruthy();
  });

  it('keeps each group contiguous, so the slash menu shows one heading per group', () => {
    const groups = BLOCKS.map((b) => b.group).filter((g, i, all) => g !== all[i - 1]);
    expect(new Set(groups).size).toBe(groups.length);
  });

  it('offers only convertible blocks in "Turn into"', () => {
    expect(CONVERTIBLE_BLOCKS.map((b) => b.id)).toContain('toggleHeading1');
    expect(CONVERTIBLE_BLOCKS.map((b) => b.id)).not.toContain('divider');
    expect(CONVERTIBLE_BLOCKS.map((b) => b.id)).not.toContain('table');
  });

  it('returns everything for an empty query', () => {
    expect(ids('')).toEqual(BLOCKS.map((b) => b.id));
  });

  it('ranks title prefixes first, then keywords', () => {
    expect(ids('head').slice(0, 3)).toEqual(['heading1', 'heading2', 'heading3']);
    expect(ids('h2')).toEqual(['heading2', 'toggleHeading2']);
    expect(ids('ul')[0]).toBe('bulletList');
    expect(ids('table')[0]).toBe('table');
    expect(ids('2 col')[0]).toBe('columns2');
    expect(ids('link to')[0]).toBe('linkToPage');
    expect(ids('list')).toEqual(
      expect.arrayContaining(['todo', 'bulletList', 'orderedList', 'toggle']),
    );
  });

  it('matches subsequences and rejects nonsense', () => {
    expect(ids('qte')).toEqual(['quote']);
    expect(ids('zzz')).toEqual([]);
  });
});
