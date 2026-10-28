import { isValidIban } from '@ledger-lens/contracts';
import { describe, expect, it } from 'vitest';
import { buildDataset } from '../src/providers/mock/dataset';
import { findMockInstitution } from '../src/providers/mock/institutions';

const TODAY = new Date('2026-10-28T10:00:00.000Z');
const DE = findMockInstitution('mock-bank')!;
const GB = findMockInstitution('mock-bank-uk')!;

describe('mock bank dataset', () => {
  it('is deterministic for the same seed and day', () => {
    const a = buildDataset({
      seed: 'standard:mock-bank',
      institution: DE,
      profile: 'standard',
      today: TODAY,
    });
    const b = buildDataset({
      seed: 'standard:mock-bank',
      institution: DE,
      profile: 'standard',
      today: TODAY,
    });
    expect(b.transactions).toEqual(a.transactions);
    expect(b.accounts).toEqual(a.accounts);
  });

  it('does not reshuffle history when the window slides by a day', () => {
    const today = buildDataset({ seed: 's', institution: DE, profile: 'standard', today: TODAY });
    const tomorrow = buildDataset({
      seed: 's',
      institution: DE,
      profile: 'standard',
      today: new Date('2026-10-29T10:00:00.000Z'),
    });
    const settled = (d: typeof today) =>
      d.transactions
        .filter((t) => !t.pending && t.date <= '2026-10-26')
        .map((t) => `${t.id}|${t.amountMinor}|${t.description}`);
    expect(settled(tomorrow)).toEqual(settled(today));
  });

  it('produces valid IBANs and the expected accounts per market', () => {
    const de = buildDataset({ seed: 's', institution: DE, profile: 'standard', today: TODAY });
    expect(de.accounts.map((a) => a.name)).toEqual(['Girokonto', 'Tagesgeld', 'Visa Gold']);
    for (const account of de.accounts.filter((a) => a.iban))
      expect(isValidIban(account.iban as string)).toBe(true);

    const gb = buildDataset({ seed: 's', institution: GB, profile: 'standard', today: TODAY });
    expect(gb.accounts.map((a) => a.name)).toEqual(['Everyday Account', 'Easy Saver']);
    for (const account of gb.accounts) {
      expect(isValidIban(account.iban as string)).toBe(true);
      expect(account.sortCode).toBe('040004');
      expect(account.accountNumber).toMatch(/^\d{8}$/);
    }
  });

  it('lands the current balance on the target and keeps card settlements consistent', () => {
    const de = buildDataset({ seed: 's', institution: DE, profile: 'standard', today: TODAY });
    const [current, savings, card] = de.accounts;
    expect(de.balances.get(current.id)?.currentMinor).toBe(284_013);
    expect(de.balances.get(savings.id)?.currentMinor).toBe(841_560);
    // The card balance is whatever has been spent since the last settlement: never positive, never beyond the limit.
    const cardBalance = de.balances.get(card.id)!.currentMinor;
    expect(cardBalance).toBeLessThanOrEqual(0);
    expect(cardBalance).toBeGreaterThan(-card.headroomMinor);

    // Every settlement on the current account has a matching payment on the card on the same day.
    const settlements = de.transactions.filter(
      (t) => t.accountId === current.id && t.description.startsWith('KREDITKARTEN'),
    );
    expect(settlements.length).toBeGreaterThanOrEqual(11);
    for (const settlement of settlements) {
      const payment = de.transactions.find(
        (t) => t.accountId === card.id && t.date === settlement.date && t.amountMinor > 0,
      );
      expect(payment?.amountMinor).toBe(-settlement.amountMinor);
    }
  });

  it('has salary on the last business day before the 28th, rent on the 1st and a savings transfer pair', () => {
    const de = buildDataset({ seed: 's', institution: DE, profile: 'standard', today: TODAY });
    const [current, savings] = de.accounts;
    const salary = de.transactions.filter(
      (t) => t.accountId === current.id && t.description.startsWith('GEHALT'),
    );
    expect(salary.length).toBeGreaterThanOrEqual(12);
    for (const row of salary) {
      expect(row.amountMinor).toBe(345_000);
      const day = new Date(`${row.date}T00:00:00Z`).getUTCDay();
      expect([0, 6]).not.toContain(day);
    }
    const rent = de.transactions.filter((t) => t.description.startsWith('MIETE'));
    expect(rent.every((t) => t.date.endsWith('-01') && t.amountMinor === -115_000)).toBe(true);

    const out = de.transactions.filter(
      (t) => t.accountId === current.id && t.description.startsWith('DAUERAUFTRAG'),
    );
    const into = de.transactions.filter(
      (t) => t.accountId === savings.id && t.description.startsWith('DAUERAUFTRAG'),
    );
    expect(into.map((t) => t.amountMinor)).toEqual(out.map((t) => -t.amountMinor));
  });

  it('has pending items without ids and booked items with unique ids', () => {
    const de = buildDataset({ seed: 's', institution: DE, profile: 'standard', today: TODAY });
    const pending = de.transactions.filter((t) => t.pending);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((t) => t.id === null && t.amountMinor < 0)).toBe(true);
    const ids = de.transactions.filter((t) => !t.pending).map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(de.transactions.some((t) => t.date > '2026-10-28')).toBe(false);
  });

  it('gives the tight profile a low balance and smaller income', () => {
    const tight = buildDataset({ seed: 's', institution: DE, profile: 'tight', today: TODAY });
    const [current] = tight.accounts;
    expect(tight.balances.get(current.id)?.currentMinor).toBe(14_207);
    const salary = tight.transactions.find((t) => t.description.startsWith('GEHALT'));
    expect(salary?.amountMinor).toBe(210_450);
  });

  it('reflects executed payments as debits on the current account', () => {
    const base = buildDataset({ seed: 's', institution: DE, profile: 'standard', today: TODAY });
    const withPayment = buildDataset({
      seed: 's',
      institution: DE,
      profile: 'standard',
      today: TODAY,
      executedPayments: [
        {
          id: 'pay_1',
          accountCurrency: 'EUR',
          amountMinor: 12_500,
          beneficiaryName: 'Alex Example',
          reference: 'Rent share',
          executedAt: '2026-10-27T09:30:00.000Z',
        },
      ],
    });
    const added = withPayment.transactions.find((t) => t.description.includes('ALEX EXAMPLE'));
    expect(added).toMatchObject({ amountMinor: -12_500, date: '2026-10-27' });
    expect(withPayment.transactions.length).toBe(base.transactions.length + 1);
  });
});
