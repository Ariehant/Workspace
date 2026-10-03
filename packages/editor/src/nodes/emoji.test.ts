import { describe, expect, it } from 'vitest';
import { searchEmoji } from './emoji';

const top = (q: string, n = 3) =>
  searchEmoji(q)
    .slice(0, n)
    .map((e) => e.emoji);

describe('searchEmoji', () => {
  it('ranks shortcode prefixes first', () => {
    expect(top('rocket', 1)).toEqual(['🚀']);
    expect(top('thumbsup', 1)).toEqual(['👍']);
    expect(searchEmoji('smile')[0]?.shortcodes).toContain('smile');
  });

  it('matches words inside shortcodes and tags', () => {
    expect(searchEmoji('robot').map((e) => e.emoji)).toContain('🤖');
    expect(searchEmoji('launch').map((e) => e.emoji)).toContain('🚀'); // tag
  });

  it('returns nothing for an empty or unknown query, and caps results', () => {
    expect(searchEmoji('')).toEqual([]);
    expect(searchEmoji('zzzzqq')).toEqual([]);
    expect(searchEmoji('a').length).toBeLessThanOrEqual(30);
  });
});
