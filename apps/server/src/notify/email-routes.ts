/**
 * Email digest settings and one-click unsubscribe (Phase 6 M7).
 *
 * - `GET|PUT /api/auth/me/email` `{digest}`: mentions (the default), daily or never; also
 *   whether the server can send email at all.
 * - `GET /email/unsubscribe?u=&t=`: a page with one button (a link opened by a mail
 *   scanner changes nothing).
 * - `POST /email/unsubscribe?u=&t=`: no more emails (RFC 8058: mail clients POST
 *   `List-Unsubscribe=One-Click` here, outside `/api` and its client header).
 */
import type { EmailDigest } from '@workspace/storage-remote';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/context';
import type { ServerContext } from '../context';

const DIGESTS: readonly EmailDigest[] = ['mentions', 'daily', 'never'];
const uuid = { type: 'string', format: 'uuid' } as const;
const unsubscribeQuery = {
  type: 'object',
  required: ['u', 't'],
  properties: { u: uuid, t: { type: 'string', pattern: '^[0-9a-f]{16,128}$' } },
} as const;

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A small page of its own (no app, no scripts). */
const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#37352f}
button{font:inherit;padding:.5rem 1rem;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer}</style>
</head><body><h1>${escape(title)}</h1>${body}</body></html>`;

export function emailRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  const { accounts } = ctx.store;

  app.get('/api/auth/me/email', { preHandler: signedIn }, async (request) => {
    const prefs = await accounts.emailPrefs(request.auth!.user.id);
    return { digest: prefs?.digest ?? 'never', available: ctx.mailer !== null };
  });

  app.put<{ Body: { digest: EmailDigest } }>(
    '/api/auth/me/email',
    {
      preHandler: signedIn,
      schema: {
        body: {
          type: 'object',
          required: ['digest'],
          additionalProperties: false,
          properties: { digest: { type: 'string', enum: [...DIGESTS] } },
        },
      },
    },
    async (request) => {
      await accounts.setEmailDigest(request.auth!.user.id, request.body.digest);
      return { digest: request.body.digest, available: ctx.mailer !== null };
    },
  );

  void app.register(async (scope) => {
    // Mail clients send the one-click POST as a form.
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 1024 },
      (_request, body, done) => done(null, body),
    );
    const html = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

    scope.get<{ Querystring: { u: string; t: string } }>(
      '/email/unsubscribe',
      { schema: { querystring: unsubscribeQuery } },
      async (request, reply) => {
        const { u, t } = request.query;
        const action = `/email/unsubscribe?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}`;
        return reply.headers(html).send(
          page(
            'Stop these emails?',
            `<p>You won't get emails about your inbox anymore. You can turn them back on in Settings.</p>
<form method="post" action="${escape(action)}"><button type="submit">Unsubscribe</button></form>`,
          ),
        );
      },
    );

    scope.post<{ Querystring: { u: string; t: string } }>(
      '/email/unsubscribe',
      { schema: { querystring: unsubscribeQuery } },
      async (request, reply) => {
        const done = await accounts.unsubscribe(request.query.u, request.query.t);
        if (!done) {
          return reply
            .code(404)
            .headers(html)
            .send(page('Link not valid', '<p>This unsubscribe link is not valid.</p>'));
        }
        return reply
          .headers(html)
          .send(
            page(
              'Unsubscribed',
              "<p>You won't get these emails anymore. You can turn them back on in Settings.</p>",
            ),
          );
      },
    );
  });
}
