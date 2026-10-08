/**
 * Presence: who else is on a doc, and where (Phase 5). The app keeps a y-protocols
 * `Awareness` per doc it shows and passes its updates through the transport's presence
 * channel (other windows, the sync server, other people), which hands back theirs.
 */

/** Someone on a doc, as their presence state names them (the server sets it). */
export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

/** What a presence state holds (y-tiptap adds `cursor` on page docs). */
export interface PresenceState {
  user: PresenceUser;
  /** On a page tree doc: the page being viewed. */
  viewing?: string | null;
  /** On a database doc: the row whose page is open. */
  row?: string | null;
  [key: string]: unknown;
}

export interface PresenceHandlers {
  /** Others' awareness update for the doc. */
  onUpdate(update: Uint8Array): void;
  /** The connection came back: announce your state again. */
  onRejoin(): void;
}

export interface PresenceChannel {
  /** Send this window's awareness update. */
  send(update: Uint8Array): void;
  leave(): void;
}

/** A transport's presence (optional: hosts without it show nobody). */
export interface PresenceTransport {
  join(docId: string, handlers: PresenceHandlers): PresenceChannel;
}

/** Cursor colors (readable on light and dark backgrounds). Same list as the server's. */
const COLORS = [
  '#e03e3e',
  '#d9730d',
  '#c29b00',
  '#0f7b6c',
  '#0b6e99',
  '#6940a5',
  '#ad1a72',
  '#2e7d32',
  '#1565c0',
  '#8e5a2b',
];

/** A person's cursor color: the same everywhere, from their id (as the server picks it). */
export function presenceColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length]!;
}
