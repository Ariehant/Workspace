/**
 * Throwaway Postgres for tests: a cluster started from the installed binaries in a temp
 * dir (or `WORKSPACE_TEST_PG_URL` when one is provided, e.g. a CI service), and a fresh
 * database per test file.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chownSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

function binDir(): string {
  try {
    return execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
  } catch {
    const base = '/usr/lib/postgresql';
    const versions = existsSync(base)
      ? readdirSync(base).sort((a, b) => Number(b) - Number(a))
      : [];
    if (!versions[0]) throw new Error('PostgreSQL is not installed (no initdb found)');
    return join(base, versions[0], 'bin');
  }
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

export interface TestPostgres {
  /** Connection URL of the cluster's `postgres` database. */
  url: string;
  stop(): void;
}

/** Start a cluster for a test run (Postgres won't run as root: then it runs as `postgres`). */
export async function startTestPostgres(): Promise<TestPostgres> {
  const provided = process.env.WORKSPACE_TEST_PG_URL;
  if (provided) return { url: provided, stop: () => {} };
  const bin = binDir();
  const dir = mkdtempSync(join(tmpdir(), 'workspace-pg-'));
  const asRoot = userInfo().uid === 0;
  if (asRoot) {
    const id = (flag: string) =>
      Number(execFileSync('id', [flag, 'postgres'], { encoding: 'utf8' }));
    const [uid, gid] = [id('-u'), id('-g')];
    chownSync(dir, uid, gid);
  }
  const run = (cmd: string, args: string[]) => {
    const [file, argv] = asRoot
      ? ['runuser', ['-u', 'postgres', '--', join(bin, cmd), ...args]]
      : [join(bin, cmd), args];
    const result = spawnSync(file as string, argv as string[], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${cmd} failed: ${result.stderr || result.stdout}`);
  };
  const data = join(dir, 'data');
  run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-sync', '-E', 'UTF8']);
  const port = await freePort();
  run('pg_ctl', [
    '-D',
    data,
    '-w',
    '-l',
    join(dir, 'log'),
    '-o',
    `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
    'start',
  ]);
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop: () => {
      try {
        run('pg_ctl', ['-D', data, '-m', 'immediate', 'stop']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** A new, empty database on the cluster; its URL. */
export async function createTestDatabase(clusterUrl: string): Promise<string> {
  const name = `t_${Math.random().toString(36).slice(2, 10)}`;
  const client = new pg.Client({ connectionString: clusterUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  const url = new URL(clusterUrl);
  url.pathname = `/${name}`;
  return url.toString();
}
