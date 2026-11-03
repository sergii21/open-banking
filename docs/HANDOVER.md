# Ledger Lens v2: hand-over (kept current after every phase)

The v2 brief is `docs/V2_BRIEF.md` (source of truth). v1, with everything that was cut, is the git tag `v1-full-featured`
(`git checkout v1-full-featured`; its own hand-over is in that tag's `docs/HANDOVER.md`). Node 24 for every command:
`export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH`.

## Where we are

| Phase                         | State       | Commit |
| ----------------------------- | ----------- | ------ |
| A baseline and cut            | in progress |        |
| B real-data path (API)        | not started |        |
| C new UI                      | not started |        |
| D evidence, docs, deliverables | not started |        |

**Done:** tag `v1-full-featured`; baseline measured (below); monobank's published spec read (below).
**Next:** delete what section 5 of the brief lists, keep `npm run verify` green.
**Not verified:** anything that needs a real monobank token (see the end of this file).

## Baseline: v1 (tag `v1-full-featured`), measured 2026-11-03

| Measure                                  | v1                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Initial JS, raw                          | 857.1 kB (main 411.2, two shared chunks 288.1 and 157.8)                   |
| Initial JS, gzip -9 / brotli estimate    | 225.3 kB / 199.9 kB                                                        |
| Initial CSS, raw / gzip                  | 41.4 kB / 8.7 kB                                                           |
| Initial total (Angular's table)          | 898.5 kB raw, 207.5 kB estimated transfer (budget 900 kB)                  |
| Largest lazy chunk                       | ApexCharts, 956 kB raw (231.7 kB transfer)                                 |
| Lighthouse 13.6, dashboard, mobile       | performance 75 (runs 65/76/75), FCP 0.90 s, LCP 8.10 s, TBT 9 ms, CLS 0   |
| Lighthouse 13.6, dashboard, desktop      | performance 95, FCP 0.24 s, LCP 1.49 s, TBT 0 ms, CLS 0                    |
| Page weight on the dashboard             | 1181 kB (the server sent static files uncompressed)                        |
| Source lines (app code, no tests)        | 19,589 (api 14.4k, web 5.0k, contracts 0.8k, scripts)                      |
| Test lines / tests                       | 7,294 unit lines (contracts 40, api 305, web 62 tests) + 1,890 e2e lines (106 Playwright tests) |

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
- That a statement item's `balance` is the balance *after* that operation.

## Defaults chosen (the brief said do not stop to ask)

Recorded here as they are made.

## Not verified (needs the user's real token)

Everything in the two assumptions above, the real shape of every field on a real account, the real 429 body, the real latency.
