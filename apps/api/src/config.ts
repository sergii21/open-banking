import { createHash } from 'node:crypto';
import { z } from 'zod';

export type NodeEnv = 'development' | 'test' | 'production';

export interface AppConfig {
  env: NodeEnv;
  isProd: boolean;
  host: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Origin the browser uses (no trailing slash). Provider redirects and cookies are built from it. */
  publicUrl: string;
  secureCookies: boolean;
  databasePath: string;
  sessionSecret: string;
  sessionTtlDays: number;
  /** 32 bytes; AES-256-GCM key for provider tokens at rest. */
  tokenEncryptionKey: Buffer;
  tokenKeyId: string;
  webDistDir: string | null;
  trustProxy: boolean;
  demoControls: boolean;
  maxPaymentMinor: number;
  refreshCooldownSeconds: number;
  /** Per-IP request ceiling for the whole app; sensitive routes add tighter per-session limits. */
  rateLimitPerMinute: number;
  providers: {
    mock: { enabled: boolean };
  };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: LogLevel.optional(),
  PUBLIC_URL: z.url().optional(),
  DATABASE_PATH: z.string().min(1).default('./data/ledger-lens.db'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters').optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  TOKEN_KEY_ID: z
    .string()
    .regex(/^[a-z0-9]{1,8}$/)
    .default('k1'),
  WEB_DIST_DIR: z.string().optional(),
  TRUST_PROXY: z.stringbool().default(false),
  DEMO_CONTROLS: z.stringbool().optional(),
  MAX_PAYMENT_MINOR: z.coerce.number().int().min(1).max(5_000_000).default(500_000),
  REFRESH_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(20),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(100_000).default(600),
  PROVIDERS: z.string().default('mock'),
});

export interface LoadConfigOptions {
  /** Used when WEB_DIST_DIR is unset; the server passes the sibling Angular build output. */
  defaultWebDistDir?: string | null;
}

function deriveDevSecret(label: string): Buffer {
  return createHash('sha256').update(`ledger-lens-dev:${label}`).digest();
}

function parseEncryptionKey(raw: string): Buffer {
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new ConfigError(
      'TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded. Generate one with: openssl rand -base64 32',
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

  if (isProd && !e.SESSION_SECRET) {
    throw new ConfigError(
      'SESSION_SECRET is required in production. Generate one with: openssl rand -base64 48',
    );
  }
  if (isProd && !e.TOKEN_ENCRYPTION_KEY) {
    throw new ConfigError(
      'TOKEN_ENCRYPTION_KEY is required in production. Generate one with: openssl rand -base64 32',
    );
  }

  const publicUrl = (
    e.PUBLIC_URL ??
    (e.NODE_ENV === 'development' ? 'http://localhost:4200' : `http://localhost:${e.PORT}`)
  ).replace(/\/+$/, '');

  const providerIds = new Set(
    e.PROVIDERS.split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean),
  );

  return {
    env: e.NODE_ENV,
    isProd,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : 'info'),
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    databasePath: e.DATABASE_PATH,
    sessionSecret: e.SESSION_SECRET ?? deriveDevSecret('session').toString('hex'),
    sessionTtlDays: e.SESSION_TTL_DAYS,
    tokenEncryptionKey: e.TOKEN_ENCRYPTION_KEY
      ? parseEncryptionKey(e.TOKEN_ENCRYPTION_KEY)
      : deriveDevSecret('token'),
    tokenKeyId: e.TOKEN_KEY_ID,
    webDistDir: e.WEB_DIST_DIR ?? options.defaultWebDistDir ?? null,
    trustProxy: e.TRUST_PROXY,
    demoControls: e.DEMO_CONTROLS ?? !isProd,
    maxPaymentMinor: e.MAX_PAYMENT_MINOR,
    refreshCooldownSeconds: e.REFRESH_COOLDOWN_SECONDS,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    providers: {
      mock: { enabled: providerIds.has('mock') },
    },
  };
}
