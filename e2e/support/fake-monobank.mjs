// A stand-in for api.monobank.ua used only by the Playwright run: the real service needs a real person's token and allows
// one statement a minute. It speaks the same wire format, so the app talks to it exactly as it talks to the bank.
import { createServer } from 'node:http';

const PORT = Number(process.env.FAKE_MONOBANK_PORT ?? 4310);
export const TOKEN_ONE = 'e2e-monobank-token-0001';
export const TOKEN_TWO = 'e2e-monobank-token-0002';

let validTokens = new Set([TOKEN_ONE, TOKEN_TWO]);

const clientInfo = {
  clientId: 'e2eClient01',
  name: 'E2E Customer',
  permissions: 'psfj',
  accounts: [
    {
      id: 'e2e-card-1',
      sendId: 'e2esend001',
      currencyCode: 980,
      cashbackType: 'UAH',
      balance: 1050000,
      creditLimit: 0,
      maskedPan: ['537541******1234'],
      type: 'black',
      iban: 'UA733220010000026201234567890',
    },
    {
      id: 'e2e-card-2',
      sendId: 'e2esend002',
      currencyCode: 980,
      cashbackType: 'UAH',
      balance: 2500000,
      creditLimit: 3000000,
      maskedPan: ['444111******9876'],
      type: 'platinum',
      iban: 'UA213220010000026207654321098',
    },
    {
      id: 'e2e-card-3',
      sendId: 'e2esend003',
      currencyCode: 840,
      cashbackType: 'None',
      balance: 120050,
      creditLimit: 0,
      maskedPan: ['537541******5678'],
      type: 'black',
      iban: 'UA453220010000026201122334455',
    },
  ],
  jars: [
    {
      id: 'e2e-jar-1',
      sendId: 'e2esend004',
      title: 'На відпустку',
      description: 'Літо',
      currencyCode: 980,
      balance: 4500000,
      goal: 10000000,
    },
  ],
};

const row = (id, ago, description, amount, mcc, hold = false) => ({
  id,
  time: Math.floor(Date.now() / 1000) - ago,
  description,
  mcc,
  originalMcc: mcc,
  hold,
  amount,
  operationAmount: amount,
  currencyCode: 980,
  commissionRate: 0,
  cashbackAmount: 0,
  balance: 1050000,
});

const statementFor = (account) =>
  account === 'e2e-card-1'
    ? [
        row('e2e-hold-1', 600, 'Uklon', -8900, 4121, true),
        row('e2e-silpo-1', 86_400, 'Сільпо', -45620, 5411),
        row('e2e-salary-1', 3 * 86_400, 'Зарплата', 4500000, 4829),
      ]
    : [];

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') return send(res, 200, { ok: true });
  // Test control: make every token stop working, as if the customer revoked it at monobank.
  if (req.method === 'POST' && url.pathname === '/__revoke') {
    validTokens = new Set([TOKEN_TWO]);
    return send(res, 200, { revoked: TOKEN_ONE });
  }
  if (req.method === 'POST' && url.pathname === '/__reset') {
    validTokens = new Set([TOKEN_ONE, TOKEN_TWO]);
    return send(res, 200, { reset: true });
  }
  if (!validTokens.has(String(req.headers['x-token'] ?? ''))) {
    return send(res, 403, { errorDescription: "Unknown 'X-Token'" });
  }
  if (url.pathname === '/personal/client-info') return send(res, 200, clientInfo);
  const statement = /^\/personal\/statement\/([^/]+)\/\d+\/\d+$/.exec(url.pathname);
  if (statement) return send(res, 200, statementFor(decodeURIComponent(statement[1])));
  return send(res, 404, { errorDescription: 'not found' });
}).listen(PORT, '127.0.0.1');
