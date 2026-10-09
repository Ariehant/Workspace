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
  // Long update logs are merged hourly (docs with more than 500 stored updates).
  // Due reminders are looked for every 30 seconds (tests make it shorter).
  const reminderPollMs = Number(process.env.REMINDER_POLL_MS) || undefined;
  const app = buildServer({
    config,
    store,
    files,
    sync: { compactEveryMs: 3_600_000 },
    notify: { reminderPollMs },
  });
  const version = await store.migrate();
  app.log.info({ schema: version }, 'database ready');
  await app.listen({ host: config.host, port: config.port });
  // Index whatever arrived while the server was down (or before search existed).
  void app.indexer.catchUp().catch((error: unknown) => app.log.error({ err: error }, 'indexing'));
  // Notify about what arrived while it was down, and fire reminders that came due.
  void app.notifier.start().catch((error: unknown) => app.log.error({ err: error }, 'notifier'));
  void app.history.start().catch((error: unknown) => app.log.error({ err: error }, 'history'));
  app.jobs.start();

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
