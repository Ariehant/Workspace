import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { PgStore } from '@workspace/storage-remote';
import Fastify, { type FastifyInstance } from 'fastify';
import { AccessService } from './access/service';
import { adminRoutes } from './admin-routes';
import { csrfGuard } from './auth/context';
import { DocEditor } from './docs-edit';
import { OidcClients } from './auth/oidc';
import { authRoutes } from './auth/routes';
import type { Config } from './config';
import type { ServerContext } from './context';
import type { FileStorage } from './files';
import { smtpMailer, type Mailer } from './mailer';
import { inviteRoutes, memberRoutes } from './members/routes';
import { scopeRoutes } from './scopes/routes';
import { MembersDoc } from './members/members-doc';
import { HistoryKeeper, type HistoryOptions } from './history/keeper';
import { Notifier } from './notify/notifier';
import { pageRoutes } from './publish/routes';
import { Site, siteRoutes } from './publish/site';
import { notificationRoutes } from './notify/routes';
import { Indexer } from './search/indexer';
import { JobRunner, type JobRunnerOptions } from './jobs/runner';
import { Automations, type AutomationOptions } from './automations/runner';
import { syncEndpoint, type SyncOptions } from './sync/endpoint';
import { fileRoutes } from './files-routes';
import { formRoutes } from './forms/routes';
import { automationRoutes } from './automations/routes';
import { buttonRoutes } from './buttons/routes';
import { settingsRoutes } from './settings-routes';
import { webApp } from './web';
import { workspaceRoutes } from './workspaces';

export const VERSION = '0.1.0';

declare module 'fastify' {
  interface FastifyInstance {
    /** The search indexer (main.ts starts its catch-up after listening). */
    indexer: Indexer;
    /** Notifications (main.ts starts it after listening). */
    notifier: Notifier;
    /** Page history (main.ts starts it after listening). */
    history: HistoryKeeper;
    /** The job queue's runner (main.ts starts it after listening). */
    jobs: JobRunner;
    /** Edits the server makes to docs for someone (forms, automations, the API). */
    docs: DocEditor;
    /** Database automations (main.ts starts their catch-up after listening). */
    automations: Automations;
  }
}

export interface ServerDeps {
  config: Config;
  store: PgStore;
  files: FileStorage;
  /** Single sign-on clients (made from the config when not given). */
  oidc?: OidcClients;
  sync?: SyncOptions;
  /** Search index: wait this long after changes before indexing. */
  indexDelayMs?: number;
  /** Notifications: wait this long after changes; look for due reminders this often. */
  notify?: { delayMs?: number; reminderPollMs?: number; now?: () => number };
  /** Page history: how long a doc must be quiet before a snapshot, and how often to look. */
  history?: HistoryOptions;
  /** Automations: how long after changes to look at them (tests shorten it). */
  automations?: AutomationOptions;
  /** Sends invite emails (default: SMTP from the config, or none). */
  mailer?: Mailer | null;
  /** The job queue: how often to look for due jobs, and retry waits (tests shorten them). */
  jobs?: JobRunnerOptions;
}

/** The HTTP server and its routes (listening is up to the caller). */
export function buildServer({
  config,
  store,
  files,
  oidc,
  sync,
  indexDelayMs,
  notify,
  history: historyOptions,
  mailer,
  jobs: jobOptions,
  automations: automationOptions,
}: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            // Never log credentials.
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
            ],
          },
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });
  const indexer = new Indexer(store, {
    delayMs: indexDelayMs,
    onError: (error, workspaceId) => app.log.error({ err: error, workspaceId }, 'indexing failed'),
  });
  // The sync endpoint is set up last (it needs the routes' hooks in place); routes reach
  // it through `realtime`, which only runs once requests are served.
  let endpoint: ReturnType<typeof syncEndpoint> | null = null;
  const live = () => {
    if (!endpoint) throw new Error('The sync endpoint is not running yet');
    return endpoint;
  };
  const realtime: ServerContext['realtime'] = {
    appendFromServer: (workspaceId, updates, userId) =>
      live().hub.appendFromServer(workspaceId, updates, userId),
    disconnect: (workspaceId, userId, removed) => live().disconnect(workspaceId, userId, removed),
  };
  const access = new AccessService(store);
  const notifier = new Notifier(store, access, {
    ...notify,
    deliver: (workspaceId, userId, notification) =>
      endpoint?.hub.deliver(workspaceId, userId, JSON.stringify(notification)),
    onError: (error, workspaceId) =>
      app.log.error({ err: error, workspaceId }, 'notifications failed'),
  });
  const history = new HistoryKeeper(store, {
    ...historyOptions,
    onError: (error) => app.log.error({ err: error }, 'page history failed'),
  });
  const jobs = new JobRunner(store, {
    ...jobOptions,
    onError: (error, job) =>
      app.log.error({ err: error, job: job?.id, kind: job?.kind }, 'job failed'),
  });
  const ctx: ServerContext = {
    config,
    store,
    files,
    oidc: oidc ?? new OidcClients(config),
    indexer,
    notifier,
    history,
    jobs,
    access,
    realtime,
    docs: new DocEditor(store, access, realtime),
    members: new MembersDoc({ store, append: realtime.appendFromServer }),
    mailer: mailer === undefined ? smtpMailer(config) : mailer,
    // Made just below: it needs the context.
    automations: null as unknown as Automations,
  };
  ctx.automations = new Automations(ctx, {
    ...automationOptions,
    onError: (error, workspaceId) =>
      app.log.error({ err: error, workspaceId }, 'automations failed'),
  });
  app.decorate('indexer', indexer);
  app.decorate('notifier', notifier);
  app.decorate('history', history);
  app.decorate('jobs', jobs);
  app.decorate('docs', ctx.docs);
  app.decorate('automations', ctx.automations);
  app.addHook('onClose', () =>
    Promise.all([
      indexer.close(),
      notifier.close(),
      history.close(),
      ctx.automations.close(),
      jobs.close(),
    ]),
  );
  const site = new Site(ctx);

  app.decorateRequest('auth', null);
  void app.register(cookie);
  // Limits are set per route (the sign-in endpoints), keyed by client IP.
  void app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) => ({
      statusCode: context.statusCode,
      error: 'rate_limited',
      message: `Too many requests. Try again in ${context.after}.`,
    }),
  });
  app.addHook('onRequest', csrfGuard);
  // Errors as `{ error, message }`, like the routes' own.
  app.setErrorHandler(
    (
      error: { statusCode?: number; validation?: unknown; message: string; error?: string },
      request,
      reply,
    ) => {
      const status = error.statusCode ?? 500;
      if (status >= 500) request.log.error(error);
      void reply.code(status).send({
        error: error.validation
          ? 'invalid'
          : status === 429
            ? 'rate_limited'
            : status >= 500
              ? 'internal'
              : (error.error ?? 'error'),
        message: status >= 500 ? 'Something went wrong on the server.' : error.message,
      });
    },
  );

  // Liveness: the process is up.
  app.get('/api/health', async () => ({ ok: true, version: VERSION }));

  // Readiness: the database and file storage answer.
  app.get('/api/ready', async (_request, reply) => {
    const checks: Record<string, string> = {};
    try {
      await store.pool.query('SELECT 1');
      checks.database = 'ok';
    } catch (error) {
      checks.database = error instanceof Error ? error.message : 'unreachable';
    }
    try {
      await files.check();
      checks.files = 'ok';
    } catch (error) {
      checks.files = error instanceof Error ? error.message : 'unreachable';
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });

  void app.register(async (scope) => {
    authRoutes(scope, ctx);
    workspaceRoutes(scope, ctx);
    adminRoutes(scope, ctx);
    fileRoutes(scope, ctx);
    settingsRoutes(scope, ctx);
    memberRoutes(scope, ctx);
    inviteRoutes(scope, ctx);
    scopeRoutes(scope, ctx);
    notificationRoutes(scope, ctx);
    pageRoutes(scope, ctx, site, history);
    siteRoutes(scope, ctx, site);
    formRoutes(scope, ctx);
    automationRoutes(scope, ctx);
    buttonRoutes(scope, ctx);
  });
  webApp(app, config.webDir);
  endpoint = syncEndpoint(app, ctx, sync);

  return app;
}
