/**
 * Automations on a device (Phase 6 M4), for a workspace that isn't on a server: the
 * desktop's main process runs them as the server would (Phase 6 M3) for its own copy.
 *
 * - **Following changes:** each database with automations keeps a starting copy (taken
 *   when it's loaded, or when its first automation appears). Changes made here are
 *   looked at a moment after they stop (`delayMs`), against that copy, and the copy
 *   moves on.
 * - **No loops:** what an automation writes has its own origin; it goes straight into
 *   the starting copy, so it's never seen as a change. Before it writes, changes still
 *   waiting are looked at first, so the copy is never behind.
 * - **Schedules** run while the app is open; one missed while it was closed runs once
 *   at the next start (not once per missed time).
 * - **Webhooks** go from here, signed with the automation's secret, and are tried
 *   again a few times; a failure is shown as a notification.
 * - **Hand-over:** while the workspace syncs, the server runs automations, and this
 *   does nothing (`active`).
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { MEMBERS_DOC_ID, isCommentsDocId, isTreeDocId } from '@workspace/core';
import {
  addRow,
  isDatabaseDoc,
  nextRun,
  planActions,
  readAutomations,
  readDatabase,
  scheduleKey,
  setCell,
  setRowTitle,
  triggeredBy,
  type Automation,
  type Effect,
} from '@workspace/database';
import * as Y from 'yjs';
import type { DocManager } from './doc-manager';
import type { SqliteStore } from './sqlite-store';

/** The origin of what an automation writes (never looked at as a change). */
export const AUTOMATION_ORIGIN = Symbol('automation');

const RUNS = 'automations.runs';
const SCHEDULES = 'automations.schedules';
const SECRETS = 'automations.secrets';
const BUTTON_SECRET = 'buttons.secret';
/** Runs kept for the run log (all automations together). */
const KEEP_RUNS = 200;
/** Look at schedules at least this often (a changed clock, sleep and resume). */
const MAX_WAIT_MS = 60_000;

export interface LocalRun {
  id: string;
  databaseId: string;
  automationId: string;
  at: number;
  rowId: string | null;
  status: 'done' | 'failed' | 'pending';
  error: string | null;
  result: unknown;
}

/** A notification an automation (or a button) shows on this device. */
export interface LocalNotice {
  title: string;
  body: string;
  /** What it's about (a page or row), to open on click. */
  pageId: string | null;
}

export interface LocalAutomationsOptions {
  /** Is this device the one to run them (not while syncing: the server does)? */
  active: () => boolean;
  /** The person using the app (who "triggered" a change made here). */
  userId: () => string;
  notify: (notice: LocalNotice) => void;
  now?: () => number;
  /** Wait this long after a change before looking at it (edits in a burst are one). */
  delayMs?: number;
  /** Waits before trying a failed webhook again (one more try per entry). */
  retryDelaysMs?: readonly number[];
  fetch?: typeof fetch;
  onError?: (error: unknown) => void;
}

interface ScheduleState {
  /** The schedule it counts from (`scheduleKey`): a changed one starts again. */
  key: string;
  /** When it last ran (or started counting). */
  lastRun: number;
}

const schedulesKey = (databaseId: string, automationId: string) => `${databaseId}/${automationId}`;

export class LocalAutomations {
  /** Each followed database's rows as last looked at. */
  private readonly baselines = new Map<string, Y.Doc>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private scheduleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Runs one at a time, in order. */
  private queue: Promise<void> = Promise.resolve();
  private readonly unsubscribe: (() => void)[] = [];
  private readonly now: () => number;
  private readonly delayMs: number;
  private readonly fetch: typeof fetch;
  private closed = false;

  constructor(
    private readonly manager: DocManager,
    private readonly store: SqliteStore,
    private readonly options: LocalAutomationsOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.delayMs = options.delayMs ?? 3000;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.unsubscribe.push(
      manager.onLoad((docId, doc) => {
        if (!this.baselines.has(docId) && followed(docId) && hasPageAutomations(doc)) {
          this.baselines.set(docId, copy(doc));
        }
      }),
      manager.onUpdate((docId, update, origin) => this.changed(docId, update, origin)),
    );
  }

  /** Start the schedules (and run any missed while the app was closed). */
  start(): void {
    this.tick();
  }

  close(): void {
    this.closed = true;
    for (const off of this.unsubscribe) off();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    clearTimeout(this.scheduleTimer);
    for (const doc of this.baselines.values()) doc.destroy();
    this.baselines.clear();
  }

  /** Does this device run automations now (not while the workspace syncs)? */
  active(): boolean {
    return this.options.active();
  }

  /** Wait for the runs started so far (tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  /** The recent runs of an automation, newest first. */
  runs(databaseId: string, automationId: string): LocalRun[] {
    return this.allRuns()
      .filter((r) => r.databaseId === databaseId && r.automationId === automationId)
      .reverse();
  }

  /** An automation's webhook signing secret (made when first asked for). */
  secret(databaseId: string, automationId: string): string {
    const secrets = this.store.getSetting<Record<string, string>>(SECRETS) ?? {};
    const key = schedulesKey(databaseId, automationId);
    if (!secrets[key]) {
      secrets[key] = newSecret();
      this.store.setSetting(SECRETS, secrets);
    }
    return secrets[key];
  }

  /** The secret button webhooks are signed with (one for the workspace). */
  buttonSecret(): string {
    let secret = this.store.getSetting<string>(BUTTON_SECRET);
    if (!secret) {
      secret = newSecret();
      this.store.setSetting(BUTTON_SECRET, secret);
    }
    return secret;
  }

  /** A button's "Send webhook" step: POST the page, signed; tried again like a run's. */
  buttonWebhook(url: string, headers: Record<string, string>, body: unknown, label: string) {
    void this.deliver(url, headers, body, this.buttonSecret(), (error) =>
      this.options.notify({
        title: `Button: ${label || 'Button'}`,
        body: `Webhook to ${hostOf(url)} failed: ${error}`,
        pageId: null,
      }),
    );
  }

  // --- Following changes ----------------------------------------------------------

  private changed(docId: string, update: Uint8Array, origin: unknown): void {
    if (this.closed || !followed(docId)) return;
    const baseline = this.baselines.get(docId);
    if (origin === AUTOMATION_ORIGIN) {
      if (baseline) Y.applyUpdate(baseline, update);
      return;
    }
    const doc = this.manager.loaded(docId);
    if (!doc || !isDatabaseDoc(doc)) return;
    // Its first automation (or the database itself) just arrived: count from here.
    if (!baseline && hasPageAutomations(doc)) this.baselines.set(docId, copy(doc));
    // Looked at even while syncing (nothing runs then): the copy keeps up.
    clearTimeout(this.timers.get(docId));
    this.timers.set(
      docId,
      setTimeout(() => this.check(docId), this.delayMs),
    );
  }

  /** Look at a database's changes now (when waiting to). */
  private flush(databaseId: string): void {
    if (this.timers.has(databaseId)) this.check(databaseId);
  }

  private check(databaseId: string): void {
    clearTimeout(this.timers.get(databaseId));
    this.timers.delete(databaseId);
    if (this.closed) return;
    const after = this.current(databaseId);
    try {
      const baseline = this.baselines.get(databaseId);
      if (!after || !isDatabaseDoc(after)) {
        baseline?.destroy();
        this.baselines.delete(databaseId);
        return;
      }
      const automations = readAutomations(after);
      this.lineUp(databaseId, automations);
      const onPages = automations.filter((a) => a.trigger.kind !== 'schedule');
      if (baseline && onPages.length && this.options.active()) {
        const now = readDatabase(after);
        const started = triggeredBy(
          onPages,
          readDatabase(baseline).rows,
          now.rows,
          now.properties,
          {
            users: new Map(),
          },
        );
        const actorId = this.options.userId();
        for (const t of started) this.enqueue(databaseId, t.automation.id, t.rowId, actorId);
      }
      if (baseline) {
        Y.applyUpdate(baseline, Y.encodeStateAsUpdate(after, Y.encodeStateVector(baseline)));
        if (!onPages.length) {
          baseline.destroy();
          this.baselines.delete(databaseId);
        }
      }
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      after?.destroy();
    }
  }

  /** The database as it is now (a copy to read). */
  private current(databaseId: string): Y.Doc | null {
    const state = this.manager.open(databaseId);
    this.manager.release(databaseId);
    if (state.byteLength <= 2) return null;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    return doc;
  }

  // --- Schedules --------------------------------------------------------------------

  /** Keep the database's schedules in the list (a new or changed one counts from now). */
  private lineUp(databaseId: string, automations: readonly Automation[]): void {
    const schedules = this.schedules();
    let changed = false;
    for (const key of Object.keys(schedules)) {
      if (!key.startsWith(`${databaseId}/`)) continue;
      const a = automations.find((x) => schedulesKey(databaseId, x.id) === key);
      if (!a || a.trigger.kind !== 'schedule' || !a.enabled) {
        delete schedules[key];
        changed = true;
      }
    }
    for (const a of automations) {
      if (a.trigger.kind !== 'schedule' || !a.enabled) continue;
      const key = schedulesKey(databaseId, a.id);
      const sk = scheduleKey(a.trigger.schedule);
      if (schedules[key]?.key === sk) continue;
      schedules[key] = { key: sk, lastRun: this.now() };
      changed = true;
    }
    if (changed) {
      this.store.setSetting(SCHEDULES, schedules);
      this.tick();
    }
  }

  private schedules(): Record<string, ScheduleState> {
    return { ...(this.store.getSetting<Record<string, ScheduleState>>(SCHEDULES) ?? {}) };
  }

  /** Run what's due (once each, however many times it was missed), then sleep. */
  tick = (): void => {
    clearTimeout(this.scheduleTimer);
    if (this.closed) return;
    const now = this.now();
    const schedules = this.schedules();
    let next = Infinity;
    let changed = false;
    for (const [key, state] of Object.entries(schedules)) {
      const [databaseId, automationId] = key.split('/') as [string, string];
      const doc = this.current(databaseId);
      const a =
        doc && isDatabaseDoc(doc)
          ? readAutomations(doc).find((x) => x.id === automationId)
          : undefined;
      doc?.destroy();
      if (!a || !a.enabled || a.trigger.kind !== 'schedule') {
        delete schedules[key];
        changed = true;
        continue;
      }
      if (scheduleKey(a.trigger.schedule) !== state.key) {
        schedules[key] = { key: scheduleKey(a.trigger.schedule), lastRun: now };
        changed = true;
        continue;
      }
      const due = nextRun(a.trigger.schedule, state.lastRun);
      if (due === null) continue;
      if (due <= now) {
        if (this.options.active()) this.enqueue(databaseId, automationId, null, null);
        schedules[key] = { ...state, lastRun: now };
        changed = true;
        const after = nextRun(a.trigger.schedule, now);
        if (after !== null) next = Math.min(next, after);
      } else next = Math.min(next, due);
    }
    if (changed) this.store.setSetting(SCHEDULES, schedules);
    const wait = Math.max(0, Math.min(next - now, MAX_WAIT_MS));
    this.scheduleTimer = setTimeout(this.tick, wait);
    (this.scheduleTimer as { unref?: () => void }).unref?.();
  };

  // --- Runs ---------------------------------------------------------------------------

  private enqueue(
    databaseId: string,
    automationId: string,
    rowId: string | null,
    actorId: string | null,
  ): void {
    const run: LocalRun = {
      id: randomUUID(),
      databaseId,
      automationId,
      at: this.now(),
      rowId,
      status: 'pending',
      error: null,
      result: null,
    };
    this.saveRun(run);
    this.queue = this.queue
      .then(() => this.run(run, actorId))
      .catch((error: unknown) => this.options.onError?.(error));
  }

  private async run(run: LocalRun, actorId: string | null): Promise<void> {
    if (this.closed) return;
    const finish = (status: LocalRun['status'], result: unknown, error: string | null = null) =>
      this.saveRun({ ...run, status, result, error });
    const doc = this.current(run.databaseId);
    let automation: Automation | undefined;
    let effects: Effect[];
    try {
      automation =
        doc && isDatabaseDoc(doc)
          ? readAutomations(doc).find((a) => a.id === run.automationId)
          : undefined;
      if (!automation || !automation.enabled || !this.options.active()) {
        finish('done', { skipped: 'off' });
        return;
      }
      const snapshot = readDatabase(doc!);
      const row = run.rowId
        ? (snapshot.rows.find((r) => r.id === run.rowId && r.trashedAt === null) ?? null)
        : null;
      if (run.rowId && !row) {
        finish('done', { skipped: 'page gone' });
        return;
      }
      effects = planActions(automation, row, snapshot.properties, {
        databaseId: run.databaseId,
        actorId,
        now: this.now(),
      });
    } finally {
      doc?.destroy();
    }
    try {
      for (const effect of effects) this.apply(run, automation, effect);
      finish('done', { done: effects.map((e) => e.kind) });
    } catch (error) {
      finish('failed', null, error instanceof Error ? error.message : String(error));
    }
  }

  private apply(run: LocalRun, a: Automation, effect: Effect): void {
    // It acts as its maker (on this device, the person using it).
    const actor = a.createdBy;
    switch (effect.kind) {
      case 'edit':
        this.edit(run.databaseId, (doc) => {
          for (const [propertyId, value] of Object.entries(effect.values)) {
            setCell(doc, effect.rowId, propertyId, value, actor, this.now());
          }
          if (effect.title !== undefined) {
            setRowTitle(doc, effect.rowId, effect.title, actor, this.now());
          }
        });
        return;
      case 'add':
        this.edit(run.databaseId, (doc) =>
          addRow(doc, { actor, title: effect.title, values: effect.values, now: this.now() }),
        );
        return;
      case 'notify':
        // One person uses a local workspace: whoever it names, it's shown here.
        this.options.notify({
          title: `Automation: ${a.name || 'Automation'}`,
          body: effect.message,
          pageId: effect.rowId ?? run.databaseId,
        });
        return;
      case 'webhook':
        void this.deliver(
          effect.url,
          effect.headers,
          effect.body,
          this.secret(run.databaseId, a.id),
          (error) =>
            this.options.notify({
              title: `Automation: ${a.name || 'Automation'}`,
              body: `Webhook to ${hostOf(effect.url)} failed: ${error}`,
              pageId: effect.body.data?.id ?? run.databaseId,
            }),
        );
    }
  }

  /** Change a database as an automation: in the manager, with the automation's origin. */
  private edit(databaseId: string, change: (doc: Y.Doc) => void): void {
    // Changes still waiting are looked at first: the starting copy must not be behind.
    this.flush(databaseId);
    const doc = this.current(databaseId);
    if (!doc) throw new Error('The database is gone');
    try {
      const updates: Uint8Array[] = [];
      doc.on('update', (u: Uint8Array) => updates.push(u));
      change(doc);
      if (updates.length) {
        this.manager.applyUpdate(databaseId, Y.mergeUpdates(updates), AUTOMATION_ORIGIN);
      }
    } finally {
      doc.destroy();
    }
  }

  // --- Webhooks -----------------------------------------------------------------------

  /** POST, signed; a network error, 5xx or 429 is tried again; `failed` when it gives up. */
  private async deliver(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    secret: string,
    failed: (error: string) => void,
  ): Promise<void> {
    const delays = this.options.retryDelaysMs ?? [5_000, 30_000, 120_000];
    const payload = JSON.stringify(body);
    let error = '';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      if (this.closed) return;
      try {
        if (!/^https?:\/\//i.test(url)) throw new PermanentError('Not an http(s) URL');
        const response = await this.fetch(url, {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'application/json',
            'user-agent': 'Workspace-Webhooks/1',
            'x-notion-signature': signature(secret, payload),
          },
          body: payload,
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
        void response.body?.cancel();
        if (response.ok) return;
        error = `HTTP ${response.status}`;
        if (response.status < 500 && response.status !== 429) break;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        if (e instanceof PermanentError) break;
      }
    }
    failed(error);
  }

  private allRuns(): LocalRun[] {
    return this.store.getSetting<LocalRun[]>(RUNS) ?? [];
  }

  private saveRun(run: LocalRun): void {
    const runs = this.allRuns().filter((r) => r.id !== run.id);
    runs.push(run);
    this.store.setSetting(RUNS, runs.slice(-KEEP_RUNS));
  }
}

class PermanentError extends Error {}

/** Docs that can be databases (not page trees, comments or the members list). */
const followed = (docId: string) =>
  !isTreeDocId(docId) && !isCommentsDocId(docId) && docId !== MEMBERS_DOC_ID;

const hasPageAutomations = (doc: Y.Doc) =>
  isDatabaseDoc(doc) && readAutomations(doc).some((a) => a.trigger.kind !== 'schedule');

function copy(doc: Y.Doc): Y.Doc {
  const out = new Y.Doc();
  Y.applyUpdate(out, Y.encodeStateAsUpdate(doc));
  return out;
}

const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/** `sha256=<hex HMAC of the body>`, as the server signs. */
export const signature = (secret: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'an invalid URL';
  }
}
