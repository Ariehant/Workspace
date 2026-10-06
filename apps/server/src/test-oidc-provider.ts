/** A tiny OpenID Connect provider for tests: discovery, authorize, token and JWKS. */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

export interface FakeAccount {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export interface FakeProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Who signs in at the next authorize request. */
  account: FakeAccount;
  /** Follow the authorization URL like a browser would; returns the redirect back. */
  authorize(url: string): Promise<URL>;
  stop(): Promise<void>;
}

export async function startFakeProvider(): Promise<FakeProvider> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    { account: FakeAccount; challenge: string; nonce: string; redirectUri: string }
  >();
  const provider = {
    clientId: 'workspace',
    clientSecret: 'shh',
    account: { sub: 'user-1' } as FakeAccount,
  } as FakeProvider;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, provider.issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: provider.issuer,
        authorization_endpoint: `${provider.issuer}/authorize`,
        token_endpoint: `${provider.issuer}/token`,
        jwks_uri: `${provider.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      if (p.get('client_id') !== provider.clientId || p.get('code_challenge_method') !== 'S256') {
        return json(400, { error: 'invalid_request' });
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, {
        account: provider.account,
        challenge: p.get('code_challenge')!,
        nonce: p.get('nonce')!,
        redirectUri: p.get('redirect_uri')!,
      });
      const back = new URL(p.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state')!);
      back.searchParams.set('iss', provider.issuer);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk));
      req.on('end', () => {
        const body = new URLSearchParams(raw);
        let id = body.get('client_id');
        let secret = body.get('client_secret');
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
        if (basic) {
          [id, secret] = Buffer.from(basic[1]!, 'base64')
            .toString()
            .split(':')
            .map(decodeURIComponent) as [string, string];
        }
        if (id !== provider.clientId || secret !== provider.clientSecret) {
          return json(401, { error: 'invalid_client' });
        }
        const grant = codes.get(body.get('code') ?? '');
        codes.delete(body.get('code') ?? '');
        const verifier = body.get('code_verifier') ?? '';
        if (
          !grant ||
          grant.redirectUri !== body.get('redirect_uri') ||
          createHash('sha256').update(verifier).digest('base64url') !== grant.challenge
        ) {
          return json(400, { error: 'invalid_grant' });
        }
        void new SignJWT({ ...grant.account, nonce: grant.nonce })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(provider.issuer)
          .setAudience(provider.clientId)
          .setSubject(grant.account.sub)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey)
          .then((idToken) =>
            json(200, {
              access_token: randomBytes(16).toString('hex'),
              token_type: 'Bearer',
              expires_in: 300,
              id_token: idToken,
            }),
          );
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  provider.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  provider.authorize = async (url) => {
    const response = await fetch(url, { redirect: 'manual' });
    if (response.status !== 302) throw new Error(`authorize: ${response.status}`);
    return new URL(response.headers.get('location')!);
  };
  provider.stop = () => new Promise((resolve) => server.close(() => resolve()));
  return provider;
}
