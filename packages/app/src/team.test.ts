import { describe, expect, it } from 'vitest';
import { parseEmails } from './team';

describe('parseEmails', () => {
  it('splits pasted lists, drops junk and duplicates, lower-cases', () => {
    expect(parseEmails('Ada@Lab.io, bob@lab.io;\n<cy@lab.io>  not-an-email bob@lab.io, ,')).toEqual(
      ['ada@lab.io', 'bob@lab.io', 'cy@lab.io'],
    );
    expect(parseEmails('   ')).toEqual([]);
  });
});
