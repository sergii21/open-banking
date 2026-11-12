import type { Clock } from '@api/clock';
import type { Calendar } from '@api/domain/calendar';
import {
  FAMILY_NAME_MAX,
  newestBudget,
  parseFamilySummary,
  type FamilyBudget,
  type FamilySummary,
} from '@ledger-lens/contracts';
import type { Store } from '../data/db';
import type { FamilyKeyring } from '../platform/keychain';
import { toBase64Url } from '../platform/node-crypto';
import {
  cleanRelayUrl,
  deriveFamilyKeys,
  fromBase64,
  inviteLink,
  newMemberId,
  parseInvite,
  seal,
  SECRET_BYTES,
  unseal,
  type FamilyKeys,
  type RandomBytes,
} from './crypto';
import { RelayClient, RelayError, type RelayWire } from './relay';
import { buildOwnSummary, summaryMonths } from './summary';

export interface FamilyState {
  joined: boolean;
  memberId: string;
  name: string;
  relayUrl: string;
  shareBalance: boolean;
  /** Everyone's last summary this phone could read, its own among them. */
  summaries: FamilySummary[];
  /** Summaries on the relay this phone could not open or understand (a newer app, or not this family's). */
  unreadable: number;
  /** When the family was last read from the relay, Unix milliseconds. */
  syncedAt: number | null;
  /** False without a real bank on this phone: it watches, and shares no figures. */
  live: boolean;
}

export class FamilyError extends Error {}

const NOT_JOINED: FamilyState = {
  joined: false,
  memberId: '',
  name: '',
  relayUrl: '',
  shareBalance: false,
  summaries: [],
  unreadable: 0,
  syncedAt: null,
  live: false,
};

const cleanName = (name: string): string =>
  name.trim().replace(/\s+/g, ' ').slice(0, FAMILY_NAME_MAX);

/** What went wrong, in words for the person. None of them holds a key, an address or a figure. */
export function familyProblemText(error: unknown): string {
  if (error instanceof FamilyError) return error.message;
  if (error instanceof RelayError) {
    switch (error.problem) {
      case 'offline':
        return 'The relay did not answer. Check the connection and try again.';
      case 'slow-down':
        return 'Too many requests in a minute. Try again shortly.';
      case 'wrong-key':
        return 'The relay keeps this family under another key. Ask for a new invitation.';
      case 'family-full':
        return 'This family already has eight people, which is the most a family can have.';
      case 'relay-full':
        return 'The relay is full and takes no new families.';
      case 'failed':
        return 'The relay answered with something unexpected. Try again later.';
    }
  }
  return 'That did not work. Try again.';
}

/**
 * Family mode on one phone. The phone keeps reading its own bank with its own token; this adds one thing: a summary
 * of the month, sealed with the family's key, left on the relay, and everyone else's read back. The secret is in the
 * Keychain; the name, the relay's address, the budget and the last summaries read are in the app's own database.
 */
export class Family {
  constructor(
    private readonly store: Store,
    private readonly keyring: FamilyKeyring,
    private readonly wire: RelayWire,
    private readonly clock: Clock,
    private readonly calendar: Calendar,
    private readonly random: RandomBytes,
  ) {}

  private async keys(): Promise<FamilyKeys | null> {
    const secret = fromBase64((await this.keyring.load()) ?? '');
    return secret && secret.length === SECRET_BYTES ? deriveFamilyKeys(secret) : null;
  }

  private async budget(): Promise<FamilyBudget | null> {
    const text = await this.store.meta('family.budget');
    return text ? (JSON.parse(text) as FamilyBudget) : null;
  }

  async state(): Promise<FamilyState> {
    const memberId = await this.store.meta('family.memberId');
    if (!memberId || (await this.keys()) === null) return NOT_JOINED;
    const cache = await this.store.meta('family.cache');
    return {
      joined: true,
      memberId,
      name: (await this.store.meta('family.name')) ?? '',
      relayUrl: (await this.store.meta('family.relay')) ?? '',
      shareBalance: (await this.store.meta('family.shareBalance')) === '1',
      summaries: cache ? (JSON.parse(cache) as FamilySummary[]) : [],
      unreadable: Number((await this.store.meta('family.unreadable')) ?? 0),
      syncedAt: Number((await this.store.meta('family.syncedAt')) ?? 0) || null,
      live: (await this.store.meta('connected')) === 'live',
    };
  }

  /** Starts a new family on this phone. Nothing is kept unless the relay took the first summary. */
  async start(name: string, relayAddress: string): Promise<void> {
    const relayUrl = cleanRelayUrl(relayAddress);
    if (!relayUrl) {
      throw new FamilyError('The relay address has to begin with https:// and be a plain address.');
    }
    await this.enter(this.random(SECRET_BYTES), relayUrl, name);
  }

  /** Joins the family an invitation is for: the link from the QR code, or text with the link in it. */
  async join(invitation: string, name: string): Promise<void> {
    const parsed = parseInvite(invitation);
    if (!parsed) throw new FamilyError('That is not a Ledger Lens family invitation.');
    await this.enter(parsed.secret, parsed.relayUrl, name);
  }

  private async enter(secret: Uint8Array, relayUrl: string, typedName: string): Promise<void> {
    const name = cleanName(typedName);
    if (name === '') throw new FamilyError('Type the name your family will see.');
    if ((await this.state()).joined) throw new FamilyError('Leave the current family first.');
    await this.keyring.keep(toBase64Url(secret));
    await this.store.setMeta('family.memberId', newMemberId(this.random));
    await this.store.setMeta('family.name', name);
    await this.store.setMeta('family.relay', relayUrl);
    await this.store.setMeta('family.shareBalance', '0');
    try {
      await this.refresh();
    } catch (error) {
      await this.forget();
      throw error;
    }
  }

  /** The link to show as a QR code. It holds the family secret: for the family's eyes only. */
  async invitation(): Promise<string | null> {
    const secret = fromBase64((await this.keyring.load()) ?? '');
    const relayUrl = await this.store.meta('family.relay');
    return secret && secret.length === SECRET_BYTES && relayUrl
      ? inviteLink({ secret, relayUrl })
      : null;
  }

  /** Leaves this phone's summary on the relay, then reads everyone's. */
  async refresh(): Promise<void> {
    const state = await this.state();
    const keys = await this.keys();
    if (!state.joined || !keys) return;
    const relay = new RelayClient(this.wire, state.relayUrl, keys);
    const now = this.clock.now().getTime();
    const [, previousMonth] = summaryMonths(this.calendar.dayKey(now));
    const own = buildOwnSummary({
      memberId: state.memberId,
      name: state.name,
      now,
      calendar: this.calendar,
      live: state.live,
      shareBalance: state.shareBalance,
      accounts: await this.store.accounts(),
      rates: await this.store.rates(),
      transactions: await this.store.bookedSince(this.calendar.dayStart(`${previousMonth}-01`)),
      budget: await this.budget(),
    });
    await relay.put(state.memberId, seal(keys, state.memberId, JSON.stringify(own), this.random));

    const summaries: FamilySummary[] = [];
    let unreadable = 0;
    for (const member of await relay.list()) {
      const text = unseal(keys, member.id, member.blob);
      let summary: FamilySummary | null;
      try {
        summary = text === null ? null : parseFamilySummary(JSON.parse(text));
      } catch {
        summary = null;
      }
      // The id inside has to be the one the relay filed it under: a summary cannot speak for someone else.
      if (summary && summary.memberId === member.id) summaries.push(summary);
      else unreadable += 1;
    }
    // The newest budget anyone carries becomes this phone's too, so it outlives the person who set it.
    const newest = newestBudget(summaries);
    if (newest && newest.setAt > (own.budget?.setAt ?? 0)) {
      await this.store.setMeta('family.budget', JSON.stringify(newest));
    }
    await this.store.setMeta('family.cache', JSON.stringify(summaries));
    await this.store.setMeta('family.unreadable', String(unreadable));
    await this.store.setMeta('family.syncedAt', String(now));
  }

  /** The family's monthly budget in kopiykas; 0 removes it. Everyone sees it after their next refresh. */
  async setBudget(monthlyMinor: number): Promise<void> {
    const state = await this.state();
    if (!state.joined) return;
    if (!Number.isSafeInteger(monthlyMinor) || monthlyMinor < 0) {
      throw new FamilyError('Type the budget as an amount in hryvnias.');
    }
    const budget: FamilyBudget = {
      monthlyMinor,
      setAt: this.clock.now().getTime(),
      setBy: state.name,
    };
    await this.store.setMeta('family.budget', JSON.stringify(budget));
    await this.refresh();
  }

  async setShareBalance(share: boolean): Promise<void> {
    if (!(await this.state()).joined) return;
    await this.store.setMeta('family.shareBalance', share ? '1' : '0');
    await this.refresh();
  }

  /** Takes this phone's summary off the relay and forgets the family. Off the relay first: afterwards there is no key. */
  async leave(): Promise<void> {
    const state = await this.state();
    const keys = await this.keys();
    if (state.joined && keys) {
      await new RelayClient(this.wire, state.relayUrl, keys).remove(state.memberId);
    }
    await this.forget();
  }

  /** Forgets the family on this phone only, for when the relay cannot be reached. Its copy expires by itself. */
  async forget(): Promise<void> {
    await this.keyring.drop();
    await this.store.clearMetaLike('family.');
  }
}
