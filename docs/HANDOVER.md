# Ledger Lens: state at the end of the build

Everything in `docs/PLAN.md` is built except the optional Enable Banking adapter. This note says what exists, how it was
checked, and above all **what was not checked**. Node 24 for every command:
`export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH`. Start with `README.md`, then `CLAUDE.md`.

## Status

| Milestone                                    | Status                                                                                                                                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 foundations                               | done (`9aefde6`)                                                                                                                                                                                                              |
| M1 mock bank, account information, Inspector | done (`3e9dfac`); verified in the browser on desktop, phone, dark mode, axe                                                                                                                                                   |
| M2 TrueLayer sandbox, account information    | done (`5a735bb`); offline fixture tests; **live sandbox not verified**                                                                                                                                                        |
| Ukraine: monobank                            | done (`ff6bc7f`, `fc77d8b`): real personal-API adapter, token connect, paced history; fake-bank e2e; **no real account was available** (see `docs/UKRAINE.md`)                                                                |
| M3 payments                                  | done (`065aea2`, `dbb4d5d`): idempotent payments, webhooks, polling fallback, mock bank journeys with every outcome, TrueLayer payments with ES512 signing and webhook verification (**written from the docs, offline only**) |
| M4 insights and polish                       | done (`a46037c`): insights API and page (ApexCharts, table views, standing payments), category override, CSV export                                                                                                           |
| M5 harden, deploy, demo                      | done (`371c851` and the commit after it): session creation cap, `no-store` under `/api`, redaction audit, CSP end-to-end check, README, `docs/DEMO.md`, `render.yaml` (**not deployed**); Enable Banking **not built**        |

## Checks that were run (final state)

- `npm run verify`: exit 0. Contracts 40, API 305, web 62 unit tests; ESLint (with Angular template accessibility rules), Prettier,
  strict typecheck, production build with the initial bundle at **898.5 kB of the 900 kB budget**.
- `npm run e2e`: 106 Playwright tests against the mock bank (every journey and failure state, payments, insights, CSP,
  phone layout including 320px, axe WCAG 2.2 AA on every route in light and dark).
- A **clean clone** (`git clone`, `npm ci`, `npm run verify`, `npm run e2e:only`) passed the same, with no `.env`, key or database file.
- The running app was driven in the in-app browser: desktop (dark and light) for connect, dashboard, payments with live timeline,
  demo webhook replay, Inspector, insights chart (hover and keyboard readout), table view, category override; phone width for the
  payment pages and Insights (which is where the card-overflow bug at 375px was found and fixed).
- Live public monobank endpoints: the rates endpoint and the bad-token answer only.

## What was NOT verified

- **TrueLayer, live**: the Data API calls, Payments v3 (create, get, error shapes), ES512 request signing, webhook signature
  verification, the `uk-cs-mock` versus `mock` provider id, the revoke endpoint (`DELETE /api/delete`), whether the `user` object and
  the merchant-account beneficiary fields (`reference`, `statement_reference`) are accepted as sent, and `external_account`
  payments (which need TrueLayer to enable them). Fixtures are written from the docs (`apps/api/test/fixtures/truelayer/README.md`),
  not recorded. The stub verifies our request signatures like the real API would, and the tests re-check the format with plain
  `node:crypto`, but only TrueLayer can say it agrees. `npm run e2e:sandbox` is the opt-in suite for the first live run.
- **monobank, with a real account**: whether a credit card's `balance` includes its `creditLimit` (the adapter assumes it does and
  shows own funds as `balance - creditLimit`), whether jar ids work in the statement endpoint, the exact 429 body, and webhooks
  (not built; they need a public URL). `MONOBANK_TOKEN=... npm run test:live -w @ledger-lens/api` runs the opt-in checks.
- **Render**: `render.yaml` parses but was never deployed. Unchecked: that Render's `generateValue` output is accepted as
  `TOKEN_ENCRYPTION_KEY` (the app wants 32 bytes in base64 and says so if not), and that Node 24.15 is selectable through `NODE_VERSION`.
- **Enable Banking**: not built. The plan's section 13 spike (redirect rules for localhost, payments in restricted mode, terms for showing
  it to others) needs an account and could not be done.
- Webhooks with a **tunnel**: no tunnel was available. The mock bank delivers real signed HTTP webhooks to the app in-process, and the
  polling fallback is tested; TrueLayer delivering to a tunnel is untested.

## Deviations from the plan

No `@faker-js/faker` (a seeded PRNG generates the mock data); a `needs_reauth` connection status was added; custom Material palette
generated with Material Color Utilities (stock cyan is neon); layouts use CSS container queries rather than viewport breakpoints; the
Inspector docks at the bottom below 1440px and on the right above; the Inspector's scope switch is a small `ll-segmented` control
instead of Material's button toggle (the toggle cost 27 kB of initial bundle); TrueLayer's mock users are username/password pairs;
payments to an arbitrary account are not assumed to be enabled (the default beneficiary is a merchant account, so `fixedPayee`);
the monobank token field is a plain signal input, while the payment form uses Signal Forms; `jose` was declared but unused and is
removed; the demo's "replay last webhook" re-signs the same event with a fresh timestamp instead of re-sending the old signature
(a stale signature would be refused, which is also correct); the web app's `zod` is a wrapper (`src/zod-jitless.ts`) because the
payments chunk split moved schema creation ahead of `main.ts` and brought back a CSP violation; the category breakdown is a bar list
rather than a chart (thirteen categories are too many for a pie, and the list is its own table view) and only the monthly view uses
ApexCharts, whose light-mode orange is below 3:1 contrast against the card, answered by a table view next to the chart.

## What is needed from you

- **TrueLayer** (to verify what is above): sandbox client id and secret, a signing key id (after `npm run keys:truelayer` and
  uploading the public key), and the merchant account ids, all in `apps/api/.env` and never in chat; the three redirect and webhook
  URLs from the README registered in the Console.
- **A webhook tunnel** (cloudflared or ngrok) if you want TrueLayer to push; polling covers it without.
- **The Enable Banking decision**: if you want real EU banks beyond Ukraine, say so; the `provider-adapter` skill is the recipe, and
  the section 13 spike comes first.
- **monobank**: your own token, pasted into the app, if you want to confirm the unverified items above.
- Whether to push this anywhere (there is no remote; nothing has ever been pushed).

## Things worth knowing before you change anything

- The initial bundle is within 1.5 kB of its warning budget. Lazy-load what one page needs (the account-filter resolver imports its
  store on demand for this reason), and run `npm run build` after touching the shell, the routes or global styles.
- `node:sqlite` is still early-stability in Node 24; it is isolated behind `apps/api/src/db` and `better-sqlite3` is the fallback.
- Payments are per session; the mock bank's payments token is cached app-wide, so only the first payment shows "Get payments token"
  in its Inspector.
- Charts: the two series colours were validated with the data-viz skill's `validate_palette.js` against this app's surfaces; re-run it
  if the theme changes.

## Follow-ups that are not scope creep

monobank webhooks for new transactions (needs a public URL); PrivatBank only if a personal API appears; a retry button for a history
load that gave up; a nightly job for the sandbox suite once credentials exist.
