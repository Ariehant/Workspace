/**
 * A real CalDAV server for the tests: Radicale (radicale.org), started per test file on a free
 * port with its own storage folder and one user, and stopped afterwards.
 *
 * Needs Radicale installed: `pip install radicale==3.9.2` (CI does this). The Python to run it
 * with is `RADICALE_PYTHON` if set, else `python3`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Radicale {
  /** The server's address (`http://127.0.0.1:<port>`). */
  url: string;
  username: string;
  password: string;
  /** The user's home, where their calendars are (`<url>/<user>/`). */
  home: string;
  /** Make a calendar collection; returns its address. */
  makeCalendar(name: string, options?: { colour?: string; id?: string }): Promise<string>;
  /** PUT an iCalendar object as the user (as another client would). */
  put(calendarUrl: string, file: string, ics: string): Promise<string | null>;
  /** GET an object: its text and ETag, or null if it's gone. */
  get(url: string): Promise<{ ics: string; etag: string | null } | null>;
  /** DELETE an object. */
  remove(url: string): Promise<void>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export async function startRadicale(): Promise<Radicale> {
  const dir = mkdtempSync(join(tmpdir(), 'radicale-'));
  const port = await freePort();
  const username = 'ada';
  const password = 'app-password-1';
  writeFileSync(join(dir, 'users'), `${username}:${password}\n`);
  writeFileSync(
    join(dir, 'config'),
    [
      '[server]',
      `hosts = 127.0.0.1:${port}`,
      '[auth]',
      'type = htpasswd',
      `htpasswd_filename = ${join(dir, 'users')}`,
      'htpasswd_encryption = plain',
      '[rights]',
      'type = owner_only',
      '[storage]',
      `filesystem_folder = ${join(dir, 'collections')}`,
      '[logging]',
      'level = warning',
      '',
    ].join('\n'),
  );
  const python = process.env.RADICALE_PYTHON ?? 'python3';
  const child: ChildProcess = spawn(python, ['-m', 'radicale', '--config', join(dir, 'config')], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  const url = `http://127.0.0.1:${port}`;
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  // Wait until it answers (or it died: Radicale not installed).
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(
        `Radicale didn't start (pip install radicale==3.9.2, or set RADICALE_PYTHON): ${stderr}`,
      );
    try {
      const res = await fetch(`${url}/.web/`);
      if (res.status < 500) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() - started > 15_000) throw new Error(`Radicale didn't answer: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  const request = (method: string, target: string, body?: string, headers = {}) =>
    fetch(target, {
      method,
      headers: { authorization: auth, ...headers },
      ...(body !== undefined && { body }),
    });

  const home = `${url}/${username}/`;
  // The user's home exists once they've been seen: ask for it once.
  await request('PROPFIND', home, undefined, { depth: '0' });

  return {
    url,
    username,
    password,
    home,
    async makeCalendar(name, options = {}) {
      const target = `${home}${options.id ?? name.toLowerCase().replace(/\W+/g, '-')}/`;
      const res = await request(
        'MKCOL',
        target,
        `<?xml version="1.0" encoding="utf-8"?>
<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:I="http://apple.com/ns/ical/">
  <D:set><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname>${name}</D:displayname>
    <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
    ${options.colour ? `<I:calendar-color>${options.colour}</I:calendar-color>` : ''}
  </D:prop></D:set>
</D:mkcol>`,
        { 'content-type': 'application/xml' },
      );
      if (!res.ok) throw new Error(`MKCOL ${target}: ${res.status} ${await res.text()}`);
      return target;
    },
    async put(calendarUrl, file, ics) {
      const res = await request('PUT', `${calendarUrl}${file}`, ics, {
        'content-type': 'text/calendar; charset=utf-8',
      });
      if (!res.ok) throw new Error(`PUT ${file}: ${res.status} ${await res.text()}`);
      return res.headers.get('etag');
    },
    async get(target) {
      const res = await request('GET', target);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET ${target}: ${res.status}`);
      return { ics: await res.text(), etag: res.headers.get('etag') };
    },
    async remove(target) {
      const res = await request('DELETE', target);
      if (!res.ok && res.status !== 404) throw new Error(`DELETE ${target}: ${res.status}`);
    },
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => (child.exitCode !== null ? r(null) : child.once('exit', r)));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
