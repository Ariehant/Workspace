import type { DocClient, Forest, User } from '@workspace/core';
import { createContext, useContext } from 'react';
import type * as Y from 'yjs';
import type { DatabaseRegistry } from './database/registry';
import type { PageDirectory } from './pages';
import type { Platform } from './platform';
import type { PresenceHub } from './presence';
import type { TeamApi } from './team';

export interface AppContextValue {
  platform: Platform;
  client: DocClient;
  /** The page trees the person can see (one, for a workspace that isn't on a server). */
  workspace: Forest;
  /** Open database docs and row lookups. */
  databases: DatabaseRegistry;
  /** Lookups across pages and rows. */
  pages: PageDirectory;
  /** The person using the app. */
  user: User;
  /** The workspace's members (a server workspace; empty otherwise), once loaded. */
  members: Y.Doc | null;
  /** Who else is on the docs this window shows. */
  presence: PresenceHub | null;
  /**
   * The workspace's server, when there is one to ask: always on the web, on the desktop
   * while it syncs this workspace. Null: a local workspace (the desktop does it itself).
   */
  team: TeamApi | null;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <App>');
  return value;
}
