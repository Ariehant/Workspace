/** The real server bundle on a throwaway Postgres, serving this app's build. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, startTestPostgres } from '@workspace/storage-remote/testing';

const serverDir = fileURLToPath(new URL('../../server', import.meta.url));
const webDir = fileURLToPath(new URL('../dist', import.meta.url));

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

export interface TestServer {
  base: string;
  stop(): Promise<void>;
}

export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  if (!existsSync(join(webDir, 'index.html'))) {
    throw new Error('Build the web app first: pnpm --filter @workspace/web build');
  }
  const build = spawnSync('node', ['build.mjs'], { cwd: serverDir, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`Server build failed: ${build.stderr}`);
  const postgres = await startTestPostgres();
  const databaseUrl = await createTestDatabase(postgres.url);
  const root = mkdtempSync(join(tmpdir(), 'workspace-web-e2e-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn('node', ['dist/main.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_URL: base,
      FILES_DIR: join(root, 'files'),
      WEB_DIR: webDir,
      SIGNUP: 'open',
      LOG_LEVEL: 'warn',
      ...env,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const start = Date.now();
  for (;;) {
    const ok = await fetch(`${base}/api/ready`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    if (Date.now() - start > 20_000) throw new Error('The server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    async stop() {
      if (child.exitCode === null) {
        await new Promise((resolve) => {
          child.once('exit', resolve);
          child.kill('SIGTERM');
        });
      }
      await postgres.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
