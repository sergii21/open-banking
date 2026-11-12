/**
 * The family relay: a place where phones leave sealed summaries for each other. It never sees a key and cannot read
 * what it keeps: a summary arrives as bytes already encrypted on the phone and leaves the same way.
 *
 * Who may use a family: whoever holds its access key, which every phone derives from the family secret. The first
 * summary stored under a family id fixes that key (only its SHA-256 is kept); after that every read and write must
 * bring it. The id and the key come from a 256-bit secret, so neither can be guessed.
 *
 * Written against the web's own Request and Response, with storage and the clock passed in, so the same code runs
 * under Node (`server.ts`) and can run on any host that speaks them.
 */

export const LIMITS = {
  maxMembers: 8,
  maxBlobBytes: 32 * 1024,
  maxFamilies: 20_000,
  expiryMs: 90 * 24 * 60 * 60_000,
  requestsPerMinute: 60,
} as const;

export interface StoredMember {
  id: string;
  /** Unix milliseconds, by the relay's clock. */
  updatedAt: number;
  blob: Uint8Array;
}

type Maybe<T> = T | Promise<T>;

export interface RelayStore {
  accessHash(familyId: string): Maybe<string | null>;
  createFamily(familyId: string, accessHash: string, now: number): Maybe<void>;
  familyCount(): Maybe<number>;
  members(familyId: string): Maybe<StoredMember[]>;
  putMember(familyId: string, memberId: string, blob: Uint8Array, now: number): Maybe<void>;
  removeMember(familyId: string, memberId: string): Maybe<void>;
  removeFamily(familyId: string): Maybe<void>;
  /** Removes summaries last written before `before`, then families left with none. */
  purge(before: number): Maybe<void>;
}

export interface RelayDeps {
  store: RelayStore;
  now: () => number;
  limits?: Partial<typeof LIMITS>;
}

const FAMILY_ID = /^[0-9a-f]{32}$/;
const MEMBER_ID = /^[0-9a-f]{16,32}$/;
const ACCESS_KEY = /^[A-Za-z0-9_-]{43}$/;
const PURGE_EVERY_MS = 60 * 60_000;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
const problem = (status: number, code: string): Response => json(status, { error: code });
const empty = (): Response => new Response(null, { status: 204 });

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Both are SHA-256 hex of the same length; every character is compared whatever the outcome. */
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class Relay {
  private readonly limits: typeof LIMITS;
  private readonly windows = new Map<string, { start: number; count: number }>();
  private purgedAt = 0;

  constructor(private readonly deps: RelayDeps) {
    this.limits = { ...LIMITS, ...deps.limits };
  }

  /** One fixed minute per client. The client is whatever the host says it is (an address); it is never stored. */
  private allowed(client: string, now: number): boolean {
    if (this.windows.size > 50_000) this.windows.clear();
    const window = this.windows.get(client);
    if (!window || now - window.start >= 60_000) {
      this.windows.set(client, { start: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.limits.requestsPerMinute;
  }

  private async purge(now: number): Promise<void> {
    if (now - this.purgedAt < PURGE_EVERY_MS) return;
    this.purgedAt = now;
    await this.deps.store.purge(now - this.limits.expiryMs);
  }

  async handle(request: Request, client: string): Promise<Response> {
    const now = this.deps.now();
    const { pathname } = new URL(request.url);
    if (pathname === '/health' && request.method === 'GET') return json(200, { ok: true });
    if (!this.allowed(client, now)) return problem(429, 'slow-down');

    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] !== 'v1' || parts[1] !== 'families') return problem(404, 'not-found');
    const familyId = parts[2] ?? '';
    if (!FAMILY_ID.test(familyId)) return problem(404, 'not-found');
    const key = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
    if (!ACCESS_KEY.test(key)) return problem(401, 'no-key');
    const offered = await sha256Hex(key);
    const { store } = this.deps;
    const known = await store.accessHash(familyId);
    const mine = known !== null && sameHash(known, offered);

    if (parts.length === 3 && request.method === 'GET') {
      // A family that does not exist and one whose key this is not look the same from outside.
      if (!mine) return problem(404, 'not-found');
      await this.purge(now);
      const members = await store.members(familyId);
      return json(200, {
        now,
        members: members.map((member) => ({
          id: member.id,
          updatedAt: member.updatedAt,
          blob: toBase64(member.blob),
        })),
      });
    }

    const memberId = parts[4] ?? '';
    if (parts.length !== 5 || parts[3] !== 'members' || !MEMBER_ID.test(memberId)) {
      return problem(404, 'not-found');
    }

    if (request.method === 'PUT') {
      if (known !== null && !mine) return problem(403, 'wrong-key');
      const declared = Number(request.headers.get('content-length') ?? 0);
      if (declared > this.limits.maxBlobBytes) return problem(413, 'too-large');
      const blob = new Uint8Array(await request.arrayBuffer());
      if (blob.length === 0) return problem(400, 'empty');
      if (blob.length > this.limits.maxBlobBytes) return problem(413, 'too-large');
      await this.purge(now);
      if (known === null) {
        if ((await store.familyCount()) >= this.limits.maxFamilies)
          return problem(507, 'relay-full');
        await store.createFamily(familyId, offered, now);
      } else {
        const members = await store.members(familyId);
        if (
          members.length >= this.limits.maxMembers &&
          !members.some((member) => member.id === memberId)
        ) {
          return problem(409, 'family-full');
        }
      }
      await store.putMember(familyId, memberId, blob, now);
      return empty();
    }

    if (request.method === 'DELETE') {
      if (!mine) return problem(404, 'not-found');
      await store.removeMember(familyId, memberId);
      if ((await store.members(familyId)).length === 0) await store.removeFamily(familyId);
      return empty();
    }

    return problem(405, 'method');
  }
}

/** Keeps everything in memory: for the tests, and for the phone app's tests, which talk to a real relay in-process. */
export class MemoryRelayStore implements RelayStore {
  private readonly families = new Map<
    string,
    { hash: string; members: Map<string, StoredMember> }
  >();

  accessHash(familyId: string): string | null {
    return this.families.get(familyId)?.hash ?? null;
  }
  createFamily(familyId: string, accessHash: string): void {
    this.families.set(familyId, { hash: accessHash, members: new Map() });
  }
  familyCount(): number {
    return this.families.size;
  }
  members(familyId: string): StoredMember[] {
    return [...(this.families.get(familyId)?.members.values() ?? [])].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }
  putMember(familyId: string, memberId: string, blob: Uint8Array, now: number): void {
    this.families.get(familyId)?.members.set(memberId, { id: memberId, updatedAt: now, blob });
  }
  removeMember(familyId: string, memberId: string): void {
    this.families.get(familyId)?.members.delete(memberId);
  }
  removeFamily(familyId: string): void {
    this.families.delete(familyId);
  }
  purge(before: number): void {
    for (const [id, family] of this.families) {
      for (const member of family.members.values()) {
        if (member.updatedAt < before) family.members.delete(member.id);
      }
      if (family.members.size === 0) this.families.delete(id);
    }
  }
}
