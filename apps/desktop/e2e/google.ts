/**
 * A stand-in for Google (Phase 8 N9 tests): the sign-in page (which answers at once), the token
 * endpoint (checking PKCE, the client and refresh tokens), revocation, Drive's `files.get`, and
 * a Picker script that picks `picks` as soon as it's shown. The app is pointed at it with
 * `googleEnv(fake)`.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeFile {
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  trashed?: boolean;
}

export interface FakeGoogle {
  origin: string;
  clientId: string;
  clientSecret: string;
  email: string;
  files: Map<string, FakeFile>;
  /** What the Picker picks next (empty: cancelled). */
  picks: string[];
  /** What the Picker was given (its token, key and app id). */
  pickerSeen: Record<string, string>[];
  grants: string[];
  revoked: string[];
  close(): Promise<void>;
}

const read = async (req: IncomingMessage) => {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return body;
};

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

const PICKER_JS = (origin: string) => `
window.gapi = { load: (name, options) => setTimeout(options.callback) };
const Response = { ACTION: 'action', DOCUMENTS: 'docs' };
const Action = { PICKED: 'picked', CANCEL: 'cancel' };
class DocsView {
  setIncludeFolders() { return this; }
  setSelectFolderEnabled() { return this; }
}
class PickerBuilder {
  constructor() { this.seen = {}; }
  addView() { return this; }
  enableFeature() { return this; }
  setOAuthToken(t) { this.seen.token = t; return this; }
  setDeveloperKey(k) { this.seen.apiKey = k; return this; }
  setAppId(a) { this.seen.appId = a; return this; }
  setOrigin(o) { this.seen.origin = o; return this; }
  setTitle() { return this; }
  setCallback(cb) { this.cb = cb; return this; }
  build() {
    const { cb, seen } = this;
    return {
      async setVisible() {
        await fetch('${origin}/picker-seen', { method: 'POST', mode: 'no-cors', body: JSON.stringify(seen) });
        const picks = await (await fetch('${origin}/picks')).json();
        cb(picks.length
          ? { action: Action.PICKED, docs: picks.map((id) => ({ id, name: 'from the picker' })) }
          : { action: Action.CANCEL });
      },
    };
  }
}
window.google = { picker: { Response, Action, DocsView, PickerBuilder, ViewId: { DOCS: 'all' },
  Feature: { MULTISELECT_ENABLED: 'multi' }, Document: { ID: 'id' } } };
`;

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const access = new Set<string>();
  let n = 0;
  const fake = {
    clientId: 'test-client.apps.googleusercontent.com',
    clientSecret: 'not-so-secret',
    email: 'ada@lab.io',
    files: new Map<string, FakeFile>(),
    picks: [] as string[],
    pickerSeen: [] as Record<string, string>[],
    grants: [] as string[],
    revoked: [] as string[],
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const json = (status: number, body: unknown) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
        });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/auth') {
        const q = url.searchParams;
        const redirect = q.get('redirect_uri') ?? '';
        const ok =
          q.get('client_id') === fake.clientId &&
          q.get('code_challenge_method') === 'S256' &&
          q.get('scope')?.includes('auth/drive.file') &&
          /^http:\/\/127\.0\.0\.1:\d+\/oauth$/.test(redirect);
        if (!ok) return json(400, { error: 'invalid_request' });
        const code = `code-${++n}`;
        codes.set(code, { challenge: q.get('code_challenge') ?? '', redirect });
        res.writeHead(302, { location: `${redirect}?code=${code}&state=${q.get('state')}` });
        return res.end();
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await read(req));
        if (form.get('client_id') !== fake.clientId) return json(401, { error: 'invalid_client' });
        if (form.get('client_secret') !== fake.clientSecret) {
          return json(401, { error: 'invalid_client' });
        }
        fake.grants.push(form.get('grant_type') ?? '');
        const token = `at-${++n}`;
        if (form.get('grant_type') === 'authorization_code') {
          const issued = codes.get(form.get('code') ?? '');
          codes.delete(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          const challenge = b64url(createHash('sha256').update(verifier).digest());
          if (
            !issued ||
            issued.challenge !== challenge ||
            issued.redirect !== form.get('redirect_uri')
          ) {
            return json(400, { error: 'invalid_grant' });
          }
          access.add(token);
          const idToken = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ email: fake.email }))}.x`;
          return json(200, {
            access_token: token,
            expires_in: 3600,
            refresh_token: 'rt-1',
            id_token: idToken,
          });
        }
        if (form.get('grant_type') === 'refresh_token') {
          if (form.get('refresh_token') !== 'rt-1' || fake.revoked.includes('rt-1')) {
            return json(400, { error: 'invalid_grant' });
          }
          access.add(token);
          return json(200, { access_token: token, expires_in: 3600 });
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      if (url.pathname === '/revoke' && req.method === 'POST') {
        fake.revoked.push(new URLSearchParams(await read(req)).get('token') ?? '');
        for (const token of access) access.delete(token);
        return json(200, {});
      }
      const file = /^\/drive\/v3\/files\/([\w-]+)$/.exec(url.pathname);
      if (file) {
        const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (!access.has(token)) return json(401, { error: { code: 401 } });
        const found = fake.files.get(file[1]!);
        if (!found) return json(404, { error: { code: 404 } });
        return json(200, { id: file[1], ...found });
      }
      if (url.pathname === '/picker.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(PICKER_JS(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      }
      if (url.pathname === '/picker-seen') {
        fake.pickerSeen.push(JSON.parse(await read(req)) as Record<string, string>);
        return json(200, {});
      }
      if (url.pathname === '/picks') return json(200, fake.picks);
      json(404, { error: 'not found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, {
    origin,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

/** The environment that points the app at the fake. */
export function googleEnv(fake: FakeGoogle): Record<string, string> {
  return {
    WORKSPACE_GOOGLE_AUTH_URL: `${fake.origin}/auth`,
    WORKSPACE_GOOGLE_TOKEN_URL: `${fake.origin}/token`,
    WORKSPACE_GOOGLE_REVOKE_URL: `${fake.origin}/revoke`,
    WORKSPACE_GOOGLE_API_URL: fake.origin,
    WORKSPACE_GOOGLE_PICKER_JS: `${fake.origin}/picker.js`,
  };
}
