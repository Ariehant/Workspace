import { getUsersMap, listUsers } from '@workspace/core';
import {
  FormulaCache,
  type DatabaseHandle,
  type DatabaseSnapshot,
  type DisplayContext,
} from '@workspace/database';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useApp } from '../context';

/** One formula cache per open database (it keeps results for unchanged rows). */
const formulaCaches = new WeakMap<DatabaseHandle, FormulaCache>();

const MINUTE = 60_000;
const subscribeMinute = (onChange: () => void) => {
  const timer = setInterval(onChange, MINUTE / 4);
  return () => clearInterval(timer);
};
/** The current minute, re-rendering as it changes (for `now()` in formulas). */
function useMinute(): number {
  return useSyncExternalStore(subscribeMinute, () => Math.floor(Date.now() / MINUTE) * MINUTE);
}

/**
 * Load a database and follow its changes; `null` until loaded. The snapshot has
 * formula values computed (see `FormulaCache`).
 */
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
  const raw = useSyncExternalStore(subscribe, () => current?.snapshot() ?? null);
  const ctx = useDisplayContext();
  const { user } = useApp();
  const now = useMinute();
  const snapshot = useMemo(() => {
    if (!current || !raw) return null;
    let cache = formulaCaches.get(current);
    if (!cache) {
      cache = new FormulaCache();
      formulaCaches.set(current, cache);
    }
    return cache.apply(raw, { ...ctx, me: user.id, now });
  }, [current, raw, ctx, user.id, now]);
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
