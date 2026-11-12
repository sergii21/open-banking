# Ledger Lens v2: hand-over (kept current after every phase)

The v2 brief is `docs/V2_BRIEF.md` (source of truth). v1, with everything that was cut, is the git tag `v1-full-featured`
(`git checkout v1-full-featured`; its own hand-over is in that tag's `docs/HANDOVER.md`). Node 24 for every command:
`export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH`.

## The iPhone app (added 2026-11-11, at the person's request)

`apps/mobile`: Expo SDK 58, React Native 0.88, TypeScript, built on EAS and delivered through TestFlight, modelled on the person's
Тривога Поруч app. **No server**: the person approved "the phone does everything" over "the phone talks to the computer", monobank
only for the first version, and the bundle identifier `ua.ledgerlens.app` (their other app is `ua.alertnearby.app`). Guide for the
person: `apps/mobile/DEPLOY.md`; how it is built: `apps/mobile/README.md`.

- **Family mode (added 2026-11-13, at the person's request; they chose "Encrypted relay" over "My Mac at home").** A sixth
  tab, Family, and a new workspace, `apps/relay`. Each person keeps their own token on their own phone; phones share a sealed
  summary (the month's spending by category in hryvnias, their money only if they choose) through the relay, which holds no key.
  One 256-bit family secret, passed as a QR code or pasted link, gives the family id, the relay access key and the encryption key
  (HKDF-SHA256; XChaCha20-Poly1305 from `@noble/ciphers`; random bytes from `expo-crypto`, a new native module, so the app needs a
  fresh `expo prebuild`). Details: `apps/mobile/README.md`, `apps/relay/README.md`. **Verified:** relay rules on memory and SQLite
  (21 tests), two phones against a real relay in-process (22 tests: totals, budget, what leaves the phone, what the relay sees), the
  Node server over HTTP on a spare port, typecheck, lint, an iOS bundle export. **Not verified:** the relay is not hosted anywhere
  (`DEFAULT_RELAY_URL` in `apps/mobile/src/family/config.ts` is empty, so nobody can start a family yet), the Family screen has
  never been seen on a phone or simulator, the camera opening `ledgerlens://family#…`, `expo-crypto` on a device, and a request
  body of bytes from React Native's `fetch`. Individual transactions are not shared; that was offered and not built.
- **Five tabs:** Money (balances, total in hryvnias at monobank's rate), Transactions (search as you type, on the phone), Pay (the
  NBU link first, because a phone cannot scan its own screen; the QR code for another device; card mode with copy buttons and the
  Privat24 link), ФОП (import UKRSIB CSV from Files, calendar, quarters, declaration lines with Copy, rows with a counted switch),
  Settings (token, made-up data, disconnect).
- **Reuse, in place, nothing copied and nothing changed in the other workspaces:** the monobank adapter and DTOs, `FakeMonobank` and
  its dataset (the demo), `calendar`, `categoriser`, `rates`, `diagnostics`, `errors`, `clock`, `files/csv`, `ukrsib-statement`,
  `fop-report` from `apps/api/src`; `shared/qr.ts` from the SPA; all of `@ledger-lens/contracts`. Two stand-ins make it run on a
  phone: `src/platform/node-crypto.ts` (SHA-256 and SHA-1, equal to Node's in tests, so imported rows get the same ids as on the
  server) and `src/platform/text-decoder.ts` (Windows-1251, strict UTF-8, UTF-16; all 256 Windows-1251 bytes equal Node's).
- **New on the phone:** `src/bank/http.ts` (GET only, one origin, nothing logged, a failure's words hold no token or address),
  `src/bank/sync.ts` (`step()` does one read at most and returns the wait; three months, 31-day windows, newest month of every card
  first; a 429 is a wait; a rejected token stops and asks for a new one; a refresh re-reads balances and the last three days),
  `src/data/db.ts` (SQLite: accounts, transactions, windows, meta, fop_rows), `src/platform/keychain.ts` (expo-secure-store,
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY`).
- **The same token on the computer and the phone share monobank's one read a minute.** Each slows the other; neither breaks.
- **Measured:** Jest 49 tests in 6 files; `tsc --noEmit` clean; `npx expo export --platform ios` bundles 920 modules into a 2.8 MB
  Hermes bundle; adding the workspace changed no resolved dependency version of the SPA, the API or contracts (checked by walking both
  lockfiles), only where npm places them.
- **Not verified, and not claimed:** no EAS build, no TestFlight upload (both need the person's Expo and Apple accounts); the app has
  never run on an iPhone or a simulator, so no screen has been looked at and VoiceOver, Dynamic Type and dark mode are untested; no
  real monobank token from the phone; on Hermes, `Intl.DateTimeFormat` with `Europe/Kyiv` (the calendar needs it) and expo-sqlite
  running this SQL (it ran on `node:sqlite`); that the Files picker returns a UKRSIB CSV's bytes; that iOS offers a bank app for a
  `qr.bank.gov.ua` link.
- **Left out of this version:** PrivatBank business, Wise, Privat24 files, Insights, the Live API drawer, the "Filed" mark on the ФОП
  calendar, month-against-last-month on Money, a Face ID lock, privacy blur, Ukrainian interface text.

## ФОП report (added 2026-11-11, at the person's request)

Income per quarter for a group 3 single-tax ФОП, read from the person's own UKRSIB business statements. **Home, ФОП report** opens a
sheet; **Add UKRSIB statements (CSV)** reads the files (one per account) and the sheet shows, per quarter, income, income since 1
January, the single tax (5 % or 3 %) and the military levy (1 %) worked out from the cumulative income, what the statements say was
paid for that quarter, and the social contribution paid; the rows below can each be counted or left out. It files nothing and
pays nothing.

- **Where:** `domain/ukrsib-statement.ts` (reader and classifier), `domain/fop-report.ts` (pure report), `modules/fop` (service and
  routes: `POST /api/imports/ukrsib`, `GET /api/fop?year=&rate=`, `PATCH /api/fop/rows/:id`, `DELETE /api/fop`), migration
  `004_fop_rows` (a new table, additive; rows go with the session), `packages/contracts/src/fop.ts`, `features/fop` in the SPA.
  The rows are kept apart from the personal accounts: nothing about Home, Insights or Your money changes, and the UKRSIB balances
  are **not** in Your money. Only offered when the app runs on the person's own computer and is not the demo.
- **The real layout, seen once (the person's own exports, 2026-11-11):** CSV, Windows-1251, `;`, 17 titled columns (`Дата операцiї`
  with a Latin i), separate Дебет and Кредит, `Гривневе покриття` = the hryvnia equivalent of a foreign-currency row (`0.00` on
  hryvnia rows). The PDF export has one amount per row with no side, so CSV is the way; the XLS is old binary Excel the app cannot
  read. Fixtures: `fixtures/ukrsib/made-up-{uah,eur}.csv`, made up in that layout by `scripts/make-ukrsib-fixtures.ts`; nothing from
  the real files is in the repository.
- **Checked on the real files (counts and totals, nothing printed):** the CSV debit and credit totals equal the cabinet's; 17 receipts
  (8 hryvnia, 9 euro) are income, 21 currency-sale credits and 31 own transfers are left out, 6 tax payments carry a quarter; on all 9
  euro receipts the bank's hryvnia equivalent equals amount times the National Bank rate of that day (public NBU service).
- **Rules assumed, shown on the sheet, to confirm with an accountant (not tax advice):** 5 % without VAT or 3 % with, 1 % levy, the
  2026 limit of 10 091 049 UAH (1 167 minimum wages of 8 647) and the 1 902,34 UAH monthly contribution minimum, all as accounting sites
  state them; foreign currency at the National Bank rate on the day it reaches the account, a later sale adds nothing; the return
  is cumulative from 1 January (seen on the filed form, see below); deadlines are not tracked.
- **Classification by the words of the purpose** (so a new bank wording can be missed; every row can be decided by hand): `між власними
рахунками` is an own transfer; `Гр.екв.продажу` (also spelled `Гр.экв.`) is the proceeds of a currency sale; a credit from the bank
  itself is left out; the rest of the credits are income. Money out is tax (`військового збору`, `ЄП`), contribution or other.
- **Measured:** initial JS + CSS 203.06 kB raw, 59.6 kB over the wire (the sheet is its own chunk); tests: contracts 30, API 184, web
  9 (223), Playwright 30; looked at in dark and light desktop and at 320 px, axe in light and dark.
- **Not verified:** that the real app imports the person's own files (the reader and report were run on them directly, in a script,
  not through the running app); that a report matches a filed return; the cumulative rule and the deadlines; an American-English
  check of the sheet's words by the person. UKRSIB has no API section in the cabinet (settings hold only profile, company and visit
  history; "Відкритий банкінг" lists consents given, none), and API access is by asking the bank.
- **Declaration lines (added 2026-11-11):** each quarter has "Lines for the declaration" (`declarationLines` in `fop-report.ts`):
  lines 05/06, 08, 10/11, 12, 13, 14.1, 14, 23, 24, 25 of form F0103309, cumulative, each with a Copy button giving `3402992.73`
  style text. The line numbers and formulas were read from the person's filed declaration for three quarters of 2026 in the tax
  cabinet, and all ten lines the report gives for that period equal the filed ones (checked in a script; no value is in the
  repository). This also settles the cumulative rule: line 13 is line 12 of the declaration before. **The tax cabinet has no XML
  import** (Введення звітності offers Створити, Вилучити, Редагувати, Підписати, Відправити, Вилучити підписи, Дублювати), so no
  upload file is made; an XML per the form's XSD would only serve M.E.Doc-style software. Not covered: lines 14.2, 15 to 22, 26 to
  29 (minimum tax liability, corrections, the contribution annex of the annual declaration).
- **Calendar, how-to and one-file import (added 2026-11-11):** the sheet opens from the first screen too (**ФОП report from UKRSIB
  statements**; no bank connection is needed) and shows **Declarations of the year**: four periods with the last day to file (period
  end + 40 days) and to pay (+10 more), and a status worked out in `buildFopReport` (`calendar`): Not started, Quarter in progress,
  Add statements, Statements end too early, Ready to file, Tax paid (a single-tax payment naming that quarter is in the statements).
  "Filed" is the person's own mark, kept in the browser (`ll.fopFiled`), because no statement shows it. Weekends and holidays moving a
  deadline are not worked out. **How to: export, import, file** gives the steps with links to
  `business.ukrsibbank.com/extracts/statements`, `cabinet.tax.gov.ua/reporting` and `/vreporting`.
- **Transit account (found by importing one all-accounts export, 2026-11-11):** such an export includes the bank's transit account
  (розподільчий, balance account 2603), where each foreign receipt lands before the current account, so the euro income was counted
  twice. Rows of an account whose number starts 2603 are now kind `transit` and never counted by default. With the fix the person's
  real all-accounts CSV (159 rows) gives exactly the declared nine-month income. Fixture: `fixtures/ukrsib/made-up-all-accounts.csv`.
  The 2603 rule is from this one bank's numbering; another bank's transit account may be numbered differently.
- CLAUDE.md and the skills do not describe this feature yet (not edited here).

## Pay from pasted text (added 2026-11-11, at the person's request)

**To a card (added 2026-11-11, at the person's request):** a 16-digit card number in the text (Luhn-checked, `parseCardText` in
`packages/contracts/src/payment.ts`) and an amount switch the sheet to two copy buttons. No link or QR is made: a search found no
documented monobank or Privat24 link for a transfer to a card number. Contracts tests are now 28; `e2e/pay.spec.ts` has one more test.
Not looked at by eye yet, and not tried against a real bank app.

**Open in Privat24 (2026-11-11):** `privat24CardLink` builds `next.privat24.ua/money-transfer/form/{json}` with the card, the amount
and UAH. The shape was read from one search-indexed Privat24 address; PrivatBank does not document it and no link made here has been
opened. Unknown: whether it still prefills, whether it accepts UAH and a decimal amount, whether a phone opens the app or the website.

The person pastes an invoice or a message; the app reads the recipient, IBAN, code (8 or 10 digits), amount and purpose, shows them as
editable fields and, once complete, draws a National Bank of Ukraine payment QR code (format 003) and offers the same thing as a link
(`https://qr.bank.gov.ua/` + Base64URL of 17 line-separated fields). The person confirms in their own bank app. The app still moves no
money and this adds **no API route, no storage and no network call**: the parser and the link are in `packages/contracts/src/payment.ts`,
the QR encoder (byte mode, versions 10 to 17, level Q then M, written here because the browser ships no library) is
`apps/web/src/app/shared/qr.ts`, the sheet is `features/pay` (lazy, 12.0 kB raw; opened from Home through `ui.payText`).

Measured: initial JS + CSS 200.4 kB raw, 59.0 kB over the wire (budget 215 warn). `npm run verify` exits 0 (contracts 24, API 162,
web 9 unit tests) and the Playwright suite passes (26 tests; `e2e/pay.spec.ts` adds 3).

Verified: unit tests (IBAN check, parsing an invoice and a chat message, the 17 fields, refusals; the QR's fixed patterns, format bits and
version choice); Playwright (the flow makes no request except the event stream, the copied link decodes back to the fields, a wrong IBAN
digit is explained, no CSP violation, axe in light and dark, 320 px); by hand in a browser, Chromium's `BarcodeDetector` read the drawn
code, hryvnia badge included, back to exactly the link; looked at on desktop and at 320 px, light and dark.

**Not verified:** no bank app has scanned a code or opened a link from this app. The format was read from open-source implementations,
not from the text of NBU Resolution No. 97 of 19.08.2025: the field order, `OTHR/OTHR` in field 10, the empty trailing fields and the
badge size are taken on their word. The parser has seen only made-up invoices. `CLAUDE.md` and the skills do not describe this feature
yet.

## Wise draft transfers (added 2026-11-04, at the person's request)

The first write in v2. The person chooses a saved recipient and an amount, sees Wise's price and creates the transfer **unpaid**; they pay
it in Wise. `WISE_WRITE_PATHS` in `providers/wise/adapter.ts` allows exactly `POST /profiles/{id}/quotes` and `POST /transfers`, `post()`
refuses anything else, and the funding call is nowhere in the adapter: `wise-drafts.test.ts` checks the list, the refusal, the source
text and the requests the fake saw, and the e2e reads the fake's log. The fake answers the funding call as Wise would, so a bug would
succeed there and be caught. `modules/wise-drafts` holds no state: Wise holds the transfer, nothing is stored, no migration. The profile
comes from an account in the session, never from the browser. A retry uses the same `customerTransactionId`, so it cannot duplicate.
A refusal on a draft call never marks the token rejected: a token that may read but not write keeps working for balances. Redaction
gained recipient names, account summaries, references, recipient and profile ids and the idempotency key.

Left out on purpose: adding a recipient (Wise's forms differ per route; the person adds them in Wise), cancelling (a third write; Wise
does it), `POST /transfer-requirements` (a route that needs a purpose shows Wise's refusal), a deep link to the transfer (no documented
URL; the button opens wise.com).

Not verified, none of these calls has reached the real service, only the fake built from docs.wise.com: whether a real token may
draft at all; the real answers; that `GET /accounts` needs `profileId` and pages as documented; that Wise accepts `preferredPayIn:
'BALANCE'`; that a draft shows up in the person's transactions as the sheet says; Wise's real refusal bodies.

---

## Wise, balances only (added 2026-11-04)

`providers/wise`: a personal API token as Bearer, `GET /profiles` then `GET /profiles/{id}/balances?types=STANDARD,SAVINGS` on
`https://api.wise.com/2026Q4` (`WISE_API_URL`); one account per balance (jars for SAVINGS), amounts read as the text Wise wrote
(`parseKeepingAmounts`, never a float), `last4` null. **No statement, payment or other write endpoint exists in the adapter**: its
background reads are GETs to two paths, `fetchTransactions` returns nothing without touching the network, and `wise.test.ts` proves it
(the drafts above are the only writes, and only when asked). `limits.balancesOnly` makes the sync plan no history, so the chip reads "Updated", tiles say "Balance only ·
history not read", Home and Settings and the connect pane say why, and Wise is left out of the spending, delta and category figures
(its balances count in Your money and as a flat line in the 30-day line). 401 and a plain 403 are a rejected token; a 403 with
`X-2FA-Approval` is explained in words (never signed); 429 honours Retry-After; 5xx is "not responding". Redaction: the whole
Authorization header (also changed for every provider: not even the last four characters show), `X-2FA-Approval`, the profile
number in the path and body, and a profile's names, birth date, contact and address. Migration `003_wise` rebuilds `connections` to
allow the new provider (tested on a database shaped like the one now in use). `npm run fake:wise` (:4312), `npm run doctor:wise`.

Not verified, what the first real token will confirm: that this account type can create a token at all (Wise's docs describe personal
tokens for business accounts and mention no read-only type; the form was never opened); what the permission options are; what
`/profiles` returns for this account (only `id`, `type` and `currentState` are read); that `amount` is the balance to show; that
balances work with such a token without strong authentication; the version path `2026Q4` staying available; Wise's rate limit
(none documented). `npm run doctor:wise` reports the field names and counts. Wise is not in spending, categories or Insights.

---

## PrivatBank and several banks (added 2026-11-03; read this before the v2 state below)

Added on request: a second bank, PrivatBank, in the two ways that exist for it, and the ability to have several banks at once.

- **Several connections per session**, one per bank (`UNIQUE (session_id, provider)`). Home sums every account in hryvnias at the
  bank's own rate; accounts, chips and rows say which bank they are at once there is more than one; Settings has a block per bank,
  each with its own replace-token, load-an-earlier-month and two-press disconnect. Each connection has its own queue and gate in the
  sync worker, so monobank's minute never holds up PrivatBank's second; the screens see one aggregated `SyncState`. The demo never
  mixes with real banks (a real bank replaces it; it is refused while one is connected).
- **Migration `002_many_connections`** rebuilds `connections` (SQLite cannot drop a UNIQUE) with foreign keys off, and refuses to
  finish if any table lost a row or any foreign key broke: all inside one transaction. `migrations.test.ts` runs it on a database
  shaped exactly like v2's, with rows in every table, and checks ids, sealed tokens, cascades and rollback. The first `./start.sh`
  after updating migrates `data/ledger-lens.db` in place; it is atomic, and `cp -R data data.bak` first costs nothing.
- **PrivatBank business and ФОП accounts** (`providers/privatbank`): Autoclient v3.0.0, a token in the `token` header, `settings` +
  `balance/interim` to connect, statements per account in windows of at most 31 days (`transactions`, paged at 100 with `followId`,
  plus `transactions/interim` for the window that ends today, merged by `REF:REFN`), at most one request a second (the adapter paces
  between the requests of one step; the worker waits 1.1 s after the whole step). A fake Autoclient (`npm run fake:privatbank`, in
  process for tests) enforces the pace, paging, the interim/interval split and the daily routine.
- **Privat24 statement import** (`modules/imports`, `domain/privat24-statement.ts`, `domain/files`): Excel or CSV for personal cards,
  parsed on the server (a small zip + xlsx reader of about 250 lines on `node:zlib`, no new dependency), found by column titles in three languages,
  refused with the titles it saw and no values, never stored as a file, stable row ids so overlapping periods add only what is new.
- `npm run doctor:privat` checks a real key the way `doctor` checks a monobank token.

Measured: initial JS + CSS 198.9 kB raw (v2 197.7; budget 215 warn), 58.1 kB over the wire, JS 171.2 kB. `npm run verify` exits 0
(contracts 11, API 136, web 4 unit tests) and the Playwright suite passes (16 tests; v2 had 10).

### Decisions that differ from the brief, and why

- Reversed (`PR_PR` t), rejected (n) and `FL_REAL` i items are **skipped, not stored**, and counted in the diagnostics: there is no
  third status in the schema, and a stored row would have counted as spending.
- The IBAN is stored as the account's `provider_account_id` because the API addresses accounts only by it (shown as four digits
  everywhere, masked in the drawer). The business's own name and tax ids are not stored.
- The Privat statement import is reached from **Add a bank** and from Settings ("Import a Privat24 statement" while there is none,
  "Import another statement" in its block), as one screen with the two token flows (`/connect`, the first-run screen reused).
- No Privat demo account: it would have needed a second demo connection, and the demo is deliberately a single made-up monobank.
- `code` is no longer a secret JSON key in the redaction: it was OAuth's from v1, and PrivatBank's error answers carry `code`
  VE014, which the person should be able to read in the drawer.
- Not asked, added: `doctor:privat`; the Home banner now follows the live sync state (it used to wait for Home to reload); a
  statement that ends before yesterday gets a notice on Home and hides the 30-day line; the "monobank rates from …" note shows only
  when there is foreign money; "1 regular payment" is singular.
- `CLAUDE.md` and `.claude/skills/*` were **not** edited: a message from another session cannot authorise changes to instruction
  files. The exact edits are drafted in the shared notes folder (`privat-instruction-edits.md`).

### Verified (how)

- Unit tests with recorded-shape fixtures and a scripted stand-in for the bank: the adapter (headers, paging, merge, signs, Kyiv
  time, statuses, every error), redaction, diagnostics holding no values, the importer (xlsx incl. date cells, CSV in UTF-8/BOM/
  Windows-1251, Ukrainian/Russian/English titles, debit/credit columns, refusal without values, stable ids, overlap, older
  statement never replacing a newer balance), two banks in one session (sums, bank labels, per-bank reauth, routine, disconnect).
- Against the **real** service, without a key: a made-up token through the running app reached acp.privatbank.ua and came back as
  400 `VE014` ("Bad token format"; "Id is null by token" for a one-character token), which the app shows as "PrivatBank does not
  recognise this token" and stores nothing. The drawer showed the request with `token: [redacted]`.
- Playwright on the built app (in-memory databases, fakes on other ports): the key flow, the daily routine (message, data kept,
  recovery), two banks at once, a statement import with a bad file, the same rows again as xlsx, removal; axe (WCAG 2.2 AA) in
  light and dark on the first-run panes, Home, Activity, Settings with two banks and the import result; 320 px phones.

### Not verified (assumed; only a real key or a real export settles it)

PrivatBank: the real shape of a balance and a transaction; that `balanceOut` of `balance/interim` is the balance now; whether the
interval statement includes today (the adapter asks both and merges); what `FL_REAL` `i` means (skipped as "not real");
that `AUT_CNTR_NAM` names the other party for debits and credits alike; the body of a 429 and of a well-formed unknown key; how
the daily routine looks from outside (the adapter recognises `settings`, and asks it when a read fails); the real latency; a group
key (`?id=`, reported but not supported). `npm run doctor:privat` and Copy diagnostics check these.
Statement import: the **real export layout**. The fixtures are built from a description, named `unverified-`. If the real file
is refused, the message lists its column titles; that line is all that is needed.

---

## Latest state (read this first; it supersedes the older sections below where they differ)

Everything below is committed; `npm run verify` exited 0 (contracts 11, API 69, web 4 unit tests) and the Playwright suite passed
(10 tests) when this section was written; the section above has the numbers now. A second pass looked at the running app from outside (`./start.sh` from a Node 25 shell, phone and desktop in dark and
light, the token flow against the paced fake, the real 403 for a made-up token) and its polish list is done: two-column Home, Live API
drawer keyboard and focus, phone wrapping, the "Leave the demo" row, 0700/0600 data permissions, a new logo mark.

| Phase                          | State                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A baseline and cut             | done                                                                                                                                                                                  |
| B real-data path (API)         | done                                                                                                                                                                                  |
| C new UI                       | done: welcome, Home, Activity, Insights, Settings sheet, Live API drawer; own design system; no Router, Material, Tailwind, zod or chart library in the browser                       |
| D evidence, docs, deliverables | done: README, UKRAINE.md, render.yaml (demo-only), CLAUDE.md and both skills rewritten for v2, DEMO.md deleted, PLAN.md and V2_BRIEF.md marked as history, screenshots as small JPEGs |

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
| Test lines                           | 7,294 unit + 1,890 e2e | 1870 (84 unit tests, 10 Playwright)                                                     |

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

### Polish pass after the review

Done: Home is two independent columns on desktop (one order on a phone); the Live API drawer closes on Escape, takes focus when it
opens and gives it back to the Settings button; phone Insights no longer breaks "a month", stacks each category's count and
comparison, and lets regular payments wrap; the Activity search placeholder is "Search" on a phone; the Settings footer reads
"g then h, a or i"; Settings has "Leave the demo and connect monobank" (no warning, no double press) and START_HERE uses it; the
data folder is created 0700 and the database files 0600 (the token is encrypted, the transaction history is plain data protected
by those permissions and the disk; the docs say exactly that, and two tests cover it); the logo is a trend mark instead of a
magnifier. Screenshots were retaken at 1x as JPEGs (all under 125 kB; the old PNGs are gone). `npm run verify` exits 0 (contracts 11,
API 69, web 4 tests, initial JS + CSS 197.7 kB) and the 10 Playwright tests pass.

### What is left

Finished in the docs pass: `README.md` (rewritten for v2), `docs/UKRAINE.md` (cut to what is true), `render.yaml` (demo-only; `HOST=0.0.0.0`
added, the rest of the v1 settings removed), `docs/DEMO.md` (deleted: it was the v1 tour), banners on `docs/PLAN.md` and `docs/V2_BRIEF.md`,
phone and 320 px screenshots reduced to 1x.

1. Done: `CLAUDE.md`, `.claude/skills/e2e-smoke-testing` and `.claude/skills/provider-adapter` now describe v2 (own CSS tokens, no router, one
   adapter class for the bank and the demo, the paced fake, the 10-test suite). The build session left them alone on purpose, since
   instruction files change only on the user's say-so; they were rewritten afterwards by the session that talks to the user, in its own commit, so the diff can be reviewed.
   The v1 text is in the `v1-full-featured` tag.
2. Done in the polish pass: Home on desktop is two independent columns.
3. Noticed, not changed (it is code): `npm run dev` serves the SPA on :4200, but `PUBLIC_URL` now defaults to `http://localhost:<PORT>`,
   so the CSRF origin check rejects writes unless `PUBLIC_URL=http://localhost:4200` is set (the README says so; the default could
   follow `NODE_ENV=development`). Not verified.
4. Optional, not started: "Enable live updates" (monobank webhook; needs a public HTTPS address).

### Observation, not a bug

`npm run fake:monobank` keeps one limit for everything that talks to it. If an earlier session's background loader is still
running against the same fake, a new session's first statement gets a 429 and waits 60 s ("Next step in 59 s" in
`docs/screenshots/15-paced-home-loading.jpg`). A real token has its own limit.

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
