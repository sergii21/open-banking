# monobank fixtures

`client-info.json` and `statement-*.json` follow monobank's published personal-API reference
(https://api.monobank.ua/docs/); the values are made up. They are **not recorded from a real account**.

`unknown-token.json` **was recorded from the live service** on 2026-10-28 by calling `GET /personal/client-info` with a dummy
token: HTTP 403 and exactly that body. The same live call is repeated by `npm run test:live -w @ledger-lens/api`, which also
reads a real account when you export your own token (`MONOBANK_TOKEN`) in your shell.
