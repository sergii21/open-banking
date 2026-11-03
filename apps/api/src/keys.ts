import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export interface StoredKeys {
  /** HMAC key for CSRF tokens. */
  session: string;
  /** 32 bytes, base64: AES-256-GCM key that seals the bank token at rest. */
  token: string;
}

export const KEY_FILE = 'secret.key';

/**
 * The keys are generated on the first run and kept next to the database with owner-only permissions, so there is nothing to
 * configure and no key in the code or in `.env.example`. Losing the file only means the stored token can no longer be opened:
 * the app asks for it again.
 */
export function loadOrCreateKeys(dataDir: string): StoredKeys {
  const path = join(dataDir, KEY_FILE);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredKeys>;
      if (
        typeof parsed.session === 'string' &&
        typeof parsed.token === 'string' &&
        Buffer.from(parsed.token, 'base64').length === 32
      ) {
        // Someone may have copied it around; make sure it is readable by the owner only.
        if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
        return { session: parsed.session, token: parsed.token };
      }
    } catch {
      // Unreadable: fall through and make a fresh one. Existing sealed tokens cannot be opened any more and are asked for again.
    }
  }
  const keys: StoredKeys = {
    session: randomBytes(48).toString('base64'),
    token: randomBytes(32).toString('base64'),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(keys), { mode: 0o600 });
  chmodSync(path, 0o600);
  return keys;
}
