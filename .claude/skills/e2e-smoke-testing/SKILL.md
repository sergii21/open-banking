---
name: e2e-smoke-testing
description: >
  Reference for Ledger Lens's Playwright suite (e2e/). Use this skill whenever asked to smoke-test the app, check
  whether it works end to end, run a regression pass after changes, or investigate an "is X broken" question.
  Run `npm run e2e` first: it builds the app, starts its own server against the deterministic mock bank and finishes
  in well under a minute, with no browser exploration needed. Only fall back to manual browsing for things outside the
  suite's coverage. Also use when extending the suite or adding axe accessibility checks.
tools: Read, Bash, Edit, Write
---

# Ledger Lens E2E Smoke Testing

`e2e/` holds broad, shallow journeys plus a few deeper ones. Everything runs against the **mock bank** with an
in-memory database, so results are deterministic and never touch your dev data or a real provider.

## Node version — do this first

The shell's default `node` may be v25, which Angular 22 rejects. Prefix commands with Node 24:

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
```

## Run it first, every time

```bash
npm run e2e          # build + Playwright (starts apps/api/dist/server.js on :4300)
npm run e2e:only     # Playwright only, when the build is current
```

`playwright.config.ts` starts the built app itself (`webServer`, `reuseExistingServer` locally). Environment:
`NODE_ENV=production`, `PORT=4300`, `DATABASE_PATH=:memory:`, `PROVIDERS=mock`, `DEMO_CONTROLS=true`, a high rate limit.
Because the DB is in memory, restarting the server resets all data.

Other useful commands:

- `PLAYWRIGHT_BASE_URL=http://localhost:4200 npx playwright test` — run against `npm run dev` (no `webServer`).
- `npx playwright test e2e/connect.spec.ts --ui` — interactive debugging.
- `npm run e2e:report` — open the last HTML report.
- `npm run e2e:sandbox` — opt-in suite against the TrueLayer sandbox (needs credentials in `apps/api/.env`).
- Browser binary missing or "Looks like Playwright was just installed or updated": `npx playwright install chromium`.

## Projects and auth

- `setup` runs `e2e/auth.setup.ts` once and saves `e2e/.auth/user.json`. There is no login: the app uses an anonymous
  demo session (HttpOnly cookie), and setup connects Mock Bank once so most specs start with data.
- `chromium` (desktop) runs every spec except `*.mobile.spec.ts`; `mobile` (Pixel 7) runs `*.mobile.spec.ts`.
- The `setup` project uses `storageState: { cookies: [], origins: [] }`. `storageState: undefined` reads as "not set" and
  falls back to the top-level `e2e/.auth/user.json`, which does not exist on a clean checkout.
- Specs that need a pristine session (connect flow, failure scenarios, delete-my-data) opt out with
  `test.use({ storageState: { cookies: [], origins: [] } })`. Do not mutate the shared session in other specs.

## Extending the suite

- Prefer role/label locators and `data-testid` on status text; assert on the **designed state** (heading + recovery action),
  not on implementation details.
- Mock-bank personas pick the outcome on the consent page (see `apps/api/src/providers/mock/`). Payment outcomes follow
  TrueLayer's convention: `test_executed`, `test_authorisation_failed`, `test_execution_rejected`, cancel.
- Demo controls (`POST /api/demo/actions`) force a bank outage, rate limit, revoke-at-bank or consent expiry; use them to
  reach failure states deterministically instead of sleeping.
- Add `@axe-core/playwright` checks (`new AxeBuilder({ page }).analyze()`) for every new route; the suite must stay at zero
  violations for WCAG 2.x A/AA tags.
- When you fix a real bug, add a regression test with a one-line comment explaining what it guards.

## Specs

| Spec                      | Session            | Covers                                                                                                          |
| ------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `smoke.spec.ts`           | shared (connected) | shell, navigation, probes, security headers, no tokens in browser storage                                       |
| `connect.spec.ts`         | fresh per test     | the full journey, GBP bank, denied, SCA timeout, outage, degraded bank, bad/reused callback, redirect-URI check |
| `dashboard.spec.ts`       | shared (read-only) | balances, recent transactions, cache-only reads, redacted Inspector detail, filters, paging, privacy copy       |
| `lifecycle.spec.ts`       | fresh per test     | refresh + Inspector, outage, rate limit, revoke + reconnect, consent countdown/expiry, remove, delete-all       |
| `a11y.spec.ts`            | shared             | axe (WCAG 2.2 AA) for every route, the Inspector and the dialog, in light and dark; skip link, focus handling   |
| `phone.mobile.spec.ts`    | shared             | drawer navigation, stacked cards, no horizontal overflow, bottom-sheet Inspector                                |
| `monobank.spec.ts`        | fresh, serial      | token journey for a real bank against a fake of its API: wrong token, history loading banner, revoked token     |
| `payments.spec.ts`        | fresh per test     | every outcome through the real UI and the bank's page, resume, double click, form errors, balance after refresh |
| `payments.mobile.spec.ts` | fresh per test     | the form, the journey and the timeline on a phone, no sideways scroll                                           |

`REFRESH_COOLDOWN_SECONDS` is 3 in e2e, so Refresh re-enables by itself (assert with `toBeEnabled()`, never sleep).
`MOCK_BANK_STEP_SECONDS` is 1, so a whole payment (authorised, executed, settled) takes about three seconds: wait for the final
state with `toContainText('Settled', { timeout: 20_000 })` instead of sleeping. `support.ts` has `startPayment` (form → bank's page),
`decideAtBank` (persona, outcome, approve or cancel → result page) and `pay` (both).

## Traps (each cost a debugging round)

- **Status chips contain their icon's ligature text** (`check_circle200`). Use `toContainText`, not `toHaveText`, on chips.
- **`toHaveText(/^...$/)` does not trim**: padded template text breaks anchored regexes. Prefer `toContainText` or unanchored regexes.
- **`getByRole('link', { name: 'Transactions' })` is a substring match** and also hits "View transactions for Girokonto".
  Scope navigation links with `mainNav(page)` from `e2e/support.ts`.
- **Run axe after animations finish** (`settleAnimations(page)`): a dialog mid-fade fails contrast on blended colours.
- **Press Tab only after the shell has rendered**; Angular bootstraps asynchronously after the session call.
- Focus tests rely on the Inspector being _visible_ when focus moves (`afterNextRender`), which is why its `visibility` has no
  transition delay when opening.
- **`toBeVisible()` does not detect occlusion.** A button under a sticky bar or clipped by a scroll container still passes.
  Assert geometry (`boundingBox()`) or hit-test with `document.elementFromPoint` when layout is the point.
- **The `monobank` project runs a second app instance** (port 4301, `PROVIDERS=mock,monobank`) next to `e2e/support/fake-monobank.mjs`
  (port 4310, started with `reuseExistingServer: false`: a stale server on that port would otherwise answer 200 and pass for the fake).
  The shell's mode badge reflects the enabled providers, so the main instance stays mock-only. Leftover `node apps/api/dist/server.js`
  processes from manual runs are the usual cause of "port already used".
- **Background pacing makes states race you.** A Refresh pressed right after a background step is told to wait (the designed rate-limit
  state); retry with `expect(async () => ...).toPass()` rather than sleeping.
- **`input[value="..."]` matches the HTML attribute, not the live value.** Signal Forms set the property. Use `toHaveValue(...)`.
- **Payments are per session, and the mock bank's payments token is cached app-wide.** "Get payments token" appears in the Inspector of
  whichever session happened to pay first, so never assert on it; assert on "Create payment" and the webhooks.
- **A payment's timeline moves while the test watches.** Intermediate states ("Authorised") can pass in a blink; assert the final state
  and the step attributes (`data-state`), not that you saw every step.
