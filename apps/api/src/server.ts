import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';

// `.env` lives next to the API package (git-ignored); the platform's real environment always wins.
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
    baseDir: resolve(import.meta.dirname, '..'),
  });
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exit(1);
  }
  throw error;
}

const { app } = await buildApp({ config });
for (const warning of config.providerWarnings) app.log.warn(warning);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
