import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addOption,
  addProperty,
  addRow,
  initDatabase,
  readDatabase,
  setAutomation,
  setCell,
  type Automation,
} from '@workspace/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  AUTOMATION_ORIGIN,
  DocManager,
  LocalAutomations,
  SqliteStore,
  signature,
  type LocalNotice,
} from './index';

let dir: string;
let store: SqliteStore;
let manager: DocManager;
const hosts: LocalAutomations[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ws-automations-'));
  store = new SqliteStore(join(dir, 'workspace.db'));
  manager = new DocManager(store, { indexDelayMs: 5 });
});
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  manager.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A window: edits its own copy and ships updates to the manager (and gets others'). */
function connectWindow(docId: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, manager.open(docId), 'load');
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote' && origin !== 'load') manager.applyUpdate(docId, update, 'window');
  });
  manager.onUpdate((id, update, origin) => {
    if (id === docId && origin !== 'window') Y.applyUpdate(doc, update, 'remote');
  });
  return doc;
}

const automation = (over: Partial<Automation>): Automation => ({
  id: 'a1',
  name: 'Done → completed',
  enabled: true,
  trigger: { kind: 'pageAdded' },
  condition: null,
  actions: [],
  createdBy: 'u-ada',
  createdAt: 1,
  ...over,
});

function setup() {
  const doc = connectWindow('db');
  initDatabase(doc, { databaseId: 'db' });
  const status = addProperty(doc, { name: 'Status', type: 'select' });
  addOption(doc, status, { id: 'todo', name: 'To do', color: 'gray' });
  addOption(doc, status, { id: 'done', name: 'Done', color: 'green' });
  const completed = addProperty(doc, { name: 'Completed', type: 'date' });
  return { doc, status, completed };
}

function host(options: Partial<ConstructorParameters<typeof LocalAutomations>[2]> = {}) {
  const notices: LocalNotice[] = [];
  const h = new LocalAutomations(manager, store, {
    active: () => true,
    userId: () => 'u-ada',
    notify: (n) => notices.push(n),
    delayMs: 10,
    retryDelaysMs: [10, 10],
    onError: (e) => {
      throw e;
    },
    ...options,
  });
  hosts.push(h);
  return { h, notices };
}

async function waitFor(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('automations on this device', () => {
  it('"set to Done": sets Completed and tells the person, once; windows see it', async () => {
    const { h, notices } = host({ now: () => Date.UTC(2026, 9, 9, 12) });
    const { doc, status, completed } = setup();
    setAutomation(
      doc,
      automation({
        trigger: { kind: 'propertyEdited', propertyId: status, to: 'done' },
        actions: [
          { kind: 'setProperties', values: { [completed]: { kind: 'now' } } },
          { kind: 'notify', people: ['u-ada'], peopleProperty: null, message: 'Done!' },
        ],
      }),
    );
    const row = addRow(doc, { actor: 'u-ada', title: 'Grease the gears' });
    await sleep(30);
    setCell(doc, row, status, 'done', 'u-ada');
    await waitFor(() => notices.length === 1);
    await h.idle();
    const r = readDatabase(doc).rows.find((x) => x.id === row)!;
    expect(r.values[completed]).toEqual({ start: '2026-10-09' });
    expect(notices[0]).toEqual({
      title: 'Automation: Done → completed',
      body: 'Done!',
      pageId: row,
    });
    expect(h.runs('db', 'a1')).toMatchObject([{ status: 'done', rowId: row }]);
    // Its own edit (and quiet time) start nothing more.
    await sleep(50);
    expect(notices).toHaveLength(1);
  });

  it('an automation that edits the property it watches runs once (no loops)', async () => {
    const { h } = host();
    const { doc, status } = setup();
    const points = addProperty(doc, { name: 'Points', type: 'number' });
    setAutomation(
      doc,
      automation({
        trigger: { kind: 'propertyEdited', propertyId: points },
        actions: [{ kind: 'setProperties', values: { [points]: { kind: 'fixed', value: 1 } } }],
      }),
    );
    const row = addRow(doc, { actor: 'u-ada', title: 'Task', values: { [status]: 'todo' } });
    await sleep(30);
    setCell(doc, row, points, 5, 'u-ada');
    await waitFor(() => h.runs('db', 'a1').length === 1);
    await h.idle();
    await sleep(60);
    expect(h.runs('db', 'a1')).toHaveLength(1);
    expect(readDatabase(doc).rows[0]!.values[points]).toBe(1);
  });

  it('a webhook is signed, tried again after a 500, and a failure is shown', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let fail = 1;
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('broken')) return new Response('', { status: 404 });
      return new Response('', { status: fail-- > 0 ? 500 : 200 });
    }) as unknown as typeof globalThis.fetch;
    const { h, notices } = host({ fetch });
    const { doc } = setup();
    setAutomation(
      doc,
      automation({
        name: 'Log',
        actions: [
          { kind: 'webhook', url: 'https://hooks.example/in', headers: { 'x-team': 'ops' } },
          { kind: 'webhook', url: 'https://broken.example/in', headers: {} },
        ],
      }),
    );
    const row = addRow(doc, { actor: 'u-ada', title: 'Grease the gears' });
    await waitFor(() => calls.length === 3 && notices.length === 1);
    const good = calls.filter((c) => c.url.includes('hooks.example'));
    expect(good).toHaveLength(2);
    const body = good[1]!.init.body as string;
    const headers = good[1]!.init.headers as Record<string, string>;
    expect(JSON.parse(body)).toMatchObject({
      source: { type: 'automation', automationId: 'a1', databaseId: 'db' },
      data: { id: row, title: 'Grease the gears' },
    });
    expect(headers['x-team']).toBe('ops');
    expect(headers['x-notion-signature']).toBe(signature(h.secret('db', 'a1'), body));
    // A 404 isn't tried again.
    expect(calls.filter((c) => c.url.includes('broken'))).toHaveLength(1);
    expect(notices[0]!.body).toBe('Webhook to broken.example failed: HTTP 404');
  });

  it('does nothing while the workspace syncs (the server runs them)', async () => {
    let syncing = true;
    const { h, notices } = host({ active: () => !syncing });
    const { doc } = setup();
    setAutomation(
      doc,
      automation({
        actions: [{ kind: 'notify', people: ['u-ada'], peopleProperty: null, message: 'New' }],
      }),
    );
    addRow(doc, { actor: 'u-ada', title: 'One' });
    await sleep(60);
    expect(notices).toHaveLength(0);
    syncing = false;
    addRow(doc, { actor: 'u-ada', title: 'Two' });
    await waitFor(() => notices.length === 1);
    expect(h.runs('db', 'a1')).toHaveLength(1);
  });

  it('schedules run at their time, and one missed while closed runs once at start', async () => {
    let now = Date.UTC(2026, 9, 9, 8, 0);
    const { h } = host({ now: () => now });
    const { doc } = setup();
    setAutomation(
      doc,
      automation({
        id: 'daily',
        name: 'Daily check-in',
        trigger: {
          kind: 'schedule',
          schedule: { every: 'day', time: '09:00', timeZone: 'UTC' },
        },
        actions: [{ kind: 'addPage', title: 'Check-in', values: {} }],
      }),
    );
    await sleep(30); // the change is looked at: the schedule counts from now
    h.tick();
    await h.idle();
    expect(readDatabase(doc).rows).toHaveLength(0);
    now = Date.UTC(2026, 9, 9, 9, 1);
    h.tick();
    await h.idle();
    expect(readDatabase(doc).rows.map((r) => r.title)).toEqual(['Check-in']);
    h.tick();
    await h.idle();
    expect(readDatabase(doc).rows).toHaveLength(1);

    // Closed for three days: one run at the next start.
    h.close();
    now = Date.UTC(2026, 9, 12, 18, 0);
    const again = host({ now: () => now }).h;
    again.start();
    await again.idle();
    expect(readDatabase(doc).rows).toHaveLength(2);
    again.tick();
    await again.idle();
    expect(readDatabase(doc).rows).toHaveLength(2);
    expect(again.runs('db', 'daily')).toHaveLength(2);
  });

  it('an automation’s edits come with their own origin', async () => {
    host();
    const { doc } = setup();
    setAutomation(doc, automation({ actions: [{ kind: 'addPage', title: 'Echo', values: {} }] }));
    const origins: unknown[] = [];
    manager.onUpdate((id, _u, origin) => id === 'db' && origins.push(origin));
    addRow(doc, { actor: 'u-ada', title: 'One' });
    await waitFor(() => readDatabase(doc).rows.length === 2);
    expect(origins).toContain(AUTOMATION_ORIGIN);
  });
});
