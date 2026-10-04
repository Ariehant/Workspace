import { getUsersMap, listUsers } from '@workspace/core';
import type { DatabaseHandle, DatabaseSnapshot, DisplayContext } from '@workspace/database';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useApp } from '../context';

/** Load a database and follow its changes; `null` until loaded. */
export function useDatabase(
  databaseId: string,
): { handle: DatabaseHandle; snapshot: DatabaseSnapshot } | null {
  const { databases } = useApp();
  const [handle, setHandle] = useState<DatabaseHandle | null>(() => databases.get(databaseId));
  useEffect(() => {
    let active = true;
    databases.load(databaseId).then(
      (h) => active && setHandle(h),
      (error: unknown) => console.error(`Failed to open database ${databaseId}`, error),
    );
    return () => {
      active = false;
    };
  }, [databases, databaseId]);
  const current = handle?.id === databaseId ? handle : databases.get(databaseId);
  const subscribe = useCallback(
    (listener: () => void) => current?.subscribe(listener) ?? (() => {}),
    [current],
  );
  const snapshot = useSyncExternalStore(subscribe, () => current?.snapshot() ?? null);
  return current && snapshot ? { handle: current, snapshot } : null;
}

/** Follow the registry (databases loading, rows arriving). Returns its version. */
export function useRegistryVersion(): number {
  const { databases } = useApp();
  return useSyncExternalStore(databases.subscribe, databases.getVersion);
}

/** User names by id, for person and created/edited-by values. */
export function useDisplayContext(): DisplayContext {
  const { workspace } = useApp();
  const subscribe = useCallback(
    (listener: () => void) => {
      const users = getUsersMap(workspace);
      users.observeDeep(listener);
      return () => users.unobserveDeep(listener);
    },
    [workspace],
  );
  const key = useSyncExternalStore(subscribe, () =>
    listUsers(workspace)
      .map((u) => `${u.id}\u0000${u.name}`)
      .join('\u0001'),
  );
  return useMemo(
    () => ({
      users: new Map(
        key
          .split('\u0001')
          .filter(Boolean)
          .map((entry) => entry.split('\u0000') as [string, string]),
      ),
    }),
    [key],
  );
}
