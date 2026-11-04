import { randomUUID } from 'node:crypto';
import type {
  WiseDraftCreated,
  WiseDraftOverview,
  WiseDraftQuote,
  WiseDraftSource,
} from '@ledger-lens/contracts';
import type { AccountRecord, ConnectionRecord } from '../../db/repos';
import { AppError, notFound } from '../../errors';
import type { BankingProvider } from '../../providers/port';
import { WiseProvider } from '../../providers/wise/adapter';
import type { CoreContext } from '../../types';
import type { ConnectionAccess } from '../connection/access';

const wiseOf = (provider: BankingProvider): WiseProvider => {
  if (provider instanceof WiseProvider) return provider;
  throw new AppError('provider_not_available', 404, 'Wise is not available here.');
};

const profileOf = (account: AccountRecord): number => {
  const profile = Number(account.providerAccountId.split(':')[0]);
  if (!Number.isSafeInteger(profile)) throw notFound('Wise balance');
  return profile;
};

/**
 * Draft transfers: the person picks a saved recipient and an amount, sees Wise's price and creates the transfer unpaid. They pay it
 * in Wise; nothing here can. Nothing is stored either: Wise holds the transfer, and the profile always comes from an account already
 * in this session, never from the browser.
 */
export class WiseDraftService {
  constructor(
    private readonly core: CoreContext,
    private readonly access: ConnectionAccess,
  ) {}

  private connection(sessionId: string): ConnectionRecord {
    const connection = this.core.repos.connections.findByProvider(sessionId, 'wise');
    if (!connection) throw notFound('Wise connection');
    return connection;
  }

  /** Current balances only: a jar is not something a transfer is priced from. */
  private balances(connection: ConnectionRecord): AccountRecord[] {
    return this.core.repos.accounts
      .listByConnection(connection.id)
      .filter((a) => a.kind === 'card' && a.cardType === 'wise');
  }

  private balance(connection: ConnectionRecord, accountId: string | undefined): AccountRecord {
    const balances = this.balances(connection);
    const found = accountId === undefined ? balances[0] : balances.find((a) => a.id === accountId);
    if (!found) throw notFound('Wise balance');
    return found;
  }

  async overview(sessionId: string, accountId: string | undefined): Promise<WiseDraftOverview> {
    const connection = this.connection(sessionId);
    const chosen = this.balance(connection, accountId);
    const profile = profileOf(chosen);
    const groups: number[] = [];
    const sources: WiseDraftSource[] = this.balances(connection).map((a) => {
      const owner = profileOf(a);
      if (!groups.includes(owner)) groups.push(owner);
      return {
        accountId: a.id,
        name: a.name,
        currency: a.currency,
        balanceMinor: a.balanceMinor,
        group: groups.indexOf(owner),
      };
    });
    return this.access.withTokens(connection, async (tokens, provider, call) => {
      const wise = wiseOf(provider);
      const { recipients, more } = await wise.listRecipients(tokens, call, profile);
      const waiting = await wise.listWaiting(tokens, call, profile);
      const names = new Map(recipients.map((r) => [r.id, r.name]));
      return {
        sources,
        accountId: chosen.id,
        recipients,
        moreRecipients: more,
        waiting: waiting.map((t) => ({
          id: t.id,
          targetMinor: t.targetMinor,
          targetCurrency: t.targetCurrency,
          recipientName: t.recipientId === null ? null : (names.get(t.recipientId) ?? null),
          createdOn: t.createdOn,
        })),
      };
    });
  }

  async quote(
    sessionId: string,
    input: { accountId: string; recipientId: number; targetCurrency: string; amountMinor: number },
  ): Promise<WiseDraftQuote> {
    const connection = this.connection(sessionId);
    const source = this.balance(connection, input.accountId);
    const quote = await this.access.withTokens(connection, (tokens, provider, call) =>
      wiseOf(provider).quoteDraft(tokens, call, {
        profileId: profileOf(source),
        recipientId: input.recipientId,
        sourceCurrency: source.currency,
        targetCurrency: input.targetCurrency,
        sourceMinor: input.amountMinor,
      }),
    );
    return { ...quote, draftKey: randomUUID() };
  }

  async create(
    sessionId: string,
    input: {
      accountId: string;
      recipientId: number;
      quoteId: string;
      draftKey: string;
      reference?: string | undefined;
    },
  ): Promise<WiseDraftCreated> {
    const connection = this.connection(sessionId);
    this.balance(connection, input.accountId);
    const created = await this.access.withTokens(connection, (tokens, provider, call) =>
      wiseOf(provider).createDraft(tokens, call, {
        recipientId: input.recipientId,
        quoteId: input.quoteId,
        key: input.draftKey,
        reference: input.reference?.trim() || null,
      }),
    );
    return { transferId: created.transferId };
  }
}
