import type { PgStore } from '@workspace/storage-remote';
import type { OidcClients } from './auth/oidc';
import type { Config } from './config';
import type { FileStorage } from './files';
import type { Indexer } from './search/indexer';

/** What route handlers share. */
export interface ServerContext {
  config: Config;
  store: PgStore;
  files: FileStorage;
  oidc: OidcClients;
  indexer: Indexer;
}
