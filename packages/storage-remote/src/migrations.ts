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
  `
  -- Scopes: sets of pages with the same access (a teamspace, someone's private pages, a
  -- shared page). Each has a tree doc with its pages' titles and order.
  CREATE TABLE scopes (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('teamspace', 'private', 'shared')),
    name text NOT NULL DEFAULT '',
    tree_doc text NOT NULL,
    -- A shared page's scope: the scope it was split from (its access is inherited).
    parent_id uuid REFERENCES scopes ON DELETE SET NULL,
    inherit boolean NOT NULL DEFAULT true,
    -- Whose private pages these are.
    owner_id uuid REFERENCES users ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, tree_doc)
  );
  CREATE INDEX scopes_workspace ON scopes (workspace_id);

  -- Who gets what in a scope: 'user:<id>', 'group:<id>' or 'workspace' (every member).
  CREATE TABLE scope_access (
    scope_id uuid NOT NULL REFERENCES scopes ON DELETE CASCADE,
    principal text NOT NULL,
    role text NOT NULL CHECK (role IN ('full', 'edit', 'comment', 'view')),
    PRIMARY KEY (scope_id, principal)
  );

  -- Which scope each doc is in: access is decided here, never by what docs contain.
  CREATE TABLE doc_scopes (
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    doc_id text NOT NULL,
    scope_id uuid NOT NULL REFERENCES scopes ON DELETE CASCADE,
    PRIMARY KEY (workspace_id, doc_id)
  );
  CREATE INDEX doc_scopes_scope ON doc_scopes (scope_id);

  -- Docs moved between scopes, at a point of the log (so devices that were away learn
  -- about the docs they gained or lost).
  CREATE TABLE doc_moves (
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    seq bigint NOT NULL,
    doc_id text NOT NULL,
    from_scope uuid,
    to_scope uuid
  );
  CREATE INDEX doc_moves_seq ON doc_moves (workspace_id, seq);

  ALTER TABLE doc_updates ADD COLUMN user_id uuid;
  -- Where a doc goes when a client doesn't say (and where the workspace doc lives).
  ALTER TABLE workspaces ADD COLUMN default_scope_id uuid REFERENCES scopes ON DELETE SET NULL;

  -- Existing workspaces: their pages become their owner's private pages (inviting
  -- someone shows them nothing until the owner shares), with every doc placed there.
  INSERT INTO scopes (id, workspace_id, kind, name, tree_doc, owner_id)
  SELECT gen_random_uuid(), w.id, 'private', 'Private', 'workspace',
    (SELECT m.user_id FROM workspace_members m
     WHERE m.workspace_id = w.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1)
  FROM workspaces w;
  INSERT INTO scope_access (scope_id, principal, role)
  SELECT id, 'user:' || owner_id, 'full' FROM scopes WHERE owner_id IS NOT NULL;
  UPDATE workspaces w SET default_scope_id = s.id FROM scopes s WHERE s.workspace_id = w.id;
  INSERT INTO doc_scopes (workspace_id, doc_id, scope_id)
  SELECT DISTINCT u.workspace_id, u.doc_id, w.default_scope_id
  FROM doc_updates u JOIN workspaces w ON w.id = u.workspace_id
  WHERE u.doc_id <> 'members';

  -- Search results are filtered by scope: each page and row is indexed with its scope.
  ALTER TABLE search_index ADD COLUMN scope_id uuid;
  UPDATE search_index s SET scope_id = w.default_scope_id FROM workspaces w
  WHERE w.id = s.workspace_id;
  `,

  // 7: teamspace details, and private pages for every member.
  `
  -- A teamspace's icon and description; who can find it (open: anyone in the workspace
  -- can join; closed: listed, joined by being added; private: only its members see it);
  -- and the role joining it gives.
  ALTER TABLE scopes ADD COLUMN icon text;
  ALTER TABLE scopes ADD COLUMN description text NOT NULL DEFAULT '';
  ALTER TABLE scopes ADD COLUMN visibility text NOT NULL DEFAULT 'open'
    CHECK (visibility IN ('open', 'closed', 'private'));
  ALTER TABLE scopes ADD COLUMN join_role text NOT NULL DEFAULT 'edit'
    CHECK (join_role IN ('full', 'edit', 'comment', 'view'));

  -- Every member but guests has private pages: make the missing ones (with their tree).
  CREATE TEMP TABLE new_private ON COMMIT DROP AS
  SELECT gen_random_uuid() AS id, m.workspace_id, m.user_id
  FROM workspace_members m
  WHERE m.role <> 'guest' AND NOT EXISTS (
    SELECT 1 FROM scopes s
    WHERE s.workspace_id = m.workspace_id AND s.kind = 'private' AND s.owner_id = m.user_id
  );
  INSERT INTO scopes (id, workspace_id, kind, name, tree_doc, owner_id, inherit)
  SELECT id, workspace_id, 'private', 'Private', 'tree:' || id, user_id, false FROM new_private;
  INSERT INTO scope_access (scope_id, principal, role)
  SELECT id, 'user:' || user_id, 'full' FROM new_private;
  INSERT INTO doc_scopes (workspace_id, doc_id, scope_id)
  SELECT workspace_id, 'tree:' || id, id FROM new_private;
  `,
  `
  -- Phase 5 M6: notifications. The time zone reminders are computed in (IANA name).
  ALTER TABLE users ADD COLUMN time_zone text;

  -- Each person's notifications in a workspace. doc_id is the doc that has to stay
  -- readable for it to be shown; key makes a notification happen once.
  CREATE TABLE notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('mention', 'comment', 'reply', 'reminder', 'access')),
    page_id text,
    title text NOT NULL DEFAULT '',
    block_id text,
    thread_id text,
    actor_id uuid REFERENCES users ON DELETE SET NULL,
    text text NOT NULL DEFAULT '',
    doc_id text,
    key text,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz,
    archived_at timestamptz
  );
  CREATE INDEX notifications_user ON notifications (user_id, workspace_id, created_at DESC);
  CREATE UNIQUE INDEX notifications_once ON notifications (user_id, workspace_id, key)
    WHERE key IS NOT NULL;

  -- Who follows a page (replies and new comments on it). following = false records an
  -- unfollow, so editing the page again doesn't follow it again.
  CREATE TABLE page_follows (
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    page_id text NOT NULL,
    user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    following boolean NOT NULL,
    PRIMARY KEY (workspace_id, page_id, user_id)
  );

  -- Reminders found in docs (@remind mentions, date properties), each for one person.
  CREATE TABLE reminders (
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    doc_id text NOT NULL,
    key text NOT NULL,
    user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    page_id text NOT NULL,
    block_id text NOT NULL,
    fire_at timestamptz NOT NULL,
    text text NOT NULL DEFAULT '',
    fired_at timestamptz,
    PRIMARY KEY (workspace_id, doc_id, key)
  );
  CREATE INDEX reminders_due ON reminders (fire_at) WHERE fired_at IS NULL;

  -- How far into each workspace's log a follower of it (the notifier) has read. Existing
  -- workspaces start now: history doesn't notify anyone.
  CREATE TABLE log_followers (
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    name text NOT NULL,
    seq bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, name)
  );
  INSERT INTO log_followers (workspace_id, name, seq) SELECT id, 'notify', last_seq FROM workspaces;
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
