export type PersonaId = 'anna' | 'ben' | 'short_consent' | 'sca_timeout' | 'bank_down';
export type DatasetProfile = 'standard' | 'tight';

export interface Persona {
  id: PersonaId;
  name: string;
  blurb: string;
  /** What happens at the bank: normal approval, strong authentication never completes, or the bank is down. */
  outcome: 'ok' | 'sca_timeout' | 'outage';
  profile: DatasetProfile;
  consentDays: number;
}

/** The people you can sign in as on the mock bank's page. The persona decides the story. */
export const PERSONAS: readonly Persona[] = [
  {
    id: 'anna',
    name: 'Anna Schmidt',
    blurb: 'Everyday banking: salary, rent, subscriptions. Everything works.',
    outcome: 'ok',
    profile: 'standard',
    consentDays: 90,
  },
  {
    id: 'ben',
    name: 'Ben Okafor',
    blurb: 'A tight month with a low balance. Large payments are refused for insufficient funds.',
    outcome: 'ok',
    profile: 'tight',
    consentDays: 90,
  },
  {
    id: 'short_consent',
    name: 'Anna Schmidt (short consent)',
    blurb:
      'Same data, but the bank only grants access for 2 days. Shows expiry reminders and reconnect.',
    outcome: 'ok',
    profile: 'standard',
    consentDays: 2,
  },
  {
    id: 'sca_timeout',
    name: 'Slow approver',
    blurb: 'Never finishes strong customer authentication. The bank times out and sends you back.',
    outcome: 'sca_timeout',
    profile: 'standard',
    consentDays: 90,
  },
  {
    id: 'bank_down',
    name: 'Bank outage',
    blurb: 'The bank is having an outage and cannot sign anyone in.',
    outcome: 'outage',
    profile: 'standard',
    consentDays: 90,
  },
];

export function findPersona(id: string): Persona | undefined {
  return PERSONAS.find((persona) => persona.id === id);
}

export interface MockInstitution {
  slug: string;
  name: string;
  country: 'DE' | 'GB';
  currency: 'EUR' | 'GBP';
  locale: 'de' | 'gb';
  /** A degraded bank always fails at sign-in, like TrueLayer's `-unhealthy` mock provider. */
  healthy: boolean;
  color: string;
  initials: string;
}

export const MOCK_INSTITUTIONS: readonly MockInstitution[] = [
  {
    slug: 'mock-bank',
    name: 'Mock Bank',
    country: 'DE',
    currency: 'EUR',
    locale: 'de',
    healthy: true,
    color: '#0e7490',
    initials: 'MB',
  },
  {
    slug: 'mock-bank-uk',
    name: 'Mock Bank UK',
    country: 'GB',
    currency: 'GBP',
    locale: 'gb',
    healthy: true,
    color: '#4f46e5',
    initials: 'MU',
  },
  {
    slug: 'mock-bank-unhealthy',
    name: 'Mock Bank (degraded)',
    country: 'DE',
    currency: 'EUR',
    locale: 'de',
    healthy: false,
    color: '#b45309',
    initials: 'MD',
  },
];

export function findMockInstitution(slug: string): MockInstitution | undefined {
  return MOCK_INSTITUTIONS.find((institution) => institution.slug === slug);
}
