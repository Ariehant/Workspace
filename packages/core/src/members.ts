import type * as Y from 'yjs';
import { listUsers } from './workspace';

/**
 * The *members doc* (guid `MEMBERS_DOC_ID`) lists the people in a server workspace:
 * names, pictures and workspace roles, for person properties, mentions and "created
 * by". Only the server writes it (clients' changes to it are refused), so it can be
 * trusted and is available offline like any other doc. Emails stay on the server.
 *
 * People who leave stay listed as `removed`, so the pages they touched keep their names.
 * A workspace that isn't on a server has no members doc (it stays empty).
 */
export const MEMBERS_DOC_ID = 'members';

/** Top-level Y.Map in the members doc: userId -> plain `MemberEntry` object. */
export const MEMBERS_MAP = 'members';

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';

export interface WorkspaceMember {
  id: string;
  name: string;
  /** A small picture as a `data:` URL, or null. */
  avatar: string | null;
  role: WorkspaceRole;
  /** No longer in the workspace (kept for the names on what they made). */
  removed: boolean;
}

type MemberEntry = Omit<WorkspaceMember, 'id'>;

export function getMembersMap(doc: Y.Doc): Y.Map<MemberEntry> {
  return doc.getMap<MemberEntry>(MEMBERS_MAP);
}

const ROLES = new Set<WorkspaceRole>(['owner', 'admin', 'member', 'guest']);

/** Everyone listed, current members first, then by name. */
export function listMembers(doc: Y.Doc): WorkspaceMember[] {
  const members: WorkspaceMember[] = [];
  for (const [id, entry] of getMembersMap(doc)) {
    if (!entry || typeof entry !== 'object') continue;
    members.push({
      id,
      name: typeof entry.name === 'string' ? entry.name : '',
      avatar: typeof entry.avatar === 'string' ? entry.avatar : null,
      role: ROLES.has(entry.role) ? entry.role : 'guest',
      removed: entry.removed === true,
    });
  }
  return members.sort(
    (a, b) => Number(a.removed) - Number(b.removed) || a.name.localeCompare(b.name),
  );
}

/**
 * Make the doc list exactly `current` as members (the server's view), marking anyone
 * else it lists as removed. Writes only what changed; returns whether anything did.
 */
export function writeMembers(
  doc: Y.Doc,
  current: readonly Omit<WorkspaceMember, 'removed'>[],
): boolean {
  const map = getMembersMap(doc);
  let changed = false;
  doc.transact(() => {
    const ids = new Set<string>();
    const put = (id: string, entry: MemberEntry) => {
      const existing = map.get(id);
      if (
        !existing ||
        existing.name !== entry.name ||
        (existing.avatar ?? null) !== entry.avatar ||
        existing.role !== entry.role ||
        (existing.removed === true) !== entry.removed
      ) {
        map.set(id, entry);
        changed = true;
      }
    };
    for (const m of current) {
      ids.add(m.id);
      put(m.id, { name: m.name, avatar: m.avatar, role: m.role, removed: false });
    }
    for (const [id, entry] of map) {
      if (!ids.has(id) && entry && entry.removed !== true) {
        put(id, { ...entry, avatar: entry.avatar ?? null, removed: true });
      }
    }
  });
  return changed;
}

/**
 * Names by user id, for showing person values: the workspace doc's own users, then the
 * members doc's (current names win).
 */
export function userNames(workspace: Y.Doc | null, members: Y.Doc | null): Map<string, string> {
  const names = new Map<string, string>();
  if (workspace) for (const u of listUsers(workspace)) names.set(u.id, u.name);
  if (members) for (const m of listMembers(members)) names.set(m.id, m.name);
  return names;
}
