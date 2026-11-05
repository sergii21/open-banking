import type { OutgoingHttpHeaders } from 'node:http';
import type { ServerEvent } from '@ledger-lens/contracts';
import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';

const HEARTBEAT_MS = 20_000;

export function registerEventRoutes(api: App, ctx: AppContext): void {
  const open = new Set<() => void>();

  // A stream never ends by itself, so an open tab would keep the server from closing. The browser reconnects when the app is back.
  api.addHook('preClose', (done) => {
    for (const end of open) end();
    done();
  });

  /** Server-sent events for this session: inspector calls, connection changes, payment status. */
  api.get('/events', (request, reply) => {
    const session = requireSession(request);

    reply.hijack();
    const raw = reply.raw;
    // Keep the security headers helmet already set on this reply (hijacking skips the normal send path).
    const headers = { ...reply.getHeaders() } as OutgoingHttpHeaders;
    headers['content-type'] = 'text/event-stream; charset=utf-8';
    headers['cache-control'] = 'no-cache, no-transform';
    headers['connection'] = 'keep-alive';
    headers['x-accel-buffering'] = 'no';
    raw.writeHead(200, headers);
    raw.write('retry: 3000\n\n: connected\n\n');

    const send = (event: ServerEvent): void => {
      raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = ctx.events.subscribe(session.id, send);
    const heartbeat = setInterval(() => raw.write(': keep-alive\n\n'), HEARTBEAT_MS);
    heartbeat.unref();

    const stop = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(end);
    };
    const end = (): void => {
      stop(); // First, so nothing writes to a stream that has ended.
      raw.end();
    };
    open.add(end);
    request.raw.on('close', stop);
  });
}
