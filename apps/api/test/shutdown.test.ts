import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers';

/** An open tab, as far as the server can tell: a session, and its event stream held open over a real socket. */
async function openTab(base: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const session = await fetch(`${base}/api/session`);
  const cookie = session.headers
    .getSetCookie()
    .map((raw) => raw.split(';')[0])
    .join('; ');
  const events = await fetch(`${base}/api/events`, { headers: { cookie } });
  expect(events.status).toBe(200);
  const stream = events.body;
  if (!stream) throw new Error('the event stream has no body');
  const reader = stream.getReader();
  await reader.read(); // The stream's first bytes: the server now holds it open.
  return reader;
}

async function untilEnded(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

const within = <T>(ms: number, work: Promise<T>): Promise<T | 'still waiting'> =>
  Promise.race([
    work,
    new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), ms)),
  ]);

describe('shutting down', () => {
  it('does not wait for the tabs that are open', async () => {
    const t = await createTestApp();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = t.app.server.address() as AddressInfo;
    const tabs = [
      await openTab(`http://127.0.0.1:${port}`),
      await openTab(`http://127.0.0.1:${port}`),
    ];

    expect(await within(3_000, t.app.close())).not.toBe('still waiting');

    // Each tab sees its stream end, and its EventSource reconnects by itself once the app is back.
    for (const tab of tabs) expect(await within(3_000, untilEnded(tab))).toBeUndefined();
    t.db.close();
  });
});
