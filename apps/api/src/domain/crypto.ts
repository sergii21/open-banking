import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export class VaultError extends Error {
  override name = 'VaultError';
}

export interface VaultKey {
  id: string;
  key: Buffer;
}

/**
 * AES-256-GCM sealing for provider tokens at rest.
 *
 * Format: `v1.<keyId>.<iv>.<ciphertext>.<tag>` (base64url parts). The key id lets us rotate: new data is sealed with the
 * current key while older ciphertexts still open with the key id they carry. The additional authenticated data (the
 * owning row's id) binds a ciphertext to its row, so a sealed token cannot be copied onto another connection.
 */
export class TokenVault {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    private readonly current: VaultKey,
    previous: readonly VaultKey[] = [],
  ) {
    for (const { id, key } of [current, ...previous]) {
      if (key.length !== 32) throw new VaultError(`Vault key "${id}" must be 32 bytes`);
      this.keys.set(id, key);
    }
  }

  seal(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.current.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      this.current.id,
      ...[iv, ciphertext, tag].map((b) => b.toString('base64url')),
    ].join('.');
  }

  open(sealed: string, aad: string): string {
    const [version, keyId, iv, ciphertext, tag] = sealed.split('.');
    if (version !== 'v1' || !keyId || !iv || !ciphertext || !tag) {
      throw new VaultError('Sealed value is malformed');
    }
    const key = this.keys.get(keyId);
    if (!key) throw new VaultError(`No vault key "${keyId}" is configured`);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      throw new VaultError('Sealed value could not be authenticated', { cause: error });
    }
  }
}

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Short, URL-safe, prefixed identifier such as `con_k3J9aQ1xT2Lm`. */
export const newId = (prefix: string): string =>
  `${prefix}_${randomBytes(9).toString('base64url')}`;

export function hmacBase64Url(secret: string | Buffer, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** RFC 7636 PKCE pair with the S256 method. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  return safeEqual(createHash('sha256').update(verifier).digest('base64url'), challenge);
}
