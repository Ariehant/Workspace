import * as client from 'openid-client';
import type { Config, OidcProvider } from '../config';

export interface OidcClaims {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/** Sign-in with the configured OpenID Connect providers (authorization code + PKCE). */
export class OidcClients {
  private readonly providers: Map<string, OidcProvider>;
  private readonly discovered = new Map<string, Promise<client.Configuration>>();

  constructor(private readonly config: Pick<Config, 'oidc' | 'oidcAllowInsecure' | 'publicUrl'>) {
    this.providers = new Map(config.oidc.map((p) => [p.id, p]));
  }

  list(): { id: string; name: string }[] {
    return this.config.oidc.map(({ id, name }) => ({ id, name }));
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  redirectUri(id: string): string {
    return `${this.config.publicUrl}/api/auth/oidc/${id}/callback`;
  }

  /** The provider's settings, discovered once (and again after a failure). */
  private configuration(id: string): Promise<client.Configuration> {
    const provider = this.providers.get(id);
    if (!provider) return Promise.reject(new Error(`Unknown provider ${id}`));
    let found = this.discovered.get(id);
    if (!found) {
      found = client.discovery(
        new URL(provider.issuer),
        provider.clientId,
        provider.clientSecret,
        undefined,
        this.config.oidcAllowInsecure ? { execute: [client.allowInsecureRequests] } : undefined,
      );
      found.catch(() => this.discovered.delete(id));
      this.discovered.set(id, found);
    }
    return found;
  }

  /** Where to send the browser, and the secrets to keep until it comes back. */
  async start(
    id: string,
  ): Promise<{ url: string; state: string; verifier: string; nonce: string }> {
    const configuration = await this.configuration(id);
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri(id),
      scope: 'openid email profile',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url: url.href, state, verifier, nonce };
  }

  /** Redeem the code the provider sent back; checks state, nonce, PKCE and the ID token. */
  async finish(
    id: string,
    callbackUrl: URL,
    pending: { state: string; verifier: string; nonce: string },
  ): Promise<OidcClaims> {
    const configuration = await this.configuration(id);
    const tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
      pkceCodeVerifier: pending.verifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims()!;
    const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
    return {
      subject: claims.sub,
      email: str(claims.email),
      emailVerified: claims.email_verified === true,
      name: str(claims.name) ?? str(claims.preferred_username),
    };
  }
}
