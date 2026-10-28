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

/** Fastify instance with the Zod type provider, so route schemas type `request` and `reply`. */
export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/** Everything a route module needs. Built once in `buildApp`; tests can swap pieces. */
export interface AppContext {
  config: AppConfig;
  clock: Clock;
  db: Db;
}
