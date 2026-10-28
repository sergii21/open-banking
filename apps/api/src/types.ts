import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Clock } from './clock';
import type { AppConfig } from './config';
import type { Db } from './db/database';
import type { Repositories } from './db/repos';
import type { TokenVault } from './domain/crypto';
import type { ConnectionAccess } from './modules/connections/access';
import type { ConnectionService } from './modules/connections/service';
import type { EventBus } from './modules/events/event-bus';
import type { InspectorStore } from './modules/inspector/inspector-store';
import type { SessionService } from './modules/session/service';
import type { SyncService } from './modules/sync/service';
import type { ProviderRegistry } from './providers/registry';

/** Fastify instance with the Zod type provider, so route schemas type `request` and `reply`. */
export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/** Infrastructure every layer may use. Built first, before providers (which need the Fastify instance). */
export interface CoreContext {
  config: AppConfig;
  clock: Clock;
  db: Db;
  log: FastifyBaseLogger;
  vault: TokenVault;
  events: EventBus;
  inspector: InspectorStore;
  repos: Repositories;
}

/** Everything a route module needs. */
export interface AppContext extends CoreContext {
  providers: ProviderRegistry;
  access: ConnectionAccess;
  sync: SyncService;
  connections: ConnectionService;
  sessions: SessionService;
}
