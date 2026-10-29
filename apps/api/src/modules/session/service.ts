import type { SessionInfo } from '@ledger-lens/contracts';
import type { SessionRecord } from '../../db/repos';
import { hmacBase64Url, randomToken, sha256Hex } from '../../domain/crypto';
import type { CoreContext } from '../../types';
import type { ConnectionService } from '../connections/service';
import type { ProviderRegistry } from '../../providers/registry';

const DAY_MS = 86_400_000;
/** Do not write on every request: refresh `last_seen_at` at most this often. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

export const CSRF_COOKIE = 'XSRF-TOKEN';
export const CSRF_HEADER = 'x-xsrf-token';

/**
 * Anonymous demo sessions. The cookie carries a random 256-bit token; the database only ever stores its SHA-256, so a
 * leaked database cannot be replayed as sessions. There are no user accounts: a session owns its connections, and
 * "delete my data" deletes the session.
 */
export class SessionService {
  /** When each address last started sessions, newest last: a one-minute sliding window, kept in memory. */
  private readonly creations = new Map<string, number[]>();

  constructor(
    private readonly core: CoreContext,
    private readonly providers: ProviderRegistry,
    private readonly connections: ConnectionService,
  ) {}

  /** `__Host-` pins the cookie to this exact host over https (no Domain attribute, Path=/, Secure). */
  get cookieName(): string {
    return this.core.config.secureCookies ? '__Host-ll_sid' : 'll_sid';
  }

  get cookieMaxAgeSeconds(): number {
    return this.core.config.sessionTtlDays * 86_400;
  }

  /**
   * Whether this address may start another session right now. Starting one is free for the caller and costs us a row, so
   * without a cap a loop could fill the database; real people start a handful. Returns seconds to wait when refused.
   */
  admitCreation(address: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = this.core.clock.now().getTime();
    const recent = (this.creations.get(address) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= this.core.config.sessionCreatesPerMinute) {
      this.creations.set(address, recent);
      const oldest = recent[0] ?? now;
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000)),
      };
    }
    recent.push(now);
    this.creations.set(address, recent);
    if (this.creations.size > 10_000) {
      for (const [key, times] of this.creations) {
        if (times.every((at) => now - at >= 60_000)) this.creations.delete(key);
      }
    }
    return { ok: true };
  }

  create(): { token: string; record: SessionRecord } {
    const token = randomToken(32);
    const record = this.core.repos.sessions.create(
      sha256Hex(token),
      this.core.clock.now().toISOString(),
    );
    return { token, record };
  }

  resolve(token: string | undefined): SessionRecord | null {
    if (!token) return null;
    const record = this.core.repos.sessions.find(sha256Hex(token));
    if (!record) return null;

    const now = this.core.clock.now().getTime();
    const lastSeen = Date.parse(record.lastSeenAt);
    if (now - lastSeen > this.core.config.sessionTtlDays * DAY_MS) {
      this.core.repos.sessions.delete(record.id);
      return null;
    }
    if (now - lastSeen > TOUCH_INTERVAL_MS) {
      this.core.repos.sessions.touch(record.id, new Date(now).toISOString());
    }
    return record;
  }

  /** Bound to the session, so a token from one session is useless in another. */
  csrfToken(sessionId: string): string {
    return hmacBase64Url(this.core.config.sessionSecret, `csrf:${sessionId}`);
  }

  toInfo(record: SessionRecord): SessionInfo {
    const { config } = this.core;
    return {
      id: record.id.slice(0, 8),
      createdAt: record.createdAt,
      environment: config.env,
      demoControls: config.demoControls,
      providers: this.providers.all().map((provider) => ({
        id: provider.id,
        mode: provider.mode,
        label: provider.label,
      })),
      limits: {
        maxPaymentMinor: config.maxPaymentMinor,
        refreshCooldownSeconds: config.refreshCooldownSeconds,
      },
    };
  }

  /** GDPR "delete my data": withdraw consents at the banks (best effort), then erase the session and everything under it. */
  async deleteAll(record: SessionRecord): Promise<void> {
    await this.connections.revokeAll(record.id);
    this.core.repos.sessions.delete(record.id);
    this.core.inspector.clear(record.id);
  }

  purgeIdle(): number {
    const cutoff = new Date(
      this.core.clock.now().getTime() - this.core.config.sessionTtlDays * DAY_MS,
    );
    return this.core.repos.sessions.purgeIdleBefore(cutoff.toISOString());
  }
}
