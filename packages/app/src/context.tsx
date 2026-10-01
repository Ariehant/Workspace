import type { DocClient } from '@workspace/core';
import { createContext, useContext } from 'react';
import type * as Y from 'yjs';
import type { Platform } from './platform';

export interface AppContextValue {
  platform: Platform;
  client: DocClient;
  workspace: Y.Doc;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <App>');
  return value;
}
