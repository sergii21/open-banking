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
  port.ts            BankingProvider interface + shared types (ProviderAccount, ProviderTransaction, TokenSet, ...)
  registry.ts        builds the enabled adapters from config; `get(providerId)` / `forInstitution(institutionId)`
  transport.ts       instrumented HTTP: every provider call is timed, redacted and pushed to the Inspector
  <id>/              one folder per provider: adapter, mapping, DTO schemas, fixtures-based tests
apps/api/test/fixtures/<id>/   recorded provider payloads (verbatim JSON)
```

## The port (what an adapter implements)

- `listInstitutions(query)` — bank picker. Institution ids are `<provider>:<slug>`.
- `startConnection({ institutionId, state, codeChallenge, redirectUri })` → `{ authUrl }`. Always send `state` and PKCE.
- `completeConnection({ code, codeVerifier, redirectUri })` → encrypted-at-rest `TokenSet` + `consentExpiresAt`.
- `refreshTokens(tokens)` — single-flight is handled by the caller; throw `reauth_required` on `invalid_grant`.
- `fetchAccounts` / `fetchBalance` / `fetchTransactions` (booked + pending, cursor or date-window pagination).
- `revoke(tokens)` — best effort; local data is deleted regardless.
- `createPayment` / `getPayment` / `verifyWebhook` for payment initiation (set `capabilities.payments`).

## Rules

1. **Money**: integer minor units + ISO 4217. Parse provider decimals with string math (`toMinorUnits`), never `parseFloat`.
   Transactions are signed (negative = out). Never sum across currencies.
2. **IDs**: de-duplicate transactions on `(account_id, provider_txn_id)`. If the provider has no stable id, derive a
   deterministic hash from date + amount + description + counter, and say so in a comment.
3. **Pending vs booked**: map both; pending rows are replaced when the booked row arrives.
4. **Transport**: use `ProviderHttp` only (never bare `fetch`) so the Inspector records the call. Declare which headers and
   JSON paths are secret; the transport redacts `authorization`, tokens, `client_secret`, `code`, signatures and account
   identifiers before anything is stored or logged.
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
