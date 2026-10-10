import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface User {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  /** A small profile picture as a `data:` URL, or null. */
  avatar: string | null;
  createdAt: Date;
  disabledAt: Date | null;
}

export interface UserWithPassword extends User {
  passwordHash: string | null;
}

export type SessionKind = 'web' | 'desktop';

/** Emails about unread notifications: mentions soon after, a daily digest, or none. */
export type EmailDigest = 'mentions' | 'daily' | 'never';

export interface Session {
  id: string;
  userId: string;
  kind: SessionKind;
  deviceName: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface PendingOidc {
  state: string;
  provider: string;
  codeVerifier: string;
  nonce: string;
  client: SessionKind;
  desktopPort: number | null;
  deviceName: string;
  /** The desktop's PKCE (S256) challenge for the one-time code. */
  desktopChallenge: string | null;
  invite: string | null;
}

/** Secrets (session tokens, invite and one-time codes) are only stored as hashes. */
export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest();

type UserRow = {
  id: string;
  email: string;
  name: string;
  is_admin: boolean;
  avatar: string | null;
  created_at: Date;
  disabled_at: Date | null;
  password_hash: string | null;
};
const toUser = (r: UserRow): UserWithPassword => ({
  id: r.id,
  email: r.email,
  name: r.name,
  isAdmin: r.is_admin,
  avatar: r.avatar ?? null,
  createdAt: r.created_at,
  disabledAt: r.disabled_at,
  passwordHash: r.password_hash,
});
const withoutPassword = ({ passwordHash: _, ...user }: UserWithPassword): User => user;

type SessionRow = {
  id: string;
  user_id: string;
  kind: SessionKind;
  device_name: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
};
const toSession = (r: SessionRow): Session => ({
  id: r.id,
  userId: r.user_id,
  kind: r.kind,
  deviceName: r.device_name,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  expiresAt: r.expires_at,
});

/** Emails compare case-insensitively: they're stored lower-cased and trimmed. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Users, sessions, OIDC identities, invites and sign-in state. */
export class Accounts {
  constructor(private readonly pool: pg.Pool) {}

  // --- Users ---------------------------------------------------------------------------

  async countUsers(): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
    return rows[0]!.n;
  }

  /** Create a user; the very first one is the admin. Null if the email is taken. */
  async createUser(input: {
    email: string;
    name: string;
    passwordHash: string | null;
  }): Promise<User | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize sign-ups so two people racing on a fresh server can't both become admin.
      await client.query('SELECT pg_advisory_xact_lock(7351003)');
      const { rows } = await client.query<UserRow>(
        `INSERT INTO users (id, email, name, password_hash, is_admin)
         VALUES ($1, $2, $3, $4, NOT EXISTS (SELECT 1 FROM users))
         ON CONFLICT (email) DO NOTHING RETURNING *`,
        [randomUUID(), normalizeEmail(input.email), input.name.trim(), input.passwordHash],
      );
      await client.query('COMMIT');
      return rows[0] ? withoutPassword(toUser(rows[0])) : null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async userByEmail(email: string): Promise<UserWithPassword | null> {
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [
      normalizeEmail(email),
    ]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async userById(id: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? withoutPassword(toUser(rows[0])) : null;
  }

  async listUsers(): Promise<User[]> {
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users ORDER BY created_at');
    return rows.map((r) => withoutPassword(toUser(r)));
  }

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    await this.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      userId,
      passwordHash,
    ]);
  }

  async setAdmin(userId: string, isAdmin: boolean): Promise<void> {
    await this.pool.query('UPDATE users SET is_admin = $2 WHERE id = $1', [userId, isAdmin]);
  }

  /** Remove an account (and its sessions and identities). */
  async deleteUser(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }

  async setName(userId: string, name: string): Promise<void> {
    await this.pool.query('UPDATE users SET name = $2 WHERE id = $1', [userId, name.trim()]);
  }

  /** The IANA time zone the person's reminders are computed in (null: UTC). */
  async setTimeZone(userId: string, timeZone: string | null): Promise<void> {
    await this.pool.query('UPDATE users SET time_zone = $2 WHERE id = $1', [userId, timeZone]);
  }

  async timeZones(userIds: readonly string[]): Promise<Map<string, string>> {
    const { rows } = await this.pool.query<{ id: string; time_zone: string | null }>(
      'SELECT id, time_zone FROM users WHERE id = ANY($1::uuid[])',
      [userIds],
    );
    return new Map(rows.map((r) => [r.id, r.time_zone ?? 'UTC']));
  }

  async setAvatar(userId: string, avatar: string | null): Promise<void> {
    await this.pool.query('UPDATE users SET avatar = $2 WHERE id = $1', [userId, avatar]);
  }

  /** Disable (or re-enable) an account; disabling also ends its sessions. */
  async setDisabled(userId: string, disabled: boolean): Promise<void> {
    await this.pool.query(
      'UPDATE users SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1',
      [userId, disabled],
    );
    if (disabled) await this.revokeAllSessions(userId);
  }

  // --- Sessions --------------------------------------------------------------------------

  async createSession(input: {
    userId: string;
    token: string;
    kind: SessionKind;
    deviceName: string;
    ttlMs: number;
  }): Promise<Session> {
    const { rows } = await this.pool.query<SessionRow>(
      `INSERT INTO sessions (id, user_id, token_hash, kind, device_name, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6::bigint * interval '1 millisecond')) RETURNING *`,
      [
        randomUUID(),
        input.userId,
        hashSecret(input.token),
        input.kind,
        input.deviceName.slice(0, 100),
        input.ttlMs,
      ],
    );
    return toSession(rows[0]!);
  }

  /** The live session and user for a token (not expired, revoked or disabled). */
  async sessionByToken(token: string): Promise<{ session: Session; user: User } | null> {
    const { rows } = await this.pool.query<SessionRow & { u: UserRow }>(
      `SELECT s.*, row_to_json(u) AS u FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
         AND u.disabled_at IS NULL AND u.kind = 'person'`,
      [hashSecret(token)],
    );
    const row = rows[0];
    if (!row) return null;
    const u = row.u;
    return {
      session: toSession(row),
      user: withoutPassword(
        toUser({ ...u, created_at: new Date(u.created_at), disabled_at: null }),
      ),
    };
  }

  /** Note the session was used (and slide its expiry for sliding sessions). */
  async touchSession(id: string, slideMs?: number): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET last_seen_at = now(),
         expires_at = CASE WHEN $2::bigint IS NULL THEN expires_at
                           ELSE greatest(expires_at, now() + ($2::bigint * interval '1 millisecond')) END
       WHERE id = $1`,
      [id, slideMs ?? null],
    );
  }

  async listSessions(userId: string): Promise<Session[]> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT * FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
       ORDER BY last_seen_at DESC`,
      [userId],
    );
    return rows.map(toSession);
  }

  /** End one of a user's sessions; false if it isn't theirs (or already ended). */
  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [sessionId, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  async revokeAllSessions(userId: string, except?: string): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2',
      [userId, except ?? null],
    );
  }

  // --- OIDC identities -------------------------------------------------------------------

  async userByIdentity(provider: string, subject: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id
       WHERE i.provider = $1 AND i.subject = $2`,
      [provider, subject],
    );
    return rows[0] ? withoutPassword(toUser(rows[0])) : null;
  }

  async linkIdentity(provider: string, subject: string, userId: string, email: string | null) {
    await this.pool.query(
      `INSERT INTO identities (provider, subject, user_id, email) VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, subject) DO NOTHING`,
      [provider, subject, userId, email],
    );
  }

  // --- Invites -----------------------------------------------------------------------------

  async createInvite(input: {
    code: string;
    email: string | null;
    createdBy: string | null;
    ttlMs: number;
  }): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO invites (id, code_hash, email, created_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5::bigint * interval '1 millisecond'))`,
      [
        id,
        hashSecret(input.code),
        input.email ? normalizeEmail(input.email) : null,
        input.createdBy,
        input.ttlMs,
      ],
    );
    return id;
  }

  /** Use an invite for `email`: true if it was valid (unused, unexpired, for this email). */
  async consumeInvite(code: string, email: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE invites SET used_by = $3, used_at = now()
       WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
         AND (email IS NULL OR email = $2)`,
      [hashSecret(code), normalizeEmail(email), userId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Whether an invite would be accepted (checked before creating the account). */
  async inviteValid(code: string, email: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM invites WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
         AND (email IS NULL OR email = $2)`,
      [hashSecret(code), normalizeEmail(email)],
    );
    return rows.length > 0;
  }

  // --- OIDC sign-ins in progress and desktop codes ---------------------------------------

  async putOidcState(pending: PendingOidc, ttlMs: number): Promise<void> {
    await this.pool.query('DELETE FROM oidc_states WHERE expires_at < now()');
    await this.pool.query(
      `INSERT INTO oidc_states (state, provider, code_verifier, nonce, client, desktop_port,
         device_name, desktop_challenge, invite, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + ($10::bigint * interval '1 millisecond'))`,
      [
        pending.state,
        pending.provider,
        pending.codeVerifier,
        pending.nonce,
        pending.client,
        pending.desktopPort,
        pending.deviceName,
        pending.desktopChallenge,
        pending.invite,
        ttlMs,
      ],
    );
  }

  /** The pending sign-in for `state`, removed so it can be used only once. */
  async takeOidcState(state: string): Promise<PendingOidc | null> {
    const { rows } = await this.pool.query<{
      state: string;
      provider: string;
      code_verifier: string;
      nonce: string;
      client: SessionKind;
      desktop_port: number | null;
      device_name: string;
      desktop_challenge: string | null;
      invite: string | null;
    }>('DELETE FROM oidc_states WHERE state = $1 AND expires_at > now() RETURNING *', [state]);
    const r = rows[0];
    return r
      ? {
          state: r.state,
          provider: r.provider,
          codeVerifier: r.code_verifier,
          nonce: r.nonce,
          client: r.client,
          desktopPort: r.desktop_port,
          deviceName: r.device_name,
          desktopChallenge: r.desktop_challenge,
          invite: r.invite,
        }
      : null;
  }

  async putAuthCode(input: {
    code: string;
    userId: string;
    deviceName: string;
    challenge: string;
    ttlMs: number;
  }): Promise<void> {
    await this.pool.query('DELETE FROM auth_codes WHERE expires_at < now()');
    await this.pool.query(
      `INSERT INTO auth_codes (code_hash, user_id, device_name, challenge, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5::bigint * interval '1 millisecond'))`,
      [hashSecret(input.code), input.userId, input.deviceName, input.challenge, input.ttlMs],
    );
  }

  /** What a one-time code was made for; the code is used up either way. */
  async takeAuthCode(
    code: string,
  ): Promise<{ userId: string; deviceName: string; challenge: string } | null> {
    const { rows } = await this.pool.query<{
      user_id: string;
      device_name: string;
      challenge: string;
    }>(
      `DELETE FROM auth_codes WHERE code_hash = $1 AND expires_at > now()
       RETURNING user_id, device_name, challenge`,
      [hashSecret(code)],
    );
    const r = rows[0];
    return r ? { userId: r.user_id, deviceName: r.device_name, challenge: r.challenge } : null;
  }

  // --- Email (Phase 6 M7) -----------------------------------------------------------------

  /** When to email someone about unread notifications, and their unsubscribe token. */
  async emailPrefs(
    userId: string,
  ): Promise<{ digest: EmailDigest; token: string; email: string; name: string } | null> {
    const { rows } = await this.pool.query<{
      email_digest: EmailDigest;
      unsubscribe_token: string;
      email: string;
      name: string;
    }>(
      `SELECT email_digest, unsubscribe_token, email, name FROM users
       WHERE id = $1 AND kind = 'person' AND disabled_at IS NULL`,
      [userId],
    );
    const r = rows[0];
    return r
      ? { digest: r.email_digest, token: r.unsubscribe_token, email: r.email, name: r.name }
      : null;
  }

  async setEmailDigest(userId: string, digest: EmailDigest): Promise<void> {
    await this.pool.query('UPDATE users SET email_digest = $2 WHERE id = $1', [userId, digest]);
  }

  /** One-click unsubscribe: no more emails, if the token is the person's. */
  async unsubscribe(userId: string, token: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE users SET email_digest = 'never' WHERE id = $1 AND unsubscribe_token = $2`,
      [userId, token],
    );
    return (rowCount ?? 0) > 0;
  }

  /** People's names, by id. */
  async names(userIds: readonly string[]): Promise<Map<string, string>> {
    const { rows } = await this.pool.query<{ id: string; name: string }>(
      'SELECT id, name FROM users WHERE id = ANY($1::uuid[])',
      [userIds],
    );
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  // --- Settings (the web app's, per user) -----------------------------------------------

  async settings(userId: string): Promise<Record<string, unknown>> {
    const { rows } = await this.pool.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM user_settings WHERE user_id = $1',
      [userId],
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async setSetting(userId: string, key: string, value: unknown): Promise<void> {
    if (value === null || value === undefined) {
      await this.pool.query('DELETE FROM user_settings WHERE user_id = $1 AND key = $2', [
        userId,
        key,
      ]);
      return;
    }
    await this.pool.query(
      `INSERT INTO user_settings (user_id, key, value) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
      [userId, key, JSON.stringify(value)],
    );
  }

  async settingCount(userId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM user_settings WHERE user_id = $1',
      [userId],
    );
    return rows[0]!.n;
  }
}
