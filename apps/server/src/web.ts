/**
 * The web app (apps/web's build) at `/`, when WEB_DIR points to it. Asset files have
 * hashed names and are cached for good; every other path that isn't the API gets
 * index.html, and the app routes in the browser.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';

export function webApp(app: FastifyInstance, webDir: string | null) {
  if (!webDir || !existsSync(join(webDir, 'index.html'))) {
    app.setNotFoundHandler((request, reply) =>
      reply
        .code(404)
        .send({ error: 'not_found', message: `No route for ${request.method} ${request.url}` }),
    );
    return;
  }
  void app.register(fastifyStatic, {
    root: webDir,
    prefix: '/',
    // index.html is served below, with its own headers.
    index: false,
    // Our own Cache-Control (below), not the plugin's.
    cacheControl: false,
    setHeaders: (res, path) => {
      res.setHeader(
        'cache-control',
        path.includes(`${join(webDir, 'assets')}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      );
    },
  });
  const page = (reply: FastifyReply) =>
    reply
      .header('cache-control', 'no-cache')
      .header('x-content-type-options', 'nosniff')
      // Never inside someone else's frame (clickjacking).
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'strict-origin-when-cross-origin')
      .sendFile('index.html', { cacheControl: false });
  app.get('/', (_request, reply) => page(reply));
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/')) return page(reply);
    return reply
      .code(404)
      .send({ error: 'not_found', message: `No route for ${request.method} ${request.url}` });
  });
}
