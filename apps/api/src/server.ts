import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';

// Optional `.env` next to the API package (git-ignored); the platform's real environment always wins. Nothing needs to be
// set for a normal run on your own machine.
for (const candidate of [resolve(process.cwd(), '.env'), resolve(import.meta.dirname, '../.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

let config;
try {
  config = loadConfig(process.env, {
    defaultWebDistDir: resolve(import.meta.dirname, '../../web/dist/web/browser'),
    defaultDataDir: resolve(import.meta.dirname, '../../../data'),
  });
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exit(1);
  }
  throw error;
}

const { app } = await buildApp({ config });
for (const warning of config.warnings) app.log.warn(warning);

// A request still waiting on a bank must not keep the person's terminal waiting. The database survives this: a commit is whole or absent.
const SHUTDOWN_DEADLINE_MS = 5_000;
let stopping = false;

const shutdown = async (signal: string): Promise<void> => {
  // Ctrl+C reaches this process twice: from the terminal, and forwarded by scripts/app.mjs.
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  setTimeout(() => {
    app.log.warn('still busy after the shutdown deadline, stopping anyway');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
  process.stdout.write(
    `\nLedger Lens is running at ${config.publicUrl}\n` +
      `  your real monobank account: ${config.live ? 'can be connected here' : 'switched off (this is a public instance)'}\n` +
      `  data: ${config.databasePath}\n\n`,
  );
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
