# Ledger Lens — project rules

A personal-finance app for a person's own monobank and PrivatBank accounts (monobank and PrivatBank business/ФОП accounts live, with a
token the person issues; personal Privat cards from a Privat24 statement file): their money in hryvnias, this month against the same
days last month, every transaction with instant search, and their regular payments. Read-only, on their own computer, and fast. How to run it:
`README.md`; the person's own steps: `docs/START_HERE.md`; current state, measurements and what is **not** verified:
`docs/HANDOVER.md`. `docs/V2_BRIEF.md` and `docs/PLAN.md` are history. The full v1 (payments, TrueLayer, mock bank, Material UI)
is the git tag `v1-full-featured`.

## Externally modified files

When a system-reminder reports that a file was **modified outside** (by the user or a linter), treat those changes as **accepted and authoritative**.

- Do NOT revert, re-apply, or re-generate the affected file.
- Do NOT ask for confirmation — the reminder already states the change was intentional.
- Continue working with the file in its current on-disk state.
- If a subsequent task touches the same file, read it fresh first to pick up the external edits.

## Node version — do this first

Node **^24.15.0** only (`.nvmrc`, `engine-strict`). The shell default may be Node 25, which Angular 22 rejects.
Prefix every session with:

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
```

`npm run check:node` (also run by `verify`, `dev` and `build`) fails fast with that hint. `./start.sh` picks Node 24 by itself. zsh does
not word-split unquoted variables and macOS has no `timeout`; keep scripts POSIX-simple.

## Commands

| Command                                        | What it does                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./start.sh`                                   | The person's entry point: finds Node 24, installs once, builds when the sources are newer than the build, serves on :3000 and opens the browser                                                                                                                                                             |
| `npm run app`                                  | Build if stale, then one Node process serves the API and the SPA on :3000 (`PORT=3100` to change it)                                                                                                                                                                                                        |
| `PUBLIC_URL=http://localhost:4200 npm run dev` | API on :3000 (tsx watch) and SPA on :4200 (`ng serve`, `/api` proxied). The API checks the CSRF origin against `PUBLIC_URL`, so it must be told the origin the browser uses                                                                                                                                 |
| `MONOBANK_TOKEN=… npm run doctor`              | Checks a real token and prints PASS or FAIL per check, counts only. The person types the token in their own terminal                                                                                                                                                                                        |
| `npm run fake:monobank`                        | A stand-in for api.monobank.ua on :4310 that answers 429 to a second read inside the interval (`FAKE_MONOBANK_INTERVAL_SECONDS`). Point the app at it with `MONOBANK_API_URL=http://127.0.0.1:4310`                                                                                                         |
| `PRIVATBANK_TOKEN=… npm run doctor:privat`     | Checks a real PrivatBank business key (settings, balance/interim, one 31-day statement) and prints PASS, FAIL or NOTE per check, counts only. The person types the key in their own terminal                                                                                                                |
| `npm run fake:privatbank`                      | A stand-in for acp.privatbank.ua on :4311: one request a second, paging, the interim/interval split and a daily-routine switch (`/__admin/routine`, `/__admin/work`). Point the app at it with `PRIVATBANK_API_URL=http://127.0.0.1:4311` (key: `FAKE_PRIVAT_TOKEN` in `providers/privatbank/demo/fake.ts`) |
| `npm run verify`                               | check:node, ESLint, Prettier, typecheck, unit tests (contracts, API, web), production build                                                                                                                                                                                                                 |
| `npm run e2e`                                  | Build, then Playwright (see Testing). `e2e:only` skips the build, `e2e:report` opens the last report                                                                                                                                                                                                        |
| `node scripts/screenshots.mjs`                 | Retakes `docs/screenshots` from running servers (its header says which)                                                                                                                                                                                                                                     |
| `npm test -w @ledger-lens/api`                 | One workspace's tests                                                                                                                                                                                                                                                                                       |

`package-lock.json` is the source of truth: use `npm ci`, commit lockfile changes, never `--legacy-peer-deps`.
TypeScript stays `~6.0.x` (Angular 22 peers `>=6.0 <6.1`; npm `latest` 7.x is unsupported).

## Layout

```
apps/web             Angular 22 SPA: zoneless, signals, no router, no UI library. Own CSS design system in src/styles
apps/api             Fastify 5 BFF (zod 4 for request schemas, node:sqlite, pino). src/{plugins,modules,providers,domain,db}
packages/contracts   Plain TypeScript types and pure helpers (money, CSV) shared by both apps. Source only, no build step
e2e                  Playwright: demo, monobank and privat (the real-token flows), import, a11y (axe, light and dark), phone
fixtures/privat24    Statement files for the tests, named unverified (no real export seen yet); scripts/make-privat24-fixtures.ts writes them
scripts              app.mjs (npm run app), check-node.mjs, screenshots.mjs, make-privat24-fixtures.ts
docs                 START_HERE, HANDOVER, UKRAINE; PLAN and V2_BRIEF are history; screenshots/
.claude/skills       e2e-smoke-testing, provider-adapter
```

`@ledger-lens/contracts` is resolved through `tsconfig.base.json` `paths` (source files) in the SPA, the API, tsx and the esbuild API
bundle. A contract change is a change to both apps: update the types first.

## Angular conventions

The official best-practice file generated by `ng new --ai-config=claude-code` is imported here and applies in full:

@apps/web/CLAUDE.md

Project specifics on top of it (ESLint enforces what it can):

- Standalone only, **zoneless**, default OnPush: never write `changeDetection` or `standalone: true`.
- `input()` / `output()` / `model()` / `viewChild()`, `inject()`, `@if` / `@for` / `@let`; `computed` and `linkedSignal` before `effect`.
- New singleton services use `@Service()` + `inject()`. No `HttpClient`, `zod`, Material, CDK, Tailwind, ngrx or chart library in the
  browser: this is what keeps the first load small. The SPA uses `fetch` through `core/api.ts` (it echoes the `XSRF-TOKEN` cookie as
  `X-XSRF-TOKEN`) and the contracts' plain types, because the API is same-origin and trusted.
- **No Angular Router.** `core/nav.ts` maps the URL to a page signal with the History API (and View Transitions where the browser has them),
  and loads each screen as its own small chunk while the browser is idle, so a tab switch never waits on the network. Sheets are
  signals in `core/ui.ts` over `shared/sheet.ts` (a native `<dialog>`: focus, Escape and inertness are the browser's). The Live API
  drawer is the one non-modal exception (`features/settings/live-api.ts`): Escape closes it from anywhere unless a modal sheet is on top,
  focus moves to its Close button on open and goes back to the opener on close.
- **Server data** is a `Remote<T>` per screen (`core/remote.ts`, held in `core/stores.ts`): the first load shows a skeleton, every reload
  after that keeps the old data on screen and swaps the new in. `core/live.ts` holds the server-sent event stream; when it says
  something changed, the stores reload quietly.
- **Styling** is our own CSS in `src/styles` (`tokens.css`, `base.css`, `components.css`, `screens.css`). Every colour is a `light-dark()`
  token: never hard-code a colour that only works on one surface. One accent hue, green for money in, no alarm red for ordinary
  spending. Amounts use tabular figures and go through `<ll-amount>` (Ukrainian format, small kopiykas, blurs in privacy mode).
- Charts are hand-drawn SVG (`shared/charts.ts`), icons are inline SVG (`shared/icon.ts`). One hue for one series, and every chart has a
  text alternative.
- **Bundle budget** (`angular.json`): initial JS + CSS 215 kB warn / 250 kB error. v2 ships about 198 kB raw (170 kB of it JS), about 58 kB over the wire.
  Run `npm run build` after touching the shell, `core/nav.ts` or anything `main.ts` imports, and load what only one place needs lazily.
- The CSP is strict (`script-src 'self'`, no inline script): the pre-paint theme script is `public/theme-init.js`. The demo spec fails on
  any violation.
- Preferences live in `localStorage` through `core/prefs.ts`, wrapped in try/catch: the app must work when storage is blocked.
- Every screen and sheet passes axe (WCAG 2.2 AA) in light and dark, and nothing sticks out at 320 px: status is never colour alone.
- Feature-first folders: `core/` (singletons), `shared/` (components), `features/<name>/`. File names follow the CLI 2025 style guide
  (`home.ts`, `home.html`, no `.component` suffix); the selector prefix is `ll`.
- Strict TypeScript: `strict`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, plus Angular `strictTemplates`.

## API conventions

- Every route validates its request with a zod schema (`fastify-type-provider-zod`); responses are typed by the contracts, not parsed.
  Errors are `application/problem+json` with a stable `code` from `packages/contracts` (`ErrorCode`): throw `AppError`, never
  hand-roll an error body.
- The SPA only ever talks to the BFF, same origin, with an HttpOnly session cookie (`ll_sid`, SameSite=Lax) and a CSRF check (the
  `XSRF-TOKEN` echo plus an origin check against `PUBLIC_URL`).
- **Bank tokens never reach the browser, API responses, logs, diagnostics or the Live API drawer.** monobank's goes in `X-Token`,
  PrivatBank's in `token`; both are redacted, and for PrivatBank IBANs, tax ids and every `*_ULTMT_*` field are masked in the drawer too.
  A token is sealed with AES-256-GCM
  (`v1.<keyId>.<iv>.<ciphertext>`), the key is generated on first run into `data/secret.key` (0600; `TOKEN_ENCRYPTION_KEY` overrides it),
  and it is unsealed in one place: `modules/connection/access.ts`.
- **Data at rest:** only the token is encrypted. The transaction history is plain data in SQLite, so the data folder belongs to its owner:
  `src/data-dir.ts` creates it 0700 and keeps the database files 0600 (and tightens what an older run left open). Never loosen that, and
  never describe the history as encrypted.
- Money is integer minor units + ISO 4217 currency. Never floats; never sum across currencies without a rate. Home and Insights are in
  hryvnias: foreign balances and rows are valued at the bank's own rate, and the screens say so.
- **Live providers** (a real person's account) only run when `PUBLIC_URL` is localhost (`ALLOW_LIVE_PROVIDERS` overrides it); the server binds
  127.0.0.1 by default. A public instance can run the demo only.
- **Providers**: `monobank` and `demo` share one adapter class (the demo is the same class on the in-process `FakeMonobank` with a
  made-up Ukrainian dataset), so everything the demo shows has gone through the code a real connection uses. `privatbank` is a second
  adapter (Autoclient: business and ФОП accounts) with its own fake. `privat24` is not a provider: it is a statement file read by
  `modules/imports` (zip, xlsx and CSV readers in `domain/files`, no dependency), so it has no token, no sync and no adapter. See the
  `provider-adapter` skill.
- **Several connections per session**, one per bank (`UNIQUE (session_id, provider)`), each with its own queue and gate in `modules/sync`;
  the screens see one aggregated `SyncState` (`stateForSession`). The demo never sits beside a real bank: connecting one replaces it, and
  the demo is refused while one is connected.
- Providers that cap read speed declare `limits` on the port; the sync worker (`modules/sync`) paces itself from them: connect is one
  account-list read, then statement windows one step per interval, the main card first, a 429 waits, a response at the row cap queues the
  rest of its window. A bank with one limit for everything sets `limits.sharedLimit`. A bank whose window takes several requests
  (PrivatBank pages at 100) paces itself between them inside the adapter, and the worker waits `statementIntervalMs` after the whole step.
- **Imports**: the file is parsed in memory and dropped. Rows get a stable id (card, moment, amount, text, nth occurrence), so importing an
  overlapping period adds only what is new. The importer finds columns by title and refuses a file by listing the titles it found, with no
  values.
- All provider HTTP goes through `ProviderHttp` (`providers/transport.ts`): timed, redacted and recorded for the Live API drawer.
- Parsing is tolerant (`providers/monobank/dto.ts`): a row that does not parse is skipped and counted, never fatal, and the adapter's
  `DiagnosticsCollector` records field names and types, never values.
- **Diagnostics hold counts, field names and yes/no checks only** — no token, description, comment, merchant, id, amount or card digits. A test
  guards this; keep it so, because the person pastes that text into chats.
- SQL lives only in `db/` repositories; migrations are in `db/migrations.ts`. `node:sqlite` is early-stability: keep it behind that layer.
  A migration that rebuilds a table sets `rebuild: true`: foreign keys are switched off around it, and inside the transaction the row
  count of every table is compared before and after and the foreign keys are checked. 002 is the example; `migrations.test.ts` runs it
  on a v2-shaped database with data. The person's database holds their real history: migrations are additive or verified rebuilds, never
  lossy.
- Time comes from the injected `Clock`, and days and months from `Calendar` (Europe/Kyiv by default). Never `Date.now()` or the machine's
  zone inside domain code.
- No `console.*` in the API (use the request or app logger). No PII in logs.

## Testing

- Vitest for contracts, the API and the SPA (`@angular/build:unit-test`). The API tests run the whole app on an in-memory database and a
  clock you move by hand (`test/helpers.ts`); the adapters are tested against the scripted fakes (`FakeMonobank`, the fake PrivatBank),
  which enforce each bank's rules.
- Playwright runs against the **built** app and stays deterministic: `demo` (every tab, instant search, a transaction, the Live API drawer,
  blur, disconnect, no CSP violations), `monobank` (the real-token flow against the paced fake: a wrong token is explained, balances
  at once, history at the bank's pace), `privat` (wrong key, balances, history at the bank's pace, the drawer's redaction, the daily
  routine, two banks at once, a bank leaving on its own), `import` (a bad file, a statement, the same rows again as xlsx, removal, 320 px),
  `a11y` (axe in light and dark) and `phone.mobile` (Pixel 7 and 320 px). See the `e2e-smoke-testing` skill.
- Before calling work done: `npm run verify` and `npm run e2e`, then look at the running app (desktop and phone width, dark and light).
  Say what was and was not verified.
- **Not verifiable without the person's real token** (and so never claimed as verified): the real field shapes on a real account,
  that an account's `balance` includes its `creditLimit`, that a statement item's `balance` is the balance after that item, and the real
  429 body. `npm run doctor` and Settings, Copy diagnostics, test the two assumptions on their data. For PrivatBank: the real field
  shapes, that `balance/interim` is the balance now, whether the interval statement includes today (the adapter merges it with the
  interim one), what `FL_REAL` `i` means (skipped), the 429 body (`npm run doctor:privat` covers the first four), and the whole real
  Privat24 export layout (the fixtures are named unverified). `docs/HANDOVER.md` keeps the list.

## Secrets and git

- `.env` and `data/` (the database and the key) are git-ignored; `apps/api/.env.example` is committed. Never ask for, print or paste a
  token in chat or commit one: the person pastes it into the app themselves, or types it in their own terminal for `doctor`.
- Commit locally at the end of each milestone with a descriptive message. There is no remote; never push.
