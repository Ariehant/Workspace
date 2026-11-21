import { addView, type OptionColor } from '@workspace/database';
import type { JSONContent } from '@workspace/editor';
import { ImportBuilder } from './build';
import { localTime } from './dates';
import type { ImportOptions, ImportReport, ImportTarget } from './import';

/**
 * A Trello board's JSON export (Board menu → Print, export and share → Export as JSON): a
 * database shown as a board grouped by list. Cards are rows: labels, due date, done, members;
 * the description, checklists (as to-dos), attachments (as links) and comments in the page.
 * Archived lists and cards stay behind.
 */

interface TrelloLabel {
  id: string;
  name?: string;
  color?: string | null;
}
interface TrelloCard {
  id: string;
  name: string;
  desc?: string;
  idList: string;
  closed?: boolean;
  pos?: number;
  due?: string | null;
  dueComplete?: boolean;
  idLabels?: string[];
  idMembers?: string[];
  attachments?: { name?: string; url: string }[];
}
export interface TrelloBoard {
  name: string;
  lists: { id: string; name: string; closed?: boolean; pos?: number }[];
  cards: TrelloCard[];
  labels?: TrelloLabel[];
  members?: { id: string; fullName?: string; username?: string }[];
  checklists?: {
    id: string;
    idCard: string;
    name: string;
    pos?: number;
    checkItems?: { name: string; state: 'complete' | 'incomplete'; pos?: number }[];
  }[];
  actions?: {
    type: string;
    date: string;
    data?: { text?: string; card?: { id: string } };
    memberCreator?: { fullName?: string; username?: string };
  }[];
}

/** Is this JSON a Trello board export? */
export function isTrelloBoard(json: unknown): json is TrelloBoard {
  const b = json as Partial<TrelloBoard> | null;
  return (
    !!b &&
    typeof b === 'object' &&
    typeof b.name === 'string' &&
    Array.isArray(b.lists) &&
    Array.isArray(b.cards)
  );
}

/** Trello's label colours (and their _light / _dark shades) in our palette. */
const COLORS: Record<string, OptionColor> = {
  green: 'green',
  lime: 'green',
  yellow: 'yellow',
  orange: 'orange',
  red: 'red',
  purple: 'purple',
  blue: 'blue',
  sky: 'blue',
  pink: 'pink',
  black: 'gray',
};
const colorOf = (color: string | null | undefined): OptionColor =>
  COLORS[(color ?? '').replace(/_(light|dark)$/, '')] ?? 'gray';

/** When a card was made: Trello ids start with its Unix time (8 hex digits). */
const createdAt = (id: string) => {
  const seconds = parseInt(id.slice(0, 8), 16);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
};

const byPos = <T extends { pos?: number }>(a: T, b: T) => (a.pos ?? 0) - (b.pos ?? 0);

export function importTrello(
  boards: readonly TrelloBoard[],
  target: ImportTarget,
  options: ImportOptions,
): ImportReport {
  const build = new ImportBuilder(target, options);
  const total = boards.reduce((n, b) => n + b.cards.length, 0);
  let done = 0;
  for (const board of boards) {
    const lists = board.lists.filter((l) => !l.closed).sort(byPos);
    const listName = new Map(lists.map((l) => [l.id, l.name]));
    const cards = board.cards
      .filter((c) => !c.closed && listName.has(c.idList))
      .sort(
        (a, b) =>
          lists.findIndex((l) => l.id === a.idList) - lists.findIndex((l) => l.id === b.idList) ||
          byPos(a, b),
      );
    const left = board.cards.length - cards.length;
    if (left) build.warn(`${left} archived Trello card${left === 1 ? ' was' : 's were'} left out`);

    const labels = new Map(
      (board.labels ?? []).map((l) => [
        l.id,
        { name: l.name?.trim() || l.color || 'Label', color: colorOf(l.color) },
      ]),
    );
    const labelOptions = [...new Map([...labels.values()].map((l) => [l.name, l])).values()];
    const members = new Map(
      (board.members ?? []).map((m) => [m.id, m.fullName || m.username || 'Someone']),
    );

    const db = build.database(board.name, [
      { name: 'Card', type: 'title' },
      {
        name: 'List',
        type: 'select',
        options: lists.map((l, i) => ({
          name: l.name,
          color: (
            ['gray', 'blue', 'yellow', 'green', 'purple', 'orange', 'pink', 'red', 'brown'] as const
          )[i % 9],
        })),
      },
      { name: 'Labels', type: 'multiSelect', options: labelOptions },
      { name: 'Due', type: 'date' },
      { name: 'Done', type: 'checkbox' },
      { name: 'Members', type: 'text' },
    ]);
    db.layout('board', 'Board', 'List');
    addView(db.doc, { viewSet: db.id, name: 'All cards', type: 'table' });

    for (const card of cards) {
      const rowId = db.row({
        title: card.name,
        values: {
          List: listName.get(card.idList),
          Labels: (card.idLabels ?? []).flatMap((id) => {
            const label = labels.get(id);
            return label ? [label.name] : [];
          }),
          Due: card.due ? localTime(card.due) : null,
          Done: card.dueComplete === true ? true : null,
          Members: (card.idMembers ?? []).map((id) => members.get(id) ?? 'Someone').join(', '),
        },
        at: createdAt(card.id),
      });

      const content: (JSONContent | string)[] = [];
      if (card.desc?.trim()) content.push(card.desc);
      for (const checklist of (board.checklists ?? [])
        .filter((c) => c.idCard === card.id)
        .sort(byPos)) {
        content.push({
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: checklist.name }],
        });
        const items = [...(checklist.checkItems ?? [])].sort(byPos);
        if (items.length) {
          content.push({
            type: 'taskList',
            content: items.map((item) => ({
              type: 'taskItem',
              attrs: { checked: item.state === 'complete' },
              content: [
                {
                  type: 'paragraph',
                  ...(item.name ? { content: [{ type: 'text', text: item.name }] } : {}),
                },
              ],
            })),
          });
        }
      }
      const attachments = (card.attachments ?? []).filter((a) => /^https?:\/\//i.test(a.url));
      if (attachments.length) {
        content.push({
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: 'Attachments' }],
        });
        content.push({
          type: 'bulletList',
          content: attachments.map((a) => ({
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: a.name || a.url,
                    marks: [{ type: 'link', attrs: { href: a.url } }],
                  },
                ],
              },
            ],
          })),
        });
      }
      const comments = (board.actions ?? [])
        .filter((a) => a.type === 'commentCard' && a.data?.card?.id === card.id && a.data.text)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (comments.length) {
        content.push({
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: 'Comments' }],
        });
        for (const comment of comments) {
          const who =
            comment.memberCreator?.fullName || comment.memberCreator?.username || 'Someone';
          content.push({
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: `${who}, ${comment.date.slice(0, 10)}: `,
                marks: [{ type: 'bold' }],
              },
              { type: 'text', text: comment.data!.text! },
            ],
          });
        }
      }
      build.content(rowId, content);
      options.onProgress?.(++done, total);
    }
  }
  return build.done();
}
