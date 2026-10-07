import type { FastifyInstance } from 'fastify';
import { fail, requireUser } from './auth/context';
import type { ServerContext } from './context';

/** Keys like `ui.theme` or `<workspace id>:ui.tabs`. */
const KEY = /^[\w.:-]{1,160}$/;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_SETTINGS = 500;

/** The web app's settings, per user (the desktop keeps its own in its database). */
export function settingsRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  const { accounts } = ctx.store;

  app.get('/api/settings', { preHandler: signedIn }, async (request) => ({
    settings: await accounts.settings(request.auth!.user.id),
  }));

  app.put<{ Params: { key: string }; Body: { value: unknown } }>(
    '/api/settings/:key',
    {
      preHandler: signedIn,
      schema: { body: { type: 'object', required: ['value'], properties: { value: {} } } },
    },
    async (request, reply) => {
      const { key } = request.params;
      if (!KEY.test(key)) return fail(reply, 400, 'invalid', 'Invalid setting name.');
      const value = request.body.value;
      if (JSON.stringify(value).length > MAX_VALUE_BYTES) {
        return fail(reply, 413, 'too_large', 'That setting is too large.');
      }
      const userId = request.auth!.user.id;
      if (value !== null && (await accounts.settingCount(userId)) >= MAX_SETTINGS) {
        const existing = await accounts.settings(userId);
        if (!(key in existing)) return fail(reply, 400, 'too_many', 'Too many settings.');
      }
      await accounts.setSetting(userId, key, value);
      return { ok: true };
    },
  );
}
