import * as Y from 'yjs';
import type { LogStore, LoggedRow, NewRow } from './hub';

/** A `LogStore` in memory, with the same semantics as the Postgres one (tests). */
export class MemoryLogStore implements LogStore {
  private readonly logs = new Map<string, { last: number; rows: LoggedRow[] }>();

  private log(workspaceId: string) {
    let log = this.logs.get(workspaceId);
    if (!log) this.logs.set(workspaceId, (log = { last: 0, rows: [] }));
    return log;
  }

  async append(workspaceId: string, updates: NewRow[]): Promise<number[]> {
    const log = this.log(workspaceId);
    return updates.map((u) => {
      const seq = ++log.last;
      log.rows.push({ seq, docId: u.docId, data: u.data, deviceId: u.deviceId });
      return seq;
    });
  }

  async since(workspaceId: string, cursor: number, limit: number): Promise<LoggedRow[]> {
    return this.log(workspaceId)
      .rows.filter((r) => r.seq > cursor)
      .slice(0, limit);
  }

  async latest(workspaceId: string): Promise<number> {
    return this.log(workspaceId).last;
  }

  async docState(workspaceId: string, docId: string): Promise<Uint8Array | null> {
    const rows = this.log(workspaceId).rows.filter((r) => r.docId === docId);
    return rows.length ? Y.mergeUpdates(rows.map((r) => r.data)) : null;
  }

  /** Merge a doc's rows into one under a new seq (like `PgStore.compactDoc`). */
  compact(workspaceId: string, docId: string): number | null {
    const log = this.log(workspaceId);
    const rows = log.rows.filter((r) => r.docId === docId);
    if (rows.length < 2) return null;
    const seq = ++log.last;
    log.rows = log.rows.filter((r) => r.docId !== docId);
    log.rows.push({ seq, docId, data: Y.mergeUpdates(rows.map((r) => r.data)), deviceId: null });
    return seq;
  }
}
