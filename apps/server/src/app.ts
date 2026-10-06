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
import { syncEndpoint, type SyncOptions } from './sync/endpoint';
import { workspaceRoutes } from './workspaces';

export const VERSION = '0.1.0';

export interface ServerDeps {
  config: Config;
  store: PgStore;
  files: FileStorage;
  /** Single sign-on clients (made from the config when not given). */
  oidc?: OidcClients;
  sync?: SyncOptions;
}

/** The HTTP server and its routes (listening is up to the caller). */
export function buildServer({ config, store, files, oidc, sync }: ServerDeps): FastifyInstance {
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
  const ctx: ServerContext = { config, store, files, oidc: oidc ?? new OidcClients(config) };

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
  });
  syncEndpoint(app, ctx, sync);

  return app;
}
