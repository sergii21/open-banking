import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { toBase64Url, toHex, utf8Bytes } from '../platform/node-crypto';
import { decodeUtf8 } from '../platform/text-decoder';

/**
 * What keeps a family's figures between its phones. One 256-bit secret, made on the phone that starts the family and
 * passed to the others as a QR code or a link, gives three things (HKDF-SHA256):
 *
 *  - the family id the relay files summaries under,
 *  - the access key the relay asks for (it keeps only a hash of it),
 *  - the encryption key, which never leaves the phones.
 *
 * A summary is sealed with XChaCha20-Poly1305 under a fresh random nonce, bound to the family and the person it is
 * from, so the relay can neither read one nor pass one person's off as another's. The ciphers are @noble's (audited,
 * plain JavaScript); nothing here is home-made but the framing.
 */

export type RandomBytes = (length: number) => Uint8Array;

export interface FamilyKeys {
  /** 32 hex characters. */
  familyId: string;
  /** 43 base64url characters: sent to the relay as a bearer key. */
  accessKey: string;
  encryptionKey: Uint8Array;
}

const SALT = utf8Bytes('ledger-lens-family-v1');
const SEAL_VERSION = 1;
const NONCE_BYTES = 24;
/** Sealed summaries are padded to a multiple of this, so their size says little about what is in them. */
const PAD_TO = 1024;

export const SECRET_BYTES = 32;

export function deriveFamilyKeys(secret: Uint8Array): FamilyKeys {
  if (secret.length !== SECRET_BYTES) throw new Error('A family secret is 32 bytes.');
  const part = (info: string, length: number): Uint8Array =>
    hkdf(sha256, secret, SALT, utf8Bytes(info), length);
  return {
    familyId: toHex(part('id', 16)),
    accessKey: toBase64Url(part('access', 32)),
    encryptionKey: part('encryption', 32),
  };
}

export const newMemberId = (random: RandomBytes): string => toHex(random(8));

const bound = (keys: FamilyKeys, memberId: string): Uint8Array =>
  utf8Bytes(`ledger-lens-family-v1|${keys.familyId}|${memberId}`);

/** Version byte, nonce, ciphertext with its tag. The text is JSON, padded with spaces, which JSON ignores. */
export function seal(
  keys: FamilyKeys,
  memberId: string,
  json: string,
  random: RandomBytes,
): Uint8Array {
  const text = utf8Bytes(json);
  const padded = new Uint8Array(Math.ceil((text.length + 1) / PAD_TO) * PAD_TO).fill(0x20);
  padded.set(text);
  const nonce = random(NONCE_BYTES);
  const sealed = xchacha20poly1305(keys.encryptionKey, nonce, bound(keys, memberId)).encrypt(
    padded,
  );
  const out = new Uint8Array(1 + NONCE_BYTES + sealed.length);
  out[0] = SEAL_VERSION;
  out.set(nonce, 1);
  out.set(sealed, 1 + NONCE_BYTES);
  return out;
}

/** The JSON text, or null when the bytes were not sealed with this family's key for this person. */
export function unseal(keys: FamilyKeys, memberId: string, blob: Uint8Array): string | null {
  if (blob.length <= 1 + NONCE_BYTES + 16 || blob[0] !== SEAL_VERSION) return null;
  try {
    const nonce = blob.slice(1, 1 + NONCE_BYTES);
    const plain = xchacha20poly1305(keys.encryptionKey, nonce, bound(keys, memberId)).decrypt(
      blob.slice(1 + NONCE_BYTES),
    );
    return decodeUtf8(plain, true).trimEnd();
  } catch {
    return null;
  }
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 or base64url, with or without padding; null when a character is neither. */
export function fromBase64(text: string): Uint8Array | null {
  const clean = text.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    let value = B64URL.indexOf(char);
    if (value < 0) value = B64.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

// ------------------------------------------------------------------------------------------------- invitations

export interface Invitation {
  secret: Uint8Array;
  /** The relay's address, `https://…` with no trailing slash. */
  relayUrl: string;
}

export const INVITE_PREFIX = 'ledgerlens://family#v1.';

/** `https://host[:port][/path]` with no trailing slash, or null: the phone talks to a relay over HTTPS only. */
export function cleanRelayUrl(text: string): string | null {
  const url = text.trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/i.test(url) ? url : null;
}

/**
 * The link a QR code carries. iPhone's camera opens it in the app; it can also be pasted. Everything after `#` stays
 * on the phones: it is the family secret, so it is shown to the family and to nobody else.
 */
export function inviteLink(invitation: Invitation): string {
  return `${INVITE_PREFIX}${toBase64Url(invitation.secret)}.${toBase64Url(utf8Bytes(invitation.relayUrl))}`;
}

/** Finds an invitation anywhere in pasted text. */
export function parseInvite(text: string): Invitation | null {
  const match = /ledgerlens:\/\/family#v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{1,400})/.exec(text);
  if (!match) return null;
  const secret = fromBase64(match[1] ?? '');
  const address = fromBase64(match[2] ?? '');
  if (!secret || secret.length !== SECRET_BYTES || !address) return null;
  let relayUrl: string | null;
  try {
    relayUrl = cleanRelayUrl(decodeUtf8(address, true));
  } catch {
    return null;
  }
  return relayUrl ? { secret, relayUrl } : null;
}
