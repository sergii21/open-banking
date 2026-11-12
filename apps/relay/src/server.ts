import { createServer, type IncomingMessage } from 'node:http';
import { LIMITS, Relay } from './relay';
import { SqliteRelayStore } from './sqlite-store';

/**
 * The relay under Node: one process, one SQLite file. Put it behind HTTPS (the phone refuses anything else).
 *
 *   PORT (8787), HOST (127.0.0.1), DATABASE_PATH (./relay.db)
 *   TRUST_PROXY=1 when a proxy in front sets X-Forwarded-For: the request limit is then counted per forwarded address.
 *
 * It writes one line when it starts and nothing after: no address, family id or request is logged.
 */
const env = process.env;
const port = Number(env['PORT'] ?? 8787);
const host = env['HOST'] ?? '127.0.0.1';
const trustProxy = env['TRUST_PROXY'] === '1';
const store = new SqliteRelayStore(env['DATABASE_PATH'] ?? './relay.db');
const relay = new Relay({ store, now: () => Date.now() });

/** The body, or null when it is longer than a sealed summary may be. */
async function readBody(request: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > LIMITS.maxBlobBytes) return null;
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

const server = createServer((incoming, outgoing) => {
  void (async () => {
    const method = incoming.method ?? 'GET';
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(incoming);
    if (body === null) {
      outgoing.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"too-large"}');
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string' && name !== 'content-length') headers.set(name, value);
    }
    const forwarded = trustProxy ? incoming.headers['x-forwarded-for'] : undefined;
    const client =
      (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ||
      incoming.socket.remoteAddress ||
      'unknown';
    const response = await relay.handle(
      new Request(`http://relay${incoming.url ?? '/'}`, { method, headers, body }),
      client,
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  })().catch(() => {
    if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json' });
    outgoing.end('{"error":"failed"}');
  });
});

server.listen(port, host, () => {
  process.stdout.write(`Family relay listening on http://${host}:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
