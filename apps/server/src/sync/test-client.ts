/** Test helpers: a device (Yjs docs + outbox + cursor) syncing through a real socket. */
import { SyncClient, type ClientStore, type OutboxEntry } from '@workspace/sync';
import WebSocket from 'ws';
import * as Y from 'yjs';

const REMOTE = Symbol('remote');

export interface DeviceOptions {
  url: string;
  token?: string;
  headers?: Record<string, string>;
  deviceId: string;
}

export class TestDevice {
  readonly docs = new Map<string, Y.Doc>();
  outbox: OutboxEntry[] = [];
  cursor = 0;
  updatesReceived = 0;
  closes: { code: number; reason: string }[] = [];
  private nextId = 1;
  readonly client: SyncClient;
  socket: WebSocket | null = null;

  constructor(options: DeviceOptions) {
    const store: ClientStore = {
      cursor: () => this.cursor,
      pending: (limit) => this.outbox.slice(0, limit),
      acknowledge: (ids) => {
        const done = new Set(ids);
        this.outbox = this.outbox.filter((e) => !done.has(e.localId));
      },
      applyRemote: (items, cursor) => {
        this.updatesReceived++;
        for (const item of items) Y.applyUpdate(this.doc(item.docId), item.update, REMOTE);
        this.cursor = cursor;
      },
    };
    this.client = new SyncClient({
      store,
      deviceId: options.deviceId,
      backoff: { minMs: 20, maxMs: 200 },
      connect: (handlers) => {
        const ws = new WebSocket(options.url, {
          headers: {
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
            ...options.headers,
          },
        });
        this.socket = ws;
        ws.binaryType = 'nodebuffer';
        ws.on('open', () => handlers.onOpen());
        ws.on('message', (data) => handlers.onMessage(data as Buffer));
        ws.on('close', (code, reason) => {
          this.closes.push({ code, reason: reason.toString() });
          handlers.onClose(code, reason.toString());
        });
        ws.on('error', () => {});
        return { send: (data) => ws.send(data), close: () => ws.close() };
      },
    });
  }

  doc(id: string): Y.Doc {
    let doc = this.docs.get(id);
    if (!doc) {
      doc = new Y.Doc();
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === REMOTE) return;
        this.outbox.push({ localId: this.nextId++, docId: id, update });
        this.client.flush();
      });
      this.docs.set(id, doc);
    }
    return doc;
  }

  text(id: string): string {
    return this.doc(id).getText('t').toString();
  }
}
