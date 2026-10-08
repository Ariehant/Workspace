import { getUsersMap, listMembers, listUsers } from '@workspace/core';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';

export interface People {
  /** Everyone with a name: members (current and former) and users of the workspace doc. */
  names: ReadonlyMap<string, string>;
  avatars: ReadonlyMap<string, string>;
  /**
   * Who to offer in pickers: a server workspace's current members; otherwise (a local
   * workspace) everyone in `names`.
   */
  active: readonly string[];
}

/**
 * The people of the workspace. A server workspace's members doc is the source (names
 * and pictures stay current there); the workspace doc's own user list fills in anyone
 * else (edits made on this device before it synced).
 */
export function readPeople(workspace: Y.Doc, members: Y.Doc | null): People {
  const names = new Map<string, string>();
  for (const u of listUsers(workspace)) names.set(u.id, u.name);
  const avatars = new Map<string, string>();
  const list = members ? listMembers(members) : [];
  for (const m of list) {
    names.set(m.id, m.name);
    if (m.avatar) avatars.set(m.id, m.avatar);
  }
  const current = list.filter((m) => !m.removed).map((m) => m.id);
  return { names, avatars, active: current.length > 0 ? current : [...names.keys()] };
}

/** Call `listener` when anyone's name, picture or membership changes. */
export function observePeople(
  workspace: Y.Doc,
  members: Y.Doc | null,
  listener: () => void,
): () => void {
  const users = getUsersMap(workspace);
  users.observeDeep(listener);
  members?.on('update', listener);
  return () => {
    users.unobserveDeep(listener);
    members?.off('update', listener);
  };
}

/** `readPeople`, kept current. */
export function usePeople(workspace: Y.Doc, members: Y.Doc | null): People {
  const subscribe = useCallback(
    (listener: () => void) => observePeople(workspace, members, listener),
    [workspace, members],
  );
  // A string snapshot (stable while nothing changes); the maps are rebuilt from it.
  const key = useSyncExternalStore(subscribe, () => {
    const people = readPeople(workspace, members);
    return JSON.stringify([[...people.names], [...people.avatars], people.active]);
  });
  return useMemo(() => {
    const [names, avatars, active] = JSON.parse(key) as [
      [string, string][],
      [string, string][],
      string[],
    ];
    return { names: new Map(names), avatars: new Map(avatars), active };
  }, [key]);
}
