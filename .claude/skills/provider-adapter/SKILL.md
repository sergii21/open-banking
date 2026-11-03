---
name: provider-adapter
description: >
  How the bank seam works in Ledger Lens (the BankingProvider port in apps/api/src/providers) and how to change it. Use this skill
  whenever asked to change how monobank's data is mapped, read a new field from client-info or the statement, handle a new response
  shape or status, change the pacing, add another bank, or debug "real data looks different from the demo". Covers the port, the
  tolerant DTOs, the diagnostics collector, error mapping, redaction, the fake bank and the test checklist.
tools: Read, Bash, Edit, Write
---

# Changing or adding a provider adapter

Everything outside `apps/api/src/providers/<id>/` is bank-agnostic: an adapter owns its provider's wire format, hands the core the
normalised types from `port.ts`, and never touches the database. v2 has one real adapter, monobank's personal API, and it is also the
demo: the `demo` provider is the same class with its transport pointed at an in-process fake bank, so everything the demo shows has gone
through the code a real connection uses. The v1 adapters (TrueLayer, the mock bank) are in the git tag `v1-full-featured`.

```
apps/api/src/providers/
  port.ts                  BankingProvider, ProviderLimits, ProviderAccount / ProviderTransaction / RatePair, TokenRejectedError
  registry.ts              builds `monobank` (only when live) and `demo`: transport, diagnostics collector, rate sources
  transport.ts             ProviderHttp: every call timed, redacted and filed with the Live API drawer; a network failure
                           becomes bank_unavailable; non-2xx answers are returned, not thrown
  monobank/adapter.ts      MonobankProvider (one class for both providers), normaliseToken, status → error mapping
  monobank/dto.ts          tolerant DTOs, the known-field lists, parseRows (one bad row never hides the others)
  monobank/currency.ts     ISO 4217 numeric → alphabetic
  monobank/demo/           FakeMonobank (in process), dataset.ts (a made-up Ukrainian dataset), server.ts (the same fake over HTTP,
                           with a 429 for a second read inside the interval: `npm run fake:monobank`)
apps/api/src/domain/diagnostics.ts          DiagnosticsCollector: field names, types, counts; never values
apps/api/src/domain/redact.ts               masks tokens and, for live providers, card numbers and IBANs
apps/api/src/modules/connection/access.ts   the one place a token is unsealed and a provider call is run with it
apps/api/src/modules/sync/service.ts        paces statement reads from `limits`
```

## The port

`connect({ token })` checks the token with a real call and returns the tokens plus the accounts it saw (so no second read is spent: the
bank allows one a minute); `fetchAccounts`, `fetchTransactions(tokens, account, { from, to })` (calendar days in the configured zone,
newest first, de-duplicated), `fetchRates` (public, no token), `revoke` (best effort: local data is deleted regardless). `limits` says how
fast the bank may be read (`statementIntervalMs`, `infoIntervalMs`, `maxWindowDays`, `maxItemsPerCall`, `historyMonths`); the sync
worker paces itself from it and asks for the rest of a window when a response reaches `maxItemsPerCall`.

## Rules for an adapter

1. **Normalise at the edge.** Money is integer minor units with the account's currency (negative is out). Card numbers and IBANs are
   reduced to the last four digits before they leave the adapter. Own funds are computed by the core from `balanceMinor` and
   `creditLimitMinor`; the adapter reports what the bank said.
2. **Parse tolerantly, fail loudly only when the whole answer is wrong.** Each row goes through `parseRows(Dto, raw)`: a row that does not
   parse is skipped and counted (`diagnostics.warn`), the rest is used. An answer of the wrong top-level shape is `unreadable` (a
   `provider_error`), never guessed at. Optional fields stay optional: monobank omits `comment`, `receiptId`, `goal` and others.
3. **Record what arrived.** Call `diagnostics.observeRows(endpoint, rows, KNOWN_FIELDS)` for every list so a field nobody mapped yet shows
   up under "fields we do not use" in Settings, Copy diagnostics. Every new field you read goes into the `*_FIELDS` set in `dto.ts`.
   `diagnostics.warn` takes field names and codes only, never data.
4. **Map statuses to the states the screens know.** 401 and 403 → `TokenRejectedError` (the loader stops and the app asks for a new
   token); 429 → `AppError('rate_limited', 429, …, { retryAfterSeconds })` (the worker waits as long as the bank says, else 60 s);
   5xx and network failures → `bank_unavailable`; anything else → `provider_error` with the status.
5. **No caching, no retries in the adapter.** The sync worker owns pacing; an adapter that retries on its own can burn the one read a
   minute. If an endpoint is cheap to share (the account list is the balance call), the worker shares it.
6. **The token stays out of everything.** It is sent only as the `X-Token` header, through `ProviderHttp`; `connect` strips whitespace and
   quotes from what the person pasted (`normaliseToken`) and refuses anything that does not look like a token before calling the bank.
   `domain/redact.ts` masks `xtoken`, and for a live provider card numbers and IBANs: add any new secret header or field name there.
7. **Live means localhost.** A provider that reads a real person's account is registered only when `PUBLIC_URL` is localhost
   (`config.live`); a public instance can run the demo only. Mark such an adapter `mode: 'live'`.

## Adding a field the bank already sends

DTO and `*_FIELDS` in `monobank/dto.ts` → `mapItem` / `fetchAccounts` in the adapter → `ProviderTransaction` / `ProviderAccount` in
`port.ts` → a migration and the repository in `db/` if it is stored → the contracts type and the presenter if a screen shows it → the
fake's dataset so the demo exercises it → a test. If the field rests on an assumption the bank's documentation does not state, add a
yes/no fact for it in `modules/diagnostics/service.ts` (see `domain/checks.ts`), so the first real run tells us whether it holds.

## Adding another bank

Implement `BankingProvider` in `providers/<id>/`, add the id to `ProviderId` in the contracts, build it in `registry.ts` behind the live
rule, and give it a scripted fake next to it so tests and a demo can run offline. A provider with an OAuth redirect needs a connect flow
the current port does not have: v1's version of that is in the `v1-full-featured` tag. PrivatBank has no personal API (see
`docs/UKRAINE.md`); a statement-file importer would be its own module, not an adapter, because it has no token and no live reads.

## Tests

- `apps/api/test/monobank.test.ts` runs the adapter against the scripted `FakeMonobank` through a stubbed `Transport`: mapping of cards,
  credit cards and jars, holds, foreign-currency purchases, transfers with comments, skipped rows, every status → error, token cleaning,
  rates.
- `apps/api/test/sync.test.ts` uses the `paced()` helper (a fake that enforces the bank's one-read-a-minute rule on a clock you move by
  hand) to prove the worker never goes faster than the bank allows, waits out a 429 and asks for the rest of a capped window.
- `apps/api/test/app.test.ts` covers the routes, CSRF, connect and disconnect on an in-memory database.
- The diagnostics test proves that no description, comment, id, last four digits or token appears in the text the person copies. Keep it
  passing when you add a field.
- `e2e/monobank.spec.ts` drives the real-token flow through the browser against the paced fake.

## Trying it against something real

Without a token you can check only what is public: `/bank/currency` (the demo reads real rates through the app) and the real 403 a made-up
token gets. Anything that needs a real account is the person's to run on their own machine: `npm run doctor` or Settings, Copy diagnostics.
Never ask for, print or store a real token; the first real connection is their step, and `docs/HANDOVER.md` lists what it will confirm.
