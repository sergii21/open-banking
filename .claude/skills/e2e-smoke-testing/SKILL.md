---
name: e2e-smoke-testing
description: >
  Reference for Ledger Lens's Playwright suite (e2e/). Use this skill whenever asked to smoke-test the app, check whether it works end
  to end, run a regression pass after changes, or investigate an "is X broken" question. Run `npm run e2e` first: it builds the app,
  starts its own servers (the demo app, a paced fake of api.monobank.ua and a second app wired to that fake) and finishes in about a
  minute, with no browser exploration needed. Only fall back to manual browsing for things outside the suite's coverage. Also use
  when extending the suite or adding axe accessibility checks.
tools: Read, Bash, Edit, Write
---

# Ledger Lens E2E smoke testing

## Run it

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
npm run e2e                                  # build, then every project
npm run e2e:only                             # skip the build (after a build you trust)
npx playwright test e2e/demo.spec.ts         # one file
npx playwright test --project=monobank       # one project (chromium, mobile or monobank)
npm run e2e:report                           # open the last HTML report
PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test --project=chromium   # demo specs against a server you started
```

The suite runs against the **built** app, so after changing code run `npm run build` (or `npm run e2e`, which does). Every run uses
in-memory databases and nothing touches `data/`.

## What starts (playwright.config.ts)

| Port  | What                                                                                                              | Used by                              |
| ----- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| :4300 | the built app on the demo bank, in-memory database, rate limits lifted                                            | `chromium` and `mobile` projects     |
| :4310 | `FakeMonobank` over HTTP, one read per 4 s and a 429 for a second one (`providers/monobank/demo/server.ts`)       | the app on :4301                     |
| :4311 | the fake PrivatBank Autoclient over HTTP, one request a second (`providers/privatbank/demo/server.ts`)            | the app on :4301                     |
| :4301 | a second copy of the app with both live providers pointed at the fakes (`MONOBANK_API_URL`, `PRIVATBANK_API_URL`) | the `monobank` and `privat` projects |

The fakes are never reused (`reuseExistingServer: false`): another process answering 200 on :4310 or :4311 would pass for the bank. The
monobank fake keeps **one** limit for everything that talks to it, so a leftover loader from an earlier run makes a new session's first
statement wait out a 429. For the same reason the `privat` project **depends on `monobank`**: both use the monobank fake and must not run
side by side. After a killed run, check for strays: `lsof -nP -iTCP:4300 -iTCP:4301 -iTCP:4310 -iTCP:4311 -sTCP:LISTEN`.

## The specs

- `demo.spec.ts`: the demo through every tab (Home hero, six accounts, the 30-day line once history has loaded), instant search, a
  transaction's detail sheet, the Live API drawer (Escape closes it and focus goes back to the Settings button) and **no
  Content-Security-Policy violations**; blurring amounts (one click, every screen, remembered); leaving the demo is one click and
  returns to the first-run screen.
- `monobank.spec.ts`: the real-token flow: a wrong token is explained in words, the right one shows balances at once, history loads at
  the bank's pace with an honest progress chip, and "Disconnect and delete my data" returns to the first-run screen.
- `privat.spec.ts` (serial): the PrivatBank key flow with the Live API drawer's redaction, the daily routine explained in words, two
  banks at once, and axe plus 320 px on each connect pane.
- `import.spec.ts` (`chromium`, on :4300): uploads `fixtures/privat24/unverified-statement.{csv,xlsx}`: a bad file is refused with its
  column titles, a statement imports, the same rows again as xlsx add nothing, and removal works; 320 px.
- `a11y.spec.ts`: axe (WCAG 2.0 A/AA, 2.1 A/AA, 2.2 AA) on the first-run screen, Home, Activity, Insights and every sheet, in light and dark.
- `phone.mobile.spec.ts`: a Pixel 7 and a 320 px screen: every tab fits, nothing sticks out past the right edge, axe passes.

`e2e/support.ts` has the helpers: `connectDemo(page)` (first-run screen → Home on the demo), `settle(page)` (waits out entry animations,
because contrast and positions are only meaningful afterwards), `expectNoViolations(page)`, `expectNothingPastTheEdge(page)`,
`watchCsp(page)`, `DEMO_TOKEN`, `FAKE_PRIVAT_TOKEN` (the fakes' own constants, not credentials) and `FAKE_PRIVAT_URL`.

## Conventions

- Locate by role and accessible name first (`getByRole('link', { name: 'Activity' })`); the few CSS classes the specs use (`.hero`,
  `.tile`, `.row`) mark things with no role of their own.
- Each test gets a fresh browser context, so a fresh anonymous session and its own data. Tests do not share state.
- Wait on what the person would see (`expect(...).toBeVisible({ timeout })`), never on a fixed sleep. History in the `monobank` project
  arrives one step every four seconds.
- A new screen or sheet goes into `a11y.spec.ts` in both colour schemes. A contrast failure means a token needs a better `light-dark()`
  pair in `apps/web/src/styles/tokens.css`, not an exemption in the test.
- A sheet or drawer must close with Escape and return focus to what opened it; `demo.spec.ts` asserts that for the Live API drawer, so do the same when you add one.

## Not covered by the suite

The real monobank service (it needs the person's own token: `npm run doctor`), the `./start.sh` first run, and visual quality beyond axe
and the edge check. For those, run the app and look at it on a phone width and a desktop width in dark and light mode;
`node scripts/screenshots.mjs` retakes `docs/screenshots` from the three servers above if you start them as `playwright.config.ts` does.
