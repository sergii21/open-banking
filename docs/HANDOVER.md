# Ledger Lens v2: hand-over (kept current after every phase)

The v2 brief is `docs/V2_BRIEF.md` (source of truth). v1, with everything that was cut, is the git tag `v1-full-featured`
(`git checkout v1-full-featured`; its own hand-over is in that tag's `docs/HANDOVER.md`). Node 24 for every command:
`export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH`.

## Latest state (read this first; it supersedes the older sections below where they differ)

The session stopped on a usage limit. Everything below is committed; `npm run verify` exits 0 (contracts 11, API 67, web 4 unit
tests) and the Playwright suite passes (10 tests).

| Phase                          | State                                                                                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A baseline and cut             | done                                                                                                                                                                                                                                                     |
| B real-data path (API)         | done                                                                                                                                                                                                                                                     |
| C new UI                       | done: welcome, Home, Activity, Insights, Settings sheet, Live API drawer; own design system; no Router, Material, Tailwind, zod or chart library in the browser                                                                                          |
| D evidence, docs, deliverables | done except two things: `CLAUDE.md` and `.claude/skills/*` still describe v1 (see "What is left"). Docs pass finished: README, UKRAINE.md, render.yaml (demo-only), DEMO.md deleted, PLAN.md and V2_BRIEF.md marked as history, phone screenshots shrunk |

### Before and after (measured 2026-11-03, same method as the baseline)

| Measure                              | v1                     | v2                                                                                      |
| ------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------- |
| Initial JS, raw                      | 857.1 kB               | 170.2 kB (main 27.1 + framework chunk 143.1)                                            |
| Initial JS + CSS, estimated transfer | 207.5 kB               | 57.7 kB (CSS 27.0 kB raw, 6.0 kB brotli)                                                |
| Lighthouse mobile, Home              | 75 (LCP 8.10 s)        | **100** (FCP 0.90 s, LCP 0.90 s, TBT 0 ms, CLS 0)                                       |
| Lighthouse desktop, Home             | 95 (LCP 1.49 s)        | **100** (FCP 0.24 s, LCP 0.24 s, TBT 0 ms, CLS 0)                                       |
| Page weight on Home                  | 1181 kB (uncompressed) | 101 kB (brotli, pre-compressed assets, all lazy chunks prefetched)                      |
| Keystroke to filtered list           | n/a                    | about one frame: 26 to 33 ms for two frames on 5,892 rows (Activity first paint 138 ms) |
| Source lines (app code, no tests)    | 19,589                 | 13141                                                                                   |
| Test lines                           | 7,294 unit + 1,890 e2e | 1870 (82 unit tests, 10 Playwright)                                                     |

### Verified

- In a browser and in Playwright, on the demo bank: first run, demo, every tab, instant search, detail sheet, category change,
  blur, disconnect, Settings, Live API; axe WCAG 2.2 AA on every screen and sheet in light and dark; phone and 320 px layouts
  (nothing past the edge); no Content-Security-Policy violations.
- The real-token flow against a paced fake monobank (`npm run fake:monobank`, enforces one read per interval): wrong token
  explained, balances in seconds, history one step per interval with an honest chip, a 429 waits, outage and rate-limit screens.
  Screenshots in `docs/screenshots` (`scripts/screenshots.mjs` regenerates them).
- Against the real service without a token: real exchange rates shown through the app (the demo asks api.monobank.ua for them);
  a made-up token gets the real 403, becomes "monobank does not recognise this token" and nothing is stored.
- From monobank's published spec (v250818): jar ids work in the statement endpoint; one read a minute per endpoint (the spec
  does not say whether the two limits are shared, so the scheduler learns it from a 429); 31 days + 1 hour per statement;
  `/bank/currency` refreshes at most every 5 minutes; webhook contract (GET check, then POSTs, no signature).

### Not verified (needs the user's real token)

Real field shapes on a real account; that `balance` includes `creditLimit` (the spec does not say; `npm run doctor` and the
diagnostics report where a credit card's balance sits against its limit); that a statement item's `balance` is the balance after
that item (the spec only says "account balance"; the diagnostics report how many consecutive pairs agree); the real 429 body;
real latency; the Render blueprint (now demo-only; reasoned from the code, never deployed).

### What is left

Finished in the docs pass: `README.md` (rewritten for v2), `docs/UKRAINE.md` (cut to what is true), `render.yaml` (demo-only; `HOST=0.0.0.0`
added, the rest of the v1 settings removed), `docs/DEMO.md` (deleted: it was the v1 tour), banners on `docs/PLAN.md` and `docs/V2_BRIEF.md`,
phone and 320 px screenshots reduced to 1x.

1. **`CLAUDE.md` and `.claude/skills/*` still describe v1 and were deliberately not changed.** A peer session asked for those edits;
   instruction and configuration files only change on the user's own say-so. When the user agrees, what has to change:
   - `CLAUDE.md`: no Material, Tailwind, ngrx, zod, HttpClient, CDK or Router in the SPA (own CSS tokens in `apps/web/src/styles`,
     native `<dialog>`, hand-drawn SVG, `core/nav.ts`, `fetch` with the XSRF header in `core/api.ts`); contracts are plain types and
     pure helpers; the API validates requests with zod and does not schema-validate responses; bundle budget 215 kB warn / 250 kB
     error for initial JS + CSS; commands `./start.sh`, `npm run app|doctor|dev|verify|e2e|fake:monobank`; keep: integer minor
     units, live providers localhost-only, token sealed (key in `data/secret.key`) and never logged, statement reads paced from the
     port's `limits`, all provider HTTP through `ProviderHttp`, time from the injected `Clock` and days from `Calendar`. Remove:
     the payments rule, charts rule, `zod-jitless`, Material/Tailwind rules, the 106-test matrix, TrueLayer and mock-bank
     commands (`e2e:sandbox`, `keys:truelayer`, `test:live`).
   - `e2e-smoke-testing`: the suite is `e2e/demo`, `monobank`, `a11y` and `phone.mobile` specs (10 tests); the demo app is on :4300 and the
     real-token flow on :4301 against the paced fake on :4310; `npm run e2e` builds first; `scripts/screenshots.mjs` retakes the pictures.
   - `provider-adapter`: the port is now `connect`, `fetchAccounts`, `fetchTransactions`, `fetchRates`, `revoke` plus `limits`
     (statement and account-list intervals, window days, row cap, history months); no redirect or payment parts; one adapter class
     serves `monobank` and `demo`; the fake bank is in `providers/monobank/demo`; DTOs are tolerant (per-row parse, diagnostics
     collector). The v1 text is in the `v1-full-featured` tag.
2. Home on desktop: the hero card does not stretch to the height of the accounts column.
3. Noticed, not changed (it is code): `npm run dev` serves the SPA on :4200, but `PUBLIC_URL` now defaults to `http://localhost:<PORT>`,
   so the CSRF origin check rejects writes unless `PUBLIC_URL=http://localhost:4200` is set (the README says so; the default could
   follow `NODE_ENV=development`). Not verified.
4. Optional, not started: "Enable live updates" (monobank webhook; needs a public HTTPS address).

### Observation, not a bug

`npm run fake:monobank` keeps one limit for everything that talks to it. If an earlier session's background loader is still
running against the same fake, a new session's first statement gets a 429 and waits 60 s ("Next step in 59 s" in
`docs/screenshots/15-paced-home-loading.png`). A real token has its own limit.

---

## Where we were after phases A and B

| Phase                          | State                                                                                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A baseline and cut             | done: v1 tagged, baseline measured, payments / TrueLayer / mock bank / old UI / old tests removed                                                                                                                                                        |
| B real-data path (API)         | done and committed: see "What the API does now". 67 API tests, 11 contracts tests                                                                                                                                                                        |
| C new UI                       | **next**: `apps/web` is empty on purpose (v1 UI deleted); build it from section 4 of the brief                                                                                                                                                           |
| D evidence, docs, deliverables | done except two things: `CLAUDE.md` and `.claude/skills/*` still describe v1 (see "What is left"). Docs pass finished: README, UKRAINE.md, render.yaml (demo-only), DEMO.md deleted, PLAN.md and V2_BRIEF.md marked as history, phone screenshots shrunk |

**Right now `npm run verify` cannot pass** until `apps/web` has an app again; the API workspace is green on its own
(`npx tsc --noEmit -p apps/api/tsconfig.json`, `npm test -w @ledger-lens/api`, `npx eslint apps/api packages/contracts`).
To try the API without a UI: `cd apps/api && npx tsx src/server.ts`, then use a script like the one described in Phase B notes below.

### What the API does now (Phase B)

- One provider adapter, `providers/monobank/adapter.ts`, used twice: `monobank` (the real bank, only when `PUBLIC_URL` is localhost) and
  `demo` (same class, transport = in-process `FakeMonobank` with a deterministic Ukrainian dataset, ~1,400 rows over 100 days,
  six accounts incl. a credit card with a limit, a USD card, a FOP account and two jars). Tolerant DTOs (`dto.ts`): one bad row never hides the others.
- Pacing (`modules/sync/service.ts`): connect = one `client-info` read, Home renders from it; then a queue of statement windows
  (main UAH card newest 31 days first, other cards' newest window, older windows, jars last), one per minute, each step
  announced over SSE (`sync.updated`). 429 waits `Retry-After` or 60 s; a 429 right after the other endpoint switches to one shared gate.
  The 500-row cap queues the rest of the window. Top-ups while someone is watching. `POST /api/sync/refresh`, `/sync/load-earlier`, `/accounts/:id/prioritise`.
- Endpoints: `GET /api/session`, `POST/PUT/DELETE /api/connection`, `GET /api/home`, `/activity`, `/insights?month=`, `/sync`,
  `/diagnostics`, `PATCH /api/transactions/:id`, `/api/inspector/calls`, SSE `/api/events`.
- Rates: `GET /bank/currency` (the demo also asks the real bank, no token needed), cached 5 min in memory, persisted, stale flag.
- Keys: `<repo>/data/secret.key` (0600) generated on first run; DB at `<repo>/data/ledger-lens.db`; both git-ignored.
- Diagnostics: field names/types/counts and yes/no checks only; a test proves no description, comment, id, last4 or token appears.

## Baseline: v1 (tag `v1-full-featured`), measured 2026-11-03

| Measure                               | v1                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Initial JS, raw                       | 857.1 kB (main 411.2, two shared chunks 288.1 and 157.8)                                        |
| Initial JS, gzip -9 / brotli estimate | 225.3 kB / 199.9 kB                                                                             |
| Initial CSS, raw / gzip               | 41.4 kB / 8.7 kB                                                                                |
| Initial total (Angular's table)       | 898.5 kB raw, 207.5 kB estimated transfer (budget 900 kB)                                       |
| Largest lazy chunk                    | ApexCharts, 956 kB raw (231.7 kB transfer)                                                      |
| Lighthouse 13.6, dashboard, mobile    | performance 75 (runs 65/76/75), FCP 0.90 s, LCP 8.10 s, TBT 9 ms, CLS 0                         |
| Lighthouse 13.6, dashboard, desktop   | performance 95, FCP 0.24 s, LCP 1.49 s, TBT 0 ms, CLS 0                                         |
| Page weight on the dashboard          | 1181 kB (the server sent static files uncompressed)                                             |
| Source lines (app code, no tests)     | 19,589 (api 14.4k, web 5.0k, contracts 0.8k, scripts)                                           |
| Test lines / tests                    | 7,294 unit lines (contracts 40, api 305, web 62 tests) + 1,890 e2e lines (106 Playwright tests) |

Method: production build, `PROVIDERS=mock` server on :4300 with the e2e environment, a session connected through the UI,
Lighthouse programmatic API with the session cookie as an extra header, default simulated throttling, 3 runs each, median.
The script lives outside the repo (scratchpad); `npm run lighthouse` is not part of the project.

## What monobank's published spec says (api.monobank.ua/docs, version v250818, read 2026-11-03)

Extracted from the OpenAPI document embedded in the docs page.

Confirmed by the spec:

- `GET /personal/client-info`: "not more often than once per 60 seconds". `GET /personal/statement/{account}/{from}/{to}`: same,
  once per 60 seconds, at most 31 days + 1 hour (2,682,000 s). The spec does not say whether the two limits are shared, so the
  scheduler treats them as separate and switches to a shared gate if a 429 shows otherwise.
- **Jar ids work in the statement endpoint**: `account` is "the account or jar identifier from the lists, or 0 for the default account".
- `GET /bank/currency`: cached by the bank and updated "not more often than once per 5 minutes". Each pair has one or more of
  `rateSell`, `rateBuy`, `rateCross`.
- Statement item: `commissionRate` is an amount in minor units (despite the name), `cashbackAmount` too; `comment` and `receiptId`
  may be absent; `balance` is described only as "account balance in minor units".
- Webhook: `POST /personal/webhook {webHookUrl}`; monobank first sends a GET that must answer exactly 200, then POSTs
  `{type:"StatementItem", data:{account, statementItem}}`; retries after 60 s and 600 s, then disables itself. No signature, so the
  URL has to carry a secret.
- Not available to clients under 16. Personal use and tools whose data does not pass through the developer's servers need no
  corporate API.

**Not stated by the spec (assumptions the app makes; the diagnostics and `npm run doctor` test them on real data):**

- That account `balance` includes `creditLimit` (so own funds = balance - creditLimit).
- That a statement item's `balance` is the balance _after_ that operation.

## Defaults chosen (the brief said do not stop to ask)

- One connection per browser session (cookie lasts 365 days, sliding); the session cookie is the only link to the data, so
  clearing cookies means pasting the token again (the old rows are purged after the TTL).
- History: 2 months for a real token (enough for month-over-month), 3 for the demo; "Load earlier months" adds one month at a time (max 13).
- Days and months are cut in `Europe/Kyiv` (`TIME_ZONE`), because the bank and the person are there.
- Home and Insights are in UAH: foreign balances and rows are valued at today's rate (`rateBuy`, else cross, else sell); the screens say so.
- Own funds = `balance - creditLimit` (assumption, see below); "available with credit" = `balance`.
- Pending (hold) items count towards spending; transfers (P2P, own accounts, jars, ATM cash) never count as spending or income.
- Regular payments: two payments a month apart for the same amount in a subscription or a utility already count (the default history is short).
- The server binds to 127.0.0.1 by default; logs are `warn` when built.
- No zod and no HttpClient in the browser: the API is same-origin and trusted, the SPA uses `fetch` and the contracts' plain types.

## Not verified (needs the user's real token)

Everything in the two assumptions above, the real shape of every field on a real account, the real 429 body, the real latency.
