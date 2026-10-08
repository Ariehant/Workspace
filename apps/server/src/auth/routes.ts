import { isTimeZone } from '@workspace/core';
import { createHash } from 'node:crypto';
import type { SessionKind, User } from '@workspace/storage-remote';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context';
import { workspaceInviteFor } from '../members/routes';
import {
  SESSION_COOKIE,
  cookieOptions,
  fail,
  publicUser,
  requireUser,
  startSession,
} from './context';
import {
  MAX_PASSWORD_LENGTH,
  hashPassword,
  passwordProblem,
  randomToken,
  verifyNothing,
  verifyPassword,
} from './passwords';
import { LoginThrottle } from './throttle';

/** Requests per minute per IP on the sign-in endpoints. */
const AUTH_RATE = { max: 20, timeWindow: '1 minute' };
const OIDC_STATE_TTL_MS = 10 * 60_000;
const DESKTOP_CODE_TTL_MS = 2 * 60_000;

const email = { type: 'string', maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+$' } as const;
const name = { type: 'string', minLength: 1, maxLength: 100 } as const;
const password = { type: 'string', maxLength: MAX_PASSWORD_LENGTH } as const;
const client = { type: 'string', enum: ['web', 'desktop'] } as const;
const deviceName = { type: 'string', maxLength: 100 } as const;
const secret = { type: 'string', minLength: 1, maxLength: 200 } as const;
/** Profile pictures are resized by the client; this is about 48 KB of image. */
const MAX_AVATAR_LENGTH = 64 * 1024;
const AVATAR = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** base64url(sha256(verifier)): PKCE's S256, between the desktop app and us. */
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A minimal page for the end of a browser sign-in (there's no web app to land on yet). */
function page(reply: FastifyReply, status: number, title: string, message: string) {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
        `<title>${escapeHtml(title)}</title>` +
        `<body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem">` +
        `<h1 style="font-size:1.4rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`,
    );
}

export function authRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { accounts } = ctx.store;
  const throttle = new LoginThrottle();
  const signedIn = requireUser(ctx);

  /**
   * Whether a new account may be created: the first one always (it becomes the admin),
   * after that per the SIGNUP policy. Returns a reason when it may not.
   */
  async function signupProblem(address: string, invite: string | null | undefined) {
    if ((await accounts.countUsers()) === 0) return { problem: null, useInvite: false };
    if (ctx.config.signup === 'open') return { problem: null, useInvite: false };
    if (ctx.config.signup === 'disabled') {
      return {
        problem: 'Sign-up is closed on this server. Ask an admin for an account.',
        useInvite: false,
      };
    }
    if (!invite) return { problem: 'You need an invite to sign up here.', useInvite: false };
    // An invite to a workspace on this server lets its invitee sign up too.
    if (await workspaceInviteFor(ctx, invite, address)) return { problem: null, useInvite: false };
    if (!(await accounts.inviteValid(invite, address))) {
      return {
        problem: 'This invite is not valid: it was used, expired or is for someone else.',
        useInvite: false,
      };
    }
    return { problem: null, useInvite: true };
  }

  /** Create the account, using up the invite (undone if someone else used it meanwhile). */
  async function createAccount(input: {
    email: string;
    name: string;
    passwordHash: string | null;
    invite: string | null | undefined;
  }): Promise<{ user: User } | { problem: string; status: number }> {
    const policy = await signupProblem(input.email, input.invite);
    if (policy.problem) return { problem: policy.problem, status: 403 };
    const user = await accounts.createUser(input);
    if (!user) return { problem: 'There is already an account with this email.', status: 409 };
    if (policy.useInvite && !(await accounts.consumeInvite(input.invite!, input.email, user.id))) {
      await accounts.deleteUser(user.id);
      return { problem: 'This invite was just used by someone else.', status: 403 };
    }
    // Signed up with a workspace invite: join that workspace right away.
    if (input.invite) {
      const joined = await ctx.store.teams.acceptInvite(input.invite, user);
      if (joined.ok) {
        await ctx.members.refresh(joined.workspaceId);
        await ctx.access.changed(joined.workspaceId);
      }
    }
    return { user };
  }

  const sessionResponse = (user: User, kind: SessionKind, token: string) =>
    kind === 'desktop' ? { user: publicUser(user), token } : { user: publicUser(user) };

  // What the sign-in screen needs to know.
  app.get('/api/auth/config', async () => ({
    signup: ctx.config.signup,
    needsSetup: (await accounts.countUsers()) === 0,
    providers: ctx.oidc.list(),
  }));

  app.post<{
    Body: {
      email: string;
      name: string;
      password: string;
      invite?: string;
      client?: SessionKind;
      deviceName?: string;
    };
  }>(
    '/api/auth/signup',
    {
      config: { rateLimit: AUTH_RATE },
      schema: {
        body: {
          type: 'object',
          required: ['email', 'name', 'password'],
          properties: { email, name, password, invite: secret, client, deviceName },
        },
      },
    },
    async (request, reply) => {
      const { body } = request;
      const problem = passwordProblem(body.password);
      if (problem) return fail(reply, 400, 'weak_password', problem);
      if (!body.name.trim()) return fail(reply, 400, 'invalid', 'Enter your name.');
      const result = await createAccount({
        email: body.email,
        name: body.name,
        passwordHash: await hashPassword(body.password),
        invite: body.invite,
      });
      if ('problem' in result) {
        return fail(
          reply,
          result.status,
          result.status === 409 ? 'email_taken' : 'signup_closed',
          result.problem,
        );
      }
      const kind = body.client ?? 'web';
      const { token } = await startSession(ctx, reply, result.user, kind, body.deviceName ?? '');
      request.log.info({ userId: result.user.id }, 'account created');
      return reply.code(201).send(sessionResponse(result.user, kind, token));
    },
  );

  app.post<{
    Body: { email: string; password: string; client?: SessionKind; deviceName?: string };
  }>(
    '/api/auth/login',
    {
      config: { rateLimit: AUTH_RATE },
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: { email: { type: 'string', maxLength: 254 }, password, client, deviceName },
        },
      },
    },
    async (request, reply) => {
      const { body } = request;
      const key = body.email.trim().toLowerCase();
      const wait = throttle.blockedFor(key);
      if (wait > 0) {
        reply.header('retry-after', Math.ceil(wait / 1000));
        return fail(reply, 429, 'rate_limited', 'Too many failed sign-ins. Try again later.');
      }
      const user = await accounts.userByEmail(key);
      const ok =
        user?.passwordHash && !user.disabledAt
          ? await verifyPassword(body.password, user.passwordHash)
          : await verifyNothing(body.password);
      if (!ok || !user) {
        throttle.fail(key);
        request.log.info({ email: key }, 'failed sign-in');
        return fail(reply, 401, 'invalid_credentials', 'Wrong email or password.');
      }
      throttle.succeed(key);
      const kind = body.client ?? 'web';
      const { token } = await startSession(ctx, reply, user, kind, body.deviceName ?? '');
      return sessionResponse(user, kind, token);
    },
  );

  app.post('/api/auth/logout', { preHandler: signedIn }, async (request, reply) => {
    await accounts.revokeSession(request.auth!.user.id, request.auth!.session.id);
    reply.clearCookie(SESSION_COOKIE, cookieOptions(ctx, 0));
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: signedIn }, async (request) => ({
    user: publicUser(request.auth!.user),
    session: { id: request.auth!.session.id, kind: request.auth!.session.kind },
  }));

  // Name and picture. Both show in every workspace the account is in (members docs).
  app.patch<{ Body: { name?: string; avatar?: string | null; timeZone?: string } }>(
    '/api/auth/me',
    {
      preHandler: signedIn,
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          properties: {
            name,
            avatar: { type: ['string', 'null'], maxLength: MAX_AVATAR_LENGTH },
            // Where the person is: their reminders fire at 9:00 there.
            timeZone: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const { name: newName, avatar, timeZone } = request.body;
      const userId = request.auth!.user.id;
      if (newName !== undefined && !newName.trim()) {
        return fail(reply, 400, 'invalid', 'Enter your name.');
      }
      if (typeof avatar === 'string' && !AVATAR.test(avatar)) {
        return fail(reply, 400, 'invalid', 'The picture must be a PNG, JPEG or WebP image.');
      }
      if (newName !== undefined) await accounts.setName(userId, newName);
      if (timeZone !== undefined) {
        if (!isTimeZone(timeZone)) return fail(reply, 400, 'invalid', 'Unknown time zone.');
        await accounts.setTimeZone(userId, timeZone);
        if (newName === undefined && avatar === undefined) {
          return { user: publicUser((await accounts.userById(userId))!) };
        }
      }
      if (avatar !== undefined) await accounts.setAvatar(userId, avatar);
      await ctx.members.refreshFor(userId);
      return { user: publicUser((await accounts.userById(userId))!) };
    },
  );

  // Change (or, for accounts made through single sign-on, set) the password. Every other
  // session ends: whoever knew the old one is signed out.
  app.post<{ Body: { current?: string; password: string } }>(
    '/api/auth/password',
    {
      preHandler: signedIn,
      config: { rateLimit: AUTH_RATE },
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          properties: { current: password, password },
        },
      },
    },
    async (request, reply) => {
      const { user, session } = request.auth!;
      const stored = (await accounts.userByEmail(user.email))?.passwordHash;
      if (stored && !(await verifyPassword(request.body.current ?? '', stored))) {
        return fail(reply, 403, 'invalid_credentials', 'The current password is wrong.');
      }
      const problem = passwordProblem(request.body.password);
      if (problem) return fail(reply, 400, 'weak_password', problem);
      await accounts.setPassword(user.id, await hashPassword(request.body.password));
      await accounts.revokeAllSessions(user.id, session.id);
      return { ok: true };
    },
  );

  app.get('/api/auth/sessions', { preHandler: signedIn }, async (request) => {
    const { user, session } = request.auth!;
    const sessions = await accounts.listSessions(user.id);
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        kind: s.kind,
        deviceName: s.deviceName,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        current: s.id === session.id,
      })),
    };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/auth/sessions/:id',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      },
    },
    async (request, reply) => {
      const ok = await accounts.revokeSession(request.auth!.user.id, request.params.id);
      if (!ok) return fail(reply, 404, 'not_found', 'No such session.');
      return { ok: true };
    },
  );

  // --- Single sign-on (OpenID Connect) --------------------------------------------------

  app.get<{
    Params: { provider: string };
    Querystring: {
      client?: SessionKind;
      port?: number;
      challenge?: string;
      device?: string;
      invite?: string;
    };
  }>(
    '/api/auth/oidc/:provider/start',
    {
      config: { rateLimit: AUTH_RATE },
      schema: {
        querystring: {
          type: 'object',
          properties: {
            client,
            port: { type: 'integer', minimum: 1024, maximum: 65535 },
            challenge: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
            device: deviceName,
            invite: secret,
          },
        },
      },
    },
    async (request, reply) => {
      const { provider } = request.params;
      if (!ctx.oidc.has(provider)) return page(reply, 404, 'Unknown sign-in method', provider);
      const kind = request.query.client ?? 'web';
      if (kind === 'desktop' && (!request.query.port || !request.query.challenge)) {
        return fail(reply, 400, 'invalid', 'The desktop app must send port and challenge.');
      }
      let start;
      try {
        start = await ctx.oidc.start(provider);
      } catch (error) {
        request.log.error({ err: error, provider }, 'OIDC discovery failed');
        return page(
          reply,
          502,
          'Sign-in is unavailable',
          'The sign-in provider could not be reached.',
        );
      }
      await accounts.putOidcState(
        {
          state: start.state,
          provider,
          codeVerifier: start.verifier,
          nonce: start.nonce,
          client: kind,
          desktopPort: kind === 'desktop' ? request.query.port! : null,
          deviceName: request.query.device ?? '',
          desktopChallenge: kind === 'desktop' ? request.query.challenge! : null,
          invite: request.query.invite ?? null,
        },
        OIDC_STATE_TTL_MS,
      );
      return reply.redirect(start.url);
    },
  );

  app.get<{ Params: { provider: string }; Querystring: Record<string, string | undefined> }>(
    '/api/auth/oidc/:provider/callback',
    { config: { rateLimit: AUTH_RATE } },
    async (request, reply) => {
      const pending =
        typeof request.query.state === 'string'
          ? await accounts.takeOidcState(request.query.state)
          : null;
      if (!pending || pending.provider !== request.params.provider) {
        return page(
          reply,
          400,
          'Sign-in expired',
          'This sign-in link is no longer valid. Start again.',
        );
      }
      const desktop = pending.client === 'desktop';
      const loopback = (params: Record<string, string>) =>
        `http://127.0.0.1:${pending.desktopPort}/callback?${new URLSearchParams(params)}`;
      const refuse = (message: string) =>
        desktop
          ? reply.redirect(loopback({ error: message }))
          : page(reply, 403, 'Could not sign in', message);

      if (request.query.error) {
        return refuse(
          request.query.error === 'access_denied'
            ? 'Sign-in was cancelled.'
            : `The provider refused: ${request.query.error_description ?? request.query.error}`,
        );
      }

      let claims;
      try {
        claims = await ctx.oidc.finish(
          pending.provider,
          new URL(request.url, ctx.config.publicUrl),
          { state: pending.state, verifier: pending.codeVerifier, nonce: pending.nonce },
        );
      } catch (error) {
        request.log.warn({ err: error, provider: pending.provider }, 'OIDC sign-in failed');
        return refuse('The sign-in could not be verified. Try again.');
      }

      let user = await accounts.userByIdentity(pending.provider, claims.subject);
      if (!user && claims.email) {
        const existing = await accounts.userByEmail(claims.email);
        if (existing) {
          // Only a provider-verified email may join an existing account.
          if (!claims.emailVerified) {
            return refuse(
              'An account with this email exists, but the provider has not verified the email. Sign in with your password.',
            );
          }
          user = existing;
          await accounts.linkIdentity(pending.provider, claims.subject, user.id, claims.email);
        }
      }
      if (!user) {
        if (!claims.email) return refuse('The provider did not share an email address.');
        const created = await createAccount({
          email: claims.email,
          name: claims.name ?? claims.email.split('@')[0]!,
          passwordHash: null,
          invite: pending.invite,
        });
        if ('problem' in created) return refuse(created.problem);
        user = created.user;
        await accounts.linkIdentity(pending.provider, claims.subject, user.id, claims.email);
        request.log.info({ userId: user.id, provider: pending.provider }, 'account created');
      }
      if (user.disabledAt) return refuse('This account is disabled.');

      if (desktop) {
        const code = randomToken();
        await accounts.putAuthCode({
          code,
          userId: user.id,
          deviceName: pending.deviceName,
          challenge: pending.desktopChallenge!,
          ttlMs: DESKTOP_CODE_TTL_MS,
        });
        return reply.redirect(loopback({ code }));
      }
      await startSession(ctx, reply, user, 'web', pending.deviceName);
      return reply.redirect('/');
    },
  );

  // The desktop app trades the one-time code (plus the PKCE verifier only it knows) for
  // its session token.
  app.post<{ Body: { code: string; verifier: string; deviceName?: string } }>(
    '/api/auth/desktop/exchange',
    {
      config: { rateLimit: AUTH_RATE },
      schema: {
        body: {
          type: 'object',
          required: ['code', 'verifier'],
          properties: { code: secret, verifier: secret, deviceName },
        },
      },
    },
    async (request, reply) => {
      const found = await accounts.takeAuthCode(request.body.code);
      if (!found || s256(request.body.verifier) !== found.challenge) {
        return fail(reply, 400, 'invalid_code', 'This sign-in code is invalid or expired.');
      }
      const user = await accounts.userById(found.userId);
      if (!user || user.disabledAt)
        return fail(reply, 403, 'disabled', 'This account is disabled.');
      const { token } = await startSession(
        ctx,
        reply,
        user,
        'desktop',
        request.body.deviceName ?? found.deviceName,
      );
      return { user: publicUser(user), token };
    },
  );
}
