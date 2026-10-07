/**
 * Single sign-on from the desktop (RFC 8252): the system browser signs in with the
 * provider, and the server sends it back to a one-off loopback server here with a
 * one-time code, which only this app can exchange (it holds the PKCE verifier).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerApi } from './api';
import { ApiError } from './api';

const TIMEOUT_MS = 5 * 60_000;

const page = (title: string, message: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem">` +
  `<h1 style="font-size:1.4rem">${title}</h1><p>${message}</p>`;

export async function signInWithBrowser(
  api: ServerApi,
  provider: string,
  deviceName: string,
  openExternal: (url: string) => Promise<void>,
  invite?: string,
) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      });
      if (code) {
        response.end(page('Signed in', 'You can close this tab and go back to Workspace.'));
        finish(null, code);
      } else {
        response.end(page('Could not sign in', 'Go back to Workspace to try again.'));
        finish(new ApiError(403, 'sso_failed', error ?? 'Sign-in failed.'));
      }
    });
    const timer = setTimeout(
      () => finish(new ApiError(0, 'timeout', 'The sign-in in the browser took too long.')),
      TIMEOUT_MS,
    );
    let done = false;
    function finish(error: Error | null, value?: string) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(value!);
    }
    server.on('error', (error) => finish(error));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const query = new URLSearchParams({
        client: 'desktop',
        port: String(port),
        challenge,
        device: deviceName,
        ...(invite ? { invite } : {}),
      });
      openExternal(
        `${api.baseUrl}/api/auth/oidc/${encodeURIComponent(provider)}/start?${query}`,
      ).catch((error: unknown) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );
    });
  });
  return api.exchange(code, verifier, deviceName);
}
