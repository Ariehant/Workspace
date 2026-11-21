import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addCustomEmoji,
  customEmojiNameProblem,
  getCustomEmoji,
  listCustomEmoji,
  observeCustomEmoji,
  removeCustomEmoji,
} from './index';

describe('custom emoji', () => {
  it('added under a name, listed by name, observed, removed', () => {
    const doc = new Y.Doc();
    let changes = 0;
    const stop = observeCustomEmoji(doc, () => changes++);
    addCustomEmoji(doc, { name: 'teamlogo', fileId: 'f1', by: 'ada', at: 5 });
    addCustomEmoji(doc, { name: 'arm', fileId: 'f2', by: null, at: 6 });
    expect(listCustomEmoji(doc).map((e) => e.name)).toEqual(['arm', 'teamlogo']);
    expect(getCustomEmoji(doc, 'teamlogo')).toEqual({
      name: 'teamlogo',
      fileId: 'f1',
      by: 'ada',
      at: 5,
    });
    removeCustomEmoji(doc, 'arm');
    expect(listCustomEmoji(doc).map((e) => e.name)).toEqual(['teamlogo']);
    expect(changes).toBe(3);
    stop();
  });

  it('names: the allowed characters, unique, and not a standard emoji', () => {
    const doc = new Y.Doc();
    addCustomEmoji(doc, { name: 'teamlogo', fileId: 'f1', by: null });
    const standard = (name: string) => name === 'rocket';
    expect(customEmojiNameProblem(doc, 'new_one-2', standard)).toBeNull();
    expect(customEmojiNameProblem(doc, 'Team Logo', standard)).toMatch(/lowercase/);
    expect(customEmojiNameProblem(doc, 'x'.repeat(33), standard)).toMatch(/lowercase/);
    expect(customEmojiNameProblem(doc, 'teamlogo', standard)).toBe(':teamlogo: is taken');
    expect(customEmojiNameProblem(doc, 'rocket', standard)).toBe(':rocket: is already an emoji');
    expect(() => addCustomEmoji(doc, { name: 'rocket', fileId: 'f', by: null }, standard)).toThrow(
      'already an emoji',
    );
  });

  it('a malformed entry is left out', () => {
    const doc = new Y.Doc();
    doc.getMap('customEmoji').set('broken', { nope: true });
    doc.getMap('customEmoji').set('Bad Name', { fileId: 'f' });
    expect(listCustomEmoji(doc)).toEqual([]);
    expect(getCustomEmoji(doc, 'broken')).toBeNull();
  });
});
