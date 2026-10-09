/**
 * Keeps each workspace's members doc (names, pictures, roles) in step with Postgres.
 * The server is its only writer: it reads the doc's merged state, writes the
 * difference and appends that like any other update, so devices get it live or when
 * they catch up.
 */
import { MEMBERS_DOC_ID, getMembersMap, writeMembers } from '@workspace/core';
import type { PgStore } from '@workspace/storage-remote';
import * as Y from 'yjs';

export interface MembersDocDeps {
  store: PgStore;
  /** Append to the workspace's log (through the sync hub, so sockets hear of it). */
  append(workspaceId: string, updates: { docId: string; data: Uint8Array }[]): Promise<unknown>;
}

export class MembersDoc {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: MembersDocDeps) {}

  /** Bring the workspace's members doc up to date (one refresh at a time per workspace). */
  refresh(workspaceId: string): Promise<void> {
    const previous = this.queues.get(workspaceId) ?? Promise.resolve();
    const next = previous.then(() => this.write(workspaceId));
    const settled = next.catch(() => {});
    this.queues.set(workspaceId, settled);
    void settled.then(() => {
      if (this.queues.get(workspaceId) === settled) this.queues.delete(workspaceId);
    });
    return next;
  }

  /** Refresh every workspace a user is in (they renamed themselves or changed picture). */
  async refreshFor(userId: string): Promise<void> {
    for (const id of await this.deps.store.teams.workspaceIdsOf(userId)) await this.refresh(id);
  }

  /**
   * Name a bot (e.g. the automations bot) in the members doc, so what it writes shows
   * its name. It's listed as a former member: never offered as a person to pick.
   */
  async ensureBot(workspaceId: string, id: string, name: string): Promise<void> {
    const { store } = this.deps;
    const doc = new Y.Doc();
    const state = await store.docState(workspaceId, MEMBERS_DOC_ID);
    if (state) Y.applyUpdate(doc, state);
    const map = getMembersMap(doc);
    const existing = map.get(id);
    if (existing && existing.name === name && existing.removed) return;
    const before = Y.encodeStateVector(doc);
    map.set(id, { name, avatar: null, role: 'member', removed: true });
    const update = Y.encodeStateAsUpdate(doc, before);
    await this.deps.append(workspaceId, [{ docId: MEMBERS_DOC_ID, data: update }]);
  }

  private async write(workspaceId: string): Promise<void> {
    const { store } = this.deps;
    const doc = new Y.Doc();
    const state = await store.docState(workspaceId, MEMBERS_DOC_ID);
    if (state) Y.applyUpdate(doc, state);
    const before = Y.encodeStateVector(doc);
    const members = await store.teams.members(workspaceId);
    const changed = writeMembers(
      doc,
      members.map((m) => ({ id: m.userId, name: m.name, avatar: m.avatar, role: m.role })),
    );
    if (!changed) return;
    const update = Y.encodeStateAsUpdate(doc, before);
    await this.deps.append(workspaceId, [{ docId: MEMBERS_DOC_ID, data: update }]);
  }
}
