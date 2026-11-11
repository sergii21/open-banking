import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { constants as zlib } from 'node:zlib';
import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BASE } from '@ledger-lens/contracts';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { registerApi } from './api';
import { systemClock, type Clock } from './clock';
import type { AppConfig } from './config';
import { Db } from './db/database';
import { migrate } from './db/migrations';
import { createRepositories } from './db/repos';
import { secureDatabaseFiles, secureDataDir } from './data-dir';
import { Calendar } from './domain/calendar';
import { TokenVault } from './domain/crypto';
import { AppError } from './errors';
import { loggerOptions, stripQuery } from './logging';
import { ConnectionAccess } from './modules/connection/access';
import { ConnectionService } from './modules/connection/service';
import { WiseDraftService } from './modules/wise-drafts/service';
import { DiagnosticsService } from './modules/diagnostics/service';
import { EventBus } from './modules/events/event-bus';
import { HomeService } from './modules/home/service';
import { FopService } from './modules/fop/service';
import { ImportService } from './modules/imports/service';
import { InsightsService } from './modules/insights/service';
import { InspectorStore } from './modules/inspector/inspector-store';
import { RatesService } from './modules/rates/service';
import { SessionService } from './modules/session/service';
import { SyncService } from './modules/sync/service';
import { registerErrorHandling } from './plugins/errors';
import { buildRegistry, type ProviderTransports } from './providers/registry';
import type { App, AppContext, CoreContext } from './types';

export interface BuildAppOptions {
  config: AppConfig;
  clock?: Clock;
  /** Tests pass their own (in-memory) database; the server lets the app open the configured file. */
  db?: Db;
  /** Tests script the bank's HTTP instead of reaching the network. */
  transports?: ProviderTransports;
  /** Tests capture what the server logs, to check that nothing sensitive is ever written there. */
  logStream?: { write(line: string): void };
  /** How long the demo bank pretends the network takes; the server uses a little so loading states are real. */
  demoLatencyMs?: number;
}

export interface BuiltApp {
  app: App;
  ctx: AppContext;
}

const HASHED_ASSET = /-[A-Z0-9]{8}\.(?:js|css|woff2?)$/;

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const ownsDb = options.db === undefined;
  // The data folder holds the transaction history in plain data and the key that seals the token: owner-only, always.
  if (ownsDb && dirname(config.databasePath) === config.dataDir) secureDataDir(config.dataDir);
  const db = options.db ?? new Db(config.databasePath);
  migrate(db);
  if (ownsDb) secureDatabaseFiles(config.databasePath);

  const logger = loggerOptions(config);
  const app: App = Fastify({
    logger:
      options.logStream && typeof logger === 'object'
        ? { ...(logger as object), stream: options.logStream }
        : logger,
    trustProxy: config.trustProxy,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  if (ownsDb) {
    app.addHook('onClose', () => {
      db.close();
    });
  }
  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header('x-request-id', request.id);
    done(null, payload);
  });

  const calendar = new Calendar(config.timeZone);
  const events = new EventBus();
  const core: CoreContext = {
    config,
    clock,
    calendar,
    db,
    log: app.log,
    vault: new TokenVault({ id: config.tokenKeyId, key: config.tokenEncryptionKey }),
    events,
    inspector: new InspectorStore(events),
    repos: createRepositories(db),
  };

  // The SPA and the API share one origin, so the policy can stay strict: no inline scripts, no third-party origins.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // No <style> elements from anywhere but this origin; style attributes (Angular sets a few) are allowed.
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        formAction: ["'self'"],
        ...(config.secureCookies ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.secureCookies ? { maxAge: 15_552_000, includeSubDomains: false } : false,
  });
  await app.register(fastifyCookie);
  // JSON answers are compressed on the fly (brotli at a speed-friendly quality); built assets ship pre-compressed.
  await app.register(fastifyCompress, {
    global: true,
    threshold: 1024,
    encodings: ['br', 'gzip'],
    brotliOptions: { params: { [zlib.BROTLI_PARAM_QUALITY]: 4 } },
    zlibOptions: { level: 6 },
  });
  await app.register(fastifyRateLimit, {
    global: true,
    max: config.rateLimitPerMinute,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) =>
      new AppError('rate_limited', 429, 'Too many requests. Slow down and try again shortly.', {
        retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)),
      }),
  });

  app.get('/healthz', { config: { rateLimit: false } }, () => ({ status: 'ok' }));
  app.get('/readyz', { config: { rateLimit: false } }, (_request, reply) => {
    if (db.ping()) return { status: 'ready' };
    return reply.code(503).send({ status: 'unavailable' });
  });

  const providers = buildRegistry({
    config,
    clock,
    inspector: core.inspector,
    calendar,
    ...(options.transports ? { transports: options.transports } : {}),
    demoLatencyMs: options.demoLatencyMs ?? (config.env === 'test' ? 0 : 120),
  });
  const access = new ConnectionAccess(core, providers);
  const sync = new SyncService(core, access, calendar);
  const rates = new RatesService(core, providers);
  rates.onUpdate = (sessionId) => sync.touch(sessionId);
  const connections = new ConnectionService(core, providers, access, sync, rates);
  const sessions = new SessionService(core, connections);
  const home = new HomeService(core, sync, rates, calendar);
  const insights = new InsightsService(core, rates, calendar);
  const diagnostics = new DiagnosticsService(core, providers, sync, rates);
  const imports = new ImportService(core, providers, access, sync, rates, calendar);
  const fop = new FopService(core, calendar);
  const wiseDrafts = new WiseDraftService(core, access);
  const ctx: AppContext = {
    ...core,
    wiseDrafts,
    providers,
    access,
    sync,
    connections,
    sessions,
    rates,
    home,
    insights,
    diagnostics,
    imports,
    fop,
  };

  await registerApi(app, ctx);

  if (config.env !== 'test') {
    // Forget sessions nobody has touched for the configured TTL.
    const purge = (): void => {
      const removed = sessions.purgeIdle();
      if (removed > 0) app.log.info({ removed }, 'purged idle sessions');
    };
    purge();
    const purgeTimer = setInterval(purge, 6 * 60 * 60_000);
    purgeTimer.unref();
    // Paced loading: one step whenever the bank's limit allows, checked every second.
    const syncTimer = setInterval(() => {
      sync.tick().catch((error: unknown) => {
        app.log.error({ err: error }, 'background sync failed');
      });
    }, 1_000);
    syncTimer.unref();
    app.addHook('onClose', () => {
      clearInterval(purgeTimer);
      clearInterval(syncTimer);
    });
  }

  const spaEnabled =
    config.webDistDir !== null && existsSync(join(config.webDistDir, 'index.html'));
  if (spaEnabled && config.webDistDir) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      index: ['index.html'],
      preCompressed: true,
      setHeaders: (reply, path) => {
        const immutable = HASHED_ASSET.test(path) || path.includes('/media/');
        reply.header(
          'cache-control',
          immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    const path = stripQuery(request.url);
    if (
      spaEnabled &&
      request.method === 'GET' &&
      !path.startsWith('/api') &&
      extname(path) === ''
    ) {
      return reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .sendFile('index.html');
    }
    return reply
      .code(404)
      .header('cache-control', 'no-store')
      .type(PROBLEM_CONTENT_TYPE)
      .send({
        type: `${PROBLEM_TYPE_BASE}not-found`,
        title: 'Not found',
        status: 404,
        code: 'not_found',
        detail: `No route for ${request.method} ${path}.`,
        instance: path,
        traceId: request.id,
      });
  });

  return { app, ctx };
}
