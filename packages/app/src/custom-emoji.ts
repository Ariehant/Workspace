import {
  listCustomEmoji,
  observeCustomEmoji,
  workspaceDataDoc,
  type CustomEmoji,
} from '@workspace/core';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useApp } from './context';

/** The workspace's custom emoji (Phase 8 N8, #7), kept current. */
export function useWorkspaceEmoji(): CustomEmoji[] {
  const { workspace } = useApp();
  const doc = workspaceDataDoc(workspace);
  const subscribe = useCallback((listener: () => void) => observeCustomEmoji(doc, listener), [doc]);
  // A string snapshot, stable while nothing changes.
  const key = useSyncExternalStore(subscribe, () => JSON.stringify(listCustomEmoji(doc)));
  return useMemo(() => JSON.parse(key) as CustomEmoji[], [key]);
}
