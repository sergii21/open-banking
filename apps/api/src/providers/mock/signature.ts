import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signing for the fake bank, shaped like Stripe's scheme: `X-Mock-Signature: t=<unix>,v1=<hex>` where the MAC is
 * HMAC-SHA256 over `"<t>.<raw body>"`. The timestamp is inside the signed text, so a captured request cannot be replayed
 * later with a fresh timestamp; the receiver rejects anything outside the tolerance window.
 */
export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';
export const MOCK_SIGNATURE_TOLERANCE_SECONDS = 300;

/** Derived from the server's session secret, so there is no shared constant in the code to copy. */
export function mockWebhookSecret(sessionSecret: string): string {
  return createHmac('sha256', sessionSecret).update('ledger-lens:mock-bank:webhook').digest('hex');
}

export function signMockWebhook(
  secret: string,
  unixSeconds: number,
  rawBody: string | Buffer,
): string {
  const mac = createHmac('sha256', secret).update(`${unixSeconds}.`).update(rawBody).digest('hex');
  return `t=${unixSeconds},v1=${mac}`;
}

export type SignatureCheck =
  { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

export function verifyMockSignature(
  secret: string,
  header: string | undefined,
  rawBody: Buffer,
  nowSeconds: number,
  toleranceSeconds = MOCK_SIGNATURE_TOLERANCE_SECONDS,
): SignatureCheck {
  if (!header) return { ok: false, reason: 'missing' };
  const fields = new Map(
    header.split(',').map((part) => {
      const [name = '', ...rest] = part.trim().split('=');
      return [name, rest.join('=')] as const;
    }),
  );
  const timestamp = Number(fields.get('t'));
  const mac = fields.get('v1') ?? '';
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(mac)) {
    return { ok: false, reason: 'malformed' };
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  const received = Buffer.from(mac, 'hex');
  // Compare the MAC first: a forged signature should not learn from the timestamp answer whether the MAC was right.
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { ok: false, reason: 'mismatch' };
  }
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { ok: false, reason: 'stale' };
  return { ok: true };
}
