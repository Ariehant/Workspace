/**
 * Integration webhooks (Phase 6 M7), as Notion's: an integration's subscription gets
 * events for pages, databases and comments it can read.
 *
 * - **Following the log** (its own cursor, `webhooks`): each changed doc is replayed author
 *   by author on the doc as it was, and compared: trees give pages and databases made,
 *   moved, trashed, restored, locked and renamed; databases give rows made, changed,
 *   trashed and restored, and schema changes; comments docs give comments made, edited
 *   and deleted; any other page's doc, content changes. Events of one pass are merged per
 *   entity, and each subscription that wants one gets a job, enqueued in the transaction
 *   that moves the cursor. Nothing is looked at while no subscription is on.
 * - **Merged content updates:** a page's `page.content_updated` waits a minute, and more
 *   changes in that minute join it (one open job per page, by key).
 * - **Access at send time:** the job checks that the integration can still read the doc
 *   (and has the capability), and that the subscription still wants the event.
 * - **Delivery:** signed with the verification token (`X-Notion-Signature`), retried for
 *   about a day. When deliveries have failed for 3 days, the subscription is paused and
 *   the integration's maker is told.
 * - **Payloads** carry ids only, as Notion's: the receiver fetches what it needs.
 */
import { randomUUID } from 'node:crypto';
import {
  COMMENTS_PREFIX,
  MEMBERS_DOC_ID,
  isCommentsDocId,
  isTreeDocId,
  listPages,
  readThreads,
  type PageMeta,
} from '@workspace/core';
import { isDatabaseDoc, readDatabase, type Property, type Row } from '@workspace/database';
import type { IntegrationWebhook, Job, LoggedUpdate, NewJob } from '@workspace/storage-remote';
import * as Y from 'yjs';
import type { WorkspaceAccess } from '../access/service';
import { automationsBotId } from '../automations/runner';
import type { ServerContext } from '../context';
import { PermanentJobError } from '../jobs/runner';
import { deliver } from './deliver';

export const WEBHOOKS_FOLLOWER = 'webhooks';

/** The events a subscription may ask for. */
export const WEBHOOK_EVENTS = [
  'page.created',
  'page.properties_updated',
  'page.content_updated',
  'page.moved',
  'page.deleted',
  'page.undeleted',
  'page.locked',
  'page.unlocked',
  'database.created',
  'database.schema_updated',
  'database.deleted',
  'comment.created',
  'comment.updated',
  'comment.deleted',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

const BATCH = 500;
const DAY = 24 * 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type EntityType = 'page' | 'database' | 'comment';
type Parent = { id: string; type: 'page' | 'database' | 'space' };

/** An event found in the log, before it's sent to anyone. */
interface Found {
  type: WebhookEventType;
  entity: { id: string; type: EntityType };
  /** The doc whose readability decides who gets it. */
  docId: string;
  /** The page its parent is looked up for (null: given in `parent`). */
  pageId: string | null;
  parent?: Parent;
  /** The last log position it came from. */
  seq: number;
  authors: Set<string>;
  updatedProperties?: Set<string>;
  pageOf?: string;
}

/** What a delivery job carries. */
export interface WebhookJob {
  integrationId: string;
  event: {
    id: string;
    timestamp: string;
    type: WebhookEventType;
    entity: { id: string; type: EntityType };
    authors: { id: string; type: 'person' | 'bot' }[];
    data: Record<string, unknown>;
  };
  docId: string;
}

interface VerifyJob {
  integrationId: string;
  url: string;
}

export interface WebhookEventsOptions {
  /** Wait this long after a change before looking at it. */
  delayMs?: number;
  /** How long content updates to a page are gathered into one event. */
  mergeMs?: number;
  /** Pause a subscription whose deliveries have failed this long. */
  pauseAfterMs?: number;
  now?: () => number;
  onError?: (error: unknown, workspaceId: string | null) => void;
}

type Ctx = Pick<ServerContext, 'store' | 'access' | 'jobs' | 'notifier' | 'config'>;

export class WebhookEvents {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private closed = false;
  private readonly delayMs: number;
  private readonly mergeMs: number;
  private readonly pauseAfterMs: number;
  private readonly now: () => number;

  constructor(
    private readonly ctx: Ctx,
    private readonly options: WebhookEventsOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 2000;
    this.mergeMs = options.mergeMs ?? 60_000;
    this.pauseAfterMs = options.pauseAfterMs ?? 3 * DAY;
    this.now = options.now ?? Date.now;
    ctx.jobs.register('integration.webhook', (job) => this.send(job));
    ctx.jobs.register('integration.verify', (job) => this.sendVerification(job));
  }

  /** Catch up on what arrived while the server was down. */
  async start(): Promise<void> {
    for (const id of await this.ctx.store.notifications.followersBehind(WEBHOOKS_FOLLOWER)) {
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

  /** Send a new subscription its verification token. */
  async requestVerification(workspaceId: string, integrationId: string, url: string) {
    const payload: VerifyJob = { integrationId, url };
    await this.ctx.store.jobs.enqueue([
      { workspaceId, kind: 'integration.verify', payload, maxAttempts: 3 },
    ]);
    void this.ctx.jobs.poke();
  }

  // --- Following the log --------------------------------------------------------------

  private async read(workspaceId: string): Promise<void> {
    const { store } = this.ctx;
    for (;;) {
      if (this.closed) return;
      const from = await store.notifications.followerSeq(workspaceId, WEBHOOKS_FOLLOWER);
      const rows = await store.updatesSince(workspaceId, from, BATCH);
      if (rows.length === 0) return;
      const last = rows.at(-1)!.seq;
      const subscriptions = (await store.integrationWebhooks.active(workspaceId)).filter(
        (s) => last > (s.fromSeq ?? Infinity),
      );
      const jobs: NewJob[] = [];
      if (subscriptions.length > 0) {
        const found = await new Pass(this.ctx, workspaceId, from).run(rows);
        jobs.push(...(await this.jobsFor(workspaceId, found, subscriptions)));
      }
      await store.transaction(async (client) => {
        await store.jobs.enqueue(jobs, client);
        await store.notifications.setFollowerSeq(workspaceId, WEBHOOKS_FOLLOWER, last, client);
      });
      if (jobs.length) void this.ctx.jobs.poke();
    }
  }

  private async jobsFor(
    workspaceId: string,
    found: Found[],
    subscriptions: IntegrationWebhook[],
  ): Promise<NewJob[]> {
    const access = await this.ctx.access.workspace(workspaceId);
    const parents = await this.parents(workspaceId, access, found);
    const bot = automationsBotId(workspaceId);
    const jobs: NewJob[] = [];
    const timestamp = new Date(this.now()).toISOString();
    for (const f of found) {
      const parent = f.parent ?? parents.get(f.pageId ?? '') ?? { id: workspaceId, type: 'space' };
      const data: Record<string, unknown> = { parent };
      if (f.updatedProperties) data.updated_properties = [...f.updatedProperties];
      if (f.pageOf) data.page_id = f.pageOf;
      const authors = [...f.authors].map((id) => ({
        id,
        type: (id === bot || access.isBot(id) ? 'bot' : 'person') as 'bot' | 'person',
      }));
      const merged = f.type === 'page.content_updated';
      for (const s of subscriptions) {
        if (f.seq <= (s.fromSeq ?? Infinity) || !s.events.includes(f.type)) continue;
        const payload: WebhookJob = {
          integrationId: s.integrationId,
          event: { id: randomUUID(), timestamp, type: f.type, entity: f.entity, authors, data },
          docId: f.docId,
        };
        jobs.push({
          workspaceId,
          kind: 'integration.webhook',
          payload,
          maxAttempts: 8,
          ...(merged && {
            runAt: this.now() + this.mergeMs,
            key: `iwh:${s.integrationId}:${f.entity.id}:${f.type}`,
          }),
        });
      }
    }
    return jobs;
  }

  /** Pages' parents, from the trees as they are now. */
  private async parents(workspaceId: string, access: WorkspaceAccess, found: Found[]) {
    const parents = new Map<string, Parent>();
    if (!found.some((f) => f.pageId && !f.parent)) return parents;
    const metas = new Map<string, PageMeta>();
    for (const treeDoc of access.treeDocs()) {
      const state = await this.ctx.store.docState(workspaceId, treeDoc);
      if (!state) continue;
      const tree = new Y.Doc();
      Y.applyUpdate(tree, state);
      for (const meta of listPages(tree)) metas.set(meta.id, meta);
      tree.destroy();
    }
    for (const f of found) {
      if (!f.pageId || f.parent) continue;
      const meta = metas.get(f.pageId);
      const parentId = meta?.parentId;
      // A row's page: its database.
      const database = meta ? undefined : access.databaseOfRow(f.pageId);
      if (database) parents.set(f.pageId, { id: database, type: 'database' });
      else if (parentId) {
        parents.set(f.pageId, {
          id: parentId,
          type: metas.get(parentId)?.kind === 'database' ? 'database' : 'page',
        });
      }
    }
    return parents;
  }

  // --- Jobs ---------------------------------------------------------------------------

  private async send(job: Job): Promise<unknown> {
    const workspaceId = job.workspaceId!;
    const p = job.payload as WebhookJob;
    const { store } = this.ctx;
    const found = await store.integrationWebhooks.withSecret(workspaceId, p.integrationId);
    const integration = await store.integrations.get(workspaceId, p.integrationId);
    if (!found || !integration) return { skipped: 'no subscription' };
    const { webhook, secret } = found;
    if (!webhook.verified || webhook.pausedAt !== null) return { skipped: 'off' };
    if (!webhook.events.includes(p.event.type)) return { skipped: 'not wanted' };
    // What it may read now (not when the change was made).
    const access = await this.ctx.access.workspace(workspaceId);
    const capability = p.event.entity.type === 'comment' ? 'readComments' : 'readContent';
    if (
      !access.isBot(p.integrationId) ||
      !integration.capabilities[capability] ||
      access.placementOf(p.docId) === undefined ||
      !access.canRead(access.roles(p.integrationId), p.docId)
    ) {
      return { skipped: 'no access' };
    }
    const { rows } = await store.pool.query<{ name: string }>(
      'SELECT name FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    const body = {
      ...p.event,
      workspace_id: workspaceId,
      workspace_name: rows[0]?.name ?? '',
      subscription_id: p.integrationId,
      integration_id: p.integrationId,
      attempt_number: job.attempts,
    };
    try {
      const response = await deliver(webhook.url, body, secret, {}, this.ctx.config.webhooks);
      if (response.status >= 500 || response.status === 429) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (response.status >= 400) throw new PermanentJobError(`HTTP ${response.status}`);
      await store.integrationWebhooks.delivered(workspaceId, p.integrationId);
      return { status: response.status };
    } catch (error) {
      if (error instanceof PermanentJobError || job.attempts >= job.maxAttempts) {
        await this.failed(workspaceId, integration, error);
      }
      throw error;
    }
  }

  /** A delivery failed for good: after 3 days of that, pause and tell the maker. */
  private async failed(
    workspaceId: string,
    integration: { id: string; name: string; createdBy: string | null },
    error: unknown,
  ) {
    const message = error instanceof Error ? error.message : String(error);
    const { integrationWebhooks } = this.ctx.store;
    const since = await integrationWebhooks.failed(workspaceId, integration.id, message);
    if (since === null || this.now() - since < this.pauseAfterMs) return;
    if (!(await integrationWebhooks.pause(workspaceId, integration.id))) return;
    if (integration.createdBy) {
      await this.ctx.notifier.integrationNotice(workspaceId, {
        userId: integration.createdBy,
        title: integration.name,
        text: `Webhook paused: deliveries have failed for 3 days (${message}).`,
        key: `webhook-paused:${integration.id}:${since}`,
      });
    }
  }

  private async sendVerification(job: Job): Promise<unknown> {
    const workspaceId = job.workspaceId!;
    const p = job.payload as VerifyJob;
    const found = await this.ctx.store.integrationWebhooks.withSecret(workspaceId, p.integrationId);
    // Changed since: the new URL got its own.
    if (!found || found.webhook.url !== p.url || found.webhook.verified) {
      return { skipped: 'changed' };
    }
    const response = await deliver(
      p.url,
      { verification_token: found.secret },
      found.secret,
      {},
      this.ctx.config.webhooks,
    );
    if (response.status >= 500 || response.status === 429)
      throw new Error(`HTTP ${response.status}`);
    if (response.status >= 400) throw new PermanentJobError(`HTTP ${response.status}`);
    return { status: response.status };
  }
}

/** One pass over a workspace's new log rows: the events in them. */
class Pass {
  private readonly found = new Map<string, Found>();
  /** Pages that appeared in a tree, and those that left one (moved between trees). */
  private readonly appeared = new Map<
    string,
    { meta: PageMeta; treeDoc: string; author: string | null; seq: number }
  >();
  private readonly left = new Set<string>();

  constructor(
    private readonly ctx: Ctx,
    private readonly workspaceId: string,
    private readonly from: number,
  ) {}

  async run(rows: LoggedUpdate[]): Promise<Found[]> {
    const byDoc = new Map<string, LoggedUpdate[]>();
    for (const row of rows) {
      if (row.docId === MEMBERS_DOC_ID) continue;
      const list = byDoc.get(row.docId);
      if (list) list.push(row);
      else byDoc.set(row.docId, [row]);
    }
    for (const [docId, updates] of byDoc) {
      // A compacted row holds the doc's whole history: nothing can be told apart.
      if (updates.some((u) => u.deviceId === null)) continue;
      await this.doc(docId, updates);
    }
    await this.placeAppeared();
    return [...this.found.values()];
  }

  private add(f: Omit<Found, 'authors'>, author: string | null, properties?: Iterable<string>) {
    const key = `${f.type}:${f.entity.id}`;
    let existing = this.found.get(key);
    if (!existing) {
      existing = { ...f, authors: new Set() };
      this.found.set(key, existing);
    }
    existing.seq = Math.max(existing.seq, f.seq);
    if (author) existing.authors.add(author);
    if (properties) {
      existing.updatedProperties ??= new Set();
      for (const p of properties) existing.updatedProperties.add(p);
    }
  }

  private async doc(docId: string, updates: LoggedUpdate[]) {
    const doc = new Y.Doc();
    try {
      const before = await this.ctx.store.docStateAt(this.workspaceId, docId, this.from);
      if (before) Y.applyUpdate(doc, before);
      if (isTreeDocId(docId)) return this.tree(docId, doc, updates);
      if (isCommentsDocId(docId)) return this.comments(docId, doc, updates);
      const wasDatabase = isDatabaseDoc(doc);
      if (wasDatabase || becomesDatabase(doc, updates)) {
        return this.database(docId, doc, updates, wasDatabase);
      }
      if (!UUID.test(docId)) return;
      for (const run of byAuthor(updates)) {
        this.add(
          {
            type: 'page.content_updated',
            entity: { id: docId, type: 'page' },
            docId,
            pageId: docId,
            seq: run.seq,
          },
          run.userId,
        );
      }
    } finally {
      doc.destroy();
    }
  }

  private tree(docId: string, doc: Y.Doc, updates: LoggedUpdate[]) {
    let pages = new Map(listPages(doc).map((p) => [p.id, p]));
    for (const run of byAuthor(updates)) {
      for (const u of run.updates) Y.applyUpdate(doc, u.data);
      const now = new Map(listPages(doc).map((p) => [p.id, p]));
      for (const [id, meta] of now) {
        const old = pages.get(id);
        if (!old) {
          this.appeared.set(id, { meta, treeDoc: docId, author: run.userId, seq: run.seq });
          continue;
        }
        const entity = { id, type: meta.kind === 'database' ? 'database' : 'page' } as const;
        const base = { entity, docId, pageId: id, seq: run.seq };
        const db = meta.kind === 'database';
        if (old.trashedAt === null && meta.trashedAt !== null) {
          this.add({ ...base, type: db ? 'database.deleted' : 'page.deleted' }, run.userId);
        } else if (old.trashedAt !== null && meta.trashedAt === null && !db) {
          this.add({ ...base, type: 'page.undeleted' }, run.userId);
        }
        if (old.parentId !== meta.parentId && !db) {
          this.add({ ...base, type: 'page.moved' }, run.userId);
        }
        if (old.locked !== meta.locked && !db) {
          this.add({ ...base, type: meta.locked ? 'page.locked' : 'page.unlocked' }, run.userId);
        }
        if (old.title !== meta.title && !db) {
          this.add({ ...base, type: 'page.properties_updated' }, run.userId, ['title']);
        }
      }
      for (const id of pages.keys()) if (!now.has(id)) this.left.add(id);
      pages = now;
    }
  }

  /** New in a tree: made, or moved in from another tree (sharing a page moves it). */
  private async placeAppeared() {
    if (this.appeared.size === 0) return;
    let before: Set<string> | null = null;
    const knownBefore = async (id: string) => {
      if (!before) {
        before = new Set();
        const access = await this.ctx.access.workspace(this.workspaceId);
        for (const treeDoc of access.treeDocs()) {
          const state = await this.ctx.store.docStateAt(this.workspaceId, treeDoc, this.from);
          if (!state) continue;
          const tree = new Y.Doc();
          Y.applyUpdate(tree, state);
          for (const meta of listPages(tree)) before.add(meta.id);
          tree.destroy();
        }
      }
      return before.has(id);
    };
    for (const [id, a] of this.appeared) {
      const db = a.meta.kind === 'database';
      const entity = { id, type: db ? 'database' : 'page' } as const;
      const base = { entity, docId: a.treeDoc, pageId: id, seq: a.seq };
      if (this.left.has(id) || (await knownBefore(id))) {
        if (!db) this.add({ ...base, type: 'page.moved' }, a.author);
      } else if (a.meta.trashedAt === null) {
        this.add({ ...base, type: db ? 'database.created' : 'page.created' }, a.author);
      }
    }
  }

  private database(docId: string, doc: Y.Doc, updates: LoggedUpdate[], wasDatabase: boolean) {
    let rows = wasDatabase ? rowMap(readDatabase(doc).rows) : new Map<string, Row>();
    let schema = wasDatabase ? schemaMap(readDatabase(doc).properties) : null;
    const parent: Parent = { id: docId, type: 'database' };
    for (const run of byAuthor(updates)) {
      for (const u of run.updates) Y.applyUpdate(doc, u.data);
      if (!isDatabaseDoc(doc)) continue;
      const snapshot = readDatabase(doc);
      const now = rowMap(snapshot.rows);
      for (const [id, row] of now) {
        const base = {
          entity: { id, type: 'page' as const },
          docId,
          pageId: null,
          parent,
          seq: run.seq,
        };
        const old = rows.get(id);
        if (!old) {
          if (row.trashedAt === null) this.add({ ...base, type: 'page.created' }, run.userId);
          continue;
        }
        if (old.trashedAt === null && row.trashedAt !== null) {
          this.add({ ...base, type: 'page.deleted' }, run.userId);
        } else if (old.trashedAt !== null && row.trashedAt === null) {
          this.add({ ...base, type: 'page.undeleted' }, run.userId);
        }
        if (old.locked !== row.locked) {
          this.add({ ...base, type: row.locked ? 'page.locked' : 'page.unlocked' }, run.userId);
        }
        const changed = changedProperties(old, row);
        if (changed.length)
          this.add({ ...base, type: 'page.properties_updated' }, run.userId, changed);
      }
      const nextSchema = schemaMap(snapshot.properties);
      if (schema) {
        const changed = [...new Set([...schema.keys(), ...nextSchema.keys()])].filter(
          (id) => schema!.get(id) !== nextSchema.get(id),
        );
        if (changed.length) {
          this.add(
            {
              type: 'database.schema_updated',
              entity: { id: docId, type: 'database' },
              docId,
              pageId: docId,
              seq: run.seq,
            },
            run.userId,
            changed,
          );
        }
      }
      rows = now;
      schema = nextSchema;
    }
  }

  private comments(docId: string, doc: Y.Doc, updates: LoggedUpdate[]) {
    const pageId = docId.slice(COMMENTS_PREFIX.length);
    const read = () => {
      const map = new Map<string, { body: string; editedAt: number | null }>();
      for (const t of readThreads(doc)) {
        for (const c of t.comments) map.set(c.id, { body: c.body, editedAt: c.editedAt });
      }
      return map;
    };
    let comments = read();
    for (const run of byAuthor(updates)) {
      for (const u of run.updates) Y.applyUpdate(doc, u.data);
      const now = read();
      const parent: Parent = { id: pageId, type: 'page' };
      const base = { docId, pageId: null, parent, pageOf: pageId, seq: run.seq };
      for (const [id, c] of now) {
        const old = comments.get(id);
        const entity = { id, type: 'comment' as const };
        if (!old) this.add({ ...base, entity, type: 'comment.created' }, run.userId);
        else if (old.body !== c.body)
          this.add({ ...base, entity, type: 'comment.updated' }, run.userId);
      }
      for (const id of comments.keys()) {
        if (!now.has(id)) {
          this.add(
            { ...base, entity: { id, type: 'comment' }, type: 'comment.deleted' },
            run.userId,
          );
        }
      }
      comments = now;
    }
  }
}

const rowMap = (rows: readonly Row[]) =>
  new Map(rows.filter((r) => !r.isTemplate).map((r) => [r.id, r]));

/** Each property's definition, comparable as text. */
const schemaMap = (properties: readonly Property[]) =>
  new Map(properties.map((p) => [p.id, JSON.stringify(p)]));

/** The ids of properties whose values differ ("title" for the title). */
function changedProperties(old: Row, row: Row): string[] {
  const changed: string[] = [];
  if (old.title !== row.title) changed.push('title');
  for (const id of new Set([...Object.keys(old.values), ...Object.keys(row.values)])) {
    if (JSON.stringify(old.values[id] ?? null) !== JSON.stringify(row.values[id] ?? null)) {
      changed.push(id);
    }
  }
  return changed;
}

/** Is the doc a database once the updates are applied? */
function becomesDatabase(doc: Y.Doc, updates: LoggedUpdate[]): boolean {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    for (const u of updates) Y.applyUpdate(copy, u.data);
    return isDatabaseDoc(copy);
  } finally {
    copy.destroy();
  }
}

/** Consecutive updates by the same author (and the last log position of each run). */
function byAuthor(updates: LoggedUpdate[]) {
  const runs: { userId: string | null; updates: LoggedUpdate[]; seq: number }[] = [];
  for (const u of updates) {
    const last = runs.at(-1);
    const userId = u.userId ?? null;
    if (last && last.userId === userId) {
      last.updates.push(u);
      last.seq = u.seq;
    } else runs.push({ userId, updates: [u], seq: u.seq });
  }
  return runs;
}
