# monobank, PrivatBank and other Ukrainian banks: what is real here

Ledger Lens reads two Ukrainian banks: **monobank** through its personal API with a token you issue yourself, and **PrivatBank**
in two ways, a live connection for business and ФОП accounts and a statement file for personal cards. This page says what has been
checked against the real services, what only your own token or your own export can check, and what is not possible. How to use it
is in [START_HERE.md](START_HERE.md).

## The rules that come with the token

- monobank's personal API is for your own and your family's accounts, is not available under 16, and a service that passes other
  people's data through its servers needs monobank's corporate API. So the real-bank provider is registered only while
  `PUBLIC_URL` is a localhost address (`ALLOW_LIVE_PROVIDERS=true` overrides that; do not use it for anything others can reach).
  A public instance runs demo data only.
- The token is read-only and stays valid at api.monobank.ua until you issue a new one there. The app has no way to revoke it.

## Checked against api.monobank.ua (2026-11-03)

From the OpenAPI document published inside https://api.monobank.ua/docs/ (version v250818):

- `client-info` and `statement` are each limited to one request per 60 seconds. The spec does not say whether the two limits
  share one budget, so the scheduler treats them as separate and switches to one shared gate if a 429 shows otherwise.
- The statement endpoint accepts a jar id as well as a card id (`0` is the default account). Window: at most 31 days and one
  hour. The app treats a response of 500 rows as possibly cut short and asks for the rest of the window.
- `/bank/currency` is cached by the bank and refreshed at most every five minutes. A pair has a buy and sell rate, a cross
  rate, or both.
- Amounts are integer minor units. `commissionRate` and `cashbackAmount` are amounts in minor units, despite the first name.
- A webhook (`POST /personal/webhook`) is validated with a GET that must answer 200, then receives `StatementItem` events,
  retried after 60 s and 600 s and then disabled; it carries no signature. Not built here (it needs a public HTTPS address).

Against the live service, without any token (through the running app):

- The exchange rates the demo shows are the real ones from `/bank/currency`.
- A made-up token gets the real 403 from `client-info`; the app says "monobank does not recognise this token" and stores nothing.
  (The same 403 body was seen on 2026-10-28: `{"errorDescription":"Unknown 'X-Token'"}`.)

## Only your own token can check

- The field shapes of a real account. Unknown fields are ignored and optional ones may be missing; Copy diagnostics lists the
  field names and types that actually arrive, and any row that could not be read.
- That `balance` includes `creditLimit`. The spec is silent. The app assumes it (own funds = balance minus limit);
  `npm run doctor` and the diagnostics say where a credit card's balance sits against its limit, which you can compare with the
  monobank app.
- That a statement item's `balance` is the balance after that item (the spec only says "account balance"). The doctor and the
  diagnostics count how many consecutive items agree.
- The real body of a 429 (the app reacts to the status and waits `Retry-After` or 60 s), whether the two limits are shared,
  real latency, and how well the categoriser knows your merchants (it uses the merchant code first, then Ukrainian and Latin
  names).
- Foreign-currency purchases: `operationAmount` has no currency in the spec, so the app shows the amount in the account's
  currency.

How: START_HERE steps 4 to 9, and `MONOBANK_TOKEN=... npm run doctor` in your own terminal.

## PrivatBank

### Personal cards: no API, so a statement file

Checked against the real service on 2026-11-03: `POST https://api.privatbank.ua/p24api/rest_fiz` (the old personal-card API)
answers 200 with `<error>The service closed since 25.11.2022. For individuals we recommend using Privat24. For legal entities we
recommend using the "Autoclient" software ...</error>`. There is no live connection for a cardholder, so a personal card comes in
through a statement exported from Privat24 (Excel or CSV): Settings, Add a bank, **Privat24 file**.

**Not verified: the real export.** Nobody on this project has seen one. The importer is written from the layout it was described
with (a title row such as "Виписка з Ваших карток за період …", then Дата, Категорія, Картка, Опис операції, Сума в валюті картки,
Валюта картки, Сума в валюті транзакції, Валюта транзакції, Залишок на кінець періоду, Валюта залишку) and is built not to depend
on it: it finds the header row and the columns by their titles (Ukrainian, Russian or English), ignores the title row, and refuses
a file with the column titles it did find (never a value) when a date, a description or an amount column is missing. Things it
guesses and a real file can contradict: that spending is negative in the card-currency amount column (every amount with one sign is
refused); that `Залишок` is the card's balance at the end of the period; that the card cell holds at least the last four digits;
that times are Kyiv time; whether `.xlsx` dates are text or Excel dates (both are read). The files in `fixtures/privat24/` are
built from that description and named `unverified-`; `scripts/make-privat24-fixtures.ts` writes them.

### Business and ФОП accounts: Autoclient (live)

Checked against the real service on 2026-11-03, without a key: `GET https://acp.privatbank.ua/api/statements/settings` with a
junk `token` header answers 400 `{"status":"ERROR","code":"VE014","message":"Bad token format",...}`. So the service is up, and the
app turns that answer, through the running app too, into "PrivatBank does not recognise this token" and stores nothing.

From the published "Автоклієнт API v3.0.0" document (the statements part):

- Every request carries `User-Agent`, `token` and `Content-Type: application/json;charset=utf8` (cp1251 is assumed if the charset is
  missing). All statement calls are GET. The bank asks for **no more than one request a second**.
- `GET /api/statements/settings` says whether the bank is in its daily routine: `phase` other than `WRK`, or `work_balance` `Y`,
  means requests may fail. The app reports that as the bank being busy, in those words, and tries again.
- `GET /api/statements/balance` and `/transactions` take `acc` (an IBAN; none means every active account), `startDate` and `endDate`
  as `DD-MM-YYYY`, `limit` (default 20, at most 500, 100 recommended) and `followId`. A response with `exist_next_page: true` gives
  `next_page_id` for the next request. `/interim` variants cover the last operating day up to now (limit at most 100); `/final`
  variants the last closed day. Amounts are decimal strings.
- A transaction is unique by `REF` + `REFN`. `PR_PR` is `p` in progress, `r` posted, `t` reversed, `n` rejected; `TRANTYPE` is `D`
  or `C`; the time is `DATE_TIME_DAT_OD_TIM_P`. Newer items may carry `UETR` and `*_ULTMT_*` fields, which can hold a passport
  number: the app hides them in the Live API drawer and never reads them.
- A key can be restricted to "Отримання балансів і транзакцій за рахунками" (tab «Обмеження по сервісам»): START_HERE says to do
  that, so the key cannot make a payment. Group mode (група ПП) needs `?id=` on every call and is not supported (the app says so).

What the app does with it: the key is checked with `settings` and `balance/interim` (the balance now); history is read per account
in windows of at most 31 days through `transactions` (paged at 100) and, for the window that ends today, `transactions/interim`,
merged by `REF:REFN`. Reversed and rejected items and items with `FL_REAL` `i` are left out and counted in the diagnostics; an
item in progress is shown as Pending. There is no balance after each item, so the 30-day line is rebuilt from the balance now
and the items since. Foreign balances and items are valued at monobank's public exchange rates (`/bank/currency`, no token) for every
bank, so a PrivatBank-only setup still makes that one call to api.monobank.ua; the Live API drawer shows it. The business account's full name, IBAN and tax ids are not stored beyond the IBAN the bank needs to be asked
for the account (shown as its last four digits everywhere).

**Not verified, only your own key can:** the real shape of a balance and a transaction (Copy diagnostics lists field names and
types, and what was skipped); that `balanceOut` of `balance/interim` is the balance now; whether the interval statement
includes today or only closed days (the app asks both and merges, so either way works, but a payment made today that does not
appear would mean they disagree); what `FL_REAL` `i` means (the app treats it as "not real" and skips it; `npm run doctor:privat`
prints how many); the real body of a 429 and of a well-formed key the bank does not know (the app reacts to the status and to
`VE014`); how the bank behaves in its daily routine; the real latency. `PRIVATBANK_TOKEN=... npm run doctor:privat` in your own
terminal checks these and prints counts only.

## Wise

Not a Ukrainian bank, added because it is the one place with a self-serve personal API. Read from docs.wise.com on 2026-11-04 (version
2026Q4, `https://api.wise.com/2026Q4`):

- Auth is `Authorization: Bearer <token>`. Personal API tokens are documented for **business** accounts (Your account > Connect and
  manage apps > API tokens, 2-step login, shown once); no read-only token type is mentioned anywhere in the docs.
- Retrieving balance statements (and funding transfers) with a personal token is "not supported except for accounts based in the US,
  Canada, Australia, New Zealand, Singapore, and Malaysia", and the statement endpoint is SCA protected for every profile registered
  elsewhere: a 403 with `X-2FA-Approval` headers and a signed one-time-token retry. Ledger Lens does not implement that, so it reads
  **balances only** in the background: `GET /profiles` and `GET /profiles/{id}/balances?types=STANDARD,SAVINGS` (savings balances are
  jars).
- Draft transfers, when the person asks: `GET /accounts?profileId=` (saved recipients, 20 a page, `seekPositionForNext`),
  `POST /profiles/{id}/quotes`, `POST /transfers` (`targetAccount`, `quoteUuid`, `customerTransactionId` so a retry never duplicates,
  `details.reference`), `GET /transfers?profile=&status=incoming_payment_waiting`. Funding,
  `POST /profiles/{id}/transfers/{id}/payments`, is the call a personal token may not make outside those six countries, and the adapter
  has no such call. A created transfer's `sourceValue` reads 0 in Wise's sample, so the app shows the target amount. Wise says a
  transfer usually must be funded within fourteen days or it is cancelled. Some routes need `details.transferPurpose` and the like
  (`POST /transfer-requirements`); the app does not ask for those and shows Wise's refusal.
- Statements, for the record: `GET /profiles/{id}/balance-statements/{balanceId}/statement.json`, at most 469 days, signed amounts,
  a running balance. Not used. A 429 carries `Retry-After`; no numeric limit is documented.
- Checked against the real service without a token on 2026-11-04: a made-up Bearer token gets `401 {"error":"invalid_token"}` on both
  the versioned and the legacy paths, which the app shows as "Wise does not recognise this token".
- Wise balances are valued in hryvnias at monobank's public rates like every other bank, not at Wise's own rate (they differ a little).
- **Not verified:** whether the user's account type can create a token at all, what the token form offers, what `/profiles` returns, and every draft call: none has been sent to the real service.

## The other Ukrainian banks and open banking (read 2026-11-11)

Read from the web on 2026-11-11, mostly news reports and bank pages; bank.gov.ua refused the fetch, so nothing here is from the
National Bank's own text or its register. Nothing was tried against a real service.

**Open banking is live, and it is not for a personal app.** The rules (NBU Resolution No. 80) have been in force since 1 August 2025. An NBU official said in autumn 2026 that the APIs reach 97% of individuals' current accounts and 71% of companies', and that
about 90% of banks follow the shared Open API Group specification. So the banks are technically open, to authorised providers only:

- A reader of accounts (AISP) must be a **legal entity authorised by the NBU** and entered in the Register of Payment Infrastructure:
  a business plan, owners' and managers' reputation documents, audited IFRS statements, professional liability insurance, internal
  rules and information-security measures. There is no fixed minimum capital for account information alone (payment initiation: UAH 1
  million).
- Then a **qualified open banking certificate** (QWAC or e-seal), mainly from the NBU's own certification centre. Every bank checks
  the register and the certificate on each call (PrivatBank, UKRSIBBANK, Raiffeisen and ProCredit all say so on their TPP pages).
- Authorised so far, as reported in October 2026: four banks (PUMB, PrivatBank, monobank's Universal Bank, UKRSIBBANK), with three
  more banks applying, and two technology operators (UPC, TASLink). No independent fintech was named. Reports differ on the list.
- Sandboxes are open without authorisation (UKRSIBBANK says its one is free and needs no steps; Raiffeisen, ProCredit and UPC have
  developer portals). A sandbox returns made-up data: useful to write an adapter against, useless for the person's money.

So Ledger Lens cannot read "the rest of the banks" through open banking unless someone registers a company with the NBU, which is a
business decision, not a feature. There is also no sign yet of an authorised provider that resells access to small developers.

**What the person can use today without us:** an authorised bank's own app. Privat24 has "Відкритий банкінг" (add another bank's
account, see its balance and history; consent lasts 90 days), and PUMB launched the same in June 2026. That shows the accounts in the
bank's app; it gives Ledger Lens nothing to read.

**Bank by bank, what a customer can get for their own accounts** (the route this app uses for monobank and PrivatBank):

| Bank                                                               | For its own customer                                                                                                                                                                                                                                       | Fit for this app                                                                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| monobank                                                           | Personal token, self-serve                                                                                                                                                                                                                                 | Built                                                                                                             |
| PrivatBank                                                         | Business and ФОП: Autoclient key, self-serve. Personal: none                                                                                                                                                                                               | Built (plus the statement file)                                                                                   |
| Raiffeisen                                                         | Corporate "Open API": Account Balance and ISO Statement, OAuth 2.0, sandbox; a signed application, onboarding said to take a day. The page does not say whether a ФОП qualifies, or the price                                                              | Possible, after asking the bank                                                                                   |
| Ukreximbank                                                        | EXIM API through a personal manager: balances, movements, OAuth 2.0 with signed requests. For companies                                                                                                                                                    | Possible for a company client only                                                                                |
| NovaPay                                                            | ФОП account: a token made in the cabinet's API section (seen in an accounting service's instructions, not NovaPay's own page)                                                                                                                              | Likely possible; not checked                                                                                      |
| UKRSIBBANK                                                         | Sources disagree: one accounting vendor says there is no statement API for clients, another describes sending the bank an RSA key and getting a client id and secret. The bank's site shows only the TPP APIs. UKRSIB business exports statements as files | CSV statement import for the ФОП report (done 2026-11-11); the cabinet has no API or key section, so ask the bank |
| PUMB                                                               | A partner integration only (the Taxer accounting service reads ФОП statements with the client's consent). No customer token found                                                                                                                          | A statement file                                                                                                  |
| Oschadbank, OTP, A-Bank, Sense, Kredobank, Ukrgasbank and the rest | Nothing found beyond client-bank file exchange (DBF, CSV, XLS) with accounting programs                                                                                                                                                                    | A statement file                                                                                                  |

**What this means for the app:** the realistic way to cover the rest is the one already built for Privat24: a statement importer per
bank (`modules/imports`), each needing one real export from the person to get the column titles right. A live adapter is worth it only
where the bank gives its own customer a key: Raiffeisen and NovaPay are the candidates, and UKRSIBBANK if the bank confirms the key route.

Sources: https://news.finance.ua/ua/plyus-dlya-fintehu-ta-ryteylu-v-nbu-rozpovily-yak-vidkrytyy-bankinh-zminyuye-platizhnyy-rynok-ukrainy,
https://www.wolftheiss.com/insights/open-banking-in-ukraine-ais-pis-providers-and-their-regulatory-status/,
https://lb.ua/economics/2026/11/01/777336_usi_rahunki_zastosunku_scho.html,
https://privatbank.ua/handbook/openbanking-for-developers, https://ukrsibbank.com/open-banking/payment-initiation-service/,
https://raiffeisen.ua/en/aem/korporatyvnym-klientam/open-api.html, https://raiffeisen.ua/en/aem/tpp/open-banking.html,
https://procreditbank.com.ua/en/private/open-banking-tpp,
https://www.eximb.com/ua/business/corporate/corporate-dystancijne-bankivske-obslugovuvannya/exim-api-connection.html,
https://support.finmap.online/ua/integracziya-novapay-ta-finmap, https://help.torgsoft.ua/bankivski-vypysky-po-rahunkah.htm,
https://softup.com.ua/modul-obminu-ukrsibbank-ta-bas-1s/,
https://news.finance.ua/ua/pumb-i-takser-zapustyly-avtomatychnu-synhronizaciyu-vypysky-dlya-fop-menshe-rutyny-bil-she-chasu-na-biznes,
https://forbes.ua/news/pumb-pershim-v-ukraini-zapustiv-vidkritiy-banking-shcho-tse-dast-klientam-11062026-39551. Wise's own Open
Banking API is likewise for regulated providers (Open Banking Directory or eIDAS certificate).

## Other routes, not built

Ukraine's open-banking regime (NBU, since 1 August 2025) is for authorised third-party providers, so a personal project cannot
use it; monobank's corporate API needs an application to the bank. Another bank is a new adapter behind the `BankingProvider`
port in `apps/api/src/providers` (PrivatBank's is the second one), or a new file importer next to `privat24-statement.ts`.
