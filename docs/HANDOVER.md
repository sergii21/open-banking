# Ledger Lens — hand-over at the M3 checkpoint

Written when the build session ran out of usage. Everything below is decided; do not re-open it. Read `docs/PLAN.md` and
`CLAUDE.md` first. Node 24 for every command: `export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH`.

## State

| Milestone                                                     | Status                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 foundations                                                | done, committed `9aefde6`                                                                                                                                                                                                                                                                                                                                                                               |
| M1 mock bank + AIS + Inspector                                | done, committed `3e9dfac`; `npm run verify` + 52 Playwright tests green; manual desktop/phone/dark/axe pass done                                                                                                                                                                                                                                                                                        |
| M2 TrueLayer sandbox AIS                                      | done, committed `5a735bb`; offline fixture tests (28) green; **live sandbox not verified (no credentials)**                                                                                                                                                                                                                                                                                             |
| **Ukrainian bank: monobank** (requested after the checkpoint) | done and committed: real personal-API adapter (token connect, paced background history, MCC + Ukrainian categorisation, local-only guard), 30 API tests, 2 Playwright tests against a fake of the bank, opt-in live checks (`npm run test:live -w @ledger-lens/api`). **No real account was available: only the public rates endpoint and the 403 error body were checked live.** See `docs/UKRAINE.md` |
| M3 payments                                                   | **started**: contracts (`Institution.fixedPayee`, optional `beneficiary`, `Payment.settlementExpected`, `InspectorCall.direction`), migrations `004_payments` + `005_mock_payments`, `domain/payment-state.ts` (+ tests), mock dataset moves balances for executed payments. Nothing else.                                                                                                              |
| M4 insights + polish                                          | not started                                                                                                                                                                                                                                                                                                                                                                                             |
| M5 harden / deploy / demo                                     | not started (README is a stub; `docs/PLAN.md` §10 has the scope)                                                                                                                                                                                                                                                                                                                                        |

## M3 — what to build (in this order)

1. **Port** (`providers/port.ts`): `PaymentInitiation { fixedPayee(institutionId, currency): {name, identifier} | null;
createPayment(input, ctx): {providerPaymentId, authUrl, status, settlementExpected}; getPayment(id, ctx): {status,
failureReason, at}; verifyWebhook({method, path, headers, rawBody}): {eventId, type, providerPaymentId, update | null} }`
   plus a `supportsPayments()` guard. Input carries `idempotencyKey` (sent to the provider), `returnUri`
   (`{PUBLIC_URL}/api/payments/return`), `customerRef` (sha256 of the session id).
2. **Repos**: `PaymentsRepo`, `WebhookEventsRepo` (tables exist). `UNIQUE (session_id, idempotency_key)`,
   `(provider, provider_payment_id)`, `webhook_events (provider, event_id)`.
3. **PaymentService** (`modules/payments`): `create` (Idempotency-Key header required → `idempotency_key_required`;
   same key + same request hash → replay the stored payment; different hash → 422 `idempotency_conflict`; insert the row
   _before_ calling the provider; on 5xx/network keep the row so a retry with the same key completes; on a definitive
   4xx delete it), `list/get/sync`, `applyProviderUpdate` (uses `applyUpdate`; publishes SSE `payment.updated`; appends
   history), `handleReturn` (public `GET /api/payments/return?payment_id=` → look up by provider id, poll once, 302 to
   `/payments/<id>/result`, add `?abandoned=1` when `error=tl_hpp_abandoned`), `pollDue` (fallback: only payments idle
   > 20 s, then every 30 s; expire `pending` after `PAYMENT_APPROVAL_MINUTES`), timer in `app.ts` outside `test` env.
   > Validate server-side: institution supports payments, currency ∈ `institution.currencies`, amount ≤
   > `config.maxPaymentMinor`, GBP ⇒ `sort_code_account_number`, EUR ⇒ `iban`; ignore the beneficiary when `fixedPayee`.
   > Expose `authUrl` only while pending (it is sealed in `auth_url_enc`; it carries a resource token).
4. **Routes**: `GET/POST /api/payments` (per-session rate limit 10/min), `GET /api/payments/:id`, `POST
/api/payments/:id/sync`, public `GET /api/payments/return`, public `POST /api/webhooks/:provider` (`csrf:false`,
   per-IP limit; capture the **raw body** with a scoped `application/json` content-type parser; verify, then in one DB
   transaction insert `webhook_events` (duplicate ⇒ 200 `duplicate`), apply, record an `inbound` Inspector call under the
   payment's session; unknown payment ⇒ 200 `unknown_payment`; bad signature ⇒ 401 `invalid_webhook_signature`). Prune
   `webhook_events` older than `webhookMaxAgeSeconds`. Register in `api.ts`; add `payments` to `AppContext`.
5. **Mock bank payments** (tables exist): client-credentials token (stateless HMAC token; no DB), `POST
/mock-bank/api/payments/v1/payments` (Idempotency-Key, bearer, return_uri must equal the allowed one), `GET …/:id`,
   hosted page `GET /mock-bank/pay?payment_id&resource_token` (persona + outcome radios: `test_executed`,
   `test_authorisation_failed`, `test_execution_rejected`, plus Cancel; degraded bank ⇒ outage page and the payment fails
   `provider_error`), `POST /mock-bank/pay/decision` ⇒ 302 `return_uri?payment_id=` (`&error=tl_hpp_abandoned` on cancel).
   Engine: `authorized` at once; `executed` after `MOCK_BANK_STEP_SECONDS` (new config, default 3); `settled` one step later
   when the institution settles (mock DE/EUR settles, mock UK/GBP ends at `executed`, so both timeline shapes appear);
   `amount > available` ⇒ `insufficient_funds`; unapproved after 15 min ⇒ `expired`. `tick(now)` runs due transitions and
   delivers the outbox via `app.inject` to `/api/webhooks/mock` (retry with backoff, 8 attempts); a 1 s timer outside `test`.
   Webhook = TrueLayer-shaped JSON (`type: payment_authorized|executed|settled|failed`, `event_id`, `payment_id`, …) with
   `X-Mock-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "t.rawBody")>`; secret = HMAC of `SESSION_SECRET` (not a code
   constant); reject |now − t| > 5 min. Linkage: add `customer_ref` to the auth URL / consent, pass `executedPayments`
   (matching institution + persona + customer_ref, status executed|settled) to `buildDataset` — the dataset cache key
   must include the payment ids. `MockProvider` implements `PaymentInitiation`; `paymentsNote`s: DE "simulated SEPA,
   settles a few seconds after executing", UK "simulated Faster Payment, ends at Executed".
6. **TrueLayer payments** (`providers/truelayer/`): payments token via `POST {auth}/connect/token` JSON
   `{grant_type: client_credentials, scope: payments, client_id, client_secret}` (cache, single-flight). `POST
{api}/v3/payments`: headers `Authorization`, `Idempotency-Key`, `Tl-Signature`, optional `X-Forwarded-For: psuIp`; body
   `{amount_in_minor, currency, payment_method: {type: bank_transfer, provider_selection: {type: user_selected, filter:
{countries: [GB|DE derived from the provider id], provider_ids: [paymentProviders[currency]]}}, beneficiary}, user:
{name: "Ledger Lens Demo", email: config.userEmail}, hosted_page: {return_uri}, metadata}`. Beneficiary:
   `merchant_account {merchant_account_id, account_holder_name?, reference (≤100), statement_reference (≤18)}` or
   `external_account {account_holder_name (≤40), account_identifier: sort_code_account_number | iban, reference (≤18)}`.
   201 ⇒ `{id, resource_token, hosted_page?.uri}`; HPP link fallback
   `https://payment.truelayer-sandbox.com/payments#payment_id=…&resource_token=…&return_uri=<encoded>`. `GET /v3/payments/{id}`
   is unsigned. Errors: 400 ⇒ `payment_rejected` 422 (surface `errors`), 401/403 ⇒ `provider_error` 502 with a hint about the
   signing key id / external-account entitlement, 409 ⇒ `conflict`, 422 ⇒ `idempotency_conflict`, 429 ⇒ `rate_limited`, 5xx ⇒
   `bank_unavailable`.
   **Signing** (verified against TrueLayer's `request-signing-v2.md` and the Node reference library): ES512 over P-521;
   header `{alg: "ES512", kid, tl_version: "2", tl_headers: "Idempotency-Key"}`; canonical string = `POST /v3/payments\n` +
   `Idempotency-Key: <value>\n` + raw body (no trailing newline); JWS signing input = `b64url(JSON header) + "." +
b64url(canonical)`; signature = raw R‖S (`crypto.sign('sha512', input, {key, dsaEncoding: 'ieee-p1363'})`); header value
   = `b64url(header) + ".." + b64url(signature)`. `ProviderHttp` already has `sign(body)` for this (pass the exact
   serialised body).
   **Webhook verification**: header `Tl-Signature` (same format, ES512 only); parse `jku`, require exactly
   `https://webhooks.truelayer-sandbox.com/.well-known/jwks`, fetch the JWKS (cache ~1 h, refetch once on unknown `kid`),
   rebuild the canonical string with method `POST`, the request path (retry once with the trailing slash toggled), the headers
   named in `tl_headers` taken from the received headers (case-insensitive, casing from `tl_headers`, missing ⇒ ""), then the
   raw body; verify with `createPublicKey({key: jwk, format: 'jwk'})`. If a signed `X-Tl-Webhook-Timestamp`/`Tl-Timestamp`
   header exists, enforce the age limit. Event types seen in docs: `payment_authorized|executed|settled|failed`; anything else
   ⇒ ignored. Respond 2xx fast; TrueLayer retries up to 72 h; `event_id` repeats on duplicates.
   Status map: `authorization_required|authorizing`⇒pending, `authorized`⇒authorised, `executed`, `settled`; `failed` by
   `failure_reason`: `canceled|user_canceled_at_provider`⇒cancelled; `authorization_failed|not_authorized|invalid_credentials|
invalid_otp|provider_expired`⇒authorisation_failed; `expired`⇒expired; `insufficient_funds`; `provider_error|
internal_server_error|unknown_error`⇒provider_error; everything else (rejected, provider_rejected, blocked, invalid_*,
   payment_limit_exceeded, …)⇒execution_rejected, unknown values ⇒ by `failure_stage`.
   Sandbox: mock providers `mock-payments-gb-redirect` / `mock-payments-de-redirect`; outcomes are chosen by username
   `test_executed`, `test_authorisation_failed`, `test_execution_rejected`, or the cancel button; sandbox cap 5,000,000 minor.
7. **Demo control** `replay_last_webhook` (`modules/demo/routes.ts` currently rejects it): mock only; re-POST the last
   delivered outbox row (same body and signature) to `/api/webhooks/mock`; return a message naming the event and that it was
   recognised as a duplicate (status unchanged).
8. **API tests**: mock flow for all four outcomes + insufficient funds + expiry through the real HTTP journey; idempotency
   (replay, conflict, retry after unknown outcome); webhook: bad signature 401, stale timestamp, duplicate/replay does not
   double-apply, out-of-order, unknown payment; poll fallback; TrueLayer: signing (round-trip with a generated P-521 key,
   exact canonical string and header shape), create/get mapping and error mapping, webhook verification with a generated JWKS,
   return handler. Put the signing/webhook fixtures in `apps/api/test/fixtures/truelayer/` (documented-shape, not recorded).
9. **SPA** (`apps/web/src/app/features/payments/`, lazy routes `payments`, `payments/new`, `payments/:id` and
   `payments/:id/result` → same detail component): Signal Forms payment form (institution select from `/api/institutions`
   with `capabilities.payments`, currency from the institution, amount, payee fields by currency unless `fixedPayee`,
   reference; `validateStandardSchema` with the contract schemas; one `crypto.randomUUID()` Idempotency-Key per attempt, reused
   only for an identical retry after an unknown outcome; then `location.assign(authUrl)`), list with empty state, detail page
   with a live timeline (Pending → Authorised → Executed → Settled; omit Settled when `settlementExpected` is false; failure
   states for each `failureReason` with a recovery action, "Resume at your bank" while pending, "Check now" ⇒ `/sync`),
   updates from SSE `payment.updated` in `core/events`, a "Replay last webhook" demo button, `abandoned=1` hint, nav item,
   `paymentsNote` display. Add the payments routes to the axe spec (light + dark) and phone layout checks.
10. **e2e** (`e2e/payments.spec.ts`, mock bank, `MOCK_BANK_STEP_SECONDS=1` in `playwright.config.ts`): all four outcomes plus
    insufficient funds visible in the UI, the replay demo not double-applying, executed payment appears on the dashboard after
    Refresh. Then `npm run verify`, `npm run e2e`, browser check (desktop, phone, dark), commit "M3: payments".

## Then

- **monobank follow-ups:** webhook for new transactions (needs a public URL); verify the credit-card balance assumption and jar
  statements with a real token (`MONOBANK_TOKEN=... npm run test:live -w @ledger-lens/api`); PrivatBank only if a personal API turns up.

- **M4**: `PATCH /api/transactions/:id` category override (+ UI), `GET /api/insights/summary` (category totals, monthly in/out,
  recurring detection; never sum across currencies), ng-apexcharts, CSV export, skeletons, responsive/dark/axe on every route,
  keep the bundle under the 900 kB warn / 1.2 MB error budget (lazy-load the chart library). Unit-test the insight numbers.
- **M5**: CSP / rate-limit / redaction audit, full README (regulatory model: aggregator licence vs own TPP; why the public
  instance never uses real accounts; TrueLayer setup incl. redirect URIs `{PUBLIC_URL}/api/connections/callback` and
  `/api/payments/return`, key generation `npm run keys:truelayer`, webhook tunnel), five-minute demo script (must work on a
  clean checkout in < 10 min), optional `render.yaml` (sandbox only), Enable Banking only if the §13 spike supports it, update
  `.claude/skills/provider-adapter` and `e2e-smoke-testing` for payments. `jose` is declared in `apps/api` but unused — remove
  it or use it.

## Final report must say

- Per milestone: status, commands run and results. Unverified: **live TrueLayer** (Data API, signing, payments, webhook
  verification are written from the docs and tested offline only; fixtures are documented-shape, not recorded), `uk-cs-mock` vs
  `mock` provider id, `external_account` entitlement, revoke endpoint `DELETE /api/delete`, whether `user` is accepted as sent.
- Deviations: no `@faker-js/faker` (seeded PRNG), added `needs_reauth` status, Playwright Chromium install, custom Material
  palette, CSS container queries, Inspector docking, TrueLayer mock users are username/password pairs, `external_account`
  payments not assumed, `fixedPayee`/merchant-account default for TrueLayer payments.
- Needed from the user: TrueLayer sandbox credentials + signing key id + merchant account ids in `apps/api/.env` (never in
  chat), a tunnel URL for webhooks (polling covers it without), the Enable Banking decision.
