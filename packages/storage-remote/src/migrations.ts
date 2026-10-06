import type pg from 'pg';

/**
 * Schema migrations, applied in order; the index + 1 is the version each one produces.
 * Never edit one that has shipped: add another.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    name text NOT NULL,
    password_hash text,
    is_admin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    disabled_at timestamptz
  );

  CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE,
    kind text NOT NULL CHECK (kind IN ('web', 'desktop')),
    device_name text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
  );
  CREATE INDEX sessions_user ON sessions (user_id);

  -- Sign-in through OIDC providers: (provider, subject) is the provider's account.
  CREATE TABLE identities (
    provider text NOT NULL,
    subject text NOT NULL,
    user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    email text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, subject)
  );

  CREATE TABLE workspaces (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    created_by uuid REFERENCES users ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- The workspace's update log counter (see doc_updates.seq).
    last_seq bigint NOT NULL DEFAULT 0
  );

  CREATE TABLE workspace_members (
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE INDEX workspace_members_user ON workspace_members (user_id);

  -- Every Yjs update of every doc of a workspace, in the order the server stored them.
  -- seq is per workspace and only grows, so devices catch up with "everything after N".
  CREATE TABLE doc_updates (
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    seq bigint NOT NULL,
    doc_id text NOT NULL,
    data bytea NOT NULL,
    device_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, seq)
  );
  CREATE INDEX doc_updates_doc ON doc_updates (workspace_id, doc_id, seq);

  -- Attachments: content-addressed ids (sha256 + extension), like on the desktop.
  CREATE TABLE files (
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    id text NOT NULL,
    name text NOT NULL,
    mime text NOT NULL,
    size bigint NOT NULL,
    uploaded_by uuid REFERENCES users ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id)
  );
  `,
];

/** Bring the schema up to date. Safe with several servers starting at once (a lock). */
export async function migrate(pool: pg.Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7351002)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version int PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`,
    );
    const { rows } = await client.query<{ version: number | null }>(
      'SELECT max(version) AS version FROM schema_migrations',
    );
    const current = rows[0]?.version ?? 0;
    for (let v = current; v < MIGRATIONS.length; v++) {
      await client.query('BEGIN');
      try {
        await client.query(MIGRATIONS[v]!);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v + 1]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return MIGRATIONS.length;
  } finally {
    await client.query('SELECT pg_advisory_unlock(7351002)').catch(() => {});
    client.release();
  }
}
