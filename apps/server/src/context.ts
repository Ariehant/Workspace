import type { PgStore } from '@workspace/storage-remote';
import type { OidcClients } from './auth/oidc';
import type { Config } from './config';
import type { FileStorage } from './files';
import type { Mailer } from './mailer';
import type { MembersDoc } from './members/members-doc';
import type { Indexer } from './search/indexer';

/** The live sync connections, as routes need them. */
export interface Realtime {
  /** Append the server's own updates and send them to the workspace's sockets. */
  appendFromServer(
    workspaceId: string,
    updates: { docId: string; data: Uint8Array }[],
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
  realtime: Realtime;
  members: MembersDoc;
  /** Null when no mail server is configured: invite links are shown to copy instead. */
  mailer: Mailer | null;
}
