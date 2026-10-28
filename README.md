# Ledger Lens

An Open Banking proof of concept: a personal-finance app that connects a bank (account information) and sends a payment
you approve inside your bank (payment initiation), with an **API Inspector** that shows the real provider calls behind
each screen.

> Status: milestone M0 (foundations). The product arrives milestone by milestone; see [`docs/PLAN.md`](docs/PLAN.md).

## Quick start

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"   # Node ^24.15.0 (see .nvmrc)
npm ci
npm run dev        # API :3000 + SPA :4200 (proxied)  ->  http://localhost:4200
npm run verify     # lint, format, typecheck, unit tests, production build
npm run e2e        # build + Playwright against the mock bank
```

The full README (architecture, regulatory model, demo script) lands in milestone M5.
