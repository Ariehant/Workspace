import { PgStore } from '@workspace/storage-remote';
import { buildServer } from './app';
import { ConfigError, loadConfig } from './config';
import { createFileStorage } from './files';

/** Stop accepting work, finish what's in flight, then close the database. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new PgStore(config.databaseUrl);
  const files = createFileStorage(config.files);
  const app = buildServer({ config, store, files });
  const version = await store.migrate();
  app.log.info({ schema: version }, 'database ready');
  await app.listen({ host: config.host, port: config.port });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    void app
      .close()
      .then(() => store.close())
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(error.message);
  else console.error(error);
  process.exit(1);
});
