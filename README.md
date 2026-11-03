# Ledger Lens

Your monobank, instantly: a small, fast personal-finance app on your own real monobank data. Read-only, on your own computer.

**Start:** `./start.sh`, click **Try with demo data**, and when you want your own accounts get a token at https://api.monobank.ua/
(scan the QR code in the monobank app) and paste it into the app. The numbered steps, with what you should see at each one, are
in [docs/START_HERE.md](docs/START_HERE.md).

> The rest of this README still describes v1 (payments, TrueLayer, mock bank) and is being rewritten. v1 is the git tag
> `v1-full-featured`. The current state is in [docs/HANDOVER.md](docs/HANDOVER.md).

An Open Banking proof of concept: a personal-finance app that connects your bank (**account information**), shows what
you own and where it goes, and sends a payment you approve inside your own bank (**payment initiation**). An **API
Inspector** beside every screen shows the real provider calls behind it, so you can watch Open Banking happen.

It runs end to end on a built-in **mock bank**, with no accounts, keys or network. A **TrueLayer sandbox** adapter and a
real-bank adapter for **monobank** (Ukraine, your own token) sit behind the same interface.

> New here? Run it, then follow the [five-minute tour](docs/DEMO.md).

## Run it

You need Node **24.15 or newer 24.x** (`.nvmrc` says 24; the Angular 22 toolchain rejects the Node 25 many shells default
to) and npm 11.

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"   # or: nvm use
npm ci
npm run dev        # API on :3000, Angular on :4200 (proxies /api and /mock-bank)
```

Open <http://localhost:4200>. The first visit starts an anonymous demo session (a cookie; there are no accounts or
passwords), and the header badge says **Mock bank** to remind you nothing real is involved.

Other commands:

| Command                                                           | What it does                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run verify`                                                  | Node check, ESLint, Prettier, typecheck, every unit test, the production build                |
| `npm run e2e`                                                     | Builds, then runs the Playwright suite (about a hundred tests, mock bank, in-memory database) |
| `npm run build` then `PUBLIC_URL=http://localhost:3000 npm start` | The production shape: one Node process serves the API and the built SPA on `:3000`            |
| `npm run keys:truelayer`                                          | Generates the ES512 key pair TrueLayer Payments needs (see [TrueLayer](#truelayer-sandbox))   |

## What you get

- **Connect a bank**: pick a bank, read plainly what will be shared and for how long, sign in on the bank's own page, come
  back. Consent has an end date, a countdown and a one-click reconnect; consent revoked at the bank is detected.
- **Dashboard and transactions**: balances per account and per currency (never summed across currencies), pending and booked
  transactions, search and filters, a cool-down so "Refresh" respects the bank's limits on background reads.
- **Payments**: a form, a hop to your bank to approve, then a live timeline (Pending, Authorised, Executed, Settled) driven by
  the bank's webhooks. Every outcome has a designed state: approved, authentication failed, rejected, not enough money,
  cancelled, expired, bank down.
- **Insights**: income, spending and what is left over per currency; spending by category; income against spending by month;
  standing payments (rent, subscriptions) found in your history. A table view sits next to every chart. Change a
  transaction's category and everything follows; export what you filtered as CSV.
- **API Inspector**: the real calls the server made to the bank (method, URL, status, latency, redacted headers and bodies),
  the webhooks the bank sent in, and demo controls that break the mock bank on purpose (outage, rate limit, revoked consent,
  expiring consent, a replayed webhook).
- **Privacy**: see exactly what each connection can read, revoke it, or delete everything. The server forgets idle sessions.

## How it fits together

```
Browser: Angular 22 SPA (zoneless, signals, Material + Tailwind)
   │  same origin: /api/*, an HttpOnly session cookie, an XSRF header, server-sent events
   ▼
BFF: Fastify 5 on Node 24 ── SQLite (sessions, connections, cached accounts and transactions, payments, webhook events)
   │                         provider tokens are AES-256-GCM sealed at rest and never leave the server
   └─ BankingProvider port: every provider is normalised to the shared contracts
        ├─ MockProvider      an in-process fake bank, served under /mock-bank (OAuth, data API, payments API,
        │                    hosted approval pages, signed webhooks)
        ├─ TrueLayerProvider sandbox: Data API, Payments v3 with request signing, webhook verification
        └─ MonobankProvider  Ukraine, your own read-only token, local only (docs/UKRAINE.md)
              ▼
        The bank's own consent and approval page: a full-page redirect, never an iframe
```

- **Why a server at all?** A browser cannot hold a client secret, sign a payment request, receive a webhook, or be trusted
  with a bank token. So the SPA only ever talks to its own backend, and the backend talks to the banks.
- **`packages/contracts`** holds the Zod schemas and types both apps import, so the API and the screens cannot disagree.
- **Every provider call goes through one instrumented transport**, which is what feeds the Inspector and applies redaction.
- Money is integer minor units plus an ISO 4217 code. Time comes from an injected clock, so tests are deterministic.

More detail for contributors is in [`CLAUDE.md`](CLAUDE.md), the two project skills in `.claude/skills/`, and the original
plan and decisions in [`docs/PLAN.md`](docs/PLAN.md).

## The regulatory model, in plain words

Open Banking (PSD2 in the EU, the OBIE regime in the UK) lets a customer tell their bank to share account data, or to make a
payment, through a third party. That third party must be a **regulated provider**: an Account Information Service Provider
(AISP) to read, a Payment Initiation Service Provider (PISP) to pay, and it identifies itself to banks with eIDAS or
Open Banking certificates over mutual TLS. Strong customer authentication always happens at the bank, not in the app.

There are two ways to be one:

1. **Be the regulated entity** yourself: authorisation from a national regulator, certificates, a connection to every bank
   (or a standard such as Berlin Group or the UK API specification) and all their quirks. This is a company, not a project.
2. **Use an aggregator** (TrueLayer, Enable Banking and others). They hold the licences and the bank connections and give you
   one REST API; you act under their licence. This is how most products are built, and it is what this project models.

What follows from that:

- A **public instance of this app only ever uses mock and sandbox data** (decision D7). Live access for other people needs a
  commercial agreement with the provider and, depending on the product, your own authorisation. That is why real-bank
  adapters switch off unless the app is served from `localhost`.
- **Consents expire** (PSD2 allows up to 180 days, and UK banks ask for reconfirmation every 90). The app tracks that and makes
  reconnecting easy. **Unattended reads are capped** by banks (typically four a day), so the app serves from its cache and
  treats "Refresh" as a customer-present call.
- **Ukraine** has had its own regime since 1 August 2025, and the practical route for a person today is different: see
  [`docs/UKRAINE.md`](docs/UKRAINE.md).

## Providers

| Provider       | Mode    | What it does here                                                        | Needs                              |
| -------------- | ------- | ------------------------------------------------------------------------ | ---------------------------------- |
| **Mock bank**  | mock    | Everything: connect, data, payments with every outcome, webhooks         | nothing (the default)              |
| **TrueLayer**  | sandbox | Connect and read the sandbox's mock bank; pay into a merchant account    | sandbox credentials, a signing key |
| **monobank**   | live    | Read **your own** accounts with a token you issue; paced history loading | your token, `localhost` only       |
| Enable Banking | -       | **Not built.** Needs the spike in `docs/PLAN.md` §13 first (see below)   | an Enable Banking account          |

Turn providers on with `PROVIDERS` in `apps/api/.env` (copy `apps/api/.env.example`, which documents every setting):

```bash
cp apps/api/.env.example apps/api/.env
# PROVIDERS=mock,truelayer      or      PROVIDERS=mock,monobank
```

### TrueLayer sandbox

TrueLayer's sandbox is self-serve and never touches real money. The adapter is written from TrueLayer's documentation and
tested offline against documented-shape fixtures; **it has not been run against the live sandbox** (no credentials were
available while it was built). Expect to find small differences the first time, and fix them against the fixtures.

1. Create a free account at <https://console.truelayer.com> and keep the **Live** toggle off. Create an app.
2. In the app's settings add the redirect URIs `{PUBLIC_URL}/api/connections/callback` (data) and
   `{PUBLIC_URL}/api/payments/return` (payments). For `npm run dev`, `PUBLIC_URL` is `http://localhost:4200`.
3. Put the sandbox client id and secret in `apps/api/.env` (`TRUELAYER_CLIENT_ID`, `TRUELAYER_CLIENT_SECRET`), never in chat or git.
4. For payments, run `npm run keys:truelayer`, upload the printed **public** key in the Console (Payments, Signing keys), and
   set `TRUELAYER_SIGNING_KEY_ID` and `TRUELAYER_PRIVATE_KEY_PATH`.
5. Payments go to a **merchant account** by default (a new sandbox app has one per currency): set
   `TRUELAYER_MERCHANT_ACCOUNT_ID_GBP` / `_EUR`. Paying an arbitrary IBAN or sort code needs "external account" payments
   enabled by TrueLayer (`TRUELAYER_BENEFICIARY=external_account`); the adapter does not assume it.
6. Webhooks: register `{PUBLIC_URL}/api/webhooks/truelayer` in the Console and run a tunnel (cloudflared or ngrok) so TrueLayer
   can reach your machine. Without one nothing breaks: the app polls for payments it has not heard about.
7. In the sandbox's mock bank, test users and outcomes are chosen by username (`test_executed`, `test_authorisation_failed`,
   `test_execution_rejected`) or the cancel button.

What is written from the docs and **not yet verified live**: the Data API calls, payment request signing (ES512), the payment
create/get calls and their error shapes, webhook signature verification, whether `uk-cs-mock` or `mock` is the right provider id,
the revoke endpoint, and whether the `user` object is accepted as sent. `npm run e2e:sandbox` is the opt-in suite for this.

### monobank (Ukraine)

monobank lets a person read their **own** accounts with a read-only token they issue themselves at <https://api.monobank.ua/>.
Add `monobank` to `PROVIDERS`, start the app on `localhost`, and paste the token into the app (never into chat or a file). History
arrives in the background, one request per minute as the bank requires. Read [`docs/UKRAINE.md`](docs/UKRAINE.md) first: it covers
what is and is not possible, the terms of use, and what was checked against the live service (the public rates endpoint and the
bad-token answer; nothing with a real account).

### Enable Banking

Not built, on purpose. The plan's §13 lists three questions to settle first (redirect rules for `http://localhost`, whether
payment initiation works in restricted mode, and the terms for showing it to other people), and none can be answered without an
account. If you want real EU banks beyond Ukraine, that decision is yours: the `provider-adapter` skill is the recipe.

## Payments in detail

- **Idempotent**: every create carries an `Idempotency-Key`. The attempt is stored _before_ the bank is called, the bank gets its
  own idempotency key, and a timeout keeps the attempt so a retry completes the same payment instead of risking a second one.
- **One state machine**: webhooks, polls and the return from the bank all feed `domain/payment-state.ts`. Final states never
  change, progress only moves forward, a replayed or late event changes nothing.
- **Webhooks** are verified over the raw bytes (HMAC for the mock bank; TrueLayer's ES512 signature against its published key
  set, with the key URL pinned, never read from the request), de-duplicated by event id in the same transaction that applies
  them, and refused when stale. A **polling fallback** and the return-from-bank handler reach the same state, so a missing
  webhook is slow, not broken.
- The bank link a pending payment carries holds a one-time token: it is stored sealed, shown only while pending, and masked in
  the Inspector.

## Security

- **Tokens, client secrets and signing keys never reach the browser, the API's responses, the logs or the Inspector.** Provider
  tokens are sealed with AES-256-GCM, bound to their row. `apps/api/test/redaction-audit.test.ts` runs a whole connect, refresh and
  payment through two providers and searches every response, event, log line and database row for every secret.
- **Sessions**: an opaque 256-bit cookie, `HttpOnly`, `SameSite=Lax` (`__Host-`, `Secure` over https); only its SHA-256 is stored.
  Writes need a session-bound XSRF token and a matching `Origin`. New sessions are rate-limited per address.
- **Strict Content-Security-Policy** (no inline or eval scripts, same-origin only, not framable) plus the usual helmet headers.
  `e2e/csp.spec.ts` walks the app, the chart and every overlay and fails on a single violation. Everything under `/api` is
  `Cache-Control: no-store`.
- **Rate limits** on connecting, payments, the CSV export, the token form and webhooks; per-session where a session exists.
- **Money**: integer minor units, never floats, never summed across currencies.
- **Data hygiene**: the CSV export defuses spreadsheet formula injection; logs carry no query strings or bodies; "Delete all my data"
  withdraws consents at the banks and erases the session.
- **Live providers** (monobank) refuse to start unless the app is served from this machine.

## Quality gates

`npm run verify` runs ESLint (with Angular's template accessibility rules), Prettier, strict TypeScript, the contracts, API and
web unit tests, and the production build with its size budget. `npm run e2e` drives the real UI in Chromium against the mock bank:
every journey and failure state, payments, insights, the phone layout, **axe (WCAG 2.2 AA) on every route in light and dark**, and
the CSP check. Provider adapters are tested from fixtures with a stubbed transport, so everything runs offline.

## Deploy a demo

`render.yaml` is a [Render](https://render.com) blueprint for a **sandbox-only** public demo (mock bank, no real accounts, a short
session lifetime). Connect the repository in Render, create a Blueprint from it, and open the URL. It is a starting point, not a
tested deployment; see the notes at the top of the file.

## Repository layout

```
apps/web         Angular 22 SPA
apps/api         Fastify BFF: src/{plugins,modules,providers,domain,db}
packages/contracts   Zod schemas and types shared by both apps (source only)
e2e              Playwright: journeys, axe, CSP, phone layout
docs             PLAN.md (the approved plan), UKRAINE.md, DEMO.md, HANDOVER.md (state and what is unverified)
.claude/skills   e2e-smoke-testing, provider-adapter
```

## Troubleshooting

- **"The engine "node" is incompatible"** or Angular refusing to start: your shell is on the wrong Node. Run the `export PATH=...`
  line above (or `nvm use`); `npm run check:node` tells you which version you are on.
- **Port already in use** (3000, 4200, 4300): a previous run is still going. `lsof -nP -iTCP:3000 -sTCP:LISTEN` shows which.
- **Payments never leave "Waiting for approval"**: you have not approved at the bank's page yet; the timeline updates by itself
  after that. "Check now" asks the bank again.
- **A real provider does not appear in the bank list**: the server logs why at startup (missing credentials, or a live provider
  refusing to start while `PUBLIC_URL` is not `localhost`).
- **Playwright cannot find a browser**: `npx playwright install chromium`.

## Known limits

Anonymous demo sessions instead of accounts; the database is SQLite through Node's `node:sqlite`, which Node still marks as
early-stability (it is isolated behind `apps/api/src/db`, with `better-sqlite3` as the documented fallback); no recurring payments
or UK variable recurring payments; English only. The live TrueLayer behaviour, and anything with a real monobank account, is
unverified: [`docs/HANDOVER.md`](docs/HANDOVER.md) lists exactly what.
