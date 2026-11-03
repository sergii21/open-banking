# monobank and other Ukrainian banks: what is real here

Ledger Lens reads one Ukrainian bank, **monobank**, through its personal API with a token you issue yourself. This page says what
has been checked against the real service, what only your own token can check, and what is not possible. How to use it is in
[START_HERE.md](START_HERE.md).

## The rules that come with the token

- monobank's personal API is for your own and your family's accounts, is not available under 16, and a service that passes other
  people's data through its servers needs monobank's corporate API. So the real-bank provider is registered only while
  `PUBLIC_URL` is a localhost address (`ALLOW_LIVE_PROVIDERS=true` overrides that; do not use it for anything others can reach).
  A public instance runs demo data only.
- The token is read-only and stays valid at api.monobank.ua until you issue a new one there. The app has no way to revoke it.

## Checked against api.monobank.ua (2026-11-03)

From the OpenAPI document published inside https://api.monobank.ua/docs/ (version v250818):

- `client-info` and `statement` are each limited to one request per 60 seconds. The spec does not say whether the two limits
  share one budget, so the scheduler treats them as separate and switches to one shared gate if a 429 shows otherwise.
- The statement endpoint accepts a jar id as well as a card id (`0` is the default account). Window: at most 31 days and one
  hour. The app treats a response of 500 rows as possibly cut short and asks for the rest of the window.
- `/bank/currency` is cached by the bank and refreshed at most every five minutes. A pair has a buy and sell rate, a cross
  rate, or both.
- Amounts are integer minor units. `commissionRate` and `cashbackAmount` are amounts in minor units, despite the first name.
- A webhook (`POST /personal/webhook`) is validated with a GET that must answer 200, then receives `StatementItem` events,
  retried after 60 s and 600 s and then disabled; it carries no signature. Not built here (it needs a public HTTPS address).

Against the live service, without any token (through the running app):

- The exchange rates the demo shows are the real ones from `/bank/currency`.
- A made-up token gets the real 403 from `client-info`; the app says "monobank does not recognise this token" and stores nothing.
  (The same 403 body was seen on 2026-10-28: `{"errorDescription":"Unknown 'X-Token'"}`.)

## Only your own token can check

- The field shapes of a real account. Unknown fields are ignored and optional ones may be missing; Copy diagnostics lists the
  field names and types that actually arrive, and any row that could not be read.
- That `balance` includes `creditLimit`. The spec is silent. The app assumes it (own funds = balance minus limit);
  `npm run doctor` and the diagnostics say where a credit card's balance sits against its limit, which you can compare with the
  monobank app.
- That a statement item's `balance` is the balance after that item (the spec only says "account balance"). The doctor and the
  diagnostics count how many consecutive items agree.
- The real body of a 429 (the app reacts to the status and waits `Retry-After` or 60 s), whether the two limits are shared,
  real latency, and how well the categoriser knows your merchants (it uses the merchant code first, then Ukrainian and Latin
  names).
- Foreign-currency purchases: `operationAmount` has no currency in the spec, so the app shows the amount in the account's
  currency.

How: START_HERE steps 4 to 6, and `MONOBANK_TOKEN=... npm run doctor` in your own terminal.

## PrivatBank

I found no personal API for PrivatBank cardholders: its APIs (AutoClient and merchant APIs) are for business customers. No Privat
importer was built. What one would need: a sample statement export from Privat24 (whatever format it offers, with anything
private edited out) so the column layout can be read, and then a file import in the app instead of a live connection.

## Other routes, not built

Ukraine's open-banking regime (NBU, since 1 August 2025) is for authorised third-party providers, so a personal project cannot
use it; monobank's corporate API needs an application to the bank. A second bank is a new adapter behind the `BankingProvider`
port in `apps/api/src/providers`.
