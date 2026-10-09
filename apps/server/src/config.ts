/** Server settings, read from the environment (see infra/.env.example). */
export interface Config {
  host: string;
  port: number;
  /** The address people reach the server at (for links and OIDC redirects). */
  publicUrl: string;
  databaseUrl: string;
  files:
    | { driver: 'fs'; dir: string }
    | {
        driver: 's3';
        endpoint: string | null;
        region: string;
        bucket: string;
        accessKeyId: string;
        secretAccessKey: string;
        forcePathStyle: boolean;
      };
  /** Largest attachment accepted, in bytes. */
  maxFileBytes: number;
  /** Who can create an account: anyone, people with an invite, or nobody (admin only). */
  signup: 'open' | 'invite' | 'disabled';
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Built web app to serve at `/` (when present). */
  webDir: string | null;
  /** Single sign-on providers (OpenID Connect), shown as "Continue with …". */
  oidc: OidcProvider[];
  /** Allow OIDC providers over plain http (local testing only). */
  oidcAllowInsecure: boolean;
  /** Where invite emails go out; without it, whoever invites copies the link. */
  smtp: { url: string; from: string } | null;
  /**
   * Webhooks (automations, later integrations): by default only to public https
   * addresses. A self-hosted server may allow its own network, and http (development).
   */
  webhooks: { allowPrivate: boolean; allowHttp: boolean };
}

export interface OidcProvider {
  /** Used in URLs: `/api/auth/oidc/<id>/callback` is the redirect URI to register. */
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export class ConfigError extends Error {}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Read and check the configuration; every problem is reported at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const get = (name: string, fallback?: string): string => {
    const value = env[name]?.trim() || fallback;
    if (value === undefined) {
      problems.push(`${name} is required`);
      return '';
    }
    return value;
  };
  const oneOf = <T extends string>(name: string, values: readonly T[], fallback: T): T => {
    const value = (env[name]?.trim() || fallback) as T;
    if (!values.includes(value)) problems.push(`${name} must be one of: ${values.join(', ')}`);
    return value;
  };
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    const value = raw ? Number(raw) : fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}`);
    }
    return value;
  };

  const port = int('PORT', 3000, 1, 65535);
  const publicUrl = get('PUBLIC_URL', `http://localhost:${port}`).replace(/\/+$/, '');
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
  } catch {
    problems.push('PUBLIC_URL must be an http(s) URL');
  }
  const driver = oneOf('FILES_DRIVER', ['fs', 's3'] as const, 'fs');
  const files: Config['files'] =
    driver === 's3'
      ? {
          driver,
          endpoint: env.S3_ENDPOINT?.trim() || null,
          region: get('S3_REGION', 'us-east-1'),
          bucket: get('S3_BUCKET'),
          accessKeyId: get('S3_ACCESS_KEY_ID'),
          secretAccessKey: get('S3_SECRET_ACCESS_KEY'),
          forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
        }
      : { driver, dir: get('FILES_DIR', './data/files') };
  const oidc: OidcProvider[] = [];
  for (const id of (env.OIDC_PROVIDERS ?? '').split(',').map((p) => p.trim().toLowerCase())) {
    if (!id) continue;
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
      problems.push(`OIDC_PROVIDERS: "${id}" must be letters, digits and dashes`);
      continue;
    }
    const prefix = `OIDC_${id.toUpperCase().replaceAll('-', '_')}_`;
    const issuer = get(`${prefix}ISSUER`);
    try {
      if (issuer) new URL(issuer);
    } catch {
      problems.push(`${prefix}ISSUER must be a URL`);
    }
    oidc.push({
      id,
      name: env[`${prefix}NAME`]?.trim() || id.charAt(0).toUpperCase() + id.slice(1),
      issuer,
      clientId: get(`${prefix}CLIENT_ID`),
      clientSecret: get(`${prefix}CLIENT_SECRET`),
    });
  }
  const smtpUrl = env.SMTP_URL?.trim() || null;
  if (smtpUrl && !/^smtps?:\/\//.test(smtpUrl)) {
    problems.push('SMTP_URL must start with smtp:// or smtps://');
  }
  const smtpFrom = env.SMTP_FROM?.trim() || null;
  if (smtpUrl && !smtpFrom) problems.push('SMTP_FROM is required with SMTP_URL');
  const config: Config = {
    host: get('HOST', '0.0.0.0'),
    port,
    publicUrl,
    databaseUrl: get('DATABASE_URL'),
    files,
    maxFileBytes: int('MAX_FILE_MB', 512, 1, 10_240) * 1024 * 1024,
    signup: oneOf('SIGNUP', ['open', 'invite', 'disabled'] as const, 'invite'),
    logLevel: oneOf('LOG_LEVEL', LOG_LEVELS, 'info'),
    webDir: env.WEB_DIR?.trim() || null,
    oidc,
    oidcAllowInsecure: env.OIDC_ALLOW_INSECURE === 'true',
    smtp: smtpUrl && smtpFrom ? { url: smtpUrl, from: smtpFrom } : null,
    webhooks: {
      allowPrivate: env.WEBHOOK_ALLOW_PRIVATE === 'true',
      allowHttp: env.WEBHOOK_ALLOW_HTTP === 'true',
    },
  };
  if (problems.length) throw new ConfigError(`Invalid configuration:\n- ${problems.join('\n- ')}`);
  return config;
}
