import { createRequire } from 'node:module';

/** Set by the build (`build.mjs`); undefined when running from source (tests, dev). */
declare const __WORKSPACE_VERSION__: string | undefined;

/** The server's version: its package.json's, which the release sets from the tag. */
export const VERSION: string =
  typeof __WORKSPACE_VERSION__ === 'string'
    ? __WORKSPACE_VERSION__
    : (createRequire(import.meta.url)('../package.json') as { version: string }).version;
