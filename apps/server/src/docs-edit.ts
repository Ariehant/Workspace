/**
 * The server editing a doc for someone (Phase 6): form submissions, automations and the
 * API write rows and pages as a client would. Each edit loads the doc's merged state,
 * runs the change, and appends just what changed, with its author, to the workspace's
 * log (and so to everyone connected).
 *
 * An edit for someone passes the same checks as a push from their own client (the role
 * to write the doc, and what the update contains), so a mistake here can't write where
 * they couldn't. Edits to one doc run one at a time.
 */
import type { PgStore } from '@workspace/storage-remote';
import * as Y from 'yjs';
import type { AccessService } from './access/service';
import type { Realtime } from './context';

/** Who an edit is made for. */
export type EditAuthor =
  /** A person or a bot: checked as their own client's push would be. */
  | { userId: string }
  /** Checked as person `as` (an automation's maker), recorded as `userId` (its bot). */
  | { as: string; userId: string }
  /** Allowed by the caller already (e.g. a form's audience); null: anonymous. */
  | { trusted: true; userId: string | null };

export class EditRefused extends Error {
  constructor(readonly docId: string) {
    super(`Not allowed to edit ${docId}`);
    this.name = 'EditRefused';
  }
}

export interface EditResult<T> {
  result: T;
  /** The log position of the change; null when nothing changed. */
  seq: number | null;
}

export class DocEditor {
  /** doc key -> the edit running on it (edits to one doc wait their turn). */
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: PgStore,
    private readonly access: AccessService,
    private readonly realtime: Pick<Realtime, 'appendFromServer'>,
  ) {}

  /**
   * Run `change` on doc `docId` and store what it changed, as `author`. A doc that
   * doesn't exist yet is placed in `scope` (as a client's hint would). Throws
   * `EditRefused` when the author may not make the change.
   */
  async edit<T>(
    workspaceId: string,
    docId: string,
    author: EditAuthor,
    change: (doc: Y.Doc) => T,
    options: { scope?: string | null } = {},
  ): Promise<EditResult<T>> {
    const key = `${workspaceId}/${docId}`;
    const previous = this.running.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.run(workspaceId, docId, author, change, options.scope ?? null));
    this.running.set(key, next);
    try {
      return await next;
    } finally {
      if (this.running.get(key) === next) this.running.delete(key);
    }
  }

  private async run<T>(
    workspaceId: string,
    docId: string,
    author: EditAuthor,
    change: (doc: Y.Doc) => T,
    scope: string | null,
  ): Promise<EditResult<T>> {
    const doc = new Y.Doc();
    try {
      const state = await this.store.docState(workspaceId, docId);
      if (state) Y.applyUpdate(doc, state);
      const updates: Uint8Array[] = [];
      doc.on('update', (update: Uint8Array) => updates.push(update));
      const result = change(doc);
      if (updates.length === 0) return { result, seq: null };
      const update = Y.mergeUpdates(updates);
      if (!('trusted' in author)) {
        const access = await this.access.workspace(workspaceId);
        const checked = 'as' in author ? author.as : author.userId;
        const roles = access.roles(checked);
        const allowed =
          (await access.canWrite(roles, docId, scope)) &&
          (await access.checkUpdate(roles, checked, docId, update, []));
        if (!allowed) throw new EditRefused(docId);
      } else {
        // A new doc goes where the caller says (they checked it may): never unplaced,
        // which anyone could read.
        const access = await this.access.workspace(workspaceId);
        if (access.placementOf(docId) === undefined) {
          if (scope === null) throw new EditRefused(docId);
          access.moved([docId], await this.store.scopes.place(workspaceId, docId, scope));
        }
      }
      const [seq] = await this.realtime.appendFromServer(
        workspaceId,
        [{ docId, data: update }],
        author.userId,
      );
      return { result, seq: seq ?? null };
    } finally {
      doc.destroy();
    }
  }
}
