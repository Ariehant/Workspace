/**
 * A real Workspace server for other apps' tests (the calendar app's integration and E2E
 * tests): built from this package and run on a throwaway Postgres, plus a workspace seeded
 * with a page shared to an integration, ready for `/v1` calls with its token.
 *
 * The server runs with its production limits (3 API requests a second, bursts of 30).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPage } from '@workspace/core';
import { createTestDatabase, startTestPostgres } from '@workspace/storage-remote/testing';
import { TestDevice } from './sync/test-client';

const serverDir = fileURLToPath(new URL('..', import.meta.url));

export interface TestServer {
  /** e.g. http://127.0.0.1:40123 */
  base: string;
  stop(): Promise<void>;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

async function until(done: () => Promise<boolean> | boolean, what: string, ms = 20_000) {
  const start = Date.now();
  while (!(await done())) {
    if (Date.now() - start > ms) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Build the server (once per call) and start it with open sign-up. */
export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const build = spawnSync('node', ['build.mjs'], { cwd: serverDir, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`Server build failed: ${build.stderr}`);
  const postgres = await startTestPostgres();
  const databaseUrl = await createTestDatabase(postgres.url);
  const files = mkdtempSync(join(tmpdir(), 'workspace-test-server-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server: ChildProcess = spawn('node', ['dist/main.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_URL: base,
      FILES_DIR: files,
      SIGNUP: 'open',
      LOG_LEVEL: 'warn',
      ...env,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await until(
    () =>
      fetch(`${base}/api/ready`).then(
        (r) => r.ok,
        () => false,
      ),
    'the test server to be ready',
  );
  let stopped = false;
  return {
    base,
    /** Stop the server and its Postgres (again is a no-op). */
    async stop() {
      if (stopped) return;
      stopped = true;
      if (server.exitCode === null) {
        await new Promise((resolve) => {
          server.once('exit', resolve);
          server.kill('SIGTERM');
        });
      }
      postgres.stop();
      rmSync(files, { recursive: true, force: true });
    },
  };
}

export interface SeededWorkspace {
  base: string;
  workspaceId: string;
  /** The person who signed up (the workspace's owner). */
  user: { id: string; name: string; token: string };
  /** A top-level page shared with the integration: create databases under it. */
  pageId: string;
  /** The integration: its bot user id and its `ntn_` token for `/v1`. */
  integration: { id: string; token: string };
  /** Change the integration's access to the shared page (`null` removes it). */
  setAccess(role: 'edit' | 'view' | null): Promise<void>;
}

let seeded = 0;

/**
 * Sign up, make a workspace with one top-level page (the API can't make one), share it with
 * a new integration, and return what a `/v1` client needs.
 */
export async function seedWorkspace(base: string, name = 'Ada'): Promise<SeededWorkspace> {
  const n = ++seeded;
  const json = async <T = unknown>(
    method: string,
    path: string,
    token: string | null,
    body?: object,
  ): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'x-workspace-client': 'test',
        ...(token && { authorization: `Bearer ${token}` }),
        ...(body && { 'content-type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  };

  const email = `${name.toLowerCase()}-${process.pid}-${n}@example.test`;
  const signup = await json<{ token: string; user: { id: string } }>(
    'POST',
    '/api/auth/signup',
    null,
    {
      email,
      name,
      password: 'long password',
      client: 'desktop',
    },
  );
  const user = { id: signup.user.id, name, token: signup.token };
  const workspaceId = (
    await json<{ workspace: { id: string } }>('POST', '/api/workspaces', user.token, {
      name: 'Lab',
    })
  ).workspace.id;
  const defaultScope = (
    await json<{ defaultScopeId: string }>(
      'GET',
      `/api/workspaces/${workspaceId}/scopes`,
      user.token,
    )
  ).defaultScopeId;

  const pageId = crypto.randomUUID();
  const device = new TestDevice({
    url: `${base.replace(/^http/, 'ws')}/api/sync/${workspaceId}`,
    token: user.token,
    deviceId: `seed-${n}`,
  });
  device.client.start();
  try {
    await until(() => device.client.state.state === 'live', 'the seeding device to connect');
    createPage(device.doc('workspace'), { id: pageId, title: 'Calendars' });
    await until(() => device.outbox.length === 0, 'the seeded page to reach the server');
  } finally {
    device.client.stop();
  }

  const made = await json<{ integration: { id: string }; token: string }>(
    'POST',
    `/api/workspaces/${workspaceId}/integrations`,
    user.token,
    { name: 'Calendar' },
  );
  const integration = { id: made.integration.id, token: made.token };
  const scope = (
    await json<{ scope: { id: string } }>(
      'POST',
      `/api/workspaces/${workspaceId}/pages/${pageId}/share`,
      user.token,
      { scope: defaultScope },
    )
  ).scope.id;
  const setAccess = async (role: 'edit' | 'view' | null) => {
    await json('PUT', `/api/workspaces/${workspaceId}/scopes/${scope}/access`, user.token, {
      principal: `user:${integration.id}`,
      role,
    });
  };
  await setAccess('edit');
  return { base, workspaceId, user, pageId, integration, setAccess };
}
