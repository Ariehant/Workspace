import type { PgStore } from '@workspace/storage-remote';
import type { AccessService } from './access/service';
import type { DocEditor } from './docs-edit';
import type { OidcClients } from './auth/oidc';
import type { Config } from './config';
import type { FileStorage } from './files';
import type { Mailer } from './mailer';
import type { MembersDoc } from './members/members-doc';
import type { HistoryKeeper } from './history/keeper';
import type { JobRunner } from './jobs/runner';
import type { Notifier } from './notify/notifier';
import type { Indexer } from './search/indexer';

/** The live sync connections, as routes need them. */
export interface Realtime {
  /**
   * Append the server's own updates and send them to the workspace's sockets; `userId`
   * is stored as their author (null: the server's own).
   */
  appendFromServer(
    workspaceId: string,
    updates: { docId: string; data: Uint8Array }[],
    userId?: string | null,
  ): Promise<number[]>;
  /**
   * Close a user's sockets on a workspace: after a role change they reconnect with the
   * new access (`removed` false); after being removed they're told they have no access.
   */
  disconnect(workspaceId: string, userId: string, removed: boolean): void;
}

/** What route handlers share. */
export interface ServerContext {
  config: Config;
  store: PgStore;
  files: FileStorage;
  oidc: OidcClients;
  indexer: Indexer;
  /** Notifications: mentions, comments, reminders, sharing. */
  notifier: Notifier;
  /** Page history: snapshots of docs once they've been quiet. */
  history: HistoryKeeper;
  /** The job queue's runner: handlers per kind (jobs are added with `store.jobs`). */
  jobs: JobRunner;
  /** Who may read and write which docs (scopes, roles, placements). */
  access: AccessService;
  realtime: Realtime;
  /** Edits to docs made by the server for someone (forms, automations, the API). */
  docs: DocEditor;
  members: MembersDoc;
  /** Null when no mail server is configured: invite links are shown to copy instead. */
  mailer: Mailer | null;
}
