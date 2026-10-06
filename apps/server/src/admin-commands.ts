import { randomBytes } from 'node:crypto';
import type { PgStore } from '@workspace/storage-remote';
import { hashPassword, randomToken } from './auth/passwords';

export const USAGE = `Usage: workspace-admin <command>

Commands:
  migrate                         Apply database migrations
  compact [threshold]             Merge the update logs of docs with more than threshold
                                  (default 200) updates
  create-user <email> [name] [--admin]
                                  Create an account; prints its generated password
  reset-password <email>          Set a new generated password and sign out everywhere
  create-invite [email] [--days N]
                                  Print an invite code (for anyone, or only that email;
                                  valid 7 days unless --days)
  list-users                      List accounts
  disable-user <email>            Disable an account and sign it out everywhere
  enable-user <email>             Re-enable an account
  make-admin <email>              Make an account a server admin
  list-workspaces                 List workspaces with their members and sizes
`;

export interface AdminIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const DAY = 24 * 3_600_000;
const newPassword = () => randomBytes(12).toString('base64url');

/** Split `--flag value` / `--flag` options from positional arguments. */
function parse(args: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const next = args[i + 1];
      if (arg === '--days' && next !== undefined) {
        flags.set(arg, next);
        i++;
      } else flags.set(arg, true);
    } else positional.push(arg);
  }
  return { positional, flags };
}

/** Run one command; returns the exit code. */
export async function runAdmin(store: PgStore, argv: string[], io: AdminIo): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, flags } = parse(rest);
  const { accounts } = store;
  const userNamed = async (email: string | undefined) => {
    if (!email) {
      io.err('An email is required.');
      return null;
    }
    const user = await accounts.userByEmail(email);
    if (!user) io.err(`No account for ${email}.`);
    return user;
  };

  switch (command) {
    case 'migrate':
      io.out(`Schema at version ${await store.migrate()}`);
      return 0;

    case 'compact': {
      const threshold = Number(positional[0] ?? 200);
      const { rows } = await store.pool.query<{ id: string }>('SELECT id FROM workspaces');
      let compacted = 0;
      for (const { id } of rows) {
        for (const doc of await store.docsToCompact(id, threshold)) {
          if ((await store.compactDoc(id, doc)) !== null) compacted++;
        }
      }
      io.out(`Compacted ${compacted} docs`);
      return 0;
    }

    case 'create-user': {
      const [email, ...name] = positional;
      if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
        io.err('Usage: create-user <email> [name] [--admin]');
        return 1;
      }
      const password = newPassword();
      const user = await accounts.createUser({
        email,
        name: name.join(' ') || email.split('@')[0]!,
        passwordHash: await hashPassword(password),
      });
      if (!user) {
        io.err(`There is already an account for ${email}.`);
        return 1;
      }
      if (flags.has('--admin') && !user.isAdmin) await accounts.setAdmin(user.id, true);
      io.out(`Created ${user.email}${flags.has('--admin') || user.isAdmin ? ' (admin)' : ''}`);
      io.out(`Password: ${password}`);
      return 0;
    }

    case 'reset-password': {
      const user = await userNamed(positional[0]);
      if (!user) return 1;
      const password = newPassword();
      await accounts.setPassword(user.id, await hashPassword(password));
      await accounts.revokeAllSessions(user.id);
      io.out(`New password for ${user.email}: ${password}`);
      return 0;
    }

    case 'create-invite': {
      const days = Number(flags.get('--days') ?? 7);
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        io.err('--days must be from 1 to 90.');
        return 1;
      }
      const code = randomToken();
      await accounts.createInvite({
        code,
        email: positional[0] ?? null,
        createdBy: null,
        ttlMs: days * DAY,
      });
      io.out(`Invite code (valid ${days} days${positional[0] ? `, for ${positional[0]}` : ''}):`);
      io.out(code);
      return 0;
    }

    case 'list-users': {
      for (const u of await accounts.listUsers()) {
        const tags = [u.isAdmin && 'admin', u.disabledAt && 'disabled'].filter(Boolean);
        io.out(`${u.email}\t${u.name}${tags.length ? `\t(${tags.join(', ')})` : ''}`);
      }
      return 0;
    }

    case 'disable-user':
    case 'enable-user': {
      const user = await userNamed(positional[0]);
      if (!user) return 1;
      await accounts.setDisabled(user.id, command === 'disable-user');
      io.out(`${command === 'disable-user' ? 'Disabled' : 'Enabled'} ${user.email}`);
      return 0;
    }

    case 'make-admin': {
      const user = await userNamed(positional[0]);
      if (!user) return 1;
      await accounts.setAdmin(user.id, true);
      io.out(`${user.email} is now an admin`);
      return 0;
    }

    case 'list-workspaces': {
      const { rows } = await store.pool.query<{
        id: string;
        name: string;
        members: number;
        last_seq: number;
        bytes: string;
      }>(
        `SELECT w.id, w.name, w.last_seq,
           (SELECT count(*)::int FROM workspace_members m WHERE m.workspace_id = w.id) AS members,
           (SELECT coalesce(sum(size), 0)::text FROM files f WHERE f.workspace_id = w.id) AS bytes
         FROM workspaces w ORDER BY w.created_at`,
      );
      for (const r of rows) {
        const mb = (Number(r.bytes) / 1024 / 1024).toFixed(1);
        io.out(`${r.id}\t${r.name}\t${r.members} members\t${r.last_seq} updates\t${mb} MB`);
      }
      return 0;
    }

    default:
      io.err(USAGE);
      return 1;
  }
}
