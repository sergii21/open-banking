# Five-minute tour

Everything below runs on the built-in **mock bank**: no accounts, keys or network. Allow about five minutes the first time, and
under ten from a clean checkout including `npm ci`.

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"   # Node 24
npm ci && npm run dev                                         # then open http://localhost:4200
```

The header badge says **Mock bank**. To start over at any point: Connections, then **Delete all my data** (or restart the server).

Each step says what to do, what you should see, and what it shows about Open Banking.

## 1. Connect a bank (0:00)

1. **Connect a bank**, choose **Mock Bank**, read the four promises (what we will see, for how long, what we will not do, your control),
   then **Continue to Mock Bank**.
2. You are now on the _bank's_ page, not the app's. Leave **Anna Schmidt** selected and press **Continue**, review the access request,
   and press **Allow access**.
3. You land on **Bank connected**.

_Shows:_ the consent redirect. The app never sees a bank login; it gets an authorisation code on its callback, swaps it for tokens on
the server (with PKCE), and the browser never holds those tokens.

## 2. The dashboard, and what a refresh really does (1:00)

1. Go to **Dashboard**: three accounts, balances per account, totals per currency, a consent countdown (90 days).
2. Open the **API Inspector** (the magnifier icon in the header). Under **This screen** it says no provider calls happened: the
   dashboard was served from the cache. Open **All calls** to see the ones from connecting.
3. Press **Refresh Girokonto**. New calls appear: `Get consent details`, `Get balance`, `List transactions`. Click one to see its
   method, URL, status, latency and redacted headers and body.
4. Press Refresh again straight away: it is disabled for a few seconds.

_Shows:_ banks cap background reads, so apps cache and treat Refresh as a customer-present call. The Inspector is the real traffic.

## 3. Break the bank on purpose (2:00)

In the Inspector, open **Demo controls**:

- **Bank outage**, then Refresh: "Your bank isn't responding", and the balance you had is still there.
- **Rate limit**, then Refresh: a 429 with a retry hint.
- **Revoke at bank**, then Refresh: the app notices the consent is gone and offers **Reconnect**.

_Shows:_ the failure states a real integration must handle, each one a designed screen with a way forward.

## 4. Send a payment (3:00)

1. **Payments**, **New payment**: leave the amount and reference as you like (try `12.34`, reference `Rent`), enter any payee name and the
   IBAN `DE89 3704 0044 0532 0130 00`, then **Continue to your bank**.
2. On the bank's approval page keep **Anna Schmidt** and **Approve and execute**, then **Approve payment**.
3. Back in the app, watch the timeline move by itself: **Pending, Authorised, Executed, Settled**. Nothing reloads: the server pushes
   each step as the bank's webhook arrives.
4. In the Inspector (**All calls**) find `Create payment` going out, and the `Webhook: payment_authorized`, `_executed` and `_settled`
   events coming _in_.
5. Press **Replay last webhook** (the dashed box on the payment page). The message says the app recognised the duplicate and changed nothing.

Now try the other outcomes, each one a new payment:

| On the bank's page choose                 | You see                                                      |
| ----------------------------------------- | ------------------------------------------------------------ |
| **Fail authentication**                   | Failed: "Approval at your bank didn't go through"            |
| **Bank rejects the payment**              | Authorised, then Failed: "The bank rejected the payment"     |
| **Ben Okafor** and an amount of `2000.00` | Failed: "Not enough money in the account"                    |
| **Cancel**                                | Cancelled: "You cancelled at the bank"                       |
| Pay from **Mock Bank (degraded)**         | The bank's page is down, and the payment fails cleanly       |
| Leave the bank page without deciding      | The payment waits; **Resume at your bank** picks it up again |

Choose **Mock Bank UK** to see a bank whose payments end at **Executed** (no settlement step) and take a sort code and account number.

_Shows:_ payment initiation. The customer approves at the bank (strong customer authentication), the app learns the result by webhook
with a polling fallback, creating a payment is idempotent so a double click or a retry cannot pay twice, and a replayed webhook is harmless.

## 5. See the money move, and understand it (4:00)

1. **Dashboard**, **Refresh Girokonto**: the balance dropped by the payment, and **Transactions** shows `UEBERWEISUNG AN ...`.
2. **Transactions**: search for `rewe`, then use the label icon on a row to **change its category**. It is marked as yours and kept
   even when the bank sends the transaction again.
3. **Insights**: income, spending and what is left over; spending by category (the biggest first); income against spending by
   month. Hover the chart, or switch it to **Table** for the exact numbers. Standing payments (rent, Netflix, insurance) are found
   automatically. Change the period at the top and everything follows. Your recategorised transaction moved its money.
4. Back on **Transactions**, press **Export CSV**: the filtered list as a spreadsheet.

_Shows:_ what an aggregator's normalised data makes possible, and why the arithmetic is explicit (transfers left out, refunds netted,
currencies never combined: "How these numbers are counted" is on the page).

## 6. Privacy (4:45)

**Connections** shows what each connection can read ("Cannot move money": a payment is approved one at a time at the bank, never by
the data consent), its expiry, and **Remove and delete data**. **Delete all my data** withdraws consents and erases the session.

## Beyond the mock

- **TrueLayer sandbox**, for real redirects to a provider and signed requests: see the README's TrueLayer section.
- **monobank (Ukraine)**, for your own real accounts on your own machine: [`UKRAINE.md`](UKRAINE.md).
- **The suites**: `npm run e2e` replays most of this tour in a browser, in light and dark, on a desktop and a phone.
