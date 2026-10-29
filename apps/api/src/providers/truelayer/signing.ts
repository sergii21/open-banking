import { createPrivateKey, createPublicKey, sign, verify, type JsonWebKey } from 'node:crypto';

/**
 * TrueLayer request signing, version 2: a detached JWS (RFC 7515, appendix F) with ES512, i.e. ECDSA over P-521 and SHA-512.
 *
 * What is signed is not the JSON body alone but a small canonical text:
 *
 *     POST /v3/payments
 *     Idempotency-Key: 5c1a...
 *     {"amount_in_minor":1000,...}
 *
 * (request line, then each signed header as `Name: value`, then the raw body, joined by single newlines, no trailing one).
 * The JWS header names which headers were included (`tl_headers`), the key (`kid`), and the scheme version, and the
 * signature travels in the `Tl-Signature` header as `<header>..<signature>`, with the payload left out.
 *
 * The same format signs our requests and is what TrueLayer uses for its webhooks, where the header also carries a `jku`
 * pointing at the public key set.
 */

const b64url = (input: string | Buffer): string => Buffer.from(input).toString('base64url');

export interface SigningKey {
  keyId: string;
  privateKeyPem: string;
}

export function canonicalRequest(
  method: string,
  path: string,
  headers: readonly (readonly [name: string, value: string])[],
  body: string,
): string {
  return [
    `${method.toUpperCase()} ${path}`,
    ...headers.map(([name, value]) => `${name}: ${value}`),
    body,
  ].join('\n');
}

/** `Tl-Signature` for a request: the exact serialised body must be the one that is sent. */
export function signRequest(
  key: SigningKey,
  request: {
    method: string;
    path: string;
    headers: readonly (readonly [name: string, value: string])[];
    body: string;
  },
): string {
  const header = {
    alg: 'ES512',
    kid: key.keyId,
    tl_version: '2',
    tl_headers: request.headers.map(([name]) => name).join(','),
  };
  const encodedHeader = b64url(JSON.stringify(header));
  const signingInput = `${encodedHeader}.${b64url(
    canonicalRequest(request.method, request.path, request.headers, request.body),
  )}`;
  // `ieee-p1363` is the raw R||S form JWS wants (132 bytes for P-521), not the DER Node produces by default.
  const signature = sign('sha512', Buffer.from(signingInput), {
    key: createPrivateKey(key.privateKeyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${encodedHeader}..${b64url(signature)}`;
}

export interface SignatureHeader {
  alg: string;
  kid: string;
  tl_version?: string;
  tl_headers?: string;
  jku?: string;
}

export interface ParsedSignature {
  header: SignatureHeader;
  encodedHeader: string;
  signature: Buffer;
}

/** Reads a detached JWS. Returns null for anything that is not one, so the caller can refuse it without guessing. */
export function parseSignature(value: string): ParsedSignature | null {
  const parts = value.split('.');
  const [encodedHeader, payload, encodedSignature] = parts;
  if (parts.length !== 3 || !encodedHeader || payload !== '' || !encodedSignature) return null;
  try {
    const header: unknown = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    if (typeof header !== 'object' || header === null) return null;
    const { alg, kid, tl_version, tl_headers, jku } = header as Record<string, unknown>;
    if (typeof alg !== 'string' || typeof kid !== 'string') return null;
    return {
      header: {
        alg,
        kid,
        ...(typeof tl_version === 'string' ? { tl_version } : {}),
        ...(typeof tl_headers === 'string' ? { tl_headers } : {}),
        ...(typeof jku === 'string' ? { jku } : {}),
      },
      encodedHeader,
      signature: Buffer.from(encodedSignature, 'base64url'),
    };
  } catch {
    return null;
  }
}

/** True when `signature` is a valid ES512 signature by `jwk` over the canonical text. Never throws on bad input. */
export function verifySignature(
  jwk: JsonWebKey,
  parsed: ParsedSignature,
  canonical: string,
): boolean {
  try {
    return verify(
      'sha512',
      Buffer.from(`${parsed.encodedHeader}.${b64url(canonical)}`),
      { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      parsed.signature,
    );
  } catch {
    return false;
  }
}
