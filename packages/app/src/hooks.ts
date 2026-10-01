import type { DocClient } from '@workspace/core';
import { useEffect, useReducer, useState } from 'react';
import type * as Y from 'yjs';

/** Acquire a doc from the client while mounted; `null` until its stored state is loaded. */
export function useDoc(client: DocClient, docId: string | null): Y.Doc | null {
  const [loaded, setLoaded] = useState<{ id: string; doc: Y.Doc } | null>(null);

  useEffect(() => {
    if (docId === null) return;
    const handle = client.acquire(docId);
    let active = true;
    handle.ready.then(
      () => active && setLoaded({ id: docId, doc: handle.doc }),
      (error: unknown) => console.error(`Failed to open doc ${docId}`, error),
    );
    return () => {
      active = false;
      handle.release();
    };
  }, [client, docId]);

  return loaded && loaded.id === docId ? loaded.doc : null;
}

/** A counter that increments on every change to `doc`, for memoizing derived views. */
export function useDocVersion(doc: Y.Doc | null): number {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!doc) return;
    doc.on('update', bump);
    return () => doc.off('update', bump);
  }, [doc]);
  return version;
}
