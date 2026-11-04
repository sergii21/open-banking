import { createServer } from 'node:http';
import { systemClock } from '../../../clock';
import { FAKE_WISE_TOKEN, FakeWise } from './fake';

/**
 * api.wise.com stand-in over HTTP: the app connects to it with WISE_API_URL=http://127.0.0.1:4312/2026Q4 and the fake token.
 * `npm run fake:wise`. Admin: POST /__admin/sca and /__admin/ok switch the strong-authentication answer on and off;
 * /__admin/down and /__admin/up simulate an outage.
 */
const port = Number(process.env['FAKE_WISE_PORT'] ?? 4312);
const intervalMs = Number(process.env['FAKE_WISE_INTERVAL_MS'] ?? 0);
const fake = new FakeWise({
  clock: systemClock,
  token: process.env['FAKE_WISE_TOKEN'] ?? FAKE_WISE_TOKEN,
  intervalMs: intervalMs > 0 ? intervalMs : null,
});

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  const admin = /^\/__admin\/(down|up|sca|ok)$/.exec(url.pathname);
  if (admin) {
    if (admin[1] === 'down' || admin[1] === 'up') fake.down = admin[1] === 'down';
    else fake.strongAuth = admin[1] === 'sca';
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
      'content-type': 'application/json; charset=utf-8',
      ...reply.headers,
    })
    .end(JSON.stringify(reply.body));
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`fake Wise on http://127.0.0.1:${port}/2026Q4, token: ${FAKE_WISE_TOKEN}\n`);
});
