import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { systemClock } from '../../../clock';
import { FAKE_WISE_TOKEN, FakeWise } from './fake';

/**
 * api.wise.com stand-in over HTTP: the app connects to it with WISE_API_URL=http://127.0.0.1:4312/2026Q4 and the fake token.
 * `npm run fake:wise`. Admin: POST /__admin/sca and /__admin/ok switch the strong-authentication answer on and off;
 * /__admin/down and /__admin/up simulate an outage; /__admin/readonly makes quotes and transfers answer a plain 403, and
 * /__admin/ok undoes it. GET /__admin/log lists what was sent (method and path only), so a test can see no payment was.
 */
const port = Number(process.env['FAKE_WISE_PORT'] ?? 4312);
const intervalMs = Number(process.env['FAKE_WISE_INTERVAL_MS'] ?? 0);
const fake = new FakeWise({
  clock: systemClock,
  token: process.env['FAKE_WISE_TOKEN'] ?? FAKE_WISE_TOKEN,
  intervalMs: intervalMs > 0 ? intervalMs : null,
});

const answer = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (url.pathname === '/__admin/log') {
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(fake.requests.map((r) => `${r.method} ${r.path}`)));
    return;
  }
  const admin = /^\/__admin\/(down|up|sca|ok|readonly)$/.exec(url.pathname);
  if (admin) {
    if (admin[1] === 'down' || admin[1] === 'up') fake.down = admin[1] === 'down';
    else if (admin[1] === 'readonly') fake.writesForbidden = true;
    else {
      fake.strongAuth = admin[1] === 'sca';
      fake.writesForbidden = false;
    }
    response.writeHead(200, { 'content-type': 'text/plain' }).end(admin[1]);
    return;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers[name] = value;
  }
  let raw = '';
  for await (const chunk of request) raw += String(chunk);
  const reply = fake.handle(
    request.method ?? 'GET',
    url.pathname,
    url.searchParams,
    headers,
    raw ? (JSON.parse(raw) as unknown) : undefined,
  );
  response
    .writeHead(reply.status, {
      'content-type': 'application/json; charset=utf-8',
      ...reply.headers,
    })
    .end(JSON.stringify(reply.body));
};

createServer((request, response) => {
  void answer(request, response);
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`fake Wise on http://127.0.0.1:${port}/2026Q4, token: ${FAKE_WISE_TOKEN}\n`);
});
