import type { Session, SessionKind, User } from '@workspace/storage-remote';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context';
import { randomToken } from './passwords';

export const SESSION_COOKIE = 'ws_session';
/** Browsers must send this on every request that changes something (see `csrfGuard`). */
export const CLIENT_HEADER = 'x-workspace-client';

/** Sessions slide: each one lasts this long after it was last used. */
export const SESSION_TTL_MS: Record<SessionKind, number> = {
  web: 30 * 24 * 3_600_000,
  desktop: 180 * 24 * 3_600_000,
};
/** How often "last seen" (and the expiry) is written back, at most. */
const TOUCH_EVERY_MS = 5 * 60_000;

export interface Auth {
  user: User;
  session: Session;
  /** Where the token came from: a cookie (browser) or an Authorization header (desktop). */
  via: 'cookie' | 'bearer';
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user (set by `requireUser`). */
    auth: Auth | null;
  }
}

/** A JSON error: `{ error: code, message }`. */
export function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

/** Find the session for the request's token, if any. */
export async function authenticate(
  ctx: ServerContext,
  request: FastifyRequest,
): Promise<Auth | null> {
  const fromHeader = bearer(request);
  const token = fromHeader ?? request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const found = await ctx.store.accounts.sessionByToken(token);
  if (!found) return null;
  await touch(ctx, found.session);
  return { ...found, via: fromHeader ? 'bearer' : 'cookie' };
}

/** Note a session was used, sliding its expiry (written at most every few minutes). */
export async function touch(ctx: Pick<ServerContext, 'store'>, session: Session): Promise<void> {
  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await ctx.store.accounts.touchSession(session.id, SESSION_TTL_MS[session.kind]);
  }
}

/** preHandler: 401 unless signed in; sets `request.auth`. */
export function requireUser(ctx: ServerContext) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    request.auth = await authenticate(ctx, request);
    if (!request.auth) return fail(reply, 401, 'unauthenticated', 'Sign in first.');
  };
}

/** preHandler: 403 unless signed in as a server admin. */
export function requireAdmin(ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await signedIn(request, reply);
    if (reply.sent) return;
    if (!request.auth!.user.isAdmin) return fail(reply, 403, 'forbidden', 'Admins only.');
  };
}

/**
 * Cross-site request forgery: a page on another site can make a browser send our cookie
 * with a form post, but not with a custom header (that needs CORS, which we don't allow).
 * So anything that isn't a plain read must carry the header, unless it authenticates
 * with a bearer token (which browsers never attach on their own).
 */
export function csrfGuard(request: FastifyRequest, reply: FastifyReply, done: () => void) {
  const safe = request.method === 'GET' || request.method === 'HEAD';
  if (!safe && request.url.startsWith('/api/') && !bearer(request)) {
    if (!request.headers[CLIENT_HEADER]) {
      void fail(reply, 403, 'csrf', `Requests must carry the ${CLIENT_HEADER} header.`);
      return;
    }
  }
  done();
}

/** Start a session; browsers get it as a cookie, the desktop app as a token. */
export async function startSession(
  ctx: ServerContext,
  reply: FastifyReply,
  user: User,
  kind: SessionKind,
  deviceName: string,
): Promise<{ token: string; session: Session }> {
  const token = randomToken();
  const session = await ctx.store.accounts.createSession({
    userId: user.id,
    token,
    kind,
    deviceName,
    ttlMs: SESSION_TTL_MS[kind],
  });
  if (kind === 'web') {
    reply.setCookie(SESSION_COOKIE, token, cookieOptions(ctx, SESSION_TTL_MS.web));
  }
  return { token, session };
}

export function cookieOptions(ctx: ServerContext, maxAgeMs: number) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: ctx.config.publicUrl.startsWith('https:'),
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

/** What clients see of a user. */
export const publicUser = (user: User) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  avatar: user.avatar,
  isAdmin: user.isAdmin,
});
