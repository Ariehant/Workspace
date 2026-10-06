import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildServer } from './app';
import { hashPassword } from './auth/passwords';
import { loadConfig } from './config';
import { FsStorage } from './files';
import { startFakeProvider, type FakeProvider } from './test-oidc-provider';

let dir: string;
let idp: FakeProvider;
const cleanups: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-auth-'));
  idp = await startFakeProvider();
});
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await idp.stop();
  rmSync(dir, { recursive: true, force: true });
});

type Who = { token?: string; cookie?: string };

/** A server on a fresh database; `env` overrides the configuration. */
async function setup(env: Record<string, string> = {}) {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 4 });
  await store.migrate();
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    FILES_DIR: dir,
    OIDC_PROVIDERS: 'fake',
    OIDC_FAKE_ISSUER: idp.issuer,
    OIDC_FAKE_CLIENT_ID: idp.clientId,
    OIDC_FAKE_CLIENT_SECRET: idp.clientSecret,
    OIDC_ALLOW_INSECURE: 'true',
    ...env,
  });
  const app = buildServer({ config, store, files: new FsStorage(dir) });
  cleanups.push(
    () => app.close(),
    () => store.close(),
  );

  const headers = (who: Who = {}) => ({
    ...(who.token ? { authorization: `Bearer ${who.token}` } : { 'x-workspace-client': 'test' }),
    ...(who.cookie ? { cookie: `ws_session=${who.cookie}` } : {}),
  });
  const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: object, who?: Who) =>
    app.inject({ method, url, payload: body, headers: headers(who) });
  const get = (url: string, who?: Who) => app.inject({ method: 'GET', url, headers: headers(who) });
  const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
    res.cookies.find((c) => c.name === 'ws_session')?.value;

  /** Sign up (web) and return the session cookie. */
  async function signup(email: string, extra: object = {}) {
    const res = await send('POST', '/api/auth/signup', {
      email,
      name: email.split('@')[0],
      password: 'correct horse',
      ...extra,
    });
    return { res, cookie: cookieOf(res) };
  }
  return { app, store, send, get, signup, cookieOf };
}

describe('password accounts', () => {
  it('makes the first account the admin, then follows the sign-up policy', async () => {
    const s = await setup({ SIGNUP: 'invite' });
    expect((await s.get('/api/auth/config')).json()).toEqual({
      signup: 'invite',
      needsSetup: true,
      providers: [{ id: 'fake', name: 'Fake' }],
    });
    const admin = await s.signup('Ada@Lab.io');
    expect(admin.res.statusCode).toBe(201);
    expect(admin.res.json().user).toMatchObject({ email: 'ada@lab.io', isAdmin: true });
    expect(admin.res.json()).not.toHaveProperty('token');
    const cookie = admin.res.cookies.find((c) => c.name === 'ws_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect((await s.get('/api/auth/config')).json().needsSetup).toBe(false);

    // No invite, a bad one, one for someone else: refused.
    expect((await s.signup('bob@lab.io')).res.statusCode).toBe(403);
    expect((await s.signup('bob@lab.io', { invite: 'nope' })).res.statusCode).toBe(403);
    const forCarol = await s.send(
      'POST',
      '/api/admin/invites',
      { email: 'carol@lab.io' },
      { cookie: admin.cookie },
    );
    expect(forCarol.statusCode).toBe(201);
    expect((await s.signup('bob@lab.io', { invite: forCarol.json().code })).res.statusCode).toBe(
      403,
    );

    // A good invite works once.
    const invite = (await s.send('POST', '/api/admin/invites', {}, { cookie: admin.cookie })).json()
      .code as string;
    const bob = await s.signup('bob@lab.io', { invite });
    expect(bob.res.statusCode).toBe(201);
    expect(bob.res.json().user.isAdmin).toBe(false);
    expect((await s.signup('dan@lab.io', { invite })).res.statusCode).toBe(403);
    expect((await s.signup('carol@lab.io', { invite: forCarol.json().code })).res.statusCode).toBe(
      201,
    );

    // Only admins make invites; the same email can't sign up twice.
    expect(
      (await s.send('POST', '/api/admin/invites', {}, { cookie: bob.cookie })).statusCode,
    ).toBe(403);
    const again = await s.send('POST', '/api/admin/invites', {}, { cookie: admin.cookie });
    expect((await s.signup('BOB@lab.io', { invite: again.json().code })).res.statusCode).toBe(409);
  });

  it('honours open and disabled sign-up and checks input', async () => {
    const open = await setup({ SIGNUP: 'open' });
    await open.signup('a@x.io');
    expect((await open.signup('b@x.io')).res.statusCode).toBe(201);
    expect((await open.signup('c@x.io', { password: 'short' })).res.json().error).toBe(
      'weak_password',
    );
    expect((await open.signup('not-an-email')).res.json().error).toBe('invalid');
    expect((await open.signup('d@x.io', { name: '   ' })).res.statusCode).toBe(400);

    const closed = await setup({ SIGNUP: 'disabled' });
    expect((await closed.signup('first@x.io')).res.statusCode).toBe(201);
    expect((await closed.signup('second@x.io')).res.json()).toMatchObject({
      error: 'signup_closed',
    });
  });

  it('signs in on the web (cookie) and on the desktop (token)', async () => {
    const s = await setup();
    await s.signup('ada@lab.io');
    const login = (body: object) =>
      s.send('POST', '/api/auth/login', {
        email: 'ada@lab.io',
        password: 'correct horse',
        ...body,
      });

    expect((await login({ password: 'wrong horse' })).statusCode).toBe(401);
    expect((await login({ email: 'nobody@lab.io' })).json()).toEqual({
      error: 'invalid_credentials',
      message: 'Wrong email or password.',
    });

    const web = await login({ email: ' ADA@lab.io ' });
    expect(web.statusCode).toBe(200);
    const cookie = s.cookieOf(web)!;
    expect((await s.get('/api/auth/me', { cookie })).json()).toMatchObject({
      user: { email: 'ada@lab.io', name: 'ada' },
      session: { kind: 'web' },
    });

    const desktop = await login({ client: 'desktop', deviceName: 'Lab laptop' });
    const token = desktop.json().token as string;
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(s.cookieOf(desktop)).toBeUndefined();
    const me = await s.get('/api/auth/me', { token });
    expect(me.json().session.kind).toBe('desktop');

    // Not signed in, or a made-up token.
    expect((await s.get('/api/auth/me')).statusCode).toBe(401);
    expect((await s.get('/api/auth/me', { token: 'forged' })).statusCode).toBe(401);

    // Rename.
    const renamed = await s.send('PATCH', '/api/auth/me', { name: 'Ada L.' }, { token });
    expect(renamed.json().user.name).toBe('Ada L.');

    // Sign out ends just that session.
    expect((await s.send('POST', '/api/auth/logout', {}, { cookie })).statusCode).toBe(200);
    expect((await s.get('/api/auth/me', { cookie })).statusCode).toBe(401);
    expect((await s.get('/api/auth/me', { token })).statusCode).toBe(200);
  });

  it('refuses cookie requests without the client header (CSRF)', async () => {
    const s = await setup();
    const { cookie } = await s.signup('ada@lab.io');
    const forged = await s.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: 'Evil' },
      headers: { cookie: `ws_session=${cookie}` },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error).toBe('csrf');
    const loginForm = await s.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ada@lab.io', password: 'correct horse' },
    });
    expect(loginForm.statusCode).toBe(403);
    // Reads don't need it.
    expect(
      (await s.app.inject({ url: '/api/auth/me', headers: { cookie: `ws_session=${cookie}` } }))
        .statusCode,
    ).toBe(200);
  });

  it('lists and revokes sessions, and expires them', async () => {
    const s = await setup();
    const { cookie } = await s.signup('ada@lab.io');
    const token = (
      await s.send('POST', '/api/auth/login', {
        email: 'ada@lab.io',
        password: 'correct horse',
        client: 'desktop',
        deviceName: 'Robot PC',
      })
    ).json().token;
    const list = (await s.get('/api/auth/sessions', { cookie })).json().sessions;
    expect(list).toHaveLength(2);
    const robot = list.find((x: { deviceName: string }) => x.deviceName === 'Robot PC');
    expect(robot).toMatchObject({ kind: 'desktop', current: false });

    // Someone else can't end it.
    const other = await setup();
    expect(
      (await s.send('DELETE', `/api/auth/sessions/${robot.id}`, undefined, { cookie: 'x' }))
        .statusCode,
    ).toBe(401);
    await other.app.close();

    expect(
      (await s.send('DELETE', `/api/auth/sessions/${robot.id}`, undefined, { cookie })).statusCode,
    ).toBe(200);
    expect((await s.get('/api/auth/me', { token })).statusCode).toBe(401);
    expect(
      (await s.send('DELETE', `/api/auth/sessions/${robot.id}`, undefined, { cookie })).statusCode,
    ).toBe(404);

    await s.store.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second'`);
    expect((await s.get('/api/auth/me', { cookie })).statusCode).toBe(401);
  });

  it('changes the password and signs out every other session', async () => {
    const s = await setup();
    const { cookie } = await s.signup('ada@lab.io');
    const other = s.cookieOf(
      await s.send('POST', '/api/auth/login', { email: 'ada@lab.io', password: 'correct horse' }),
    );
    const change = (body: object) => s.send('POST', '/api/auth/password', body, { cookie });
    expect((await change({ current: 'wrong', password: 'battery staple' })).statusCode).toBe(403);
    expect((await change({ current: 'correct horse', password: 'tiny' })).statusCode).toBe(400);
    expect(
      (await change({ current: 'correct horse', password: 'battery staple' })).statusCode,
    ).toBe(200);
    expect((await s.get('/api/auth/me', { cookie })).statusCode).toBe(200);
    expect((await s.get('/api/auth/me', { cookie: other })).statusCode).toBe(401);
    const login = (password: string) =>
      s.send('POST', '/api/auth/login', { email: 'ada@lab.io', password });
    expect((await login('correct horse')).statusCode).toBe(401);
    expect((await login('battery staple')).statusCode).toBe(200);
  });

  it('locks an account after repeated failures, and limits each address', async () => {
    const s = await setup();
    await s.signup('ada@lab.io');
    const login = (email: string, password: string) =>
      s.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password },
        headers: { 'x-workspace-client': 'test' },
        remoteAddress: email === 'ada@lab.io' ? '10.0.0.1' : '10.0.0.2',
      });
    for (let i = 0; i < 10; i++) expect((await login('ada@lab.io', 'guess')).statusCode).toBe(401);
    const locked = await login('ada@lab.io', 'correct horse');
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

    // Per address: 20 sign-in requests a minute.
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await login(`u${i}@x.io`, 'guess')).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes[20]).toBe(429);
  });

  it('shuts out disabled accounts', async () => {
    const s = await setup();
    const admin = await s.signup('ada@lab.io');
    const bob = await s.store.accounts.createUser({
      email: 'bob@lab.io',
      name: 'Bob',
      passwordHash: null,
    });
    // Bob has no password yet: he can't sign in with one...
    expect(
      (await s.send('POST', '/api/auth/login', { email: 'bob@lab.io', password: 'bob password' }))
        .statusCode,
    ).toBe(401);
    // ...until an admin gives him one.
    await s.store.accounts.setPassword(bob!.id, await hashPassword('bob password'));
    const bobCookie = s.cookieOf(
      await s.send('POST', '/api/auth/login', { email: 'bob@lab.io', password: 'bob password' }),
    );
    expect((await s.get('/api/auth/me', { cookie: bobCookie })).statusCode).toBe(200);

    const users = (await s.get('/api/admin/users', { cookie: admin.cookie })).json().users;
    expect(users.map((u: { email: string }) => u.email)).toEqual(['ada@lab.io', 'bob@lab.io']);
    expect((await s.get('/api/admin/users', { cookie: bobCookie })).statusCode).toBe(403);

    const disable = (id: string, disabled: boolean) =>
      s.send('POST', `/api/admin/users/${id}/disabled`, { disabled }, { cookie: admin.cookie });
    expect((await disable(admin.res.json().user.id, true)).statusCode).toBe(400);
    expect((await disable(bob!.id, true)).statusCode).toBe(200);
    expect((await s.get('/api/auth/me', { cookie: bobCookie })).statusCode).toBe(401);
    expect(
      (await s.send('POST', '/api/auth/login', { email: 'bob@lab.io', password: 'bob password' }))
        .statusCode,
    ).toBe(401);
    await disable(bob!.id, false);
    expect(
      (await s.send('POST', '/api/auth/login', { email: 'bob@lab.io', password: 'bob password' }))
        .statusCode,
    ).toBe(200);
  });
});

describe('workspaces', () => {
  it('creates, lists and renames workspaces for their members only', async () => {
    const s = await setup({ SIGNUP: 'open' });
    const ada = await s.signup('ada@lab.io');
    const bob = await s.signup('bob@lab.io');
    const created = await s.send(
      'POST',
      '/api/workspaces',
      { name: ' Lab ' },
      { cookie: ada.cookie },
    );
    expect(created.statusCode).toBe(201);
    const ws = created.json().workspace;
    expect(ws).toMatchObject({ name: 'Lab', role: 'owner' });

    expect((await s.get('/api/workspaces', { cookie: ada.cookie })).json().workspaces).toEqual([
      expect.objectContaining({ id: ws.id, name: 'Lab', role: 'owner' }),
    ]);
    expect((await s.get('/api/workspaces', { cookie: bob.cookie })).json().workspaces).toEqual([]);

    const rename = (who: string | undefined, name: string) =>
      s.send('PATCH', `/api/workspaces/${ws.id}`, { name }, { cookie: who });
    expect((await rename(bob.cookie, 'Mine')).statusCode).toBe(404);
    await s.store.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       SELECT $1, id, 'member' FROM users WHERE email = 'bob@lab.io'`,
      [ws.id],
    );
    expect((await rename(bob.cookie, 'Mine')).statusCode).toBe(403);
    const renamed = await rename(ada.cookie, 'Robotics lab');
    expect(renamed.json().workspace).toMatchObject({ name: 'Robotics lab', role: 'owner' });
    expect((await rename(ada.cookie, '')).statusCode).toBe(400);
    expect(
      (await s.send('PATCH', '/api/workspaces/not-a-uuid', { name: 'x' }, { cookie: ada.cookie }))
        .statusCode,
    ).toBe(400);
  });
});

describe('single sign-on', () => {
  /** Run a browser through start → provider → callback; returns the callback's response. */
  async function signIn(s: Awaited<ReturnType<typeof setup>>, query = '') {
    const start = await s.get(`/api/auth/oidc/fake/start${query}`);
    expect(start.statusCode).toBe(302);
    const back = await idp.authorize(start.headers.location as string);
    expect(back.pathname).toBe('/api/auth/oidc/fake/callback');
    return s.get(back.pathname + back.search);
  }

  it('creates the account on first sign-in and finds it again', async () => {
    const s = await setup({ SIGNUP: 'open' });
    idp.account = { sub: 'g-1', email: 'Ada@Lab.io', email_verified: true, name: 'Ada' };
    const first = await signIn(s);
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe('/');
    const cookie = s.cookieOf(first)!;
    const me = (await s.get('/api/auth/me', { cookie })).json();
    expect(me.user).toMatchObject({ email: 'ada@lab.io', name: 'Ada', isAdmin: true });

    const second = await signIn(s);
    expect((await s.get('/api/auth/me', { cookie: s.cookieOf(second) })).json().user.id).toBe(
      me.user.id,
    );
    expect(await s.store.accounts.countUsers()).toBe(1);

    // The account has no password; it can set one without a current one.
    expect(
      (await s.send('POST', '/api/auth/password', { password: 'now a password' }, { cookie }))
        .statusCode,
    ).toBe(200);
  });

  it('joins an existing account only through a verified email', async () => {
    const s = await setup();
    const { res } = await s.signup('ada@lab.io');
    idp.account = { sub: 'g-2', email: 'ada@lab.io', email_verified: false };
    const refused = await signIn(s);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain('not verified');

    idp.account = { sub: 'g-2', email: 'ada@lab.io', email_verified: true };
    const linked = await signIn(s);
    expect((await s.get('/api/auth/me', { cookie: s.cookieOf(linked) })).json().user.id).toBe(
      res.json().user.id,
    );
  });

  it('follows the sign-up policy for new accounts', async () => {
    const s = await setup({ SIGNUP: 'invite' });
    const admin = await s.signup('ada@lab.io');
    idp.account = { sub: 'g-3', email: 'bob@lab.io', email_verified: true, name: 'Bob' };
    const refused = await signIn(s);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain('invite');

    const invite = (await s.send('POST', '/api/admin/invites', {}, { cookie: admin.cookie })).json()
      .code;
    const ok = await signIn(s, `?invite=${invite}`);
    expect(ok.statusCode).toBe(302);
    expect((await s.get('/api/auth/me', { cookie: s.cookieOf(ok) })).json().user.name).toBe('Bob');

    idp.account = { sub: 'g-4' };
    expect((await signIn(s)).body).toContain('did not share an email');
  });

  it('hands the desktop app a one-time code on its loopback port', async () => {
    const s = await setup();
    idp.account = { sub: 'g-5', email: 'ada@lab.io', email_verified: true };
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    expect((await s.get('/api/auth/oidc/fake/start?client=desktop')).statusCode).toBe(400);
    const done = await signIn(s, `?client=desktop&port=45123&challenge=${challenge}&device=Rig`);
    expect(done.statusCode).toBe(302);
    const loopback = new URL(done.headers.location as string);
    expect(loopback.origin).toBe('http://127.0.0.1:45123');
    expect(loopback.pathname).toBe('/callback');
    const code = loopback.searchParams.get('code')!;
    expect(s.cookieOf(done)).toBeUndefined();

    // The code alone (without the verifier) is useless, and is then gone.
    const stolen = await s.send('POST', '/api/auth/desktop/exchange', { code, verifier: 'x' });
    expect(stolen.statusCode).toBe(400);
    const again = await signIn(s, `?client=desktop&port=45123&challenge=${challenge}&device=Rig`);
    const code2 = new URL(again.headers.location as string).searchParams.get('code')!;
    const exchanged = await s.send('POST', '/api/auth/desktop/exchange', { code: code2, verifier });
    expect(exchanged.statusCode).toBe(200);
    const { token, user } = exchanged.json();
    expect(user.email).toBe('ada@lab.io');
    const me = (await s.get('/api/auth/me', { token })).json();
    expect(me.session.kind).toBe('desktop');
    const sessions = (await s.get('/api/auth/sessions', { token })).json().sessions;
    expect(sessions[0].deviceName).toBe('Rig');
    expect(
      (await s.send('POST', '/api/auth/desktop/exchange', { code: code2, verifier })).statusCode,
    ).toBe(400);
  });

  it('rejects unknown, replayed and cancelled sign-ins', async () => {
    const s = await setup();
    expect((await s.get('/api/auth/oidc/nope/start')).statusCode).toBe(404);
    expect((await s.get('/api/auth/oidc/fake/callback?state=made-up&code=x')).statusCode).toBe(400);

    idp.account = { sub: 'g-6', email: 'x@lab.io', email_verified: true };
    const start = await s.get('/api/auth/oidc/fake/start');
    const back = await idp.authorize(start.headers.location as string);
    expect((await s.get(back.pathname + back.search)).statusCode).toBe(302);
    // The same callback again: its state was used up.
    expect((await s.get(back.pathname + back.search)).statusCode).toBe(400);

    const cancelled = await s.get('/api/auth/oidc/fake/start');
    const state = new URL(cancelled.headers.location as string).searchParams.get('state');
    const res = await s.get(`/api/auth/oidc/fake/callback?state=${state}&error=access_denied`);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('cancelled');

    // A tampered code fails verification without signing anyone in.
    const tampered = await s.get('/api/auth/oidc/fake/start');
    const t = await idp.authorize(tampered.headers.location as string);
    t.searchParams.set('code', 'forged');
    const bad = await s.get(t.pathname + t.search);
    expect(bad.statusCode).toBe(403);
    expect(s.cookieOf(bad)).toBeUndefined();
  });

  it('lists no providers when none are configured', async () => {
    const s = await setup({ OIDC_PROVIDERS: '' });
    expect((await s.get('/api/auth/config')).json().providers).toEqual([]);
  });
});
