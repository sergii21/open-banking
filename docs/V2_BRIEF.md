# Ledger Lens v2: small, fast, beautiful, on real data

> **History.** This was the brief for the v2 pass, which is finished; it is kept as the record of what was asked. Do not read the lists below as a to-do list: the current state, the measurements and what is left are in [HANDOVER.md](HANDOVER.md), and the steps for using the app are in [START_HERE.md](START_HERE.md).

Brief from the user, written 2026-11-03 by the coordinating session. This file is the source of truth for the v2 pass.
Read it fully, work through the phases in order, and commit this file with the first phase.

## The request (the user's words)

> Enhance my Open Banking App. Make sure it is working with real data rather than concentrate on unit testing. Apply modern
> nice looking design. I want my app to be better than Privat or Monobank. Easy to use with a very small but helpful
> functionality for a first POC. Very fast. I can login and provide the credentials later. Just give me clear steps.

How to read it: the user is Ukrainian and banks with monobank and PrivatBank. They want a personal-finance app they would
actually open every day, on their **own real monobank data**, that feels faster and calmer than the banks' own apps, with
very few features that each earn their place. They will paste their monobank token into the app themselves later. Neither
of us can do a real-account run now, so the first real connection has to work, and any surprise has to be easy to
diagnose from a pasted diagnostic. PrivatBank has no personal API (see `docs/UKRAINE.md`): do not build an importer; say in
the final report that Privat data would need a sample statement export.

## What I saw (so you do not have to guess the baseline)

I ran v1 and looked at it: a generic dark Material admin dashboard on European mock data (EUR, German payee strings),
small dense type, a filter form that dominates the Transactions page, payments, TrueLayer and a multi-bank picker the user
does not need, and an initial bundle of 898.5 kB against a 900 kB budget. That is the opposite of "small, fast, better
than monobank". Treat v2 as a product pass, not a patch. I stopped the dev servers I used (ports 3000 and 4200 are free).

## Order of work (commit after each phase; keep `docs/HANDOVER.md` current)

The last run stopped on a usage limit mid-milestone, so every phase must leave a working, committed app and a handover
note that says done / next / not verified.

**Phase A: baseline and cut.**

1. `git tag v1-full-featured` first. Everything you cut stays recoverable. No remote; never push.
2. Record the baseline for a before/after table: production build size (initial JS and CSS, raw and gzip), a Lighthouse or
   Performance API reading of the dashboard (FCP, LCP, TBT, CLS, desktop and mobile), source line count, test count.
3. Delete what section 5 lists. `npm run verify` stays green (delete tests of deleted code).

**Phase B: the real-data path** (sections 2 and 3, API side).
**Phase C: the new UI** (sections 1 and 4).
**Phase D: evidence and docs** (sections 6 and 7).

## 1. The product: "your monobank, instantly"

Three tabs and one settings sheet. Nothing else.

- **First run, one screen, two choices.** "Connect monobank": three numbered steps (open api.monobank.ua, scan the QR in
  the monobank app, copy the token), a token field, one privacy line (read-only, stays on this computer, encrypted).
  And "Try with demo data". After Connect, Home shows balances within about 2 seconds. No banking jargon on screen:
  say "Connect monobank", not "Open Banking consent".
- **Home**, served by one request (`GET /api/home`):
  - Hero: own money in UAH, converted from every card and jar with real monobank rates (`GET /bank/currency`). Credit
    limits are excluded from own funds ("available with credit" is the secondary line). An eye toggle blurs every amount
    on every screen (persisted). A 30-day balance trend drawn from the statement item's own `balance` field (the account
    balance after that operation, per monobank's docs; the adapter does not map it today, so store it).
  - This month against the same days last month: delta chip, daily-spend bars, projected month end. If last month is still
    loading, say so; never show a wrong delta.
  - Accounts as compact tiles (type, currency, last 4, own funds); tap goes to Activity filtered to that card.
  - Top 5 categories this month; a "6 regular payments, 2 340 ₴ a month" teaser.
  - A sync chip: "Updated 12 s ago" or "Loading history, 2 of 5 steps, next in 41 s", live over the existing SSE.
- **Activity.** Grouped by day. Merchant, category chip, amount (expenses in the normal text colour, income green, no
  alarm red), card and last 4, a "Pending" pill for `hold`. Instant search (press `/`) and one row of chips (All, Spending,
  Income, This month, one per card); amount and date range behind a "More" popover, not a form. A row opens a detail sheet:
  MCC and category, cashback, commission, comment, receipt id, balance after, copy buttons. Keep CSV export of the current
  filter. Search must feel instant on about 5,000 rows.
- **Insights.** Month picker; spending by category as one ranked bar list; change against last month per category; top
  merchants; and **regular payments** (detected subscriptions: merchant, amount, cadence, next expected date, monthly
  total). The last one is what neither bank app shows well. Reuse `domain/insights.ts` and the categoriser; trim to about
  12 categories with good icons. Any chart is hand-rolled SVG.
- **Settings sheet.** Connection (status, last sync, replace token, disconnect and delete my data), theme (system, light,
  dark), amounts blur, **Live API** (the Inspector, restyled as a quiet drawer: it is the on-screen proof that the numbers
  are real calls to the bank), and **Copy diagnostics** (section 2).

Keep the name Ledger Lens. No third-party logos: a neutral initial badge per bank.

## 2. Real data

- **Demo runs the real code path.** Demo mode is the monobank adapter pointed at an in-process fake monobank API (the e2e
  fake, upgraded), with pacing off so history appears at once. The dataset is Ukrainian and realistic: a UAH black card with
  a few thousand transactions over about 3 months, a USD card, a credit card with a limit, two jars, FOP-style income, `hold`
  items, cashback, Cyrillic merchants and comments (Сільпо, АТБ, Нова пошта, Uklon, Київстар, Netflix, Spotify, ...), real
  MCCs. A persistent "Demo data" chip on every screen. Replace the EUR mock dataset.
- **Limits are the real constraint, so design around them.** monobank allows one request per minute per token on
  `client-info` and on `statement` (the docs state each endpoint's limit; check whether they are shared, and handle either),
  31-day windows, 500 rows per response. Connect makes one `client-info` call and renders Home from it at once. Then fetch
  the main UAH card's newest 31 days first, then the other cards one per minute (newest window first), then older months;
  jars on demand (when one is opened) or last. Default history 2 months so month-over-month works; a "Load earlier months"
  button extends it. The UI never blocks on the queue: partial data with honest progress, one SSE update per finished step,
  per-card state in the sync chip. A 429 waits `Retry-After` or 60 s.
- **Tolerant parsing.** Unknown fields allowed; optional everywhere except `id`, `time`, `amount`, `currencyCode`; an
  unknown currency code or MCC degrades gracefully; one bad row never hides the others.
- **Copy diagnostics.** Produces a text block with no token, names, merchants, amounts or ids: app version, provider,
  per-endpoint status and latency, response shape (field names, types, counts), parse warnings. The user will paste it to
  us if real data surprises us, so make it sufficient to fix a mapping bug blind.
- **Rates.** Real `GET /bank/currency`, cached on the server at least 5 minutes, last-known rates persisted, "rates as of"
  shown; if the call fails show the last known with its timestamp.
- **Check the adapter's assumptions against monobank's docs** (https://api.monobank.ua/docs/ is JS-rendered; try the
  swagger/yaml it links to): `balance` includes `creditLimit`, jar ids work in the statement endpoint, the statement
  `balance` is the balance after the operation, the webhook contract. The final report says which you confirmed from the
  docs and which stay assumptions.
- **Security for real data.** The token-encryption key is generated randomly on first run and stored next to the database
  with 0600 permissions (never a constant in code or in `.env.example`). Database, key and `.env` stay git-ignored. No
  merchant names, descriptions or tokens in logs. Live providers stay localhost-only. Never ask for the token in chat; it
  goes only into the app's field.
- **Zero config.** monobank works on localhost without editing `.env` (local default `PROVIDERS` includes it; the
  public/Render profile stays demo-only).
- **Optional, only after everything else is done and verified:** webhook receiver for instant new transactions (needs a
  public HTTPS URL; document the cloudflared steps and add one "Enable live updates" button that calls
  `POST /personal/webhook`). Otherwise leave it as a documented follow-up.

## 3. Fast

Measured on the production build and reported in the final table:

- Initial JS under 250 kB raw (about 80 kB gzip), CSS under 30 kB gzip; `angular.json` budgets fail above that.
  Lighthouse performance 95+ on desktop and mobile emulation against `npm run app`.
- Tab and route changes under 100 ms: prefetch lazy routes when idle, keep data in memory, use View Transitions for the
  swap. No layout shift: skeletons are exactly the size of what replaces them. Keystroke to filtered list under 50 ms.
- One `GET /api/home` for Home; SQL aggregates with the right indexes; compression on static files and API; hashed static
  assets with long cache headers.
- Fonts: system UI stack with tabular figures, or one self-hosted variable font (latin and cyrillic subset) preloaded.
  Measure and choose. No icon font; a small inline SVG icon set.
- Measure zod in the browser; if it is significant, drop runtime validation from the SPA (the BFF is same-origin and
  trusted; keep schemas in the API and types in contracts). That would also retire `zod-jitless.ts`.
- Daily-use shape: `npm run app` builds if needed and serves SPA and API from one Node process on :3000 (production shape,
  no `ng serve`). Add `./start.sh` (macOS and Linux) that picks Node 24 itself via nvm, installs if dependencies are
  missing, runs `npm run app` and opens the browser. The user's shell default is Node 25, which Angular 22 rejects; they
  must not have to know that.

## 4. Design: better than a bank app, not a Material admin template

Reference points for polish and calm: Revolut, Monzo, Wise, Copilot Money, Apple Wallet. None of their branding.

- Tokens as CSS variables with `light-dark()`; one accent hue plus semantic income and expense colours; neutral surfaces
  with hairline borders in dark and soft shadows in light; 16 to 24 px radii; AA contrast everywhere (re-run the data-viz
  palette validator for any chart colour).
- A clear type scale with tabular numbers for money; the amount component shows the fraction smaller and muted; a large,
  confident hero number. Cyrillic must look as good as Latin.
- Phone first. Sticky slim top bar (sync chip, blur toggle, settings), bottom tab bar on phones, a slim left rail on
  desktop, content about 1120 px wide, Home as a two-column grid on desktop with hero and accounts leading.
- Motion that earns its place and respects `prefers-reduced-motion`: hero count-up, staggered list entry under 200 ms,
  press feedback, shimmer skeletons, tab transitions. Avoid expensive effects (large blurs, backdrop-filter on scrolling
  lists).
- Trust and delight: blur-amounts mode, keyboard shortcuts (`/` search, `g h`, `g a`, `g i`), pull-to-refresh on touch,
  a designed empty, loading and error state on every screen, honest copy ("monobank allows one read a minute; next in 41 s").
- The checklist for "better than monobank and Privat24": one glance answers "how much do I really have", other currencies
  included; this month against last month in one glance; subscriptions visible; privacy blur; instant search; no upsell
  clutter; export works.
- UI language is English; amounts are formatted the Ukrainian way (`12 345,67 ₴`); Cyrillic data renders cleanly. Do not
  build i18n; keep strings in templates and we will ask the user later.

## 5. Cut, do not hide (the v1 tag has it all)

Payments and everything behind them (UI, API, mock payments bank, TrueLayer payments); the TrueLayer adapter; the mock
bank's hosted consent and payment pages; the multi-bank picker; consent-expiry UI; connect-review and connect-result
screens; Angular Material, the Material icon font and ApexCharts (Angular CDK is fine for overlay and a11y primitives);
`@ngrx/signals` if plain signals do the job; the Inspector's demo-break controls; and the 106-test e2e matrix (replaced
by section 6's small suite). Keep: the `BankingProvider` port and the `provider-adapter` skill (a second bank stays a small,
documented job), the instrumented transport and redaction, sealed tokens, SSE, the sync queue.

## 6. What "done" means: evidence, not test counts

- Run it for real in the in-app browser and look at it: first run, demo, the fake-monobank connect with pacing on (watch the
  progress chip and the Live API drawer), every tab, phone width (375 and 320), dark and light, wrong token, rate limit,
  API down. Small screenshots into `docs/screenshots/`.
- Live checks possible without a token: real rates visible on Home through the app, and the dummy-token 403 path.
- Tests: spend little. Keep `npm run verify` green, delete tests of deleted code, and write only the few that guard real
  risk (monobank mapping from realistic payloads incl. credit card, jar, hold and FX; money and formatting; the
  recurring-payment detector). One small Playwright smoke for demo and one for the fake-monobank connect, plus axe on the
  three tabs. Delete the rest.
- `npm run doctor`: reads `MONOBANK_TOKEN` from the environment only, makes the two read-only calls, prints PASS or FAIL per
  check (token accepted, accounts parsed, currencies known, own-funds math, statement parsed) with counts only, nothing
  identifying. Reuse `test:live`'s calls.

## 7. Deliverables

- `docs/START_HERE.md`: the user asked for clear steps. Numbered, copy-paste commands, each step saying what they should
  see and what to do if not. 1 start (`./start.sh`); 2 try the demo; 3 get the monobank token; 4 paste it and what to expect
  (balances in about 2 s, first transactions in about 10 s, the rest one request a minute, and why); 5 check it is real
  (compare one balance with the monobank app, open Live API); 6 if something is off (Copy diagnostics and send it);
  7 stop and remove access (disconnect and delete in the app; the token stays valid at api.monobank.ua until a new one is
  issued there, so say so). The same steps appear on the first-run screen. Put the first lines of it at the top of
  `README.md` and trim the rest of the README to what is true now.
- Update `CLAUDE.md`, `docs/HANDOVER.md`, `docs/UKRAINE.md`, the e2e skill and the provider skill to match what is left.
- Final report: a before/after table (bundle, Lighthouse, source lines, tests), what was cut, what was verified live, against
  the fake and by eye, what was **not** verified (anything that needs the real token), the defaults you chose, and the
  START_HERE steps in short.

## 8. Rules

Export the Node 24 path first. Never ask for or print the user's token. Commit locally per phase and never push. Do not stop
to ask questions unless truly blocked: choose sensible defaults and list them in the report. The coordinating session will
review the running app itself when you finish.
