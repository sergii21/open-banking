import { createServer } from 'node:http';
import { systemClock } from '../../../clock';
import { Calendar } from '../../../domain/calendar';
import { DEMO_TOKEN, FakeMonobank } from './fake';

/**
 * api.monobank.ua stand-in over HTTP, for runs where the real pacing matters: the app connects to it with
 * MONOBANK_API_URL=http://127.0.0.1:4310 and the demo token, and it answers 429 to a second read inside the interval just
 * like the real one. `npm run fake:monobank`. Admin: POST /__admin/down and /__admin/up simulate an outage.
 */
const port = Number(process.env['FAKE_MONOBANK_PORT'] ?? 4310);
const intervalSeconds = Number(process.env['FAKE_MONOBANK_INTERVAL_SECONDS'] ?? 60);

const fake = new FakeMonobank({
  clock: systemClock,
  calendar: new Calendar(process.env['TIME_ZONE'] ?? 'Europe/Kyiv'),
  token: process.env['FAKE_MONOBANK_TOKEN'] ?? DEMO_TOKEN,
  limits:
    intervalSeconds > 0
      ? { statementMs: intervalSeconds * 1000, infoMs: intervalSeconds * 1000 }
      : null,
});

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (url.pathname === '/__admin/down' || url.pathname === '/__admin/up') {
    fake.down = url.pathname.endsWith('down');
    response.writeHead(200, { 'content-type': 'text/plain' }).end(fake.down ? 'down' : 'up');
    return;
  }
  const token = request.headers['x-token'];
  const reply = fake.handle(
    request.method ?? 'GET',
    url.pathname,
    typeof token === 'string' ? token : undefined,
  );
  response
    .writeHead(reply.status, {
      'content-type': 'application/json; charset=utf-8',
      ...reply.headers,
    })
    .end(JSON.stringify(reply.body));
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(
    `fake monobank on http://127.0.0.1:${port} (one read per ${intervalSeconds || '0 = unlimited'} s), token: ${DEMO_TOKEN}\n`,
  );
});
