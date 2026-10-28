import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, newClient, type Client, type TestApp } from './helpers';

let t: TestApp;
const openStreams: { close(): void }[] = [];

afterEach(async () => {
  for (const stream of openStreams.splice(0)) stream.close();
  await t.close();
});

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function openStream(client: Client, port: number) {
  const controller = new AbortController();
  const cookie = [...client.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
    headers: { cookie },
    signal: controller.signal,
  });
  let text = '';
  const reader = response.body?.getReader();
  void (async () => {
    const decoder = new TextDecoder();
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  })().catch(() => undefined);
  const stream = { response, text: () => text, close: () => controller.abort() };
  openStreams.push(stream);
  return stream;
}

describe('server-sent events', () => {
  it('rejects anonymous callers with a problem document', async () => {
    t = await createTestApp();
    const response = await t.app.inject({ method: 'GET', url: '/api/events' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'session_required' });
  });

  it('streams a session’s inspector and connection events, and only to that session', async () => {
    t = await createTestApp();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as AddressInfo).port;

    const owner = await newClient(t);
    const stranger = await newClient(t);
    const ownerStream = await openStream(owner, port);
    const strangerStream = await openStream(stranger, port);

    expect(ownerStream.response.status).toBe(200);
    expect(ownerStream.response.headers.get('content-type')).toContain('text/event-stream');
    expect(ownerStream.response.headers.get('cache-control')).toContain('no-cache');
    expect(ownerStream.response.headers.get('content-security-policy')).toContain(
      "default-src 'self'",
    );
    await waitUntil(() => ownerStream.text().includes(': connected'));

    await owner.connectBank();
    await waitUntil(() => ownerStream.text().includes('event: connection.updated'));

    const events = [...ownerStream.text().matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events).toContain('inspector.call');
    expect(events).toContain('connection.updated');

    const data = /event: connection\.updated\ndata: (.+)\n/.exec(ownerStream.text())?.[1] ?? '';
    expect(JSON.parse(data)).toMatchObject({
      type: 'connection.updated',
      connection: { institutionName: 'Mock Bank', status: 'active' },
    });
    expect(ownerStream.text()).not.toContain('mbk_at_');

    // The other session saw nothing but its own handshake.
    expect(strangerStream.text()).not.toContain('event:');
  });

  it('releases the subscription when the browser disconnects', async () => {
    t = await createTestApp();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as AddressInfo).port;
    const client = await newClient(t);
    const sessionId = t.db.get<{ id: string }>('SELECT id FROM sessions')?.id as string;

    const stream = await openStream(client, port);
    await waitUntil(() => t.ctx.events.subscriberCount(sessionId) === 1);
    stream.close();
    await waitUntil(() => t.ctx.events.subscriberCount(sessionId) === 0);
  });
});
