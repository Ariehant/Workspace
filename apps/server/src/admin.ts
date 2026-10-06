/**
 * `workspace-admin`: maintenance from the command line (in the container:
 * `docker compose exec server workspace-admin <command>`).
 */
import { PgStore } from '@workspace/storage-remote';
import { USAGE, runAdmin } from './admin-commands';
import { loadConfig } from './config';

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  const config = loadConfig();
  const store = new PgStore(config.databaseUrl, { max: 2 });
  try {
    if (command !== 'migrate') await store.migrate();
    return await runAdmin(store, argv, {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
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
