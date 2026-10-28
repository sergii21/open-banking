# Real Ukrainian banks

Ledger Lens reads one real Ukrainian bank today: **monobank**, through its personal API. This page says what that is,
how to use it, what it cannot do, and what the alternatives are. Facts were checked on 2026-10-28; where a fact comes from
a document and was not exercised against a real account, it says so.

## What is actually possible

| Route                                         | Who can use it                                                                                                                              | Status here                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **monobank personal API** (`api.monobank.ua`) | One person, for their own accounts, with a token they issue in the monobank app                                                             | **Built.** Read-only: cards, jars, balances, statements      |
| monobank corporate API                        | A company with the bank's approval that serves other people's accounts                                                                      | Not built: needs an application to monobank and signing keys |
| NBU open banking (PSD2-style)                 | Third-party providers authorised by the National Bank of Ukraine                                                                            | Not built, see below                                         |
| PrivatBank                                    | Business customers (AutoClient, token from the business portal). I found nothing confirming a personal-token API for individual cardholders | Not built                                                    |
| An aggregator with Ukrainian coverage         | Anyone the aggregator onboards                                                                                                              | None confirmed (see below)                                   |

### The regulated route (NBU open banking)

Ukraine's open banking regime started on **1 August 2025** (Law "On Payment Services", chapter 4, with NBU Board Resolution
No. 80 of 25 July 2025). Banks must give API access to account data and payment initiation to **third-party providers
authorised by the NBU**, with strong customer authentication. Industry commentary expects the market to become active
around the end of 2026. Two consequences for this project:

- A proof of concept cannot simply "use the banks' PSD2 APIs" the way TrueLayer's sandbox suggests. Doing that for other
  people means becoming an authorised AISP/PISP (or working through one) and integrating bank by bank. I found no public
  sandbox or specification for the large banks, so I did not guess one.
- Nothing in the app prevents adding such a bank later: it would be one more adapter behind the `BankingProvider` port, with
  the redirect-and-consent flow the TrueLayer adapter already uses.

Sources: [Asters](https://www.asterslaw.com/press_center/legal_alerts/open_banking_to_launch_in_ukraine_on_1_august_2025/),
[Lexology](https://www.lexology.com/library/detail.aspx?g=bdf1714f-322f-4079-b773-2ee01a3b3b9e),
[Salt Edge on NBU compliance](https://blog.saltedge.com/open-banking-compliance-in-ukraine-salt-edge-cs/),
[Open Banking Tracker: Ukraine](https://www.openbankingtracker.com/regulation/ukraine-open-banking).

### Aggregators

TrueLayer (used for the UK sandbox) does not cover Ukraine. Salt Edge, which works with Ukrainian banks on the compliance
side, appears in aggregator directories, but I could not confirm that it offers account-information access to Ukrainian
banks for third parties, so no adapter was written for it.

## Using monobank

monobank's own terms limit the personal API to **personal and family use**; a service that passes other people's data
through its servers needs the corporate API. So this provider is local only:

- It is off unless `PROVIDERS` lists `monobank`.
- It refuses to start while `PUBLIC_URL` is not `localhost` (override: `ALLOW_LIVE_PROVIDERS=true`, which you should not do for
  anything other people can reach). The startup log says why when it stays off.

```bash
# apps/api/.env
PROVIDERS=mock,monobank
# MONOBANK_HISTORY_MONTHS=3          # how far back the background loader goes (1-13)
```

1. `npm run dev`, open http://localhost:4200, **Connect a bank**, choose **monobank**.
2. Open https://api.monobank.ua/, sign in with the QR code in the monobank app, copy the token.
3. Paste it into the field and connect. The token is checked with a real call, encrypted at rest (AES-256-GCM, bound to the
   connection), and never returned to the browser, logged, or shown in the API Inspector (`X-Token` is redacted and account
   identifiers are masked for live providers).

You never type the token anywhere else, and nobody needs to send it to anyone: in particular, do not paste it into a chat.

### What it does

- **Accounts:** cards (black, white, platinum, iron, kids, FOP, eSupport) and jars. Jars appear as savings accounts.
- **Balances:** `balance` from monobank includes the credit limit, so the app shows own funds as `balance - creditLimit` and
  "available" as `balance`. _This follows monobank's documentation as I understand it and is not yet checked against a credit
  card: look at one before trusting it._
- **Transactions:** a statement row with `hold: true` is shown as pending. Amounts are in the account currency. The merchant
  category code (`mcc`) feeds the categoriser, which also reads Ukrainian merchant names (Сільпо, АТБ, Київстар, Uklon, ...).
- **Pacing:** monobank allows **one statement request per minute per token**. Connecting reads the account list at once
  (balances show immediately) and queues one statement read per account and 31-day window. A background worker runs one per
  minute, newest window of every account first, and the dashboard shows "Loading history from monobank, 3 of 12 steps done".
  Three accounts and three months take about ten minutes. The queue is stored, so it resumes after a restart.
  A busy account can return 500 rows, which is the cap; the worker then asks for the rest of that window.
- **Refresh:** if a background step ran in the last minute, Refresh answers "the bank allows one transaction read per minute" with
  the seconds to wait, exactly as for any other rate-limited bank.
- **Token no longer accepted** (replaced or revoked at monobank): the connection moves to _needs a new token_, the queue stops, and
  Reconnect asks for a new token on the same connection.
- **Removing the connection** deletes the token and everything cached. monobank has no API to withdraw a token: it stays valid at
  api.monobank.ua until you issue a new one, and the app says so.

### What it cannot do

- Move money. The personal API has no payment initiation, so payments stay with the mock and TrueLayer providers.
- Push updates. monobank can call a webhook for new transactions, but that needs a public URL; use Refresh.
- Read more than 31 days per request, or faster than one request a minute. These are the bank's limits.

## Checking it against the real service

Offline tests use made-up data shaped like monobank's documentation. Two things were also checked against the live service on
2026-10-28 with no account: `GET /bank/currency` (public rates) and `GET /personal/client-info` with a dummy token, which answers
`403` with `{"errorDescription":"Unknown 'X-Token'"}`, the body the adapter treats as "token not accepted". Run them any time:

```bash
npm run test:live -w @ledger-lens/api
```

To check your own account (read-only, two requests, prints counts only), export the token in the same shell. It is read from
the environment and never written anywhere:

```bash
export MONOBANK_TOKEN=...            # your own token, typed by you
npm run test:live -w @ledger-lens/api
```

If that passes, the response shapes the adapter expects match your real data.

## Not verified

- Any real account: no token was available while this was built.
- That `balance` includes `creditLimit` for credit cards (see above).
- That the statement endpoint accepts a jar's id as the account (the adapter assumes it does).
- The exact 429 body: the adapter treats the status code as the signal and waits a minute.
