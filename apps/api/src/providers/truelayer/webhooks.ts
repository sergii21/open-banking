import type { JsonWebKey } from 'node:crypto';
import * as z from 'zod';
import type { Clock } from '../../clock';
import { AppError } from '../../errors';
import type { WebhookRequest } from '../port';
import type { Transport } from '../transport';
import { canonicalRequest, parseSignature, verifySignature } from './signing';

/**
 * The only place TrueLayer publishes the keys its webhooks are signed with. The `jku` in a signature header is attacker
 * controlled until it has been checked, so it is compared against this constant rather than fetched: otherwise anyone
 * could point it at their own key set and sign whatever they liked.
 */
export const TRUELAYER_JWKS_URL = 'https://webhooks.truelayer-sandbox.com/.well-known/jwks';

const JWKS_TTL_MS = 60 * 60_000;
/** An unknown `kid` triggers one refetch (the keys rotate), but not more often than this. */
const JWKS_REFETCH_MIN_MS = 60_000;
/** A timestamp this far in the future is as suspect as one that is too old. */
const CLOCK_SKEW_MS = 5 * 60_000;

const Jwks = z.object({
  keys: z.array(z.looseObject({ kty: z.string(), kid: z.string(), crv: z.string().optional() })),
});

const refuse = (reason: string): AppError =>
  new AppError(
    'invalid_webhook_signature',
    401,
    `The webhook signature did not verify (${reason}).`,
  );

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Header lookup that does not care about case, as HTTP does not. */
function headerValue(headers: WebhookRequest['headers'], name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return first(value) ?? '';
  }
  return '';
}

/** Verifies `Tl-Signature` on webhooks: ES512, a key from TrueLayer's own key set, and a timestamp that is not stale. */
export class WebhookVerifier {
  private cache: { keys: JsonWebKey[]; fetchedAt: number } | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly clock: Clock,
    private readonly maxAgeSeconds: number,
    private readonly jwksUrl: string = TRUELAYER_JWKS_URL,
  ) {}

  private async keys(forceRefresh: boolean): Promise<JsonWebKey[]> {
    const now = this.clock.now().getTime();
    const cached = this.cache;
    if (cached) {
      const age = now - cached.fetchedAt;
      if (!forceRefresh && age < JWKS_TTL_MS) return cached.keys;
      if (forceRefresh && age < JWKS_REFETCH_MIN_MS) return cached.keys;
    }
    let body: unknown;
    try {
      const response = await this.transport(this.jwksUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
    } catch (error) {
      // Not the sender's fault: answer 5xx so the provider retries instead of dropping the event.
      throw new AppError(
        'provider_error',
        502,
        'Could not fetch the provider’s webhook signing keys.',
        {
          cause: error,
        },
      );
    }
    const parsed = Jwks.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        'provider_error',
        502,
        'The provider’s webhook signing keys are unreadable.',
      );
    }
    const keys = parsed.data.keys as JsonWebKey[];
    this.cache = { keys, fetchedAt: now };
    return keys;
  }

  async verify(request: WebhookRequest): Promise<void> {
    const header = first(request.headers['tl-signature']);
    if (!header) throw refuse('no Tl-Signature header');
    const parsed = parseSignature(header);
    if (!parsed) throw refuse('malformed signature');

    // Pin everything the sender controls: the algorithm (no "none", no downgrade) and where the keys come from.
    if (parsed.header.alg !== 'ES512') throw refuse('unsupported algorithm');
    if (parsed.header.jku !== this.jwksUrl) throw refuse('untrusted key set');

    const byKid = (key: JsonWebKey): boolean => key['kid'] === parsed.header.kid;
    let jwk = (await this.keys(false)).find(byKid);
    jwk ??= (await this.keys(true)).find(byKid);
    if (!jwk) throw refuse('unknown key');

    const names = (parsed.header.tl_headers ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    const headers = names.map((name) => [name, headerValue(request.headers, name)] as const);

    // A signed timestamp header lets us refuse a captured request replayed long after the fact. The event id check later
    // is the second line of defence for replays that are still fresh.
    const timestamp = headers.find(([name]) =>
      ['x-tl-webhook-timestamp', 'tl-timestamp'].includes(name.toLowerCase()),
    )?.[1];
    if (timestamp) {
      const sentAt = Date.parse(timestamp);
      const age = this.clock.now().getTime() - sentAt;
      if (Number.isNaN(sentAt) || age > this.maxAgeSeconds * 1000 || age < -CLOCK_SKEW_MS) {
        throw refuse('stale timestamp');
      }
    }

    const body = request.rawBody.toString('utf8');
    // Proxies add or drop a trailing slash; the signature was made over whichever form the provider called.
    const alternate = request.path.endsWith('/') ? request.path.slice(0, -1) : `${request.path}/`;
    const valid = [request.path, alternate].some((path) =>
      verifySignature(jwk, parsed, canonicalRequest(request.method, path, headers, body)),
    );
    if (!valid) throw refuse('mismatch');
  }
}
