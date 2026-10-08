import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { PgStore } from '@workspace/storage-remote';
import Fastify, { type FastifyInstance } from 'fastify';
import { adminRoutes } from './admin-routes';
import { csrfGuard } from './auth/context';
import { OidcClients } from './auth/oidc';
import { authRoutes } from './auth/routes';
import type { Config } from './config';
import type { ServerContext } from './context';
import type { FileStorage } from './files';
import { smtpMailer, type Mailer } from './mailer';
import { inviteRoutes, memberRoutes } from './members/routes';
import { MembersDoc } from './members/members-doc';
import { Indexer } from './search/indexer';
import { syncEndpoint, type SyncOptions } from './sync/endpoint';
import { fileRoutes } from './files-routes';
import { settingsRoutes } from './settings-routes';
import { webApp } from './web';
import { workspaceRoutes } from './workspaces';

export const VERSION = '0.1.0';

declare module 'fastify' {
  interface FastifyInstance {
    /** The search indexer (main.ts starts its catch-up after listening). */
    indexer: Indexer;
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
  /** Sends invite emails (default: SMTP from the config, or none). */
  mailer?: Mailer | null;
}

/** The HTTP server and its routes (listening is up to the caller). */
export function buildServer({
  config,
  store,
  files,
  oidc,
  sync,
  indexDelayMs,
  mailer,
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
    appendFromServer: (workspaceId, updates) => live().hub.appendFromServer(workspaceId, updates),
    disconnect: (workspaceId, userId, removed) => live().disconnect(workspaceId, userId, removed),
  };
  const ctx: ServerContext = {
    config,
    store,
    files,
    oidc: oidc ?? new OidcClients(config),
    indexer,
    realtime,
    members: new MembersDoc({ store, append: realtime.appendFromServer }),
    mailer: mailer === undefined ? smtpMailer(config) : mailer,
  };
  app.decorate('indexer', indexer);
  app.addHook('onClose', () => indexer.close());

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
  });
  webApp(app, config.webDir);
  endpoint = syncEndpoint(app, ctx, sync);

  return app;
}
