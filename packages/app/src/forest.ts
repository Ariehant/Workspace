import {
  Forest,
  WORKSPACE_DOC_ID,
  type DocClient,
  type DocHandle,
  type TreeInfo,
} from '@workspace/core';
import { useEffect, useRef, useState } from 'react';
import type { Platform, ScopeInfo } from './platform';

/**
 * The scopes the person can read, kept current: `undefined` while loading, `null` for a
 * workspace that isn't on a server (or before the server has said).
 */
export function useScopes(platform: Platform): ScopeInfo[] | null | undefined {
  const [scopes, setScopes] = useState<ScopeInfo[] | null | undefined>(
    platform.scopes ? undefined : null,
  );
  useEffect(() => {
    const source = platform.scopes;
    if (!source) return;
    let alive = true;
    let last = '';
    const update = (next: ScopeInfo[] | null) => {
      // Sync status changes often (typing); only a real change re-renders.
      const key = JSON.stringify(next);
      if (!alive || key === last) return;
      last = key;
      setScopes(next);
    };
    source.get().then(update, (error: unknown) => {
      console.error('Failed to load scopes', error);
      update(null);
    });
    const off = source.onChange(update);
    return () => {
      alive = false;
      off();
    };
  }, [platform]);
  return scopes;
}

const treeOf = (scope: ScopeInfo): TreeInfo => ({
  id: scope.treeDoc,
  scope: scope.id,
  kind: scope.kind,
  name: scope.name,
  role: scope.role,
  parent: scope.parent || null,
});

/**
 * The page trees of the scopes the person can read, as one `Forest` that stays the same
 * object for the app's life (its trees change with access). `null` until the first set
 * is loaded.
 */
export function useForest(client: DocClient, platform: Platform): Forest | null {
  const scopes = useScopes(platform);
  const [forest] = useState(() => new Forest());
  const [ready, setReady] = useState(false);
  const held = useRef<DocHandle[]>([]);

  useEffect(() => {
    if (scopes === undefined) return;
    const infos: TreeInfo[] =
      scopes === null
        ? [
            {
              id: WORKSPACE_DOC_ID,
              scope: null,
              kind: 'local',
              name: 'Private',
              role: 'full',
              parent: null,
            },
          ]
        : scopes.map(treeOf);
    // The new trees are acquired before the old ones are released, so a tree in both
    // keeps its doc.
    const handles = infos.map((info) => client.acquire(info.id));
    let active = true;
    Promise.all(handles.map((h) => h.ready)).then(
      () => {
        if (!active) return;
        forest.set(infos.map((info, i) => ({ info, doc: handles[i]!.doc })));
        for (const old of held.current) old.release();
        held.current = handles;
        setReady(true);
      },
      (error: unknown) => console.error('Failed to open the page trees', error),
    );
    return () => {
      active = false;
      // Not yet in use (a newer set came first): let them go.
      if (held.current !== handles) for (const h of handles) h.release();
    };
  }, [client, forest, scopes]);

  useEffect(
    () => () => {
      for (const h of held.current) h.release();
      held.current = [];
    },
    [forest],
  );

  return ready ? forest : null;
}
