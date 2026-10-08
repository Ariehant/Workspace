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
  `
  -- Invites for sign-up when it's invite-only: the code is stored only as a hash.
  CREATE TABLE invites (
    id uuid PRIMARY KEY,
    code_hash bytea NOT NULL UNIQUE,
    email text,
    created_by uuid REFERENCES users ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_by uuid REFERENCES users ON DELETE SET NULL,
    used_at timestamptz
  );

  -- An OIDC sign-in in progress (between leaving for the provider and coming back).
  CREATE TABLE oidc_states (
    state text PRIMARY KEY,
    provider text NOT NULL,
    code_verifier text NOT NULL,
    nonce text NOT NULL,
    client text NOT NULL CHECK (client IN ('web', 'desktop')),
    -- The desktop's loopback port, to send the one-time code to.
    desktop_port int,
    device_name text NOT NULL DEFAULT '',
    -- S256 challenge from the desktop app: only it can exchange the one-time code.
    desktop_challenge text,
    -- An invite to use if this sign-in creates the account.
    invite text,
    expires_at timestamptz NOT NULL
  );

  -- One-time codes the desktop exchanges for a session after signing in in the browser.
  CREATE TABLE auth_codes (
    code_hash bytea PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    device_name text NOT NULL DEFAULT '',
    challenge text NOT NULL,
    expires_at timestamptz NOT NULL
  );
  `,
  `
  -- The search index: derived from the docs (rebuildable), like the desktop's.
  -- kind is null for content that arrived before its page or row is known.
  CREATE TABLE search_index (
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    id text NOT NULL,
    kind text CHECK (kind IN ('page', 'row')),
    database_id text,
    title text NOT NULL DEFAULT '',
    icon text,
    props text NOT NULL DEFAULT '',
    body text NOT NULL DEFAULT '',
    in_trash boolean NOT NULL DEFAULT false,
    updated_at bigint NOT NULL DEFAULT 0,
    -- 'simple': no stemming, so mixed languages and code-ish words match as typed.
    tsv tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', title), 'A') ||
      setweight(to_tsvector('simple', props), 'B') ||
      setweight(to_tsvector('simple', left(body, 500000)), 'C')
    ) STORED,
    PRIMARY KEY (workspace_id, id)
  );
  CREATE INDEX search_index_tsv ON search_index USING gin (tsv);
  CREATE INDEX search_index_db ON search_index (workspace_id, database_id);

  -- How far into each workspace's update log the index is.
  CREATE TABLE search_state (
    workspace_id uuid PRIMARY KEY REFERENCES workspaces ON DELETE CASCADE,
    indexed_seq bigint NOT NULL DEFAULT 0
  );
  `,
  `
  -- The web app's settings (theme, sidebar, tabs...), per user.
  CREATE TABLE user_settings (
    user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    key text NOT NULL,
    value jsonb NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  `,
  `
  -- A small profile picture (a data: URL the client already resized).
  ALTER TABLE users ADD COLUMN avatar text;

  -- Invitations to join a workspace, for one email address. The token is in the link
  -- the invitee gets, and stored only as a hash.
  CREATE TABLE workspace_invites (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    email text NOT NULL,
    role text NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
    token_hash bytea NOT NULL UNIQUE,
    invited_by uuid REFERENCES users ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    accepted_by uuid REFERENCES users ON DELETE SET NULL,
    accepted_at timestamptz,
    revoked_at timestamptz
  );
  CREATE INDEX workspace_invites_workspace ON workspace_invites (workspace_id);

  -- Named sets of a workspace's members, to share pages with (Phase 5 M2).
  CREATE TABLE groups (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, name)
  );

  CREATE TABLE group_members (
    group_id uuid NOT NULL REFERENCES groups ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX group_members_user ON group_members (user_id);
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
