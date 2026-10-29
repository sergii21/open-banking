import type { Clock } from '../../clock';
import { buildDataset, type Dataset } from './dataset';
import { findPersona, type MockInstitution, type Persona } from './institutions';
import type { MockPaymentsStore } from './payments-store';

/**
 * What the fake bank knows about a customer's accounts. A dataset is a pure function of (profile, bank, day), plus the
 * payments this customer has made through Ledger Lens that have executed: those leave the current account, so they
 * are part of the key and the dataset is rebuilt when one executes.
 */
export class MockDatasets {
  private readonly entries = new Map<string, Dataset>();

  constructor(
    private readonly payments: MockPaymentsStore,
    private readonly clock: Clock,
  ) {}

  get(
    institution: MockInstitution,
    persona: Persona,
    customerRef: string | null | undefined,
  ): Dataset {
    const today = this.clock.now();
    // Anna and "Anna (short consent)" are the same customer: payments follow the story (profile), not the login.
    const executed = customerRef
      ? this.payments
          .executedFor(institution.slug, customerRef)
          .filter((payment) => findPersona(payment.persona)?.profile === persona.profile)
      : [];
    const key = [
      persona.profile,
      institution.slug,
      today.toISOString().slice(0, 10),
      executed.map((payment) => payment.id).join(','),
    ].join('|');

    let dataset = this.entries.get(key);
    if (!dataset) {
      dataset = buildDataset({
        seed: `${persona.profile}:${institution.slug}`,
        institution,
        profile: persona.profile,
        today,
        executedPayments: executed,
      });
      if (this.entries.size > 40) this.entries.clear();
      this.entries.set(key, dataset);
    }
    return dataset;
  }

  /** What a payment could still draw on: the current account's available balance, overdraft headroom included. */
  availableMinor(
    institution: MockInstitution,
    persona: Persona,
    customerRef: string | null | undefined,
  ): number {
    const dataset = this.get(institution, persona, customerRef);
    const current = dataset.accounts.find((account) => account.type === 'TRANSACTION');
    return current ? (dataset.balances.get(current.id)?.availableMinor ?? 0) : 0;
  }
}
