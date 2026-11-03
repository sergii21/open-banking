import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import * as z from 'zod';
import { loadOrCreateKeys } from './keys';

export type NodeEnv = 'development' | 'test' | 'production';

/** The bank's personal API, as the live adapter and the demo adapter both use it. */
export interface MonobankConfig {
  /** https://api.monobank.ua except in tests and when pointed at the stand-alone fake. */
  apiUrl: string;
  /** Gap between two statement reads. monobank's own limit is one per minute; only tests and demos shorten it. */
  statementIntervalMs: number;
  /** Gap between two reads of the account list (same limit). */
  infoIntervalMs: number;
  /** How many months of history the background loader fetches. */
  historyMonths: number;
}

export interface AppConfig {
  env: NodeEnv;
  isProd: boolean;
  host: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Origin the browser uses (no trailing slash). Cookies and the CSRF origin check are built from it. */
  publicUrl: string;
  secureCookies: boolean;
  dataDir: string;
  databasePath: string;
  sessionSecret: string;
  sessionTtlDays: number;
  /** 32 bytes; AES-256-GCM key for the bank token at rest. */
  tokenEncryptionKey: Buffer;
  tokenKeyId: string;
  webDistDir: string | null;
  trustProxy: boolean;
  refreshCooldownSeconds: number;
  /** Per-IP request ceiling for the whole app. */
  rateLimitPerMinute: number;
  /** New anonymous sessions one address may start per minute. */
  sessionCreatesPerMinute: number;
  /** IANA zone used to cut days and months (monobank is Ukrainian). */
  timeZone: string;
  /** Whether a real monobank token may be connected: only when served from this machine (decision D7), unless forced. */
  live: boolean;
  /** Real provider settings, used when `live` is on. */
  monobank: MonobankConfig;
  /** The demo asks the real bank for its public rates before falling back to the fake's. Off in tests. */
  demoRealRates: boolean;
  /** The demo runs the same adapter against the in-process fake; pacing is off so history appears at once. */
  demo: { statementIntervalMs: number; infoIntervalMs: number; historyMonths: number };
  warnings: string[];
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: LogLevel.optional(),
  PUBLIC_URL: z.url().optional(),
  /** Render sets this to the service's public https URL; it stands in for PUBLIC_URL when that is not given. */
  RENDER_EXTERNAL_URL: z.url().optional(),
  DATA_DIR: z.string().min(1).optional(),
  DATABASE_PATH: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters').optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(730).default(365),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  TOKEN_KEY_ID: z
    .string()
    .regex(/^[a-z0-9]{1,8}$/)
    .default('k1'),
  WEB_DIST_DIR: z.string().optional(),
  TRUST_PROXY: z.stringbool().default(false),
  REFRESH_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(10),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(100_000).default(1200),
  SESSION_CREATES_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(30),
  TIME_ZONE: z.string().min(1).default('Europe/Kyiv'),
  ALLOW_LIVE_PROVIDERS: z.stringbool().optional(),
  MONOBANK_HISTORY_MONTHS: z.coerce.number().int().min(1).max(13).default(2),
  MONOBANK_API_URL: z.url().default('https://api.monobank.ua'),
  MONOBANK_MIN_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(600).default(61),
  /** 0 (the default) shows the whole demo history at once; a value shows what the paced real thing feels like. */
  DEMO_REAL_RATES: z.stringbool().optional(),
  DEMO_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(600).default(0),
});

export interface LoadConfigOptions {
  /** Used when WEB_DIST_DIR is unset; the server passes the sibling Angular build output. */
  defaultWebDistDir?: string | null;
  /** Used when DATA_DIR is unset; the server passes `<repo>/data`. */
  defaultDataDir?: string;
}

const isLoopbackUrl = (url: string): boolean => {
  const { hostname } = new URL(url);
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
};

function parseEncryptionKey(raw: string): Buffer {
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new ConfigError(
      'TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded. Leave it unset and the app creates one for you, or use: openssl rand -base64 32',
    );
  }
  return key;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadConfigOptions = {},
): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new ConfigError(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';
  const warnings: string[] = [];

  const publicUrl = (e.PUBLIC_URL ?? e.RENDER_EXTERNAL_URL ?? `http://localhost:${e.PORT}`).replace(
    /\/+$/,
    '',
  );

  const dataDir = resolve(e.DATA_DIR ?? options.defaultDataDir ?? './data');
  const databasePath = e.DATABASE_PATH ?? join(dataDir, 'ledger-lens.db');

  // Keys: explicit values win; tests get throwaway ones; everything else keeps generated keys in the data directory.
  let sessionSecret = e.SESSION_SECRET;
  let tokenKey = e.TOKEN_ENCRYPTION_KEY ? parseEncryptionKey(e.TOKEN_ENCRYPTION_KEY) : null;
  if (!sessionSecret || !tokenKey) {
    if (e.NODE_ENV === 'test' || databasePath === ':memory:') {
      sessionSecret ??= randomBytes(48).toString('base64');
      tokenKey ??= randomBytes(32);
    } else {
      const stored = loadOrCreateKeys(dataDir);
      sessionSecret ??= stored.session;
      tokenKey ??= Buffer.from(stored.token, 'base64');
    }
  }

  const loopback = isLoopbackUrl(publicUrl);
  const live = e.ALLOW_LIVE_PROVIDERS ?? loopback;
  if (live && !loopback) {
    warnings.push(
      'ALLOW_LIVE_PROVIDERS is on while PUBLIC_URL is not this machine: anyone who can open the app could connect their bank to it.',
    );
  }
  const apiUrl = e.MONOBANK_API_URL.replace(/\/+$/, '');
  if (!apiUrl.startsWith('https://') && !isLoopbackUrl(apiUrl)) {
    throw new ConfigError(
      'MONOBANK_API_URL must be https (plain http is only allowed for localhost).',
    );
  }

  return {
    env: e.NODE_ENV,
    isProd,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : isProd ? 'warn' : 'info'),
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    dataDir,
    databasePath,
    sessionSecret,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    tokenEncryptionKey: tokenKey,
    tokenKeyId: e.TOKEN_KEY_ID,
    webDistDir: e.WEB_DIST_DIR ?? options.defaultWebDistDir ?? null,
    trustProxy: e.TRUST_PROXY,
    refreshCooldownSeconds: e.REFRESH_COOLDOWN_SECONDS,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    sessionCreatesPerMinute: e.SESSION_CREATES_PER_MINUTE,
    timeZone: e.TIME_ZONE,
    live,
    monobank: {
      apiUrl,
      statementIntervalMs: e.MONOBANK_MIN_INTERVAL_SECONDS * 1000,
      infoIntervalMs: e.MONOBANK_MIN_INTERVAL_SECONDS * 1000,
      historyMonths: e.MONOBANK_HISTORY_MONTHS,
    },
    demoRealRates: e.DEMO_REAL_RATES ?? e.NODE_ENV !== 'test',
    demo: {
      statementIntervalMs: e.DEMO_INTERVAL_SECONDS * 1000,
      infoIntervalMs: e.DEMO_INTERVAL_SECONDS * 1000,
      historyMonths: Math.max(e.MONOBANK_HISTORY_MONTHS, 3),
    },
    warnings,
  };
}
