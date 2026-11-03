# Ledger Lens v2: hand-over (kept current after every phase)

The v2 brief is `docs/V2_BRIEF.md` (source of truth). v1, with everything that was cut, is the git tag `v1-full-featured`
(`git checkout v1-full-featured`; its own hand-over is in that tag's `docs/HANDOVER.md`). Node 24 for every command:
`export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH`.

## Where we are

| Phase                          | State                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| A baseline and cut             | done: v1 tagged, baseline measured, payments / TrueLayer / mock bank / old UI / old tests removed |
| B real-data path (API)         | done and committed: see "What the API does now". 67 API tests, 11 contracts tests                 |
| C new UI                       | **next**: `apps/web` is empty on purpose (v1 UI deleted); build it from section 4 of the brief    |
| D evidence, docs, deliverables | not started (`npm run doctor`, `start.sh`, `docs/START_HERE.md`, README, skills, screenshots)     |

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
