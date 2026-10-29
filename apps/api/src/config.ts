import { createHash, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as z from 'zod';

export type NodeEnv = 'development' | 'test' | 'production';

export type PaymentCurrency = 'GBP' | 'EUR';

/** How TrueLayer pay-ins are addressed. See the README: merchant accounts are what a sandbox app has out of the box. */
export type TrueLayerBeneficiary =
  | { type: 'merchant_account'; merchantAccountIds: Partial<Record<PaymentCurrency, string>> }
  | { type: 'external_account' };

export interface TrueLayerConfig {
  clientId: string;
  clientSecret: string;
  /** Value of the auth link's `providers` parameter; `uk-cs-mock` is TrueLayer's Mock Bank. */
  dataProviders: string;
  /** Payments v3 request signing (ES512). Without it the adapter still reads account data but offers no payments. */
  signing: { keyId: string; privateKeyPem: string } | null;
  beneficiary: TrueLayerBeneficiary;
  /** Sandbox mock bank used for each payment currency. */
  paymentProviders: Record<PaymentCurrency, string>;
  /** Contact details sent with a payment; sandbox only, so a placeholder address is fine. */
  userEmail: string;
}

/** monobank (Ukraine): the customer's own read-only token against the bank's personal API. Real accounts, so local use only. */
export interface MonobankConfig {
  /** How many months of history the background loader fetches (one request per minute per account and month). */
  historyMonths: number;
  /** Always https://api.monobank.ua except in tests, which point it at a local fake. */
  apiUrl: string;
  /** Gap between statement reads. monobank's own limit is one per minute; only tests and the e2e run shorten it. */
  minIntervalSeconds: number;
}

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
  /** New anonymous sessions one address may start per minute: each costs a database row, so a public demo caps it. */
  sessionCreatesPerMinute: number;
  /** Payments older than this, still awaiting the bank, are marked expired (TrueLayer's resource token lasts 15 minutes). */
  paymentApprovalMinutes: number;
  /** A webhook claiming to be older than this is rejected. TrueLayer retries for up to 72 hours. */
  webhookMaxAgeSeconds: number;
  /** How long the fake bank takes between the steps of a payment (authorised, executed, settled). */
  mockBankStepSeconds: number;
  providers: {
    mock: { enabled: boolean };
    /** Null when TrueLayer is not listed in PROVIDERS or has no credentials. */
    truelayer: TrueLayerConfig | null;
    /** Null unless listed in PROVIDERS and PUBLIC_URL is this machine (or ALLOW_LIVE_PROVIDERS is set). */
    monobank: MonobankConfig | null;
  };
  /** Providers named in PROVIDERS that could not be enabled, with the reason (logged at startup). */
  providerWarnings: string[];
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const optionalText = z.string().trim().min(1).optional();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: LogLevel.optional(),
  PUBLIC_URL: z.url().optional(),
  /** Render sets this to the service's public https URL; it stands in for PUBLIC_URL when that is not given. */
  RENDER_EXTERNAL_URL: z.url().optional(),
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
  SESSION_CREATES_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(30),
  PAYMENT_APPROVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  ALLOW_LIVE_PROVIDERS: z.stringbool().default(false),
  MONOBANK_HISTORY_MONTHS: z.coerce.number().int().min(1).max(13).default(3),
  MONOBANK_API_URL: z.url().default('https://api.monobank.ua'),
  MONOBANK_MIN_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(600).default(61),
  WEBHOOK_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .default(72 * 3600 + 600),
  MOCK_BANK_STEP_SECONDS: z.coerce.number().int().min(0).max(120).default(3),
  PROVIDERS: z.string().default('mock'),

  TRUELAYER_CLIENT_ID: optionalText,
  TRUELAYER_CLIENT_SECRET: optionalText,
  TRUELAYER_DATA_PROVIDERS: z.string().trim().min(1).default('uk-cs-mock'),
  TRUELAYER_SIGNING_KEY_ID: optionalText,
  TRUELAYER_PRIVATE_KEY_PATH: optionalText,
  TRUELAYER_PRIVATE_KEY: optionalText,
  TRUELAYER_BENEFICIARY: z
    .enum(['merchant_account', 'external_account'])
    .default('merchant_account'),
  TRUELAYER_MERCHANT_ACCOUNT_ID_GBP: optionalText,
  TRUELAYER_MERCHANT_ACCOUNT_ID_EUR: optionalText,
  TRUELAYER_PAYMENT_PROVIDER_GBP: z.string().trim().min(1).default('mock-payments-gb-redirect'),
  TRUELAYER_PAYMENT_PROVIDER_EUR: z.string().trim().min(1).default('mock-payments-de-redirect'),
  TRUELAYER_USER_EMAIL: z.string().trim().min(3).default('demo@ledger-lens.example'),
});

type Env = z.infer<typeof EnvSchema>;

export interface LoadConfigOptions {
  /** Used when WEB_DIST_DIR is unset; the server passes the sibling Angular build output. */
  defaultWebDistDir?: string | null;
  /** Relative key file paths (TRUELAYER_PRIVATE_KEY_PATH) resolve against this folder: apps/api. */
  baseDir?: string;
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

/** Loads the ES512 key from an inline PEM (Render-style secret, `\n` allowed) or a file, and checks it is P-521. */
function loadSigningKey(e: Env, baseDir: string): TrueLayerConfig['signing'] {
  if (!e.TRUELAYER_SIGNING_KEY_ID && !e.TRUELAYER_PRIVATE_KEY && !e.TRUELAYER_PRIVATE_KEY_PATH)
    return null;
  if (!e.TRUELAYER_SIGNING_KEY_ID) {
    throw new ConfigError(
      'TRUELAYER_SIGNING_KEY_ID is required when a TrueLayer private key is configured.',
    );
  }
  let pem = e.TRUELAYER_PRIVATE_KEY?.replaceAll('\\n', '\n');
  if (!pem && e.TRUELAYER_PRIVATE_KEY_PATH) {
    const path = resolve(baseDir, e.TRUELAYER_PRIVATE_KEY_PATH);
    try {
      pem = readFileSync(path, 'utf8');
    } catch {
      throw new ConfigError(
        `TRUELAYER_PRIVATE_KEY_PATH points at ${path}, which cannot be read. Run \`npm run keys:truelayer\` to create it.`,
      );
    }
  }
  if (!pem) return null;
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'secp521r1') {
      throw new Error('not an EC P-521 key');
    }
  } catch (error) {
    throw new ConfigError(
      `The TrueLayer private key must be an EC P-521 (secp521r1) PEM, as generated by \`npm run keys:truelayer\` (${error instanceof Error ? error.message : 'unreadable'}).`,
    );
  }
  return { keyId: e.TRUELAYER_SIGNING_KEY_ID, privateKeyPem: pem };
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

/**
 * Live providers read real people's accounts. A public demo must never do that (decision D7), so they only switch on when
 * the app is served from this machine, unless the operator says otherwise on purpose.
 */
function loadMonobank(
  e: Env,
  providerIds: ReadonlySet<string>,
  publicUrl: string,
  warnings: string[],
): MonobankConfig | null {
  if (!providerIds.has('monobank')) return null;
  if (!e.ALLOW_LIVE_PROVIDERS && !isLoopbackUrl(publicUrl)) {
    warnings.push(
      'monobank reads real bank accounts and is for personal use on your own machine, so it is not enabled while PUBLIC_URL is not localhost. Set ALLOW_LIVE_PROVIDERS=true only if you really mean it.',
    );
    return null;
  }
  const apiUrl = e.MONOBANK_API_URL.replace(/\/+$/, '');
  if (!apiUrl.startsWith('https://') && !isLoopbackUrl(apiUrl)) {
    throw new ConfigError(
      'MONOBANK_API_URL must be https (plain http is only allowed for localhost).',
    );
  }
  return {
    historyMonths: e.MONOBANK_HISTORY_MONTHS,
    apiUrl,
    minIntervalSeconds: e.MONOBANK_MIN_INTERVAL_SECONDS,
  };
}

function loadTrueLayer(
  e: Env,
  providerIds: ReadonlySet<string>,
  baseDir: string,
  warnings: string[],
): TrueLayerConfig | null {
  if (!providerIds.has('truelayer')) return null;
  if (!e.TRUELAYER_CLIENT_ID || !e.TRUELAYER_CLIENT_SECRET) {
    warnings.push(
      'truelayer is listed in PROVIDERS but TRUELAYER_CLIENT_ID / TRUELAYER_CLIENT_SECRET are missing, so it is not enabled.',
    );
    return null;
  }
  const merchantAccountIds: Partial<Record<PaymentCurrency, string>> = {};
  if (e.TRUELAYER_MERCHANT_ACCOUNT_ID_GBP)
    merchantAccountIds.GBP = e.TRUELAYER_MERCHANT_ACCOUNT_ID_GBP;
  if (e.TRUELAYER_MERCHANT_ACCOUNT_ID_EUR)
    merchantAccountIds.EUR = e.TRUELAYER_MERCHANT_ACCOUNT_ID_EUR;

  return {
    clientId: e.TRUELAYER_CLIENT_ID,
    clientSecret: e.TRUELAYER_CLIENT_SECRET,
    dataProviders: e.TRUELAYER_DATA_PROVIDERS,
    signing: loadSigningKey(e, baseDir),
    beneficiary:
      e.TRUELAYER_BENEFICIARY === 'external_account'
        ? { type: 'external_account' }
        : { type: 'merchant_account', merchantAccountIds },
    paymentProviders: {
      GBP: e.TRUELAYER_PAYMENT_PROVIDER_GBP,
      EUR: e.TRUELAYER_PAYMENT_PROVIDER_EUR,
    },
    userEmail: e.TRUELAYER_USER_EMAIL,
  };
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
    e.RENDER_EXTERNAL_URL ??
    (e.NODE_ENV === 'development' ? 'http://localhost:4200' : `http://localhost:${e.PORT}`)
  ).replace(/\/+$/, '');

  const providerIds = new Set(
    e.PROVIDERS.split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean),
  );
  const providerWarnings: string[] = [];

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
    sessionCreatesPerMinute: e.SESSION_CREATES_PER_MINUTE,
    paymentApprovalMinutes: e.PAYMENT_APPROVAL_MINUTES,
    webhookMaxAgeSeconds: e.WEBHOOK_MAX_AGE_SECONDS,
    mockBankStepSeconds: e.MOCK_BANK_STEP_SECONDS,
    providers: {
      mock: { enabled: providerIds.has('mock') },
      truelayer: loadTrueLayer(e, providerIds, options.baseDir ?? process.cwd(), providerWarnings),
      monobank: loadMonobank(e, providerIds, publicUrl, providerWarnings),
    },
    providerWarnings,
  };
}
