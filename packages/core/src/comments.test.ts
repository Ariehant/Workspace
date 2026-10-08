import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addComment,
  checkCommentsChange,
  createThread,
  decideSuggestion,
  decodeAnchorPosition,
  deleteComment,
  editComment,
  encodeAnchorPosition,
  mentionsIn,
  openThreadCount,
  readThreads,
  setResolved,
  toggleReaction,
  updateSuggestion,
} from './comments';

/** What `fn` does to a copy of `doc`, as an update (a device's change, before it's sent). */
function change(doc: Y.Doc, fn: (copy: Y.Doc) => void): Uint8Array {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const before = Y.encodeStateVector(copy);
  fn(copy);
  return Y.encodeStateAsUpdate(copy, before);
}

const ada = { userId: 'ada', canEdit: true, canManage: true };
const gus = { userId: 'gus', canEdit: false, canManage: false };

describe('comments', () => {
  it('threads, replies, edits, reactions, resolving and deleting', () => {
    const doc = new Y.Doc();
    const t = createThread(doc, {
      anchor: { kind: 'page' },
      author: 'ada',
      body: ' Looks good ',
      now: 1,
    });
    const reply = addComment(doc, t, 'gus', 'Thanks <@ada>!', 2);
    editComment(doc, t, reply, 'Thanks a lot <@ada>!', 3);
    toggleReaction(doc, t, reply, '👍', 'ada');
    toggleReaction(doc, t, reply, '👍', 'mo');
    toggleReaction(doc, t, reply, '👍', 'mo');
    expect(readThreads(doc)).toEqual([
      expect.objectContaining({
        id: t,
        createdBy: 'ada',
        comments: [
          expect.objectContaining({ author: 'ada', body: 'Looks good', editedAt: null }),
          expect.objectContaining({
            author: 'gus',
            body: 'Thanks a lot <@ada>!',
            editedAt: 3,
            reactions: { '👍': ['ada'] },
          }),
        ],
      }),
    ]);
    expect(mentionsIn('Thanks <@ada> and <@mo>, <@ada>')).toEqual(['ada', 'mo']);
    expect(openThreadCount(doc)).toBe(1);
    setResolved(doc, t, 'gus', 4);
    expect(readThreads(doc)[0]).toMatchObject({ resolvedBy: 'gus', resolvedAt: 4 });
    expect(openThreadCount(doc)).toBe(0);
    deleteComment(doc, t, reply);
    deleteComment(doc, t, readThreads(doc)[0]!.comments[0]!.id);
    expect(readThreads(doc)).toEqual([]);
  });

  it('text anchors follow the text through others’ edits', () => {
    const page = new Y.Doc();
    const text = page.getText('t');
    text.insert(0, 'The gripper slipped.');
    const anchor = {
      kind: 'range' as const,
      start: encodeAnchorPosition(Y.createRelativePositionFromTypeIndex(text, 4)),
      end: encodeAnchorPosition(Y.createRelativePositionFromTypeIndex(text, 11)),
      quote: 'gripper',
    };
    // Someone else edits before and inside the range.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(page));
    other.getText('t').insert(0, 'Note: ');
    Y.applyUpdate(page, Y.encodeStateAsUpdate(other));
    const at = (pos: string) =>
      Y.createAbsolutePositionFromRelativePosition(decodeAnchorPosition(pos)!, page)!.index;
    expect(text.toString().slice(at(anchor.start), at(anchor.end))).toBe('gripper');
    // The text is deleted: the range collapses where it was (the app shows "deleted text").
    other.getText('t').delete(10, 'gripper'.length);
    Y.applyUpdate(page, Y.encodeStateAsUpdate(other));
    expect(text.toString()).toBe('Note: The  slipped.');
    expect(at(anchor.start)).toBe(10);
    expect(at(anchor.end)).toBe(10);
    expect(decodeAnchorPosition('not base64!')).toBeNull();
  });

  it('suggestions: open, extended by their author, decided', () => {
    const doc = new Y.Doc();
    const t = createThread(doc, {
      anchor: { kind: 'range', start: 'a', end: 'b', quote: 'slipped' },
      author: 'gus',
      suggestion: { insert: 'slid' },
    });
    updateSuggestion(doc, t, { insert: 'slid off' });
    expect(readThreads(doc)[0]!.suggestion).toEqual({
      insert: 'slid off',
      status: 'open',
      decidedBy: null,
      decidedAt: null,
    });
    expect(openThreadCount(doc)).toBe(1);
    decideSuggestion(doc, t, 'accepted', 'ada', 9);
    expect(readThreads(doc)[0]!.suggestion).toMatchObject({ status: 'accepted', decidedBy: 'ada' });
    expect(openThreadCount(doc)).toBe(0);
  });

  it('the server’s check: everything written is the writer’s own', () => {
    const doc = new Y.Doc();
    const t = createThread(doc, { anchor: { kind: 'page' }, author: 'ada', body: 'Hi' });
    const adas = readThreads(doc)[0]!.comments[0]!.id;
    const ok = (update: Uint8Array, who = gus) => checkCommentsChange(doc, update, who);

    expect(ok(change(doc, (d) => addComment(d, t, 'gus', 'Hello')))).toBeNull();
    expect(ok(change(doc, (d) => addComment(d, t, 'ada', 'Forged')))).toBe(
      'comment by someone else',
    );
    expect(
      ok(
        change(doc, (d) => createThread(d, { anchor: { kind: 'page' }, author: 'ada', body: 'x' })),
      ),
    ).toBe('thread by someone else');
    expect(ok(change(doc, (d) => editComment(d, t, adas, 'Changed')))).toBe(
      "edited someone else's comment",
    );
    expect(
      ok(
        change(doc, (d) => editComment(d, t, adas, 'Fixed typo')),
        ada,
      ),
    ).toBeNull();
    expect(ok(change(doc, (d) => deleteComment(d, t, adas)))).toBe('deleted a thread');
    expect(
      ok(
        change(doc, (d) => deleteComment(d, t, adas)),
        { ...gus, canManage: true },
      ),
    ).toBeNull();
    expect(ok(change(doc, (d) => toggleReaction(d, t, adas, '👍', 'gus')))).toBeNull();
    expect(ok(change(doc, (d) => toggleReaction(d, t, adas, '👍', 'ada')))).toBe(
      "changed someone else's reaction",
    );
    expect(ok(change(doc, (d) => setResolved(d, t, 'gus')))).toBeNull();
    expect(ok(change(doc, (d) => setResolved(d, t, 'ada')))).toBe('resolved as someone else');
    expect(ok(change(doc, (d) => d.getMap('other').set('x', 1)))).toBe('unknown part "other"');

    // Suggestions: only someone who may edit accepts; the author may withdraw.
    const s = createThread(doc, {
      anchor: { kind: 'page' },
      author: 'gus',
      suggestion: { insert: 'x' },
    });
    expect(ok(change(doc, (d) => decideSuggestion(d, s, 'accepted', 'gus')))).toBe(
      'may not accept',
    );
    expect(ok(change(doc, (d) => decideSuggestion(d, s, 'rejected', 'gus')))).toBeNull();
    expect(
      ok(
        change(doc, (d) => decideSuggestion(d, s, 'accepted', 'ada')),
        ada,
      ),
    ).toBeNull();
    expect(
      ok(
        change(doc, (d) => updateSuggestion(d, s, { insert: 'y' })),
        ada,
      ),
    ).toBe("changed someone else's suggestion");
  });
});
