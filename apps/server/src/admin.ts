/**
 * `workspace-admin`: maintenance from the command line (in the container:
 * `docker compose exec server node dist/admin.js <command>`).
 */
import { PgStore } from '@workspace/storage-remote';
import { loadConfig } from './config';

const USAGE = `Usage: workspace-admin <command>

Commands:
  migrate                  Apply database migrations
  compact [threshold]      Merge the update logs of docs with more than threshold (default 200) updates
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  const config = loadConfig();
  const store = new PgStore(config.databaseUrl, { max: 2 });
  try {
    if (command === 'migrate') {
      console.log(`Schema at version ${await store.migrate()}`);
      return 0;
    }
    if (command === 'compact') {
      const threshold = Number(args[0] ?? 200);
      const { rows } = await store.pool.query<{ id: string }>('SELECT id FROM workspaces');
      let compacted = 0;
      for (const { id } of rows) {
        for (const doc of await store.docsToCompact(id, threshold)) {
          if ((await store.compactDoc(id, doc)) !== null) compacted++;
        }
      }
      console.log(`Compacted ${compacted} docs`);
      return 0;
    }
    process.stderr.write(USAGE);
    return 1;
  } finally {
    await store.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
