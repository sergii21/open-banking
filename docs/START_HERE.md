# Start here

Ledger Lens shows your own monobank accounts: your money in hryvnias, this month against last month, every transaction with
instant search, and your regular payments. Read-only, on your computer. The first time takes about ten minutes.

## 1. Start it

```bash
./start.sh
```

You should see: the terminal says "Ledger Lens is running at http://localhost:3000" and your browser opens on "Your monobank,
instantly."

If not:

- "needs Node 24 and could not find it": install Node 24 from https://nodejs.org (the 24.x line) or with nvm, then run it again.
  `start.sh` picks Node 24 by itself when nvm is there, so your default Node 25 can stay as it is.
- "already running": it just opens the copy that is running.
- Port busy: `PORT=3100 ./start.sh`.

Stop it later with Ctrl+C in that terminal.

## 2. Try the demo

Click **Try with demo data**. Within a couple of seconds you should see Home with a big hryvnia number, a DEMO DATA label, six
accounts and an "Updated just now" chip. Try Activity (press `/` and type Сільпо), Insights (regular payments), the eye icon
(blurs every amount) and the sliders icon, then **Live API** (the calls the app made).

The demo is optional: if you would rather go straight to your own accounts, skip to step 3.

If the page is blank or says Ledger Lens is not reachable, the terminal from step 1 was closed: run `./start.sh` again.

## 3. Get your monobank token

1. Open https://api.monobank.ua/
2. Scan the QR code with the monobank app on your phone and confirm.
3. Copy the token the page shows.

It is read-only: it can see balances and transactions and can never move money. Keep it out of chats and files. The only place
it goes is the app's token field (and your own terminal if you use the optional check below). monobank's personal API is for
your own and your family's accounts and is not available under 16.

## 4. Paste it

1. If you looked at the demo: sliders icon, then **Leave the demo and connect monobank**. You land on the first-run screen (if you
   skipped the demo you are already there).
2. Paste the token and press **Connect monobank**.

What to expect: balances and your money in hryvnias in about 2 seconds; the first transactions of your main card in about 10
seconds; then the rest one step a minute, because monobank allows one read a minute. The chip at the top says what is happening
("Next step in 41 s · 2 of 8"). The 30-day line and "vs last month" appear once enough history has loaded, usually after a few
minutes. Settings, **Load an earlier month**, adds more.

- "monobank does not recognise this token": copy all of it, or issue a new one at api.monobank.ua.
- "allows one check a minute": wait the seconds it shows, then press the button again.

Optional check first, in your own terminal (type the token yourself): `MONOBANK_TOKEN=... npm run doctor` prints PASS or FAIL per
check and counts only. Do not run it and connect in the app within the same minute: both use monobank's one read.

## 5. Check it is real

- Compare one balance with the monobank app. For a credit card, "own funds" is the balance minus the limit: that is an assumption
  monobank's documentation does not state, so tell us if yours differs.
- Open Settings, **Live API**: the calls to api.monobank.ua, with the token shown as [redacted].
- Open one transaction on Activity and compare it with the monobank app (category code, cashback, comment).

## 6. If something looks off

Settings, **Copy diagnostics**, then paste the text to us. It holds no token, names, merchants, amounts or ids, only counts, field
names and checks, so it is safe to share and enough to fix a mapping problem without seeing your data. Add one sentence about what
you expected.

## 7. Stop and remove access

- Settings, **Disconnect and delete my data**: deletes the token and everything read from monobank from this computer.
- The token stays valid at api.monobank.ua until you issue a new one there. Do that to revoke it.
- Everything lives in the `data/` folder next to the app (not in git). `rm -rf data` removes the database and its key.
- The token is encrypted. Your transactions are stored as plain data in that folder, protected by the folder's permissions (only
  your user can open it) and by your disk's own encryption.

## Good to know

- Card payments the bank has not booked yet show a "Pending" label.
- Transfers between people and your own accounts are not counted as spending or income.
- PrivatBank has no personal API. To see Privat data we would need a sample statement export from Privat24; nothing is built for it.
- Not yet run against a real account: the first connection may surprise us. That is what step 6 is for.
