import { createServer } from 'node:http';
import { systemClock } from '../../../clock';
import { Calendar } from '../../../domain/calendar';
import { FAKE_PRIVAT_TOKEN, FakeAutoclient } from './fake';

/**
 * acp.privatbank.ua stand-in over HTTP, for runs where the real pacing matters: the app connects to it with
 * PRIVATBANK_API_URL=http://127.0.0.1:4311 and the fake key, and it answers 429 to a second request inside the interval just
 * like the real one is asked to. `npm run fake:privatbank`.
 * Admin: POST /__admin/routine and /__admin/work switch the bank's daily routine on and off; /__admin/down and /__admin/up
 * simulate an outage.
 */
const port = Number(process.env['FAKE_PRIVATBANK_PORT'] ?? 4311);
const intervalMs = Number(process.env['FAKE_PRIVATBANK_INTERVAL_MS'] ?? 1000);

const fake = new FakeAutoclient({
  clock: systemClock,
  calendar: new Calendar(process.env['TIME_ZONE'] ?? 'Europe/Kyiv'),
  token: process.env['FAKE_PRIVATBANK_TOKEN'] ?? FAKE_PRIVAT_TOKEN,
  intervalMs: intervalMs > 0 ? intervalMs : null,
});

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  const admin = /^\/__admin\/(down|up|routine|work)$/.exec(url.pathname);
  if (admin) {
    if (admin[1] === 'down' || admin[1] === 'up') fake.down = admin[1] === 'down';
    else fake.routine = admin[1] === 'routine';
    response.writeHead(200, { 'content-type': 'text/plain' }).end(admin[1]);
    return;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers[name] = value;
  }
  const reply = fake.handle(request.method ?? 'GET', url.pathname, url.searchParams, headers);
  response
    .writeHead(reply.status, {
      'content-type': 'application/json;charset=UTF-8',
      ...reply.headers,
    })
    .end(JSON.stringify(reply.body));
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(
    `fake PrivatBank Autoclient on http://127.0.0.1:${port} (one request per ${intervalMs || '0 = unlimited'} ms), key: ${FAKE_PRIVAT_TOKEN}\n`,
  );
});
