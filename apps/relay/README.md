# The family relay

Where the phones of one family leave their month's totals for each other. It is a letterbox: what it keeps was
encrypted on the phone with a key the relay never sees, and it hands the same bytes back to whoever holds the family's
access key.

## What it keeps

| Kept                                                            | Never sent to it                                       |
| --------------------------------------------------------------- | ------------------------------------------------------ |
| A family id (random-looking, derived from the family's secret)  | The family secret and the encryption key               |
| The SHA-256 of the family's access key                          | A bank token (the relay client cannot reach one)       |
| Per person: an id, the time of the last write, the sealed bytes | Names, amounts, categories, transactions, in the clear |

It logs nothing after the line it prints at start. A summary nobody renewed for 90 days is removed, and a family with
no summaries left goes with it.

## The protocol

Every call carries `Authorization: Bearer <access key>` (43 base64url characters).

| Call                                            | What it does                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PUT /v1/families/{family}/members/{member}`    | Stores the body (1 byte to 32 KiB). The first one creates the family and fixes its key   |
| `GET /v1/families/{family}`                     | `{ now, members: [{ id, updatedAt, blob }] }`, `blob` in base64. 404 for a wrong key too |
| `DELETE /v1/families/{family}/members/{member}` | Removes one person's summary; the family goes with its last                              |
| `GET /health`                                   | `{ "ok": true }`                                                                         |

Limits: 8 people a family, 60 requests a minute per client address, 20 000 families.

## Running it

```bash
npm run start -w @ledger-lens/relay
```

`PORT` (8787), `HOST` (127.0.0.1), `DATABASE_PATH` (`./relay.db`), `TRUST_PROXY=1` behind a proxy that sets
`X-Forwarded-For`. The phone only talks to a relay over **HTTPS**, so it needs a host or a proxy that terminates TLS.
`src/relay.ts` is written against the web's `Request` and `Response` with storage passed in, so it can be moved to
another runtime by writing a store for it.

## On Cloudflare

`src/worker.ts` is the same relay as a Cloudflare Worker with D1 for storage (`src/d1-store.ts`, `wrangler.toml`). From this
folder, signed in with `npx wrangler login`: `npx wrangler d1 create ledger-lens-relay`, put the id it prints into
`wrangler.toml`, then `npx wrangler deploy`. The tables are made on the first request.

## What is and is not verified

`npm test -w @ledger-lens/relay`: the rules above, on the in-memory store, on SQLite and on the D1 store (over Node's SQLite, not on Cloudflare). The phone app's tests run two
phones against this relay in-process and check that nothing readable reaches it. **Not done:** it has not been hosted
anywhere, and no real phone has talked to it.
