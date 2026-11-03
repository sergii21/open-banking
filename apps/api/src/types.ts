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
import type { Calendar } from './domain/calendar';
import type { TokenVault } from './domain/crypto';
import type { ConnectionAccess } from './modules/connection/access';
import type { ConnectionService } from './modules/connection/service';
import type { DiagnosticsService } from './modules/diagnostics/service';
import type { EventBus } from './modules/events/event-bus';
import type { HomeService } from './modules/home/service';
import type { ImportService } from './modules/imports/service';
import type { InsightsService } from './modules/insights/service';
import type { InspectorStore } from './modules/inspector/inspector-store';
import type { RatesService } from './modules/rates/service';
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

/** Infrastructure every layer may use. */
export interface CoreContext {
  config: AppConfig;
  clock: Clock;
  calendar: Calendar;
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
  rates: RatesService;
  home: HomeService;
  insights: InsightsService;
  diagnostics: DiagnosticsService;
  imports: ImportService;
}
