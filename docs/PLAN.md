> v1 history: this was the plan for v1. For the app as it is now see [START_HERE.md](START_HERE.md) and [HANDOVER.md](HANDOVER.md).

# Open Banking POC — build plan

Prepared 2026-10-28 · Status: **draft for your approval. Nothing has been created yet.**

## 1. Context

You want a proof of concept that shows Open Banking APIs working inside a realistic app. It lives in a new repo outside `angular-workspace2`, uses the latest Angular, and carries over that workspace's conventions. Angular 22.2 is current (npm `latest` = 22.2.x; `next` is only 22.3 pre-release, so there is no v23 yet).

Two facts shape the whole plan:

- **A browser app can't call Open Banking APIs safely.** Client secrets, request signing, bank redirects and webhooks all need a server. "Real life" therefore means an Angular SPA plus a small Node backend-for-frontend (BFF).
- **You don't need to be a licensed provider.** Aggregators (TrueLayer, Enable Banking, …) operate under their own licences and expose a normal REST API. Going straight to banks (UK OBIE / Berlin Group: eIDAS or OB certificates, mTLS, dynamic client registration, JWS signing, per-bank quirks) would roughly triple the scope and isn't how most real products are built.

## 2. What we're building

**Working title: Ledger Lens.** A personal-finance app. You link a bank through Open Banking, see every account in one place, understand your spending, and send a payment you approve inside your bank.

It shows both halves of Open Banking:

- **Account information (AIS):** consent → accounts → balances → transactions
- **Payment initiation (PIS):** create payment → approve at the bank → live status

### MVP journeys

1. **Connect a bank:** pick bank → "what we'll access and for how long" → redirect to the bank → back in the app.
2. **Dashboard:** balances per account, totals per currency, last-refreshed time, consent-expiry countdown.
3. **Transactions:** search; filter by date, amount, category, account; category override; CSV export.
4. **Insights:** spend by category, income vs spend by month, detected recurring payments.
5. **Send money:** payee + amount + reference → bank approval → timeline Pending → Authorised → Executed → Settled / Failed, updating live.
6. **Connections & privacy:** reconnect, revoke consent, delete all my data.
7. **API Inspector** (exists only to serve the POC's purpose): a side panel listing the real provider calls (method, path, status, latency, redacted payload) behind whatever screen you're on.

### Out of scope (deliberate)

User accounts and login (anonymous demo session instead), becoming a regulated TPP, multi-tenancy, mobile apps, i18n. Stretch only: recurring payments / VRP (UK commercial VRP wave 1 was reported live in June 2026).

## 3. Decisions (recommended — veto any)

| # | Decision | Recommendation | Why / alternatives |
|---|---|---|---|
| D1 | Scenario | Personal-finance manager (AIS + PIS) | Exercises read *and* write APIs in one believable product. The same backend could instead drive a pay-by-bank cashier (PIS-led) or an affordability check (AIS-led). |
| D2 | Bank access | Provider-agnostic port. Adapters in order: **Mock bank → TrueLayer sandbox → (optional) Enable Banking for your real accounts** | Deterministic demos and tests first, real sandbox flows second, real banks last. TrueLayer's sandbox is self-serve (mock banks, test users, usernames that force outcomes); its go-live guide routes upgrades through their sales team. Enable Banking's "restricted production" lets you link your own accounts for individual, non-commercial use (third-party guides call it free; the official page doesn't state a price). Not chosen: Tink (quote-based pricing per third-party sources), Plaid (good sandbox, but I couldn't confirm UK/EU live terms) and GoCardless Bank Account Data (couldn't confirm new sign-ups are open). |
| D3 | Architecture | Angular SPA + Node BFF, same origin, HttpOnly session cookie | Tokens, secrets and signing keys never reach the browser; no CORS. |
| D4 | BFF stack | Fastify 5 + Zod 4 + built-in `node:sqlite` + pino, TypeScript ~6.0 | Schema-validated routes and structured logs out of the box; no native build. Express 5 (as in `backends/admin`) would also work. |
| D5 | API contract | `packages/contracts`: Zod schemas + inferred types, imported by both apps | One source of truth; no codegen to maintain for ~15 endpoints. |
| D6 | Repo | `~/Desktop/src/open-banking-poc`, npm workspaces, Node 24 (`.nvmrc` + `engine-strict`) | Matches your npm-lockfile habit. Your shell default is Node 25.9, which Angular 22 rejects. |
| D7 | Hosting | One Node service serves API + built SPA. A public instance uses sandbox providers only | Restricted production is for your own accounts; real-bank access for other people needs a commercial agreement with the provider (and possibly your own authorisation). The live adapter stays local. |

Market assumption: EUR/SEPA primary, GBP secondary (the mock and TrueLayer sandbox support both). Say so if you're UK-first.

## 4. Architecture

```
Browser — Angular 22 SPA (zoneless, signals)
   │  same-origin /api/*  ·  HttpOnly session cookie  ·  XSRF header
   ▼
BFF — Fastify 5 on Node 24 ── SQLite: sessions, connections*, cached accounts/txns, payments, webhook events
   │                          *provider tokens AES-256-GCM encrypted at rest, never sent to the browser
   │
   └─ BankingProvider port (normalises every provider to packages/contracts types)
        ├─ MockProvider          in-process fake bank + consent page   (M1: dev, tests, offline demo)
        ├─ TrueLayerProvider     sandbox mock banks: Data API + Payments v3 + webhooks   (M2–M3)
        └─ EnableBankingProvider your real banks, restricted production   (M5, optional, local only)
              ▼
        Bank / provider-hosted consent + SCA page — full-page redirect, never an iframe
```

**Connect (AIS)**

1. SPA `POST /api/connections {institutionId}`. BFF stores a pending row with a random `state` (+ PKCE verifier) and returns the provider `authUrl`. SPA calls `location.assign(authUrl)`.
2. User authenticates and consents at the bank.
3. Provider redirects to `GET /api/connections/callback?code&state`. The BFF finds the pending row **by `state`, not by cookie** (some banks return via cross-site POST and SameSite=Lax would drop the cookie), exchanges the code server-side, stores encrypted tokens, fetches accounts, then redirects to `/connect/result`.
4. SPA loads accounts and transactions from the BFF.

**Pay (PIS)**

1. `POST /api/payments` with an `Idempotency-Key`. BFF validates, creates the payment, calls the provider, returns `authUrl`.
2. User approves at the bank and returns to `/payments/:id/result`.
3. Provider webhook (polling fallback) → status update → SSE `/api/events` → SPA timeline.

## 5. Angular conventions

**Carried over from `angular-workspace2`**

- Standalone only, zoneless, default (OnPush) change detection with no `changeDetection` property.
- Signal `input()` / `output()` / `model()` / `viewChild()`, `inject()`, `@if` / `@for` / `@let`; `computed` and `linkedSignal` over `effect`.
- Tailwind 4 + Angular Material, ApexCharts for charts. Tailwind via `.postcssrc.json` + `@tailwindcss/postcss`, with **no** `tailwind.config.js` (the stale one in workspace2 is what broke its Karma builds).
- Strict TypeScript (`strict`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noImplicitReturns`, `noFallthroughCasesInSwitch`) and `strictTemplates`; feature-first folders with lazy routes.
- Playwright smoke suite with the `auth.setup.ts` storage-state pattern and a `PLAYWRIGHT_BASE_URL` override; a dev proxy file for `/api`.
- npm lockfile as source of truth; `.nvmrc`; `CLAUDE.md` + project skills; the "externally modified files are authoritative" rule.

**Deliberately different (greenfield, Angular 22)**

| angular-workspace2 | New app | Reason |
|---|---|---|
| Jest 30 + jest-preset-angular | Vitest through `@angular/build:unit-test` (CLI default) | The builder accepts Vitest `^4.0.8 \|\| ^5`; no legacy specs to carry |
| NgRx Store / Effects / Entity | `httpResource()` / `resource()` for server state + signals; `@ngrx/signals` SignalStore only for shared client state (filters, selected account) | Both are `@publicApi 22.0`; far less boilerplate |
| Reactive forms / form-ganarator | Signal Forms (`@angular/forms/signals`) | Stable in 22 (`@publicApi 22.0`); Angular's own recommendation |
| `@Injectable({ providedIn: 'root' })` | `@Service()` + `inject()` | `@Service` exists in 22.2 core; it's in Angular's best-practice file |
| `withXhr()` in `app.config.ts` | nothing | Fetch is the default `HttpBackend` (`withFetch` is deprecated); XHR only matters for upload progress |
| `*.component.ts` file names | CLI 2025 style guide (`transactions.ts`, `transactions.html`) | `ng new` default; generators and docs assume it |
| No ESLint | ESLint 10 + angular-eslint 22.6 + typescript-eslint + Prettier | Enforces the rules above mechanically (prefer-inject, prefer-signals, control flow, template a11y) |
| `@angular-devkit/build-angular` (webpack) still in devDependencies | `@angular/build` (esbuild) only | One builder, no Tailwind-plugin clash |
| Material / CDK 21.2 | Material / CDK 22.2.4 | Matches core |

Also from Angular's best-practice file: `host: {}` instead of `@HostBinding` / `@HostListener`, no `ngClass` / `ngStyle` / `CommonModule`, `NgOptimizedImage` for bank logos, axe + WCAG AA checks.

**Scaffold command** (run once the folder exists):

```bash
npx @angular/cli@22 new web --directory apps/web --style=scss --routing --zoneless --ssr=false \
  --test-runner=vitest --ai-config=claude-code --package-manager=npm --skip-git --interactive=false
```

SCSS because Material's theming needs Sass; `--ai-config=claude-code` generates Angular's official best-practice context for Claude, which we merge with our own `CLAUDE.md`. Versions checked on 2026-10-28: Angular 22.2.x, TypeScript must stay `>=6.0 <6.1` (npm `latest` is 7.0.2 — not supported by Angular 22), Node `^22.22.3 || ^24.15.0 || >=26`.

## 6. Repo layout

```
open-banking-poc/
├── apps/
│   ├── web/                    Angular SPA
│   │   └── src/app/
│   │       ├── core/           app.config, functional interceptors (problem+json → typed errors), session, inspector stream
│   │       ├── shared/         money, bank-logo, status-chip, empty / error / skeleton states
│   │       └── features/       connect · dashboard · transactions · insights · payments · connections · inspector
│   └── api/                    Fastify BFF
│       └── src/
│           ├── app.ts · server.ts · config.ts   (env validated with Zod)
│           ├── plugins/        session, csrf, helmet/CSP, rate-limit, RFC 9457 error handler
│           ├── modules/        connections · accounts · transactions · payments · webhooks · events · inspector · privacy
│           ├── providers/      port.ts · mock/ · truelayer/ · enablebanking/   (+ recorded fixtures for tests)
│           ├── domain/         categoriser · recurring detector · money · consent expiry
│           └── db/             node:sqlite wrapper · SQL migrations · repositories
├── packages/contracts/         Zod schemas + types (Institution, Account, Balance, Transaction, Payment, Problem…)
├── e2e/                        Playwright: auth.setup, smoke journey, axe checks
├── .claude/skills/             e2e-smoke-testing, provider-adapter (how to add a bank provider)
└── CLAUDE.md · .nvmrc · .npmrc (engine-strict) · eslint.config.js · .prettierrc · package.json (workspaces) · render.yaml (optional)
```

## 7. BFF API surface (v1)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/institutions?country&q` | Bank picker |
| POST | `/api/connections` | Start consent → `{ authUrl }` |
| GET | `/api/connections/callback` | Provider redirect target; code exchange server-side |
| GET / DELETE | `/api/connections`, `/api/connections/:id` | Status + expiry; revoke and purge cached data |
| GET | `/api/accounts` · POST `/api/accounts/:id/refresh` | Accounts with balances; user-initiated refresh |
| GET / PATCH | `/api/transactions?accountId&from&to&q&category&cursor`, `/:id` | Paged list; category override |
| GET | `/api/insights/summary?from&to` | Category totals, monthly in/out, recurring |
| POST / GET | `/api/payments`, `/api/payments/:id` | Create (Idempotency-Key); list / detail |
| POST | `/api/webhooks/:provider` | Signed provider callbacks |
| GET | `/api/events` | SSE: payment status, connection state, inspector calls |
| GET | `/api/inspector/calls` | Last 200 provider calls, redacted |
| DELETE | `/api/session` | Delete all my data / reset demo |
| GET | `/healthz`, `/readyz` | Probes |

Errors are `application/problem+json` with a stable `code` (`consent_expired`, `bank_unavailable`, `rate_limited`, `payment_rejected`, …) that the SPA maps to designed states.

## 8. Data model (SQLite)

- `sessions` (id, created_at, last_seen_at)
- `connections` (id, session_id, provider, institution_id, status `pending|active|expired|revoked|error`, state, encrypted tokens, token_expires_at, consent_expires_at)
- `accounts` (id, connection_id, provider_account_id, name, masked identifiers, currency, type, balance_minor, balance_at)
- `transactions` (id, account_id, provider_txn_id, booked_at, status `pending|booked`, amount_minor, currency, description, counterparty, category, category_source `auto|user`); unique (account_id, provider_txn_id)
- `payments` (id, session_id, provider, provider_payment_id, idempotency_key unique, amount_minor, currency, payee, reference, status, status_history)
- `webhook_events` (id, provider, event_id unique, payload, processed_at)

Tokens use AES-256-GCM from `node:crypto`, key from env, key-id prefix for rotation. The inspector is an in-memory ring buffer (not persisted).

## 9. The "real life" behaviours we build in

- **Consent lifecycle:** expiry tracking, reminders, one-click reconnect, detection of consent revoked at the bank.
- **Token refresh** with a single-flight lock; `invalid_grant` → connection `needs_reauth`.
- **Unattended-access limits:** PSD2 lets banks cap background account-data reads (typically four per account per day), so we cache, show `lastRefreshedAt`, and treat "Refresh" as a user-initiated call.
- **Data hygiene:** cursor pagination, de-duplication by provider transaction id, pending vs booked, integer minor units + ISO 4217 (no floats; never sum across currencies).
- **Payments:** idempotent creation, webhook signature verification, replay protection, idempotent processing, polling fallback.
- **Failure modes** simulated by the mock bank and by TrueLayer's outcome usernames, each with a designed UI state: consent denied, SCA timeout, bank unavailable, rate limited, insufficient funds, payment rejected, cancelled.
- **Security:** `state` + PKCE, strict redirect allow-list, helmet + CSP, SameSite=Lax cookie + Angular's built-in XSRF header, rate limiting, pino `redact`, no PII in logs, inspector masks account identifiers in live mode, GDPR "delete my data".
- **README explains the regulatory model** (aggregator licence vs your own TPP licence) and why the public instance never uses real accounts.

## 10. Milestones — each ends in something demoable

| M | Scope | Accept when |
|---|---|---|
| **M0 Foundations** | Monorepo, tooling, `CLAUDE.md`, ESLint / Prettier, Vitest, Playwright harness, `npm run dev` (API + SPA via proxy), CI-neutral `npm run verify` | `verify` is green on the empty shell; wrong Node version fails fast |
| **M1 Mock bank + AIS** | contracts, provider port, MockProvider with hosted consent page and failure scenarios, session + CSRF, connect flow, accounts, dashboard, transactions, Inspector v1 | Playwright journey connects "Mock Bank" and shows seeded data; denial / timeout / outage show designed states |
| **M2 TrueLayer sandbox (AIS)** | Auth link, code exchange, refresh, accounts / balances / transactions with test users `john1…john100`, `doe1…doe100`; mapping tests from recorded fixtures | Connecting the TrueLayer mock bank from the UI works; refresh and reconnect work; fixture tests run offline in CI |
| **M3 Payments (PIS)** | Signal-Forms payment form; Payments v3 with request signing + idempotency; mock bank outcomes via `test_executed`, `test_authorisation_failed`, `test_execution_rejected`, cancel; webhook → SSE → timeline | All four outcomes visible in the UI; replaying a webhook doesn't double-apply |
| **M4 Insights + polish** | Categoriser (rules + override), ApexCharts, recurring detection, CSV export, skeletons, responsive + dark mode, axe clean, bundle budget | Insight numbers match unit-tested expectations; axe passes on every route |
| **M5 Harden, deploy, demo** | CSP, rate limits, redaction audit, README + 5-minute demo script, optional Render blueprint (sandbox only). Optional: `EnableBankingProvider` (JWT RS256) for your own accounts, local only | Demo script runs on a clean checkout in under 10 minutes |

## 11. Verification

- `npm run verify`: lint, typecheck, Vitest, build.
- `npm run e2e`: Playwright against the mock provider (deterministic). `npm run e2e:sandbox`: opt-in, needs TrueLayer credentials.
- Manual pass through the demo script in the browser; confirm the Inspector shows the real provider calls.
- Security check: no provider token in browser storage, API responses or logs.

## 12. What I need from you, and when

- **Now:** confirm D1–D7 or change them; confirm the folder; tell me where the repo will live (GitHub or GitLab) so CI can be added later.
- **Before M2:** a free TrueLayer Console account → sandbox client id / secret and a signing key (I'll walk you through generating it). Credentials go in `apps/api/.env`, never in chat.
- **Before M3 webhooks:** a tunnel (cloudflared or ngrok) or the URL of the deployed instance.
- **Optional, M5:** an Enable Banking account, an app registered in production (restricted) mode, and your own bank linked.

## 13. Risks and things to verify first

- **Enable Banking spike (before M5):** (a) redirect-URL rules for `http://localhost`; (b) whether payment initiation works in restricted mode; (c) the Terms of Service for showing it to other people. The docs I could read don't answer these.
- **TrueLayer live access:** its go-live guide routes upgrades through their sales team (current process not verified), so the POC stays on sandbox unless your company already has a contract.
- **Provider drift:** contained by the mapping layer, recorded fixtures and contract tests.
- **`node:sqlite` is still flagged as early-stability in Node 24:** it's isolated behind the repository layer; `better-sqlite3` is the fallback.
- **Node:** wrong Node versions are the most likely first-day failure; `.nvmrc`, `engine-strict` and a `CLAUDE.md` note guard against it.

## 14. How the build would run

A new session rooted at the new folder (this session still has an unfinished merge in `angular-workspace2`). It works M0 → M5 in order; in M1 the API and web halves can proceed in parallel once `packages/contracts` exists. Commits follow your usual style.

### Reused from angular-workspace2 (copy and adapt)

- `playwright.config.ts` (setup project + storage state) and `e2e/auth.setup.ts`
- `tsconfig.json` strict flags and `angularCompilerOptions`
- `proxy.conf.json` / `proxy.mock.conf.json` pattern
- `render.yaml` structure (generated secrets, health-check path)
- `CLAUDE.md` rules and the `.claude/skills/e2e-smoke-testing/SKILL.md` layout
- `projects/admin/src/app/app.config.ts` layout for interceptors (functional, in `core/`)

The existing `ui` library is not reused: it's a casino-admin kit, and its `package.json` still declares Angular `^19.2` peers.

## Sources

- Enable Banking: [quick start](https://enablebanking.com/docs/api/quick-start/), [restricted production](https://enablebanking.com/docs/api/linked-accounts/)
- TrueLayer: [quickstarts](https://docs.truelayer.com/docs/quickstart-guides), [test payments in sandbox](https://docs.truelayer.com/docs/test-payments-in-sandbox), [mock users](https://docs.truelayer.com/docs/mock-users)
- Angular: [official best practices](https://angular.dev/assets/context/best-practices.md), [v22 announcement](https://blog.angular.dev/announcing-angular-v22-c52bb83a4664), [angular-new-app skill](https://www.skills.sh/angular/skills/angular-new-app)
- UK commercial VRP: [Finexer summary](https://blog.finexer.com/?p=35851)
