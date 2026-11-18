/**
 * Sharing a page and changing who has access, as the scope routes and access requests
 * (Phase 8 N4) both do it. Moves are server operations: the server edits both tree docs (as
 * a peer of its own), moves the pages' docs to the new scope, records the move, and the
 * open connections get what they gained or lost.
 */
import { listPages, moveSubtree, subtreeIds } from '@workspace/core';
import { isDatabaseDoc, readDatabase } from '@workspace/database';
import type { Scope, ScopeRole } from '@workspace/storage-remote';
import * as Y from 'yjs';
import type { ServerContext } from '../context';

export class Sharing {
  /** One scope operation at a time per workspace (moves read and write two trees). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ctx: Pick<ServerContext, 'store' | 'realtime' | 'access' | 'notifier'>,
  ) {}

  locked<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(workspaceId) ?? Promise.resolve()).then(fn, fn);
    this.locks.set(
      workspaceId,
      run.catch(() => {}),
    );
    return run;
  }

  /**
   * Share a page on its own: it becomes its own scope, inheriting where it was (so nobody
   * loses it), ready for people to be added. Null if the page isn't in `from`. Call it
   * inside `locked`.
   */
  async sharePage(workspaceId: string, pageId: string, from: Scope): Promise<Scope | null> {
    const { store, access } = this.ctx;
    const created = await store.scopes.create({
      workspaceId,
      kind: 'shared',
      name: '',
      parentId: from.id,
      inherit: true,
      access: [],
    });
    await access.changed(workspaceId);
    if (!(await this.movePage(workspaceId, pageId, from, created, { stub: true }))) {
      await store.pool.query('DELETE FROM scopes WHERE id = $1', [created.id]);
      await access.changed(workspaceId);
      return null;
    }
    return created;
  }

  /**
   * Share `pageId`, in scope `from`, for a grant: the scope itself when the page is already
   * shared on its own (the top of a `shared` scope), else a new one (see `sharePage`). Null if
   * the page isn't there. Call it inside `locked`.
   */
  async scopeToShare(workspaceId: string, pageId: string, from: Scope): Promise<Scope | null> {
    if (from.kind === 'shared') {
      const state = await this.ctx.store.docState(workspaceId, from.treeDoc);
      if (state) {
        const tree = new Y.Doc();
        Y.applyUpdate(tree, state);
        const page = listPages(tree).find((p) => p.id === pageId);
        tree.destroy();
        if (page && !page.parentId) return from;
      }
    }
    return this.sharePage(workspaceId, pageId, from);
  }

  /**
   * Give `principal` a role in a scope (null removes it). Someone newly added (not a role
   * changed) is told, by `by`.
   */
  async grant(
    workspaceId: string,
    scopeId: string,
    principal: string,
    role: ScopeRole | null,
    by: string,
  ): Promise<void> {
    const { store, access, notifier } = this.ctx;
    const { rows: had } = await store.pool.query(
      'SELECT 1 FROM scope_access WHERE scope_id = $1 AND principal = $2',
      [scopeId, principal],
    );
    await store.scopes.setAccess(scopeId, principal, role);
    await access.changed(workspaceId);
    if (role && had.length === 0 && principal.startsWith('user:')) {
      await notifier.accessGranted(workspaceId, scopeId, by, [principal.slice(5)]);
    }
  }

  /**
   * Move page `page` (in `from`'s tree) with its sub-pages to `to`'s tree. With `stub`, a
   * stub stays in its place (sharing). Returns false if the page isn't there.
   */
  async movePage(
    workspaceId: string,
    page: string,
    from: Scope,
    to: Scope,
    options: { parentId?: string | null; stub?: boolean },
  ): Promise<boolean> {
    const { store, realtime, access } = this.ctx;
    const load = async (docId: string) => {
      const doc = new Y.Doc();
      const state = await store.docState(workspaceId, docId);
      if (state) Y.applyUpdate(doc, state);
      return doc;
    };
    const source = await load(from.treeDoc);
    const target = await load(to.treeDoc);
    const before = [Y.encodeStateVector(source), Y.encodeStateVector(target)] as const;
    if (subtreeIds(source, page).length === 0) return false;
    const pages = moveSubtree(source, target, page, {
      parentId: options.parentId,
      stubScope: options.stub ? to.id : null,
    });
    // The pages' own docs: content (or database) docs, comments, and database rows.
    const docIds = new Set<string>();
    for (const id of pages) {
      docIds.add(id);
      docIds.add(`comments:${id}`);
      const doc = await load(id);
      if (isDatabaseDoc(doc)) {
        for (const row of readDatabase(doc).rows) {
          docIds.add(row.id);
          docIds.add(`comments:${row.id}`);
        }
      }
      doc.destroy();
    }
    const seqs = await realtime.appendFromServer(workspaceId, [
      { docId: from.treeDoc, data: Y.encodeStateAsUpdate(source, before[0]) },
      { docId: to.treeDoc, data: Y.encodeStateAsUpdate(target, before[1]) },
    ]);
    const moved = await store.scopes.move(
      workspaceId,
      [...docIds],
      from.id,
      to.id,
      Math.max(...seqs),
    );
    await access.moved(workspaceId, moved, from.id, to.id);
    return true;
  }
}
