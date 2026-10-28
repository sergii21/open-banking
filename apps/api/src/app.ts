import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
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
import { TokenVault } from './domain/crypto';
import { AppError } from './errors';
import { loggerOptions, stripQuery } from './logging';
import { ConnectionAccess } from './modules/connections/access';
import { ConnectionService } from './modules/connections/service';
import { EventBus } from './modules/events/event-bus';
import { InspectorStore } from './modules/inspector/inspector-store';
import { SessionService } from './modules/session/service';
import { SyncService } from './modules/sync/service';
import { registerErrorHandling } from './plugins/errors';
import { buildRegistry } from './providers/registry';
import type { App, AppContext, CoreContext } from './types';

export interface BuildAppOptions {
  config: AppConfig;
  clock?: Clock;
  /** Tests pass their own (in-memory) database; the server lets the app open the configured file. */
  db?: Db;
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
  const db = options.db ?? new Db(config.databasePath);
  migrate(db);

  const app: App = Fastify({
    logger: loggerOptions(config),
    trustProxy: config.trustProxy,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    bodyLimit: 256 * 1024,
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

  const events = new EventBus();
  const core: CoreContext = {
    config,
    clock,
    db,
    log: app.log,
    vault: new TokenVault({ id: config.tokenKeyId, key: config.tokenEncryptionKey }),
    events,
    inspector: new InspectorStore(events),
    repos: createRepositories(db),
  };

  // The SPA, the mock bank's own pages and the provider redirects are all served from this origin,
  // so the policy can stay strict: no inline scripts, no third-party origins.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Angular and Material inject component styles at runtime; scripts stay locked down.
        styleSrc: ["'self'", "'unsafe-inline'"],
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

  const providers = await buildRegistry({ app, ctx: core });
  const access = new ConnectionAccess(core, providers);
  const sync = new SyncService(core, access);
  const connections = new ConnectionService(core, providers, access, sync);
  const sessions = new SessionService(core, providers, connections);
  const ctx: AppContext = { ...core, providers, access, sync, connections, sessions };

  await registerApi(app, ctx);

  if (config.env !== 'test') {
    // Keep a public demo tidy: forget sessions nobody has touched for the configured TTL.
    const purge = (): void => {
      const removed = sessions.purgeIdle();
      if (removed > 0) app.log.info({ removed }, 'purged idle sessions');
    };
    purge();
    const timer = setInterval(purge, 6 * 60 * 60_000);
    timer.unref();
    app.addHook('onClose', () => {
      clearInterval(timer);
    });
  }

  const spaEnabled =
    config.webDistDir !== null && existsSync(join(config.webDistDir, 'index.html'));
  if (spaEnabled && config.webDistDir) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      index: ['index.html'],
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
    const isBackendPath = path.startsWith('/api') || path.startsWith('/mock-bank');
    if (spaEnabled && request.method === 'GET' && !isBackendPath && extname(path) === '') {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply
      .code(404)
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
