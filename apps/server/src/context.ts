import type { PgStore } from '@workspace/storage-remote';
import type { OidcClients } from './auth/oidc';
import type { Config } from './config';
import type { FileStorage } from './files';

/** What route handlers share. */
export interface ServerContext {
  config: Config;
  store: PgStore;
  files: FileStorage;
  oidc: OidcClients;
}
