/**
 * Presence in the app: one y-protocols `Awareness` per doc a window shows, shared by its
 * views, connected to the host's presence channel (other windows, the server, other
 * people). Only this window's own state is sent; others' come back through the channel.
 */
import type {
  DocClient,
  Forest,
  PresenceChannel,
  PresenceState,
  PresenceUser,
} from '@workspace/core';
import { createContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { useApp } from './context';

/** Origin of updates that came through the channel (not sent back). */
const REMOTE = Symbol('remote');

interface Entry {
  awareness: Awareness;
  refs: number;
  channel: PresenceChannel | null;
}

export class PresenceHub {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly client: DocClient,
    readonly user: PresenceUser,
  ) {}

  /** The awareness of a doc this window shows (pair with `release`). */
  acquire(docId: string, doc: Y.Doc): Awareness {
    const existing = this.entries.get(docId);
    if (existing && existing.awareness.doc === doc) {
      existing.refs++;
      return existing.awareness;
    }
    if (existing) this.drop(docId, existing);
    const awareness = new Awareness(doc);
    awareness.setLocalState({ user: this.user });
    const channel = this.client.joinPresence(docId, {
      onUpdate: (update) => applyAwarenessUpdate(awareness, update, REMOTE),
      // The server forgot us (reconnected): the same state again, with a newer clock.
      onRejoin: () => awareness.setLocalState(awareness.getLocalState()),
    });
    awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        if (origin === REMOTE || !channel) return;
        const mine = [...added, ...updated, ...removed].filter((id) => id === awareness.clientID);
        if (mine.length > 0) channel.send(encodeAwarenessUpdate(awareness, mine));
      },
    );
    this.entries.set(docId, { awareness, refs: 1, channel });
    return awareness;
  }

  release(docId: string, awareness: Awareness): void {
    const entry = this.entries.get(docId);
    if (!entry || entry.awareness !== awareness) return;
    if (--entry.refs > 0) return;
    this.drop(docId, entry);
  }

  private drop(docId: string, entry: Entry) {
    this.entries.delete(docId);
    // Destroying clears our state: the others see us go.
    entry.awareness.destroy();
    entry.channel?.leave();
  }
}

/** A doc's awareness while mounted (null without a doc or presence). */
export function usePresence(docId: string | null, doc: Y.Doc | null): Awareness | null {
  const { presence } = useApp();
  const [awareness, setAwareness] = useState<Awareness | null>(null);
  useEffect(() => {
    if (!presence || !doc || !docId) {
      setAwareness(null);
      return;
    }
    const a = presence.acquire(docId, doc);
    setAwareness(a);
    return () => presence.release(docId, a);
  }, [presence, docId, doc]);
  return awareness;
}

export interface Peer {
  clientID: number;
  state: PresenceState;
}

const NO_PEERS: Peer[] = [];

/**
 * Who else is here: the other states with a user (not this person's own windows),
 * kept current.
 */
export function usePeers(awareness: Awareness | null, selfId: string | null): Peer[] {
  const key = useSyncExternalStore(
    (listener) => {
      awareness?.on('change', listener);
      return () => awareness?.off('change', listener);
    },
    () => {
      if (!awareness) return '';
      const list: [number, PresenceState][] = [];
      for (const [clientID, state] of awareness.getStates()) {
        const s = state as Partial<PresenceState>;
        if (clientID === awareness.clientID || !s.user || s.user.id === selfId) continue;
        list.push([clientID, s as PresenceState]);
      }
      return JSON.stringify(list);
    },
  );
  return useMemo(
    () =>
      key
        ? (JSON.parse(key) as [number, PresenceState][]).map(([clientID, state]) => ({
            clientID,
            state,
          }))
        : NO_PEERS,
    [key],
  );
}

/** One per person (they may have several windows on the page). */
export function uniquePeople(peers: Peer[]): Peer[] {
  const seen = new Set<string>();
  return peers.filter((p) => !seen.has(p.state.user.id) && seen.add(p.state.user.id));
}

/**
 * Presence on a database: who has which row open. With `rowId`, this window says it has
 * that row open (while mounted). Returns the others, by row.
 */
export function useRowPresence(
  databaseId: string | null,
  databaseDoc: Y.Doc | null,
  rowId: string | null = null,
): ReadonlyMap<string, Peer[]> {
  const { user } = useApp();
  const awareness = usePresence(databaseId, databaseDoc);
  useEffect(() => {
    if (!awareness || !rowId) return;
    awareness.setLocalStateField('row', rowId);
    return () => {
      if (awareness.getLocalState()) awareness.setLocalStateField('row', null);
    };
  }, [awareness, rowId]);
  const peers = usePeers(awareness, user.id);
  return useMemo(() => {
    const byRow = new Map<string, Peer[]>();
    for (const peer of uniquePeople(peers)) {
      const row = peer.state.row;
      if (!row) continue;
      byRow.set(row, [...(byRow.get(row) ?? []), peer]);
    }
    return byRow;
  }, [peers]);
}

/** Who has each row of the database on screen open (for the views' rows). */
export const RowPresenceContext = createContext<ReadonlyMap<string, Peer[]>>(new Map());

/**
 * Who is viewing which page: each window says which page it shows on that page's tree
 * doc (readers of the tree can see the page anyway). Returns the others, by page.
 */
export function usePageViewers(
  forest: Forest,
  current: string | null,
): ReadonlyMap<string, Peer[]> {
  const { presence, user } = useApp();
  // The trees change only when access does (not on every edit).
  const trees = useSyncExternalStore(
    (listener) => {
      forest.on('update', listener);
      return () => forest.off('update', listener);
    },
    () => forest.list(),
  );
  const [awarenesses, setAwarenesses] = useState<Awareness[]>([]);
  useEffect(() => {
    if (!presence) return;
    const held = trees.map((t) => ({ id: t.info.id, a: presence.acquire(t.info.id, t.doc) }));
    setAwarenesses(held.map((h) => h.a));
    return () => {
      for (const h of held) presence.release(h.id, h.a);
    };
  }, [presence, trees]);
  // Say where this window is.
  useEffect(() => {
    const home = current ? forest.treeOf(current)?.info.id : undefined;
    trees.forEach((t, i) => {
      const a = awarenesses[i];
      if (!a?.getLocalState()) return;
      const viewing = t.info.id === home ? current : null;
      if (a.getLocalState()!.viewing !== viewing) a.setLocalStateField('viewing', viewing);
    });
  }, [awarenesses, trees, forest, current]);
  // Everyone else's, kept current.
  const key = useSyncExternalStore(
    (listener) => {
      for (const a of awarenesses) a.on('change', listener);
      return () => {
        for (const a of awarenesses) a.off('change', listener);
      };
    },
    () => {
      const list: [string, number, PresenceState][] = [];
      for (const a of awarenesses) {
        for (const [clientID, state] of a.getStates()) {
          const s = state as Partial<PresenceState>;
          if (clientID === a.clientID || !s.user || s.user.id === user.id || !s.viewing) continue;
          list.push([s.viewing, clientID, s as PresenceState]);
        }
      }
      return JSON.stringify(list);
    },
  );
  return useMemo(() => {
    const byPage = new Map<string, Peer[]>();
    for (const [page, clientID, state] of JSON.parse(key) as [string, number, PresenceState][]) {
      const list = byPage.get(page) ?? [];
      if (!list.some((p) => p.state.user.id === state.user.id)) list.push({ clientID, state });
      byPage.set(page, list);
    }
    return byPage;
  }, [key]);
}
