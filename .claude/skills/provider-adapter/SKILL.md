---
name: provider-adapter
description: >
  How to add or change a bank/aggregator provider in Ledger Lens (the BankingProvider port in
  apps/api/src/providers). Use this skill whenever asked to add a provider (TrueLayer, Enable Banking, another
  aggregator), change how a provider's data is mapped, add a failure scenario to the mock bank, record fixtures, or debug
  provider drift. Covers the port contract, mapping into packages/contracts types, instrumented transport and redaction,
  token handling, error mapping, webhooks, fixtures and the test checklist.
tools: Read, Bash, Edit, Write
---

# Adding or changing a provider adapter

Every provider is an adapter behind one port. Nothing outside `apps/api/src/providers/<id>/` may know a provider's wire
format: adapters normalise to the types in `packages/contracts` and throw `AppError`s with stable codes.

```
apps/api/src/providers/
  port.ts            BankingProvider interface, TokenSet, ProviderAccount/Transaction, typed errors
  registry.ts        builds the enabled adapters from config; `resolveInstitution('<provider>:<slug>')`, `mock()`
  transport.ts       ProviderHttp: every provider call is timed, redacted and pushed to the Inspector
  shared/data-api.ts DTO schemas + mappers for the "Data API" dialect (TrueLayer and the mock both speak it)
  mock/              the fake bank: adapter, bank.ts (OAuth + data API routes), html.ts pages, dataset.ts, store.ts
  <id>/              one folder per provider: adapter, DTO schemas, fixtures-based tests
apps/api/test/fixtures/<id>/   recorded provider payloads (verbatim JSON)

## Token providers and rate-limited banks (monobank)

Not every bank has a consent redirect. `providers/monobank/` is the pattern for a **token** provider: `Institution.connectMethod:
'token'` makes the SPA show a token field, `POST /api/connections/token` calls `provider.connectWithToken()` (a real call, so a typo
fails immediately), and the token is stored as `TokenSet.accessToken` with a far-future expiry and no refresh token
(`refreshTokens` throws `InvalidGrantError`, so a rejected token becomes `needs_reauth`).

A provider that caps read speed sets `limits` (`minIntervalMs`, `maxWindowDays`, `maxItemsPerCall`, `historyMonths`). Then
`SyncService.initialSync` stores accounts and balances at once and queues `sync_jobs` (one per account and window, newest first)
instead of reading history inline; `runDue()` runs one job per open rate gate, waits out a 429, asks for the rest of a window that hit
the row cap, and stops when the connection is lost. Cache whatever you can inside the adapter (monobank's client-info is cached for a
minute because the account list *is* the balance call). Redact the credential header in `domain/redact.ts` and mark the provider's
`mode` as `live`, which also masks identifiers in the Inspector.

`test/monobank-stub.ts` enforces the real service's rules (token check, one request per minute per endpoint, window and row caps), so a
test fails if the worker ever goes faster than the bank allows. Keep a `test/live/*.live.ts` file for the checks that can run against
the real service without secrets, and let it read an optional personal token from the environment, never from a file.
apps/api/src/modules/connections/access.ts   the only place tokens are unsealed, refreshed (single-flight) and retried
```

## The port (what an adapter implements)

- `listInstitutions(query, ctx)` — bank picker. Institution ids are `<provider>:<slug>`; `mode` is mock | sandbox | live.
- `startConnection({ institutionId, state, codeChallenge, redirectUri }, ctx)` → `{ authUrl }`. Always send `state` and PKCE (S256).
- `parseCallback(query)` → `{ kind: 'code', code }` or `{ kind: 'failure', outcome }` where outcome is one of
  `denied | timeout | unavailable | error`: the SPA has a designed state for each. Never throw from here.
- `completeConnection({ code, codeVerifier, redirectUri }, ctx)` → `{ tokens, consentExpiresAt, permissions }`.
- `refreshTokens(tokens, ctx)` — throw `InvalidGrantError` on `invalid_grant`; the caller marks the connection `needs_reauth`.
- `fetchConsent(tokens, ctx)` → `{ expiresAt, permissions }`, called on every user-initiated refresh so reminders stay accurate.
- `fetchAccounts` / `fetchBalance` / `fetchTransactions` (booked + pending merged and de-duplicated; paginate inside the adapter).
- `revoke(tokens, ctx)` — best effort; local data is deleted regardless.
- Payments (M3): `createPayment` / `getPayment` / `verifyWebhook`, advertised through institution `capabilities.payments`.

Typed errors the adapter throws so the core can react: `TokenRejectedError` (401 on a data call: refresh once and retry),
`InvalidGrantError` (re-auth needed), `ConsentGoneError('expired' | 'revoked')` (403), and `AppError` for the rest
(`bank_unavailable`, `rate_limited` with `retryAfterSeconds`, `provider_error`). `throwDataApiError` in `shared/data-api.ts` maps a
Data-API-style response in one call.

## Rules

1. **Money**: integer minor units + ISO 4217. Parse provider decimals with string math (`toMinorUnits`), never `parseFloat`.
   Transactions are signed (negative = out). Never sum across currencies.
2. **IDs**: de-duplicate transactions on `(account_id, provider_txn_id)`. If the provider has no stable id, derive a
   deterministic hash from date + amount + description + counter, and say so in a comment.
3. **Pending vs booked**: map both; pending rows are replaced when the booked row arrives.
4. **Transport**: use `ProviderHttp` only (never bare `fetch`) so the Inspector records the call. Redaction lives in
   `domain/redact.ts` (`authorization`, tokens, `client_secret`, `code`, `code_verifier`, signatures always; account identifiers
   for live providers); add new secret key names there, with a test. The transport is injectable (`Transport`), which is how
   adapter tests replay fixtures and how the mock bank is reached in-process.
5. **Errors** (throw `AppError`): 401 on data call → refresh once, then `reauth_required`; `invalid_grant` → `reauth_required`;
   consent expired/revoked → `consent_expired` / `consent_revoked`; 429 → `rate_limited` with `retryAfterSeconds`;
   5xx/timeouts → `bank_unavailable`; everything else → `provider_error` (log the provider's request id, not the body).
6. **Secrets** come from `config.providers.<id>` (Zod-validated env). An adapter without credentials is not registered.
7. **Webhooks**: verify the signature over the **raw body** with a timestamp tolerance, store `event_id` (unique) before
   applying, and make processing idempotent. Never trust a webhook's status without an idempotent state-machine check;
   the polling fallback must reach the same state.
8. **Tests are fixture-based and offline**: record real sandbox responses (strip secrets), put them in
   `test/fixtures/<id>/`, and drive the adapter through a stub `Transport` that replays them. Cover: happy path, pagination,
   pending→booked, 401→refresh→retry, `invalid_grant`, 429, 5xx, malformed payload, amount edge cases (0.10, 1000000.01,
   negative), and webhook signature (valid, tampered, stale, replayed).
9. Live checks are opt-in (`npm run e2e:sandbox`) and must never run in `verify`.

## Checklist for a new provider

- [ ] Add the id to `ProviderId` / `ProviderMode` in `packages/contracts/src/common.ts` if it is new.
- [ ] Config section + `.env.example` entries; skip registration when credentials are missing.
- [ ] Adapter folder, DTO Zod schemas for the provider's responses, mapper functions with unit tests.
- [ ] Register in `providers/registry.ts`; institutions appear in `GET /api/institutions` with the right `mode`.
- [ ] Fixtures + offline tests; update the README provider table and the Inspector labels.
- [ ] Redaction audit: grep the Inspector output and logs for tokens/identifiers for a full connect + refresh + payment run.
- [ ] Document consent lifetime, rate limits, and any unattended-access limits in the adapter header comment.

## The mock bank is a real adapter

`providers/mock/` implements the same port against an in-process fake bank that speaks HTTP (OAuth + a TrueLayer-shaped
REST API) served at `/mock-bank`. Failure scenarios (consent denied, SCA timeout, bank unavailable, rate limited,
insufficient funds, payment rejected, cancelled) live there, selected by persona on the consent page or by demo controls.
Add new failure modes to the mock first so the UI state and the e2e test exist before the live adapter needs them.
