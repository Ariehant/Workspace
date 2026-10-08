import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getPageContent } from './blocks';
import { addComment, createThread, editComment, readThreads } from './comments';
import { reminderTime, zonedTime } from './dates';
import {
  commentEvents,
  commentText,
  parseNotification,
  readPersonMentions,
  reminderKey,
} from './notifications';

const person = (userId: string) => {
  const m = new Y.XmlElement('mention');
  m.setAttribute('kind', 'person');
  m.setAttribute('userId', userId);
  return m;
};

describe('notifications', () => {
  it('finds person mentions with their block', () => {
    const doc = new Y.Doc();
    const p = new Y.XmlElement('paragraph');
    p.setAttribute('id', 'b1');
    p.insert(0, [new Y.XmlText('Ask  '), person('bob'), new Y.XmlText(' about gears')]);
    const page = new Y.XmlElement('mention');
    page.setAttribute('kind', 'page');
    page.setAttribute('pageId', 'p2');
    const q = new Y.XmlElement('paragraph');
    q.insert(0, [page]);
    getPageContent(doc).insert(0, [p, q]);
    expect(readPersonMentions(doc)).toEqual([
      { blockId: 'b1', userId: 'bob', text: 'Ask about gears' },
    ]);
  });

  it('comment events: new threads, replies with who took part, new mentions in edits', () => {
    const doc = new Y.Doc();
    const anchor = { kind: 'page' as const };
    const t = createThread(doc, { anchor, author: 'ada', body: 'Torque? <@bob>' });
    const before = readThreads(doc);
    expect(commentEvents([], before)).toEqual([
      expect.objectContaining({ kind: 'thread', threadId: t, author: 'ada', mentions: ['bob'] }),
    ]);
    const c = addComment(doc, t, 'bob', 'Fine');
    addComment(doc, t, 'gus', 'Agreed');
    const after = readThreads(doc);
    expect(commentEvents(before, after)).toEqual([
      expect.objectContaining({
        kind: 'reply',
        commentId: c,
        author: 'bob',
        participants: ['ada'],
      }),
      expect.objectContaining({ kind: 'reply', author: 'gus', participants: ['ada', 'bob'] }),
    ]);
    editComment(doc, t, c, 'Fine, <@gus> <@ada>');
    const edited = commentEvents(after, readThreads(doc));
    expect(edited).toEqual([
      expect.objectContaining({ kind: 'edit', commentId: c, mentions: ['gus', 'ada'] }),
    ]);
    expect(commentText('Hi <@gus> and <@zed>', new Map([['gus', 'Gus']]))).toBe(
      'Hi @Gus and @someone',
    );
  });

  it('parses notifications, rejecting anything else', () => {
    const n = {
      id: 'n1',
      kind: 'mention',
      pageId: 'p',
      title: 'Gearbox',
      blockId: 'b',
      threadId: null,
      actorId: 'ada',
      text: 'Ask @Bob',
      createdAt: 5,
      readAt: null,
      archivedAt: null,
      key: null,
    };
    expect(parseNotification(JSON.stringify(n))).toEqual(n);
    expect(parseNotification('{"id":"x","kind":"spam","createdAt":1}')).toBeNull();
    expect(parseNotification('not json')).toBeNull();
    expect(reminderKey('p', 'b', 9)).toBe('p/b/9');
  });

  it('wall-clock times in a time zone', () => {
    // 9:00 in Berlin: UTC+2 in summer, UTC+1 in winter.
    expect(zonedTime(2026, 7, 1, 9, 0, 'Europe/Berlin')).toBe(Date.UTC(2026, 6, 1, 7, 0));
    expect(zonedTime(2026, 1, 15, 9, 0, 'Europe/Berlin')).toBe(Date.UTC(2026, 0, 15, 8, 0));
    expect(zonedTime(2026, 3, 8, 9, 0, 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 13, 0));
    expect(zonedTime(2026, 3, 8, 9, 0, 'Not/AZone')).toBe(Date.UTC(2026, 2, 8, 9, 0));
    expect(reminderTime('2026-10-05', 'Asia/Kolkata')).toBe(Date.UTC(2026, 9, 5, 3, 30));
  });
});
