import type { PgStore } from '@workspace/storage-remote';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import type { FileStorage } from './files';

export const VERSION = '0.1.0';

export interface ServerDeps {
  config: Config;
  store: PgStore;
  files: FileStorage;
}

/** The HTTP server and its routes (listening is up to the caller). */
export function buildServer({ config, store, files }: ServerDeps): FastifyInstance {
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

  return app;
}
