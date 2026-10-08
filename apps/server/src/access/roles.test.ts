import type { AccessModel, Scope } from '@workspace/storage-remote';
import { describe, expect, it } from 'vitest';
import { atLeast, rolesFor } from './roles';

const scope = (id: string, extra: Partial<Scope> = {}): Scope => ({
  id,
  workspaceId: 'w',
  kind: 'teamspace',
  name: id,
  treeDoc: `tree:${id}`,
  parentId: null,
  inherit: true,
  ownerId: null,
  icon: null,
  description: '',
  visibility: 'open',
  joinRole: 'edit',
  ...extra,
});

const model: AccessModel = {
  defaultScopeId: 'general',
  scopes: [
    scope('general'),
    scope('eng'),
    scope('ada-private', { kind: 'private', ownerId: 'ada' }),
    scope('spec', { kind: 'shared', parentId: 'eng' }),
    scope('secret', { kind: 'shared', parentId: 'eng', inherit: false }),
    scope('from-private', { kind: 'shared', parentId: 'ada-private' }),
  ],
  entries: [
    { scopeId: 'general', principal: 'workspace', role: 'edit' },
    { scopeId: 'eng', principal: 'group:engineers', role: 'edit' },
    { scopeId: 'eng', principal: 'user:bob', role: 'view' },
    { scopeId: 'ada-private', principal: 'user:ada', role: 'full' },
    { scopeId: 'spec', principal: 'user:gus', role: 'comment' },
    { scopeId: 'secret', principal: 'user:cy', role: 'full' },
    { scopeId: 'from-private', principal: 'user:bob', role: 'view' },
  ],
  members: [
    { userId: 'ada', role: 'owner' },
    { userId: 'bob', role: 'member' },
    { userId: 'cy', role: 'member' },
    { userId: 'gus', role: 'guest' },
  ],
  groups: [{ userId: 'bob', groupId: 'engineers' }],
};

const roles = (userId: string) => Object.fromEntries(rolesFor(model, userId));

describe('rolesFor', () => {
  it('combines own, group, workspace, inherited and manager roles', () => {
    expect(roles('ada')).toEqual({
      general: 'full',
      eng: 'full',
      'ada-private': 'full',
      spec: 'full',
      'from-private': 'full',
    });
    // Bob: edit in eng through his group (higher than his own view), inherited by spec.
    expect(roles('bob')).toEqual({
      general: 'edit',
      eng: 'edit',
      spec: 'edit',
      'from-private': 'view',
    });
    expect(roles('cy')).toEqual({ general: 'edit', secret: 'full' });
  });

  it('guests only get what is shared with them; outsiders nothing', () => {
    expect(roles('gus')).toEqual({ spec: 'comment' });
    expect(roles('stranger')).toEqual({});
  });

  it('ranks roles', () => {
    expect(atLeast('edit', 'comment')).toBe(true);
    expect(atLeast('comment', 'edit')).toBe(false);
    expect(atLeast(undefined, 'view')).toBe(false);
  });

  // Can't happen (a parent exists before its child), but must not hang.
  it('survives a parent cycle', () => {
    const looped: AccessModel = {
      ...model,
      scopes: [scope('a', { parentId: 'b' }), scope('b', { parentId: 'a' })],
      entries: [{ scopeId: 'a', principal: 'user:bob', role: 'view' }],
    };
    expect(Object.fromEntries(rolesFor(looped, 'bob')).a).toBe('view');
  });
});
