import type { Clock } from '../../clock';
import { newId, randomToken, sha256Hex, verifyPkce } from '../../domain/crypto';
import type { Db } from '../../db/database';

export const MOCK_CLIENT_ID = 'ledger-lens-mock';
export const MOCK_CLIENT_SECRET = 'mock-client-secret';
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
const AUTH_CODE_TTL_MS = 60_000;

export interface MockConsent {
  id: string;
  institution: string;
  persona: string;
  clientId: string;
  seed: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  failNext: 'unavailable' | 'rate_limit' | null;
}

interface ConsentRow {
  id: string;
  institution: string;
  persona: string;
  client_id: string;
  seed: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  fail_next: string | null;
}

const toConsent = (row: ConsentRow): MockConsent => ({
  id: row.id,
  institution: row.institution,
  persona: row.persona,
  clientId: row.client_id,
  seed: row.seed,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  failNext:
    row.fail_next === 'unavailable' || row.fail_next === 'rate_limit' ? row.fail_next : null,
});

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

/** The fake bank's own database tables. Only providers/mock may use this. */
export class MockBankStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  private nowIso(): string {
    return this.clock.now().toISOString();
  }

  createConsent(input: {
    institution: string;
    persona: string;
    seed: string;
    validDays: number;
    clientId?: string;
  }): MockConsent {
    const now = this.clock.now();
    const consent: MockConsent = {
      id: newId('mbc'),
      institution: input.institution,
      persona: input.persona,
      clientId: input.clientId ?? MOCK_CLIENT_ID,
      seed: input.seed,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.validDays * 86_400_000).toISOString(),
      revokedAt: null,
      failNext: null,
    };
    this.db.run(
      `INSERT INTO mock_consents (id, institution, persona, client_id, seed, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      consent.id,
      consent.institution,
      consent.persona,
      consent.clientId,
      consent.seed,
      consent.createdAt,
      consent.expiresAt,
    );
    return consent;
  }

  getConsent(id: string): MockConsent | undefined {
    const row = this.db.get<ConsentRow>('SELECT * FROM mock_consents WHERE id = ?', id);
    return row ? toConsent(row) : undefined;
  }

  createAuthCode(consentId: string, redirectUri: string, codeChallenge: string | null): string {
    const code = `mbk_code_${randomToken(24)}`;
    this.db.run(
      `INSERT INTO mock_auth_codes (code_hash, consent_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)`,
      sha256Hex(code),
      consentId,
      redirectUri,
      codeChallenge,
      new Date(this.clock.now().getTime() + AUTH_CODE_TTL_MS).toISOString(),
    );
    return code;
  }

  /** Single use, bound to the redirect URI, and PKCE-checked. Returns the consent or an OAuth error. */
  redeemAuthCode(
    code: string,
    redirectUri: string,
    verifier: string | undefined,
  ): { ok: true; consent: MockConsent } | { ok: false; error: string } {
    const row = this.db.get<{
      consent_id: string;
      redirect_uri: string;
      code_challenge: string | null;
      expires_at: string;
      used_at: string | null;
    }>('SELECT * FROM mock_auth_codes WHERE code_hash = ?', sha256Hex(code));
    if (!row) return { ok: false, error: 'invalid_grant' };
    if (row.used_at) return { ok: false, error: 'invalid_grant' };
    this.db.run(
      'UPDATE mock_auth_codes SET used_at = ? WHERE code_hash = ?',
      this.nowIso(),
      sha256Hex(code),
    );
    if (row.expires_at <= this.nowIso()) return { ok: false, error: 'invalid_grant' };
    if (row.redirect_uri !== redirectUri) return { ok: false, error: 'invalid_grant' };
    if (row.code_challenge && (!verifier || !verifyPkce(verifier, row.code_challenge))) {
      return { ok: false, error: 'invalid_grant' };
    }
    const consent = this.getConsent(row.consent_id);
    return consent ? { ok: true, consent } : { ok: false, error: 'invalid_grant' };
  }

  issueTokens(consentId: string): IssuedTokens {
    const accessToken = `mbk_at_${randomToken(24)}`;
    const refreshToken = `mbk_rt_${randomToken(24)}`;
    const now = this.clock.now().getTime();
    this.db.run(
      `INSERT INTO mock_tokens (token_hash, kind, consent_id, expires_at) VALUES (?, 'access', ?, ?)`,
      sha256Hex(accessToken),
      consentId,
      new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    );
    // Refresh tokens live as long as the consent does.
    const consent = this.getConsent(consentId);
    this.db.run(
      `INSERT INTO mock_tokens (token_hash, kind, consent_id, expires_at) VALUES (?, 'refresh', ?, ?)`,
      sha256Hex(refreshToken),
      consentId,
      consent?.expiresAt ?? new Date(now).toISOString(),
    );
    return { accessToken, refreshToken, expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS };
  }

  /** Rotating refresh: the presented token is spent. Fails if the consent was revoked or has ended. */
  redeemRefreshToken(refreshToken: string): { ok: true; consent: MockConsent } | { ok: false } {
    const row = this.db.get<{ consent_id: string; expires_at: string; used_at: string | null }>(
      `SELECT consent_id, expires_at, used_at FROM mock_tokens WHERE token_hash = ? AND kind = 'refresh'`,
      sha256Hex(refreshToken),
    );
    if (!row || row.used_at || row.expires_at <= this.nowIso()) return { ok: false };
    const consent = this.getConsent(row.consent_id);
    if (!consent || consent.revokedAt || consent.expiresAt <= this.nowIso()) return { ok: false };
    this.db.run(
      `UPDATE mock_tokens SET used_at = ? WHERE token_hash = ?`,
      this.nowIso(),
      sha256Hex(refreshToken),
    );
    return { ok: true, consent };
  }

  resolveAccessToken(
    accessToken: string,
  ): { state: 'unknown' } | { state: 'expired' } | { state: 'ok'; consent: MockConsent } {
    const row = this.db.get<{ consent_id: string; expires_at: string }>(
      `SELECT consent_id, expires_at FROM mock_tokens WHERE token_hash = ? AND kind = 'access'`,
      sha256Hex(accessToken),
    );
    if (!row) return { state: 'unknown' };
    const consent = this.getConsent(row.consent_id);
    if (!consent || consent.revokedAt) return { state: 'unknown' };
    if (row.expires_at <= this.nowIso()) return { state: 'expired' };
    return { state: 'ok', consent };
  }

  /** Consent id behind a token pair, used by the demo controls (the BFF never learns this id). */
  consentForAccessToken(accessToken: string): MockConsent | undefined {
    const row = this.db.get<{ consent_id: string }>(
      `SELECT consent_id FROM mock_tokens WHERE token_hash = ? AND kind = 'access'`,
      sha256Hex(accessToken),
    );
    return row ? this.getConsent(row.consent_id) : undefined;
  }

  revoke(consentId: string): void {
    this.db.run(
      `UPDATE mock_consents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
      this.nowIso(),
      consentId,
    );
  }

  setExpiry(consentId: string, expiresAt: string): void {
    this.db.run('UPDATE mock_consents SET expires_at = ? WHERE id = ?', expiresAt, consentId);
    this.db.run(
      `UPDATE mock_tokens SET expires_at = ? WHERE consent_id = ? AND kind = 'refresh'`,
      expiresAt,
      consentId,
    );
  }

  setFailNext(consentId: string, kind: 'unavailable' | 'rate_limit' | null): void {
    this.db.run('UPDATE mock_consents SET fail_next = ? WHERE id = ?', kind, consentId);
  }

  /** Reads and clears the one-shot failure flag. */
  takeFailNext(consentId: string): 'unavailable' | 'rate_limit' | null {
    const consent = this.getConsent(consentId);
    if (!consent?.failNext) return null;
    this.setFailNext(consentId, null);
    return consent.failNext;
  }
}
