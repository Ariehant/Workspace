/**
 * A real sync server for the E2E tests that need one (built from apps/server, on a
 * throwaway Postgres), and a TCP proxy to put in front of it for a device the test
 * takes offline.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, startTestPostgres } from '@workspace/storage-remote/testing';
import { expect } from './helpers';

const serverDir = fileURLToPath(new URL('../../server', import.meta.url));

export interface SyncServer {
  /** e.g. http://127.0.0.1:40123 */
  base: string;
  port: number;
  stop(): Promise<void>;
}

/** Build and start the server (open sign-up), with its files under `root`. */
export async function startSyncServer(root: string): Promise<SyncServer> {
  const build = spawnSync('node', ['build.mjs'], { cwd: serverDir, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`Server build failed: ${build.stderr}`);
  const postgres = await startTestPostgres();
  const databaseUrl = await createTestDatabase(postgres.url);
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
      FILES_DIR: join(root, 'server-files'),
      SIGNUP: 'open',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await expect
    .poll(
      () =>
        fetch(`${base}/api/ready`).then(
          (r) => r.status,
          () => 0,
        ),
      { timeout: 20_000 },
    )
    .toBe(200);
  return {
    base,
    port,
    async stop() {
      if (server.exitCode === null) {
        await new Promise((resolve) => {
          server.once('exit', resolve);
          server.kill('SIGTERM');
        });
      }
      await postgres.stop();
    },
  };
}

/** A TCP proxy in front of the server, for one device: `cut()` takes it offline. */
export class Proxy {
  private readonly sockets = new Set<Socket>();
  private blocked = false;
  private server!: Server;
  port = 0;

  async start(target: number) {
    this.server = createServer((client) => {
      if (this.blocked) return void client.destroy();
      const upstream = createConnection(target, '127.0.0.1');
      for (const s of [client, upstream]) {
        this.sockets.add(s);
        s.on('close', () => this.sockets.delete(s));
        s.on('error', () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  /** Drop every connection and refuse new ones (unplugged network). */
  cut() {
    this.blocked = true;
    for (const s of this.sockets) s.destroy();
  }

  restore() {
    this.blocked = false;
  }

  close() {
    this.cut();
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
