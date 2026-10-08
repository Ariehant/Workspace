import { describe, expect, it } from 'vitest';
import type { PageRef } from '../services';
import { dateCandidates, mentionItemLabel, mentionItems } from './mention';

const now = new Date(2026, 9, 1, 10); // Thu 1 Oct 2026
const page = (id: string, title: string, inTrash = false): PageRef => ({
  id,
  title,
  icon: null,
  inTrash,
});
const services = {
  listPages: () => [
    page('a', 'Gear ratios'),
    page('b', 'Drivetrain'),
    page('c', 'Gearbox (old)', true),
  ],
};
const labels = (q: string) => mentionItems(q, services, now).map((i) => mentionItemLabel(i, now));

describe('mention suggestions', () => {
  it('offers today, a reminder and recent pages for a bare "@"', () => {
    expect(labels('')).toEqual(['Today', 'Remind me tomorrow', 'Gear ratios', 'Drivetrain']);
  });

  it('matches pages by title, skipping trashed ones', () => {
    expect(labels('gear')).toEqual(['Gear ratios']);
  });

  it('offers members by any word of their name, before pages', () => {
    const withPeople = {
      ...services,
      people: {
        list: () => [
          { id: 'u1', name: 'Ada Lovelace', avatar: null },
          { id: 'u2', name: 'Gerty Cori', avatar: null },
        ],
        get: () => null,
        subscribe: () => () => {},
      },
    };
    const items = (q: string) =>
      mentionItems(q, withPeople, now).map((i) => [i.kind, mentionItemLabel(i, now)]);
    expect(items('love')).toEqual([['person', 'Ada Lovelace']]);
    expect(items('g')).toEqual([
      ['person', 'Gerty Cori'],
      ['page', 'Gear ratios'],
    ]);
    expect(items('').filter(([kind]) => kind === 'person')).toHaveLength(2);
  });

  it('parses dates, including half-typed "in N …"', () => {
    expect(labels('tomorrow')).toEqual(['Tomorrow']);
    expect(dateCandidates('in', now)).toHaveLength(2);
    expect(dateCandidates('in 2 w', now).map((d) => d.getDate())).toEqual([15]);
    expect(labels('in 3 d')).toEqual(['Sunday']);
  });

  it('turns "remind …" into reminders', () => {
    expect(labels('remind')).toEqual(['Remind me today', 'Remind me tomorrow']);
    expect(labels('remind me fri')).toEqual(['Remind me tomorrow']);
    expect(labels('remind next mon')).toEqual(['Remind me on Monday']);
    expect(labels('remind xyz')).toEqual([]);
  });
});
