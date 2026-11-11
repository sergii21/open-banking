# Start here

Ledger Lens shows your own monobank and PrivatBank accounts together: your money in hryvnias, this month against last month,
every transaction with instant search, and your regular payments. It never moves money, and it stays on your computer. The first time takes about ten
minutes for one bank; each further bank is one more short section (5 and 6).

## 1. Start it

```bash
./start.sh
```

You should see: the terminal says "Ledger Lens is running at http://localhost:3000" and your browser opens on "Your banks,
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

1. If you looked at the demo: sliders icon, then **Leave the demo and connect a bank**. You land on the first-run screen (if you
   skipped the demo you are already there).
2. Choose **monobank**, paste the token and press **Connect monobank**.

What to expect: balances and your money in hryvnias in about 2 seconds; the first transactions of your main card in about 10
seconds; then the rest one step a minute, because monobank allows one read a minute. The chip at the top says what is happening
("Next step in 41 s · 2 of 8"). The 30-day line and "vs last month" appear once enough history has loaded, usually after a few
minutes. Settings, **Load an earlier month**, adds more.

- "monobank does not recognise this token": copy all of it, or issue a new one at api.monobank.ua.
- "allows one check a minute": wait the seconds it shows, then press the button again.

Optional check first, in your own terminal (type the token yourself): `MONOBANK_TOKEN=... npm run doctor` prints PASS or FAIL per
check and counts only. Do not run it and connect in the app within the same minute: both use monobank's one read.

## 5. Add PrivatBank (optional: business and ФОП accounts)

PrivatBank closed its API for personal cards in 2022, so a live connection exists only for **business accounts** (a ФОП or a
company), through its "Автоклієнт" integration. Personal cards come in from a file: step 6.

1. In Privat24 for Business connect the app **Інтеграція (Автоклієнт)**, press **Підключити API** and name the key (for example
   "Ledger Lens").
2. **Restrict the key so it can only read.** Open the key's settings, the tab **Обмеження по сервісам**, switch the restriction on
   and tick only **Отримання балансів і транзакцій за рахунками**. Then the key cannot create a payment, whatever happens to it.
3. Copy the token (the **ID і Token** button shows it). Keep it out of chats and files, as with monobank's.
4. In Ledger Lens: sliders icon, **Add a bank** (or the first-run screen), choose **PrivatBank**, paste, **Connect PrivatBank**.

What to expect: your business accounts and their balances in a couple of seconds; then history at the bank's pace, one request a
second (it should take about a minute), with the chip saying so. The 30-day line is rebuilt from today's balance and the items since.

- "PrivatBank does not recognise this token": copy all of it, or create a new key.
- "PrivatBank is doing its daily routine": around closing the day the bank stops answering statement requests for a while. The app
  keeps what it has and tries again by itself.
- A key for a **group** account (група ПП) is not supported yet; the app says so.

Optional check first, in your own terminal (type the token yourself): `PRIVATBANK_TOKEN=... npm run doctor:privat` prints PASS or
FAIL per check and counts only. It also checks the guesses that were made from the bank's document and not from real data.

## 6. Add your personal Privat cards (optional: from a statement file)

1. In Privat24 (the website or the app) open the card, choose **Виписка** (statement), pick the period and download it as
   **Excel** or **CSV**.
2. In Ledger Lens: **Add a bank**, choose **Privat24 file**, **Choose a statement file**.

Home then shows one card per last four digits, marked with the days it covers ("Statement 01.09–30.09"). Import again later to add
newer days: rows already here are not counted twice, and a category you chose is kept. The file is read on your computer and thrown
away; only its rows are stored.

**I have not seen a real Privat24 export yet.** The importer does not rely on column positions: it finds the columns by their titles
(Дата, Опис операції, Сума в валюті картки, Валюта картки, Залишок на кінець періоду; Russian and English titles too). If it refuses
your file, the message lists the column titles it found and nothing else from the file. **Send me that line** and the importer can be
fixed without seeing your data.

- A card is only as current as its file: the tile says which days it covers. When a statement stops before yesterday, Home says
  newer days are missing and hides the 30-day line (it would claim nothing happened since); import a newer statement to move it
  forward.
- If the file has no balance column, the card is listed but left out of the total (the screen says so).
- Spending must be negative in the file; if every amount has the same sign the importer refuses instead of guessing.
- If you also connect a business account whose card you import here, those payments are counted twice: import personal cards only.

## 7. Add Wise (optional: balances, and drafts you pay in Wise)

Ledger Lens can read your **Wise balances** (every currency, and jars) with a personal API token and count them in Your money. It
does **not** read Wise transactions: Wise requires strong authentication for statements outside the US, Canada, Australia, New
Zealand, Singapore and Malaysia, and this app does not implement that. So Wise shows as tiles marked "Balance only", and it is left
out of spending, categories and Insights (the screens say so).

1. In Wise open **Your account**, then **Integrations and tools**, then **API tokens** (Wise asks for 2-step login there).
2. **Add a new token** and choose the **narrowest permission the form offers**, read-only if it is there. Wise's documentation shows
   no read-only token type and nobody has yet seen the form for your account, so assume the token may be able to do more than Ledger
   Lens uses. The app reads balances, and writes only when you ask it to draft a transfer (below). You can revoke the token in Wise
   any time. A token that cannot create transfers still reads balances; only drafts need more.
3. Copy the token (Wise shows it once) and paste it in **Add a bank**, **Wise**, **Connect Wise**.

Wise's own documentation describes personal tokens for business accounts, so whether your account type can create one at all is
unconfirmed: if Wise will not create it, there is nothing more this app can do for Wise.

- "Wise does not recognise this token": copy all of it, or create a new one.
- "Wise asks for strong customer authentication": Wise wants a step this app does not do. Nothing is lost; balances read earlier stay.

Optional check first, in your own terminal: `WISE_TOKEN=... npm run doctor:wise` (prints counts only; it only reads).

### Draft a Wise transfer

Ledger Lens cannot pay anyone. It can prepare a transfer so you only have to pay it in Wise: **Draft a Wise transfer** on Home (or in
Settings), choose a balance, a recipient you already saved in Wise and an amount, check Wise's price, and create the draft. Then open
Wise and pay it there. Wise's API does not let a personal token fund a transfer outside the US, Canada, Australia, New Zealand,
Singapore and Malaysia, and this app never sends that call anywhere.

- A draft sits in Wise waiting for payment. Wise cancels it if it stays unpaid, usually within 14 days. Cancel one sooner in Wise itself.
- New recipients are added in Wise; the app only lists the ones saved there.
- "Wise does not let this token do that": the token may not create transfers. Make the transfer in Wise, or issue a token that allows it.
- Some routes need more details than this form asks for (a transfer purpose, for example). Wise then refuses and the sheet shows its
  words; make that one in Wise.

### Pay from pasted text

For a hryvnia payment to a Ukrainian account. **Pay from pasted text** on Home: paste an invoice or a message with payment details
(or press **Paste from the clipboard**). The app finds the recipient, the account (IBAN), the recipient's code, the amount and what the
payment is for, and shows them as fields you can correct. When they are complete it draws a National Bank of Ukraine payment QR code.

- Scan the code with your bank app's scanner for payment QR codes, check the details there and confirm. Or press **Copy the payment
  link** and open the link on your phone.
- Ledger Lens sends no money and keeps no copy: the text stays in the browser, is not sent to the server and is gone when you close the
  sheet. Nothing is paid until you confirm in your bank.
- Leave the amount empty to type it in the bank app.
- A wrong digit in the IBAN is caught and said in words; always compare the recipient and the amount in your bank app before you confirm.
- **By hand:** nothing has to be pasted. The switch under the text box picks **Account (IBAN)** or **Card number**, and every field of
  either kind can be typed in. Pasted text only fills them in.
- **To a card:** paste a message with a 16-digit card number and an amount ("4149 … 5678, 500 грн"). There is no payment code for a
  card and no bank offers a link for one, so the sheet shows the number (a wrong digit is said in words) and the amount with **Copy the
  card number** and **Copy the amount**: paste them into your bank app's transfer to a card and confirm there.
  **Open in Privat24** opens Privat24's transfer form with both filled in; PrivatBank does not document that link and it has not been
  tried yet, so check the card and the amount there. Tell us whether it worked.
- Not tried with a real bank app yet: if yours does not read the code, tell us which bank, and pay from the fields by hand.

### ФОП report (UKRSIB business statements)

For a sole proprietor (ФОП) on the single tax, group 3, with an account at UKRSIB business. **ФОП report** on Home (or **ФОП report
from UKRSIB statements** on the first screen: no bank needs to be connected) opens a sheet that
adds your income up per quarter from your statements, with the single tax and the military levy worked out from it. It files nothing
and pays nothing, and it needs files: UKRSIB has no key for it.

1. In UKRSIB business open **Рахунки та виписки, Виписки** (https://business.ukrsibbank.com/extracts/statements, after logging
   in). Click **Рахунок** and tick every account, set **Дата з** to 1 January and **Дата по** to the last day of the quarter, press
   **Сформувати**, then the **CSV** icon (not PDF: it does not say money in from money out; not XLS). One file holds every account.
2. In Ledger Lens press **Add UKRSIB statements (CSV)** and choose the files. Add newer ones later: rows already here are not counted
   twice, and what you decided about a row is kept. The files are read on your computer and thrown away; only their rows are kept.
3. Look at each quarter: income, the tax and levy it comes to, and what your statements say you paid for it ("Matches", "Paid less",
   "Not paid yet"). Choose 5 % (without VAT) or 3 % (with VAT) to match your registration.
4. Check the rows. Money from clients is counted; your own transfers and the hryvnias a currency sale brought are not (the currency
   counted when it arrived). Foreign currency counts at the hryvnia amount the statement shows, which should be the National Bank rate of
   the day it arrived. **Count it** or **Do not count it** changes any row.

5. When you file: open **Lines for the declaration** under the quarter. It lists the lines of the form (06, 08, 11, 12, 13, 14.1, 14,
   23, 24, 25) with the amounts from 1 January and a **Copy** button each. In the tax cabinet, **Введення звітності**, either create
   the declaration or select the one before and use **Додатково, Дублювати**, then set the period and paste the amounts. The cabinet
   has no file upload for this. Lines 13 and 24 must equal lines 12 and 23 of the declaration you filed before. The annual declaration
   also has a contribution annex this report does not fill.

The sheet starts with **Declarations of the year**: the four periods, the last day to file and to pay each, and where each stands
(Add statements, Statements end too early, Ready to file, Tax paid). **Mark as filed** is yours to press: a statement cannot show
that. **How to: export, import, file** in the sheet repeats these steps with the links.

The rates, the limit and the rules are assumptions written on the sheet (**What this report assumes**): confirm them with the tax
office or an accountant. This is not tax advice. A quarter is only as complete as your statements, and the UKRSIB accounts are not in
**Your money**.

## 8. Check it is real

- Compare one balance with the bank's own app. For a monobank credit card, "own funds" is the balance minus the limit: that is an assumption
  monobank's documentation does not state, so tell us if yours differs.
- Open Settings, **Live API**: the calls to api.monobank.ua and acp.privatbank.ua, with the token shown as [redacted] and account
  numbers and tax ids cut to their last digits.
- Open one transaction on Activity and compare it with the monobank app (category code, cashback, comment).

## 9. If something looks off

Settings, **Copy diagnostics**, then paste the text to us. It holds no token, names, merchants, amounts or ids, only counts, field
names and checks, so it is safe to share and enough to fix a mapping problem without seeing your data. Add one sentence about what
you expected.

## 10. Stop and remove access

- Settings has a block per bank. **Disconnect and delete my data** (press twice) deletes that bank's token and everything read from
  it from this computer and leaves the other banks as they are. **Remove the imported data** does the same for statement files.
- A token stays valid until you revoke it at the bank: at api.monobank.ua by issuing a new one, for PrivatBank by deleting the key
  in Privat24 for Business.
- Everything lives in the `data/` folder next to the app (not in git). `rm -rf data` removes the database and its key.
- The token is encrypted. Your transactions are stored as plain data in that folder, protected by the folder's permissions (only
  your user can open it) and by your disk's own encryption if you have it on (FileVault, on a Mac).

## Good to know

- Card payments the bank has not booked yet show a "Pending" label.
- Transfers between people and your own accounts are not counted as spending or income.
- The demo and your own banks never mix: connecting a bank replaces the demo, and the demo is not offered while a bank is connected.
- Updating a copy you already used: the first start upgrades the database in place (it either finishes completely or changes nothing).
  `cp -R data data.bak` before it is a free safety net; stop the running copy first (Ctrl+C), or `./start.sh` just opens it.
- Not yet run against a real account: the first connection may surprise us. That is what step 9 is for.
