# Ledger Lens for iPhone

The phone version of Ledger Lens: Expo SDK 58, React Native, TypeScript. **No server** for your own data: the phone does
the work itself. Family mode, if you turn it on, adds one: a relay that passes on encrypted totals it cannot read.

| Tab      | What it does                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------- |
| Money    | monobank balances, each account and the total in hryvnias (foreign money at monobank's rate of today)    |
| Activity | Every transaction read so far, with search as you type                                                   |
| Pay      | Pay from pasted text: the National Bank of Ukraine payment link and QR code, or a card number to copy    |
| Family   | One budget for the family: spending by person and category, the family's money, a monthly budget         |
| ФОП      | The single-tax report from UKRSIB business CSV statements: quarters, declaration lines, the year's dates |
| Settings | Connect monobank with your own token, try made-up data, disconnect                                       |

It never moves money. How to get it onto your phone: [`DEPLOY.md`](./DEPLOY.md).

## How it is built

- **It reuses the server's code, in place.** The monobank adapter, the fake bank behind the demo, the categoriser, the
  rates table, the calendar, the UKRSIB reader and the ФОП report are imported from `apps/api/src` (`@api/…`), the QR
  encoder from `apps/web` (`@web-shared/…`), money and the payment parser from `@ledger-lens/contracts`. Nothing was
  copied and nothing in those workspaces changed. The aliases are in `tsconfig.json`, `metro.config.js` and
  `jest.config.js`.
- **Two stand-ins make that possible** (`src/platform`): `node-crypto.ts` (SHA-256 and SHA-1 for row ids and the demo's
  made-up data; Metro points `node:crypto` at it) and `text-decoder.ts` (Windows-1251 and strict UTF-8 for the statement
  reader). Both are tested against Node's own.
- **The token** is in the iOS Keychain (`src/platform/keychain.ts`: this device only, readable while unlocked). It is
  read back in one place (`src/bank/sync.ts`) and never printed: the app has no `console` call at all, and a test keeps
  it so.
- **Read-only towards the bank, by construction.** `src/bank/http.ts` is the only code that talks to a bank. It
  refuses anything but a GET, and any address but the bank's, before a byte is sent.
- **Family mode** (`src/family`). Each person connects their own bank on their own phone; a token only ever shows its
  owner's accounts, and sharing one would hand over a whole history. What a phone shares is a summary: this month and
  the last, spending by category in hryvnias (the rules of Insights), and the person's money only if they choose so.
  No transaction, shop, account or card. The summary is sealed with XChaCha20-Poly1305 (`@noble/ciphers`) under a key
  derived from a 256-bit family secret, which is made on the phone that starts the family, kept in the Keychain and
  passed on as a QR code (`ledgerlens://family#…`, opened by the iPhone camera) or pasted text. The relay
  (`apps/relay`) gets a family id, an access key and sealed bytes; `src/family/relay.ts` is the app's second and last
  way to the network, HTTPS only. A phone with no bank, or in the demo, shares no figures and still sees the family's.
  The budget travels inside the summaries: the newest wins and every phone carries it on.
- **The history** is plain SQLite in the app's own folder (`src/data/db.ts`). It is not encrypted by the app.
- **Pacing.** monobank allows one read a minute per endpoint. `Sync.step()` does one read at most and says how long to
  wait; the app calls it while it is open. Three months of history is about three minutes a card. The same token on
  your computer shares the limit: a 429 is a wait, not an error.
- Money is integer minor units everywhere.

## Commands

Run in `apps/mobile`, with Node 24.15+:

| Command                                    | What it does                                                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                 | Jest: the stand-ins, the HTTP guard, the store on real SQLite, the paced sync against the fake bank, Pay, ФОП, the family (two phones against a real relay in-process) |
| `npm run typecheck`                        | `tsc --noEmit`                                                                                                                                                         |
| `npx expo-doctor`                          | Expo's project checks (needs the network)                                                                                                                              |
| `npx expo export --platform ios`           | Bundles the iOS JavaScript with Metro, without a build: a quick "does it bundle"                                                                                       |
| `npx expo start`                           | Development server, for Expo Go or a simulator on a Mac                                                                                                                |
| `npm run build:ios` / `npm run submit:ios` | EAS build and upload to TestFlight (`DEPLOY.md`)                                                                                                                       |

From the repository root, `npm run verify` also runs this workspace's typecheck and tests.

## Not in this version

PrivatBank business, Wise balances, Privat24 statement files, Insights, the Live API drawer, the "Filed" mark on the ФОП
calendar, a Face ID lock and a privacy blur. What has not been verified is listed at the end of `DEPLOY.md` and in
`docs/HANDOVER.md`.
