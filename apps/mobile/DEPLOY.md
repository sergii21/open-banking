# Deploy guide: Ledger Lens on your iPhone, through TestFlight

Follow the steps in order. The app has **no server**: the phone reads monobank itself, keeps the token in its Keychain and
everything else in its own folder. So "deploying" is only this: build the app in the cloud, send it to Apple, install it from
TestFlight.

Builds run on **EAS (Expo Application Services)**. You need no Xcode and no Mac.

Every command below is run **in `apps/mobile`**, not in the repository root:

```bash
cd apps/mobile
```

The steps marked **you** need your own accounts and passwords. Nobody else can do them for you, and none of them belongs in
the repository or in a chat.

---

## 0. Accounts you need

| Account                 | Cost       | Link                                        |
| ----------------------- | ---------- | ------------------------------------------- |
| Expo account            | free       | https://expo.dev/signup                     |
| Apple Developer Program | $99 a year | https://developer.apple.com/programs/enroll |

If you already have these from Тривога Поруч, use the same ones. The free Expo plan includes a limited number of builds a
month; expo.dev shows how many are left under Billing.

On the computer: Node **24.15 or newer 24.x** (the repository's `.nvmrc`), then, once, from the repository root:

```bash
npm ci
```

---

## 1. Sign in to Expo (you)

```bash
npx eas-cli@latest login
```

```bash
npx eas-cli@latest whoami
```

---

## 2. Link the project to Expo (you, once)

```bash
npx eas-cli@latest init
```

This creates the project `ledger-lens` in your Expo account and writes two things into `app.json`: `extra.eas.projectId` and
`owner`. Neither is a secret (the project id is an address, not a key). Commit that change so the next build finds the
project:

```bash
git add app.json
```

```bash
git commit -m "Mobile: link the Expo project"
```

**The bundle identifier is `ua.ledgerlens.app`** (`app.json`, `ios.bundleIdentifier`), named the way Тривога Поруч is
(`ua.alertnearby.app`). If you want a different one, change it **now**: after the first upload to Apple it cannot change
without becoming a different app.

---

## 3. Build for the iPhone

```bash
npx eas-cli@latest build --platform ios --profile production
```

The first time, EAS asks you to sign in with your Apple ID (**you**; your password goes to Apple through the EAS CLI and is
not stored in the repository) and offers to create the distribution certificate and the provisioning profile. Say yes to
each. It also registers the bundle identifier with Apple.

EAS uploads the whole repository (the phone app uses code from the other folders) and installs it with Node 24.15, as
`eas.json` says. Expect roughly 15 to 30 minutes; the first build has not been timed. The command prints a link to its page on expo.dev; you can close the
terminal and come back to that page.

What the three profiles in `eas.json` are for:

| Profile       | What it makes                                                                           |
| ------------- | --------------------------------------------------------------------------------------- |
| `production`  | The build for TestFlight and the App Store. The build number goes up by itself.         |
| `preview`     | An installable build for phones registered with `eas device:create`, without TestFlight |
| `development` | The same as preview today; kept for a development client later                          |

Version numbers: `appVersionSource` is `remote`, so EAS keeps the build number and raises it on every production build
(`autoIncrement`). You only change `"version"` in `app.json` (1.0.0, 1.0.1, …) when you want a new visible version.

---

## 4. Send the build to Apple (you)

```bash
npx eas-cli@latest submit --platform ios --latest
```

The first time, EAS asks for your Apple ID again, creates the app in App Store Connect if it is not there (name: Ledger
Lens; the name must be free in the App Store, so it may ask for another) and offers to create an App Store Connect API key
for later uploads. Say yes.

The repository is public, so `eas.json` deliberately holds **no** Apple ID, team id or App Store Connect app id: EAS asks,
and remembers the answers in your Expo account, not in a file.

After the upload Apple processes the build for 5 to 20 minutes and emails you when it is ready.

---

## 5. Install it from TestFlight (you)

1. Open https://appstoreconnect.apple.com, **Apps**, **Ledger Lens**, **TestFlight**.
2. If the build shows **Missing Compliance**: the app already declares that it uses no encryption of its own
   (`usesNonExemptEncryption: false` in `app.json`; HTTPS and the Keychain are Apple's). If Apple still asks, answer
   **None of the algorithms mentioned above**.
3. **Internal Testing**, **+**, make a group, add yourself (your Apple ID is already a user of the account), add the build.
   Internal testers need **no review by Apple**.
4. On the iPhone install **TestFlight** from the App Store, sign in with the same Apple ID, and install Ledger Lens.

A TestFlight build works for **90 days**. To keep the app, build and submit again before then (step 7), or publish it to the
App Store (step 8).

---

## 6. First run on the phone

1. Open **Settings** in the app and choose **Try with made-up data**. Look at Money and Transactions, try the search. No
   bank is contacted.
2. **Pay**: copy an invoice text, **Paste from the clipboard**, check the fields, **Open in a bank app**. You confirm in the
   bank's app; Ledger Lens sends nothing.
3. **ФОП**: export the CSV from UKRSIB business, save it to Files on the phone, **Add UKRSIB statements (CSV)**.
4. When you are ready for real data: **Settings**, **Leave the demo**, then issue a token at https://api.monobank.ua and
   paste it. Balances appear at once; three months of history come one read a minute while the app is open.

Please write down what does not match (see "What has not been tried" below): this build has never run on a real iPhone.

---

## 7. Shipping an update

1. Change the code. For a new visible version, raise `"version"` in `app.json`.
2. From the repository root: `npm run verify` (it runs the phone's typecheck and tests too).
3. In `apps/mobile`:

```bash
npm run build:ios
```

```bash
npm run submit:ios
```

4. In App Store Connect, TestFlight, the new build appears in your internal group by itself.

---

## 8. Publishing to the App Store (optional, later)

TestFlight is enough for your own phone. If you ever want the app in the App Store:

1. **App Privacy**: _Data Not Collected_. Nothing leaves the phone except requests to monobank, with your own token.
2. A privacy-policy page at a public address (GitHub Pages works, as in Тривога Поруч).
3. **App Review notes**: the reviewer has no monobank account, so say: _"Open Settings and tap 'Try with made-up data' to
   see the app with sample accounts. The app reads the user's own bank accounts with a personal read-only token they issue
   themselves; it initiates no payments."_
4. Screenshots for a 6.9" iPhone, a description, a support address.

Apple reviews finance apps more closely and may ask who you are in relation to the bank. That is a decision for then, not
part of this guide.

---

## What has not been tried

Said plainly, so nothing here is taken as checked when it is not:

- **No EAS build has been run** and nothing has been uploaded to TestFlight: those need your accounts. What was run: the
  unit tests, `tsc`, `expo-doctor`, and Metro bundling the iOS JavaScript (`npx expo export --platform ios`).
- **The app has never run on an iPhone or a simulator.** The screens have not been looked at; expect layout fixes.
- **No real monobank token** has been used from the phone build. The reading code is the server's adapter, tested here
  against the paced fake bank.
- On the phone's JavaScript engine (Hermes) these are assumed, not checked: that dates work in the Europe/Kyiv time zone
  through `Intl.DateTimeFormat`, and that the Files picker hands over a UKRSIB CSV as bytes.
- Whether "Open in a bank app" offers your bank for a `qr.bank.gov.ua` link on your phone. No bank app has opened one from
  this app (the same is unverified in the web app).

---

## Checklist

- [ ] `npx eas-cli@latest login`
- [ ] `npx eas-cli@latest init`, and the `app.json` change committed
- [x] Bundle identifier set (`ua.ledgerlens.app`); change it before the first upload or never
- [ ] `npx eas-cli@latest build --platform ios --profile production`
- [ ] `npx eas-cli@latest submit --platform ios --latest`
- [ ] Internal testing group in TestFlight, build added
- [ ] Installed from TestFlight; demo, Pay, ФОП and monobank tried
