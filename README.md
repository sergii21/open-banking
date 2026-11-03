# Ledger Lens

```bash
./start.sh                          # installs once, builds if needed, starts, and opens http://localhost:3000
npm run app                         # the same server without the helper: builds if the sources changed, serves on :3000
MONOBANK_TOKEN=... npm run doctor   # optional: checks your own monobank token first (read-only, prints counts only)
```

Numbered steps, with what you should see at each one: [docs/START_HERE.md](docs/START_HERE.md).

## What it is

Your monobank, instantly: a small, fast personal-finance app on your own real monobank data. It runs on your computer, reads
with a token you issue yourself (read-only: it can never move money) and keeps everything in a local SQLite file.

- **Home**: your money in hryvnias (every card and jar, foreign currencies at monobank's own rates), a 30-day line, this month
  against the same days last month, accounts, top categories, regular payments.
- **Activity**: every transaction grouped by day, instant search (press `/`), filters, a detail sheet, category changes that
  stick, CSV export.
- **Insights**: spending by category and place for any month, change against the month before, and regular payments found
  automatically.
- **Settings**: theme, blurred amounts, replace or delete the token, **Live API** (the real calls the app makes, token
  redacted) and **Copy diagnostics** (counts and field names only, safe to paste).
- **Demo data**: the same code running against a built-in fake bank with a made-up Ukrainian customer, so you can look around
  before connecting anything.

monobank allows one read a minute per endpoint. Connecting therefore shows balances from a single read straight away and loads
history one step a minute, newest first, saying where it is ("Next step in 41 s · 2 of 8").

## How it is built

```
apps/web             Angular 22 SPA: zoneless, signals, own CSS design system (tokens in src/styles), native <dialog> sheets,
                     hand-drawn SVG icons and charts, a ~100-line navigator (core/nav.ts) instead of a router
apps/api             Fastify 5 backend-for-frontend: Zod 4 request validation, node:sqlite, pino
  src/providers        the BankingProvider port, the monobank adapter (used for the real bank and for the demo), the fake bank
  src/modules          session, connection, sync (the paced loader), home, insights, rates, diagnostics, events, inspector
  src/domain, src/db   money, calendar, categorising and insight logic; migrations and repositories (all SQL lives in db/)
packages/contracts   plain TypeScript types and small pure helpers (money formatting, CSV) shared by both apps, no dependencies
e2e                  Playwright: the demo, the token flow against a paced fake monobank, axe on every screen, phone layouts
scripts              app.mjs (npm run app), check-node.mjs, screenshots.mjs
data/                created on the first run, git-ignored: ledger-lens.db and secret.key (0600)
docs                 START_HERE.md, HANDOVER.md (state of the work), UKRAINE.md, V2_BRIEF.md and PLAN.md (history), screenshots/
```

- One browser is one session: an HttpOnly cookie, a CSRF header on every write, a strict Content-Security-Policy. The browser
  only talks to this server, same origin. The bank is only ever called from the server.
- The token is sealed with AES-256-GCM under a key generated on the first run and kept next to the database. It never reaches
  the browser, a log or the Live API drawer (`x-token` is redacted).
- Real accounts connect only when the app is served from this machine (`PUBLIC_URL` on localhost). A public instance can only
  run demo data.
- Money is integer minor units plus a currency. Home and Insights value foreign amounts in hryvnias at today's rate and say so.
- Everything the bank sends goes through one instrumented HTTP layer that the Live API drawer and the diagnostics read from.
  The demo runs the same adapter against an in-process fake, so what it shows has gone through the code a real connection uses.

## Before and after

| Measure                                | v1                  | v2                            |
| -------------------------------------- | ------------------- | ----------------------------- |
| Initial JS, raw                        | 857 kB              | **170 kB**                    |
| Initial JS + CSS, estimated transfer   | 207 kB              | **58 kB**                     |
| Lighthouse on Home, mobile / desktop   | 75 / 95 (LCP 8.1 s) | **100 / 100** (LCP 0.9 s)     |
| Home page weight                       | 1181 kB             | **101 kB**                    |
| Keystroke to filtered list, 5,892 rows | n/a                 | about one frame (26 to 33 ms) |
| Source lines (no tests)                | 19,589              | 13,141                        |
| Tests                                  | 513                 | 82 unit + 10 Playwright       |

Measured on the production build, with Lighthouse 13.6 on `/home` with a session cookie, three runs, median. Details and method
in [docs/HANDOVER.md](docs/HANDOVER.md).

## Developing

Node 24 (`.nvmrc`; `./start.sh` finds it through nvm), then `npm ci`.

| Command                                        | What it does                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`                               | check:node, ESLint, Prettier, typecheck, unit tests (contracts, API, web), production build                                              |
| `npm run e2e`                                  | build, then Playwright: demo bank (:4300), the token flow against the paced fake (:4301, :4310), axe, phone widths                       |
| `npm run fake:monobank`                        | a stand-in for api.monobank.ua with the same one-read-a-minute limit, for trying the paced loading                                       |
| `PUBLIC_URL=http://localhost:4200 npm run dev` | API on :3000 (watch) and the Angular dev server on :4200; the API must be told the origin the browser uses. Not exercised in the v2 pass |
| `node scripts/screenshots.mjs`                 | retakes `docs/screenshots` from running servers (its header says which)                                                                  |

The build fails above 250 kB of initial JS + CSS and warns above 215 kB (`apps/web/angular.json`). Optional settings, all with
defaults: `apps/api/.env.example`.

## A public demo

`render.yaml` is a Render blueprint for a demo-only instance: made-up data only, anonymous sessions forgotten after two days. By
reading the code it should deploy and work, but it has never been deployed from this repository, so check the first build's log.

## History, and what is not verified

- The full v1 (payments, TrueLayer sandbox, the mock bank with hosted consent pages, Material UI, a charts library) is the git
  tag `v1-full-featured`.
- Not yet run with a real token: field shapes on a real account, whether `balance` includes the credit limit, and whether a
  statement item's `balance` is the balance after it. `npm run doctor` and Copy diagnostics test these on your data.
  See [docs/UKRAINE.md](docs/UKRAINE.md) and [docs/HANDOVER.md](docs/HANDOVER.md).
- PrivatBank has no personal API, so there is no Privat importer (details in docs/UKRAINE.md).
