/**
 * Redaction for everything that leaves the process boundary of a provider call: the Inspector buffer, logs and
 * error details. Tokens, secrets and signatures are always masked. Account identifiers are masked too when the
 * provider is a live one (mock and sandbox data is fake, and showing it is the point of the Inspector).
 */

const REDACTED = '[redacted]';

const normalise = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const SECRET_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'token',
  'clientsecret',
  'secret',
  'code',
  'codeverifier',
  'resourcetoken',
  'password',
  'pin',
  'authorization',
  'cookie',
  'setcookie',
  'signature',
  'tlsignature',
  'apikey',
  'privatekey',
  'xtoken',
]);

const IDENTIFIER_KEYS = new Set([
  'iban',
  'accountnumber',
  'sortcode',
  'number',
  'swiftbic',
  'bic',
  'pan',
  'maskedpan',
  'cardnumber',
  'counteriban',
  'sendid',
]);

export interface RedactOptions {
  maskIdentifiers: boolean;
}

/** Longer identifiers keep their last four characters, short ones (sort codes, short account numbers) almost nothing. */
function maskIdentifier(value: unknown): unknown {
  if (typeof value !== 'string' && typeof value !== 'number') return value;
  const text = String(value);
  if (text.length <= 6) return '••••';
  const visible = text.length <= 8 ? 2 : 4;
  return `${'•'.repeat(Math.min(text.length - visible, 8))}${text.slice(-visible)}`;
}

/** A customer's IP address is personal data: keep the network part, drop the host part. */
export function maskIpAddress(value: string): string {
  if (value.includes(':')) return `${value.split(':').slice(0, 3).join(':')}:••••`;
  const octets = value.split('.');
  return octets.length === 4 ? `${octets.slice(0, 3).join('.')}.•••` : REDACTED;
}

export function redactJson(value: unknown, options: RedactOptions): unknown {
  if (Array.isArray(value)) return value.map((item) => redactJson(item, options));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalised = normalise(key);
      if (SECRET_KEYS.has(normalised) && child !== null && child !== undefined) {
        result[key] = REDACTED;
      } else if (options.maskIdentifiers && IDENTIFIER_KEYS.has(normalised)) {
        result[key] = Array.isArray(child) ? child.map(maskIdentifier) : maskIdentifier(child);
      } else {
        result[key] = redactJson(child, options);
      }
    }
    return result;
  }
  return value;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = normalise(name);
    if (key === 'authorization') {
      const [scheme, credential] = value.split(' ');
      result[name] = credential ? `${scheme} ••••${credential.slice(-4)}` : REDACTED;
    } else if (
      key === 'cookie' ||
      key === 'setcookie' ||
      key === 'xtoken' ||
      key.endsWith('signature')
    ) {
      result[name] = REDACTED;
    } else if (key === 'xpsuip' || key === 'xforwardedfor') {
      result[name] = value
        .split(',')
        .map((address) => maskIpAddress(address.trim()))
        .join(', ');
    } else {
      result[name] = value;
    }
  }
  return result;
}

const SECRET_QUERY_PARAMS = new Set([
  'code',
  'access_token',
  'refresh_token',
  'client_secret',
  'resource_token',
  'code_verifier',
  'token',
]);

/** Masks secret query values; relative or malformed URLs are returned as given. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const name of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY_PARAMS.has(name)) parsed.searchParams.set(name, REDACTED);
    }
    return decodeURI(parsed.toString());
  } catch {
    return url;
  }
}

export interface TruncateOptions {
  maxArrayItems: number;
  maxStringLength: number;
  maxDepth: number;
}

export const INSPECTOR_TRUNCATION: TruncateOptions = {
  maxArrayItems: 4,
  maxStringLength: 400,
  maxDepth: 7,
};

/** Keeps a payload readable and small: long arrays, long strings and deep nesting are cut and marked. */
export function truncateJson(
  value: unknown,
  options: TruncateOptions = INSPECTOR_TRUNCATION,
): { value: unknown; truncated: boolean } {
  let truncated = false;

  const visit = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') {
      if (node.length > options.maxStringLength) {
        truncated = true;
        return `${node.slice(0, options.maxStringLength)}…`;
      }
      return node;
    }
    if (node === null || typeof node !== 'object') return node;
    if (depth >= options.maxDepth) {
      truncated = true;
      return '…';
    }
    if (Array.isArray(node)) {
      const kept = node.slice(0, options.maxArrayItems).map((item) => visit(item, depth + 1));
      if (node.length > options.maxArrayItems) {
        truncated = true;
        kept.push(`… ${node.length - options.maxArrayItems} more`);
      }
      return kept;
    }
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([key, child]) => [
        key,
        visit(child, depth + 1),
      ]),
    );
  };

  const result = visit(value, 0);
  return { value: result, truncated };
}
