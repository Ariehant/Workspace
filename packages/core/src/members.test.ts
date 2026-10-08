import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getMembersMap, listMembers, writeMembers } from './members';

const ada = { id: 'u1', name: 'Ada', avatar: null, role: 'owner' as const };
const bob = { id: 'u2', name: 'Bob', avatar: 'data:image/png;base64,AA', role: 'member' as const };

describe('members doc', () => {
  it('writes only what changed and keeps people who left as removed', () => {
    const doc = new Y.Doc();
    let updates = 0;
    doc.on('update', () => updates++);
    expect(writeMembers(doc, [ada, bob])).toBe(true);
    expect(updates).toBe(1);
    expect(writeMembers(doc, [ada, bob])).toBe(false);
    expect(updates).toBe(1);

    expect(writeMembers(doc, [{ ...ada, name: 'Ada L.' }])).toBe(true);
    expect(listMembers(doc)).toEqual([
      { ...ada, name: 'Ada L.', removed: false },
      { ...bob, removed: true },
    ]);
    // Back again.
    writeMembers(doc, [ada, { ...bob, role: 'guest' }]);
    expect(listMembers(doc).map((m) => [m.name, m.role, m.removed])).toEqual([
      ['Ada', 'owner', false],
      ['Bob', 'guest', false],
    ]);
  });

  it('reads defensively', () => {
    const doc = new Y.Doc();
    const map = getMembersMap(doc) as Y.Map<unknown>;
    map.set('x', { name: 7, role: 'king' });
    map.set('y', 'junk');
    expect(listMembers(doc)).toEqual([
      { id: 'x', name: '', avatar: null, role: 'guest', removed: false },
    ]);
  });
});
