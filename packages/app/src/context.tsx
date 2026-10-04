import type { DocClient, User } from '@workspace/core';
import { createContext, useContext } from 'react';
import type * as Y from 'yjs';
import type { DatabaseRegistry } from './database/registry';
import type { PageDirectory } from './pages';
import type { Platform } from './platform';

export interface AppContextValue {
  platform: Platform;
  client: DocClient;
  workspace: Y.Doc;
  /** Open database docs and row lookups. */
  databases: DatabaseRegistry;
  /** Lookups across pages and rows. */
  pages: PageDirectory;
  /** The person using the app. */
  user: User;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <App>');
  return value;
}
