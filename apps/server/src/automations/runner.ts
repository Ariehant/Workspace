/**
 * Automations on the server (Phase 6 M3).
 *
 * - **Following the log** (its own cursor, `automations`): for each database doc that
 *   changed, the change is replayed author by author (as the notifier does with comments)
 *   and diffed, row by row, against the automations in the doc (`triggeredBy`). Each
 *   automation started is a job, enqueued in the transaction that moves the cursor.
 *   Changes are looked at a few seconds after they stop, so typing a title is one change.
 * - **No loops:** the workspace's automations bot writes every change an automation
 *   makes, and the bot's changes are replayed without being looked at.
 * - **Runs** (`automation.run` jobs) act with the access of the automation's maker,
 *   through the same checks as their own edits, written as the bot. A maker who can no
 *   longer edit the database is told, and the automation does nothing.
 * - **Schedules** (`automation.schedule` jobs, one per next run, keyed so it's made once)
 *   start a run and line up the next one, while the schedule is still the automation's.
 * - **Webhooks** (`webhook.deliver` jobs) are retried with backoff; the maker is told
 *   when one fails for good.
 */
import { createHash } from 'node:crypto';
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
  type WebhookBody,
} from '@workspace/database';
import type { Job, LoggedUpdate, NewJob } from '@workspace/storage-remote';
import * as Y from 'yjs';
import { atLeast } from '../access/roles';
import type { ServerContext } from '../context';
import { EditRefused } from '../docs-edit';
import { PermanentJobError } from '../jobs/runner';
import { deliver } from '../webhooks/deliver';

export const AUTOMATIONS_FOLLOWER = 'automations';
const BATCH = 500;
const BOT_NAME = 'Automations';

/** The workspace's automations bot: a fixed id (the log's author of what automations do). */
export function automationsBotId(workspaceId: string): string {
  const hex = createHash('sha256').update(`automations:${workspaceId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface AutomationOptions {
  /** Wait this long after a change before looking at it (edits in a burst are one). */
  delayMs?: number;
  now?: () => number;
  onError?: (error: unknown, workspaceId: string | null) => void;
}

interface RunPayload {
  databaseId: string;
  automationId: string;
  rowId: string | null;
  actorId: string | null;
}

interface SchedulePayload {
  databaseId: string;
  automationId: string;
  schedule: string;
  runAt: number;
}

export interface DeliverPayload {
  /** The automation's database (a button's: the doc the button is in). */
  databaseId: string;
  automationId: string;
  url: string;
  headers: Record<string, string>;
  body: WebhookBody | ButtonWebhookBody;
  /** A button's webhook: who pressed it (told if it fails), signed with the button secret. */
  button?: { userId: string; label: string; pageId: string | null };
}

/** What a button's "Send webhook" step sends. */
export interface ButtonWebhookBody {
  source: { type: 'button'; pageId: string | null; userId: string };
  data: unknown;
  triggeredAt: string;
}

/** Button webhooks are signed with one secret per workspace (kept with automations'). */
export const BUTTON_SECRET = { databaseId: '*', automationId: 'buttons' } as const;

type Ctx = Pick<
  ServerContext,
  'store' | 'access' | 'docs' | 'jobs' | 'notifier' | 'members' | 'config'
>;

export class Automations {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private closed = false;
  private readonly delayMs: number;
  private readonly now: () => number;

  constructor(
    private readonly ctx: Ctx,
    private readonly options: AutomationOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 3000;
    this.now = options.now ?? Date.now;
    ctx.jobs.register('automation.run', (job) => this.run(job));
    ctx.jobs.register('automation.schedule', (job) => this.scheduled(job));
    ctx.jobs.register('webhook.deliver', (job) => this.deliver(job));
  }

  /** Catch up on what arrived while the server was down. */
  async start(): Promise<void> {
    for (const id of await this.ctx.store.notifications.followersBehind(AUTOMATIONS_FOLLOWER)) {
      this.schedule(id, 0);
    }
  }

  /** A workspace's log grew. */
  schedule(workspaceId: string, delayMs = this.delayMs): void {
    if (this.closed || this.timers.has(workspaceId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(workspaceId);
      void this.follow(workspaceId);
    }, delayMs);
    timer.unref?.();
    this.timers.set(workspaceId, timer);
  }

  /** Read a workspace's log to the end now (one pass at a time per workspace). */
  follow(workspaceId: string): Promise<void> {
    const current = this.running.get(workspaceId);
    if (current) {
      this.again.add(workspaceId);
      return current;
    }
    const pass = (async () => {
      try {
        do {
          this.again.delete(workspaceId);
          await this.read(workspaceId);
        } while (this.again.has(workspaceId) && !this.closed);
      } catch (error) {
        this.options.onError?.(error, workspaceId);
      } finally {
        this.running.delete(workspaceId);
      }
    })();
    this.running.set(workspaceId, pass);
    return pass;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(this.running.values());
  }

  // --- Following the log --------------------------------------------------------------

  private async read(workspaceId: string): Promise<void> {
    const { store } = this.ctx;
    for (;;) {
      if (this.closed) return;
      const from = await store.notifications.followerSeq(workspaceId, AUTOMATIONS_FOLLOWER);
      const rows = await store.updatesSince(workspaceId, from, BATCH);
      if (rows.length === 0) return;
      const byDoc = new Map<string, LoggedUpdate[]>();
      for (const row of rows) {
        if (isTreeDocId(row.docId) || isCommentsDocId(row.docId) || row.docId === MEMBERS_DOC_ID) {
          continue;
        }
        const list = byDoc.get(row.docId);
        if (list) list.push(row);
        else byDoc.set(row.docId, [row]);
      }
      const jobs: NewJob[] = [];
      for (const [docId, updates] of byDoc) {
        jobs.push(...(await this.changes(workspaceId, docId, updates, from)));
      }
      await store.transaction(async (client) => {
        await store.jobs.enqueue(jobs, client);
        await store.notifications.setFollowerSeq(
          workspaceId,
          AUTOMATIONS_FOLLOWER,
          rows.at(-1)!.seq,
          client,
        );
      });
      if (jobs.length) void this.ctx.jobs.poke();
    }
  }

  /** The jobs one database's new updates make: runs started, and schedules lined up. */
  private async changes(
    workspaceId: string,
    docId: string,
    updates: LoggedUpdate[],
    from: number,
  ): Promise<NewJob[]> {
    // A compacted row (no device) holds the doc's whole history: nothing can be told apart.
    if (updates.some((u) => u.deviceId === null)) return [];
    const doc = new Y.Doc();
    try {
      const before = await this.ctx.store.docStateAt(workspaceId, docId, from);
      if (before) Y.applyUpdate(doc, before);
      const bot = automationsBotId(workspaceId);
      const jobs: NewJob[] = [];
      // Rows are compared from the point the doc is a database with automations (a run
      // that creates the database, or adds the automation, starts from there).
      const ready = () =>
        isDatabaseDoc(doc) && readAutomations(doc).some((a) => a.trigger.kind !== 'schedule');
      for (const run of byAuthor(updates)) {
        if (run.userId === bot) {
          for (const u of run.updates) Y.applyUpdate(doc, u.data);
          continue;
        }
        let old = ready() ? readDatabase(doc).rows : null;
        for (const u of run.updates) {
          Y.applyUpdate(doc, u.data);
          if (old === null && ready()) old = readDatabase(doc).rows;
        }
        if (old === null || !ready()) continue;
        const automations = readAutomations(doc).filter((a) => a.trigger.kind !== 'schedule');
        const now = readDatabase(doc);
        for (const t of triggeredBy(automations, old, now.rows, now.properties, {
          users: new Map(),
        })) {
          const payload: RunPayload = {
            databaseId: docId,
            automationId: t.automation.id,
            rowId: t.rowId,
            actorId: run.userId,
          };
          jobs.push({ workspaceId, kind: 'automation.run', payload, maxAttempts: 1 });
        }
      }
      if (isDatabaseDoc(doc)) {
        for (const a of readAutomations(doc))
          jobs.push(...this.nextSchedule(workspaceId, docId, a));
      }
      return jobs;
    } finally {
      doc.destroy();
    }
  }

  /** The next scheduled run of an automation (made once: its key names the time). */
  private nextSchedule(
    workspaceId: string,
    databaseId: string,
    a: Automation,
    after = this.now(),
  ): NewJob[] {
    if (!a.enabled || a.trigger.kind !== 'schedule') return [];
    const runAt = nextRun(a.trigger.schedule, Math.max(after, this.now()));
    if (runAt === null) return [];
    const schedule = scheduleKey(a.trigger.schedule);
    const payload: SchedulePayload = { databaseId, automationId: a.id, schedule, runAt };
    return [
      {
        workspaceId,
        kind: 'automation.schedule',
        payload,
        runAt,
        maxAttempts: 1,
        key: `schedule:${workspaceId}:${databaseId}:${a.id}:${schedule}:${runAt}`,
      },
    ];
  }

  // --- Jobs ---------------------------------------------------------------------------

  private async load(workspaceId: string, databaseId: string, automationId: string) {
    const state = await this.ctx.store.docState(workspaceId, databaseId);
    if (!state) return null;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    try {
      if (!isDatabaseDoc(doc)) return null;
      const automation = readAutomations(doc).find((a) => a.id === automationId);
      return automation ? { automation, snapshot: readDatabase(doc) } : null;
    } finally {
      doc.destroy();
    }
  }

  /** May the maker still edit the database? If not, they're told (once), and it doesn't run. */
  private async makerMayEdit(workspaceId: string, databaseId: string, a: Automation) {
    const access = await this.ctx.access.workspace(workspaceId);
    const role = access.isMember(a.createdBy)
      ? access.roles(a.createdBy).get(access.placementOf(databaseId) ?? '')
      : undefined;
    if (atLeast(role, 'edit')) return true;
    await this.ctx.notifier.automationNotice(workspaceId, {
      userId: a.createdBy,
      databaseId,
      pageId: null,
      title: a.name,
      text: 'Paused: you can no longer edit this database.',
      key: `paused:${databaseId}:${a.id}`,
    });
    return false;
  }

  private async run(job: Job): Promise<unknown> {
    const workspaceId = job.workspaceId!;
    const p = job.payload as RunPayload;
    const loaded = await this.load(workspaceId, p.databaseId, p.automationId);
    if (!loaded || !loaded.automation.enabled) return { skipped: 'off' };
    const { automation, snapshot } = loaded;
    if (!(await this.makerMayEdit(workspaceId, p.databaseId, automation))) {
      return { skipped: 'paused' };
    }
    const row = p.rowId
      ? (snapshot.rows.find((r) => r.id === p.rowId && r.trashedAt === null) ?? null)
      : null;
    if (p.rowId && !row) return { skipped: 'page gone' };
    const effects = planActions(automation, row, snapshot.properties, {
      databaseId: p.databaseId,
      actorId: p.actorId,
      now: this.now(),
    });
    await this.ensureBot(workspaceId);
    try {
      for (const effect of effects) await this.apply(workspaceId, p.databaseId, automation, effect);
    } catch (error) {
      // What's done is done: no retry (it would do it twice).
      const message = error instanceof EditRefused ? 'Not allowed to edit' : String(error);
      throw new PermanentJobError(message);
    }
    return { done: effects.map((e) => e.kind) };
  }

  private async apply(workspaceId: string, databaseId: string, a: Automation, effect: Effect) {
    const bot = automationsBotId(workspaceId);
    const as = { as: a.createdBy, userId: bot };
    switch (effect.kind) {
      case 'edit':
        await this.ctx.docs.edit(workspaceId, databaseId, as, (doc) => {
          for (const [propertyId, value] of Object.entries(effect.values)) {
            setCell(doc, effect.rowId, propertyId, value, bot);
          }
          if (effect.title !== undefined) setRowTitle(doc, effect.rowId, effect.title, bot);
        });
        return;
      case 'add':
        await this.ctx.docs.edit(workspaceId, databaseId, as, (doc) =>
          addRow(doc, { actor: bot, title: effect.title, values: effect.values }),
        );
        return;
      case 'notify':
        for (const userId of effect.userIds) {
          await this.ctx.notifier.automationNotice(workspaceId, {
            userId,
            databaseId,
            pageId: effect.rowId,
            title: a.name,
            text: effect.message,
          });
        }
        return;
      case 'webhook': {
        const payload: DeliverPayload = {
          databaseId,
          automationId: a.id,
          url: effect.url,
          headers: effect.headers,
          body: effect.body,
        };
        await this.ctx.store.jobs.enqueue([
          { workspaceId, kind: 'webhook.deliver', payload, maxAttempts: 5 },
        ]);
        void this.ctx.jobs.poke();
      }
    }
  }

  private async scheduled(job: Job): Promise<unknown> {
    const workspaceId = job.workspaceId!;
    const p = job.payload as SchedulePayload;
    const loaded = await this.load(workspaceId, p.databaseId, p.automationId);
    const a = loaded?.automation;
    // Changed or gone since it was lined up: the change lined up its own.
    if (
      !a ||
      !a.enabled ||
      a.trigger.kind !== 'schedule' ||
      scheduleKey(a.trigger.schedule) !== p.schedule
    ) {
      return { skipped: 'changed' };
    }
    const run: RunPayload = {
      databaseId: p.databaseId,
      automationId: a.id,
      rowId: null,
      actorId: null,
    };
    await this.ctx.store.jobs.enqueue([
      { workspaceId, kind: 'automation.run', payload: run, maxAttempts: 1 },
      // The one after this run (not after "now": a clock behind would find this one).
      ...this.nextSchedule(workspaceId, p.databaseId, a, p.runAt),
    ]);
    void this.ctx.jobs.poke();
    return { started: true };
  }

  private async deliver(job: Job): Promise<unknown> {
    const workspaceId = job.workspaceId!;
    const p = job.payload as DeliverPayload;
    const key = p.button ? BUTTON_SECRET : p;
    const secret = await this.ctx.store.automationSecrets.get(
      workspaceId,
      key.databaseId,
      key.automationId,
    );
    try {
      const response = await deliver(p.url, p.body, secret, p.headers, this.ctx.config.webhooks);
      if (response.status >= 500 || response.status === 429) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (response.status >= 400) throw new PermanentJobError(`HTTP ${response.status}`);
      return { status: response.status, body: response.body };
    } catch (error) {
      const permanent = error instanceof PermanentJobError;
      if (permanent || job.attempts >= job.maxAttempts) {
        const text = `Webhook to ${safeHost(p.url)} failed: ${error instanceof Error ? error.message : String(error)}`;
        if (p.button) {
          await this.ctx.notifier.automationNotice(workspaceId, {
            userId: p.button.userId,
            databaseId: p.databaseId,
            pageId: p.button.pageId,
            title: p.button.label || 'Button',
            text,
          });
        } else {
          const loaded = await this.load(workspaceId, p.databaseId, p.automationId);
          if (loaded) {
            await this.ctx.notifier.automationNotice(workspaceId, {
              userId: loaded.automation.createdBy,
              databaseId: p.databaseId,
              pageId: (p.body as WebhookBody).data?.id ?? null,
              title: loaded.automation.name,
              text,
            });
          }
        }
      }
      throw error;
    }
  }

  /** The bot's name, in the members doc (listed as a former member: never picked). */
  private botNamed = new Set<string>();
  private async ensureBot(workspaceId: string) {
    if (this.botNamed.has(workspaceId)) return;
    await this.ctx.members.ensureBot(workspaceId, automationsBotId(workspaceId), BOT_NAME);
    this.botNamed.add(workspaceId);
  }
}

const safeHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return 'a webhook';
  }
};

/** Consecutive updates by the same author. */
function byAuthor(updates: LoggedUpdate[]) {
  const runs: { userId: string | null; updates: LoggedUpdate[] }[] = [];
  for (const u of updates) {
    const last = runs.at(-1);
    const userId = u.userId ?? null;
    if (last && last.userId === userId) last.updates.push(u);
    else runs.push({ userId, updates: [u] });
  }
  return runs;
}
