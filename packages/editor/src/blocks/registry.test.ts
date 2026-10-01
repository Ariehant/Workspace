import { describe, expect, it } from 'vitest';
import { BLOCKS, getBlock, searchBlocks } from './registry';

const ids = (query: string) => searchBlocks(query).map((b) => b.id);

describe('block registry', () => {
  it('has unique ids', () => {
    expect(new Set(BLOCKS.map((b) => b.id)).size).toBe(BLOCKS.length);
    expect(getBlock('heading2')?.title).toBe('Heading 2');
  });

  it('returns everything for an empty query', () => {
    expect(ids('')).toEqual(BLOCKS.map((b) => b.id));
  });

  it('ranks title prefixes first, then keywords', () => {
    expect(ids('head')).toEqual(['heading1', 'heading2', 'heading3']);
    expect(ids('h2')).toEqual(['heading2']);
    expect(ids('ul')[0]).toBe('bulletList');
    expect(ids('list').slice(0, 2)).toEqual(['bulletList', 'orderedList']);
  });

  it('matches subsequences and rejects nonsense', () => {
    expect(ids('qte')).toEqual(['quote']);
    expect(ids('zzz')).toEqual([]);
  });
});
