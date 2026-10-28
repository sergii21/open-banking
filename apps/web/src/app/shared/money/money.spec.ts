import { TestBed } from '@angular/core/testing';
import { Money } from './money';

async function render(inputs: {
  amountMinor: number;
  currency: string;
  signed?: boolean;
  colorize?: 'none' | 'positive' | 'both';
}) {
  const fixture = TestBed.createComponent(Money);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('Money', () => {
  it('renders the formatted amount and exposes the raw minor units for tests and tooling', async () => {
    const el = await render({ amountMinor: 284_013, currency: 'EUR' });
    expect(el.textContent.trim()).toBe('€2,840.13');
    expect(el.dataset['amountMinor']).toBe('284013');
    expect(el.dataset['currency']).toBe('EUR');
  });

  it('colours money in, never relying on colour alone: the sign is in the text', async () => {
    const income = await render({
      amountMinor: 345_000,
      currency: 'EUR',
      signed: true,
      colorize: 'positive',
    });
    expect(income.textContent.trim()).toBe('+€3,450.00');
    expect(income.classList).toContain('text-positive');

    const spend = await render({
      amountMinor: -4217,
      currency: 'EUR',
      signed: true,
      colorize: 'positive',
    });
    expect(spend.textContent.trim()).toBe('-€42.17');
    expect(spend.classList).not.toContain('text-positive');
    expect(spend.classList).not.toContain('text-negative');
  });

  it('can colour negatives too, for balances owed', async () => {
    const owed = await render({ amountMinor: -29_727, currency: 'EUR', colorize: 'both' });
    expect(owed.classList).toContain('text-negative');
  });
});
