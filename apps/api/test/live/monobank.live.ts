import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { ClientInfoDto, StatementDto } from '../../src/providers/monobank/dto';

/**
 * Checks against the real monobank service. Run with `npm run test:live -w @ledger-lens/api`.
 *
 * The first two need nothing. The third reads your own account and only runs when you export your own token in the shell
 * that runs the command (`export MONOBANK_TOKEN=...`): it is never typed into chat, a file or the app for this. It makes at
 * most two requests and prints counts, never balances or descriptions.
 */
const BASE = process.env['MONOBANK_API_URL'] ?? 'https://api.monobank.ua';
const unknownToken = JSON.parse(
  readFileSync(join(import.meta.dirname, '../fixtures/monobank/unknown-token.json'), 'utf8'),
) as unknown;

const RateDto = z.array(
  z.object({
    currencyCodeA: z.number().int(),
    currencyCodeB: z.number().int(),
    date: z.number().int(),
    rateBuy: z.number().optional(),
    rateSell: z.number().optional(),
    rateCross: z.number().optional(),
  }),
);

describe('monobank (live)', () => {
  it('publishes exchange rates without a token, in the documented shape', async () => {
    const response = await fetch(`${BASE}/bank/currency`);
    expect(response.status).toBe(200);
    const rates = RateDto.parse(await response.json());
    expect(rates.length).toBeGreaterThan(5);
    expect(rates.some((r) => r.currencyCodeA === 840 && r.currencyCodeB === 980)).toBe(true); // USD/UAH
  });

  it('answers an unknown token with 403 and the error body the adapter treats as "token not accepted"', async () => {
    const response = await fetch(`${BASE}/personal/client-info`, {
      headers: { 'x-token': 'ledger-lens-live-probe-this-is-not-a-token' },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(unknownToken);
  });

  it.skipIf(!process.env['MONOBANK_TOKEN'])(
    'reads your own accounts and a week of statement in the shape our mappers expect',
    async () => {
      const headers = { 'x-token': process.env['MONOBANK_TOKEN'] ?? '' };
      const infoResponse = await fetch(`${BASE}/personal/client-info`, { headers });
      expect(infoResponse.status, 'client-info (HTTP 429 means wait a minute and retry)').toBe(200);
      const info = ClientInfoDto.parse(await infoResponse.json());
      expect(info.accounts.length).toBeGreaterThan(0);

      const now = Math.floor(Date.now() / 1000);
      const statementResponse = await fetch(
        `${BASE}/personal/statement/${info.accounts[0].id}/${now - 7 * 86_400}/${now}`,
        { headers },
      );
      expect(statementResponse.status, 'statement (HTTP 429 means wait a minute and retry)').toBe(
        200,
      );
      const statement = StatementDto.parse(await statementResponse.json());
      console.info(
        `monobank: ${info.accounts.length} accounts, ${info.jars?.length ?? 0} jars, ${statement.length} statement rows in the last 7 days`,
      );
    },
  );
});
