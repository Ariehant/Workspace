import { describe, expect, it } from 'vitest';
import {
  cleanSearchOptions,
  editedSince,
  hasSearchFilters,
  searchOptionsFromQuery,
  searchOptionsToParams,
} from './search';

describe('search options', () => {
  it('keeps only valid options from untrusted input', () => {
    expect(cleanSearchOptions(null)).toEqual({});
    expect(
      cleanSearchOptions({
        titlesOnly: 'yes',
        trees: ['t1', 5, 'bad tree', 't2'],
        editedAfter: -1,
        createdBy: 'ada',
        sort: 'sideways',
        limit: 500,
        extra: 1,
      }),
    ).toEqual({ trees: ['t1', 't2'], createdBy: 'ada', limit: 50 });
  });

  it('round-trips through query parameters', () => {
    const options = {
      titlesOnly: true,
      trees: ['t1', 't2'],
      editedAfter: 1234,
      createdBy: 'bob',
      sort: 'edited' as const,
    };
    const params = new URLSearchParams();
    searchOptionsToParams(options, params);
    const query: Record<string, unknown> = {};
    for (const key of new Set(params.keys())) {
      const all = params.getAll(key);
      query[key] = all.length > 1 ? all : all[0];
    }
    expect(searchOptionsFromQuery(query)).toEqual(options);
  });

  it('knows when filters are set, and where "Edited" ranges start', () => {
    expect(hasSearchFilters({})).toBe(false);
    expect(hasSearchFilters({ sort: 'relevance', limit: 5 })).toBe(false);
    expect(hasSearchFilters({ sort: 'created' })).toBe(true);
    const now = new Date(2026, 10, 18, 15, 30).getTime();
    expect(editedSince('today', now)).toBe(new Date(2026, 10, 18).getTime());
    expect(editedSince('week', now)).toBe(new Date(2026, 10, 12).getTime());
  });
});
