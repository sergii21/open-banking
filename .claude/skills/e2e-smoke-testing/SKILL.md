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

## Two traps worth knowing

- **`toBeVisible()` does not detect occlusion.** A button under a sticky bar or clipped by a scroll container still passes.
  Assert geometry (`boundingBox()`) or hit-test with `document.elementFromPoint` when layout is the point.
- **`input[value="..."]` matches the HTML attribute, not the live value.** Signal Forms set the property. Use `toHaveValue(...)`.
