import { AppError } from '@api/errors';
import { PhoneHttp, type Wire } from '../src/bank/http';

const CTX = { sessionId: 'phone', connectionId: null };
const ORIGIN = 'https://api.monobank.ua';
const SECRET = 'uSecretTokenThatMustNeverShowUp1234567890';

const answering =
  (status: number, text: string, seen: unknown[] = []): Wire =>
  (url, init) => {
    seen.push({ url, init });
    return Promise.resolve({
      status,
      headers: { get: (name) => (name === 'retry-after' ? '42' : null) },
      text: () => Promise.resolve(text),
    });
  };

describe('the phone’s bank HTTP', () => {
  it('sends a GET with the headers it was given and parses the JSON', async () => {
    const seen: { url: string; init: { method: string; headers: Record<string, string> } }[] = [];
    const http = new PhoneHttp(answering(200, '{"ok":true}', seen), ORIGIN);
    const result = await http.request(CTX, {
      label: 'x',
      method: 'GET',
      url: `${ORIGIN}/personal/client-info`,
      headers: { 'x-token': SECRET },
    });
    expect(result).toMatchObject({ status: 200, ok: true, body: { ok: true } });
    expect(result.headers['retry-after']).toBe('42');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.init.method).toBe('GET');
    expect(seen[0]?.init.headers['x-token']).toBe(SECRET);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    'refuses a %s before anything is sent',
    async (method) => {
      const seen: unknown[] = [];
      const http = new PhoneHttp(answering(200, '{}', seen), ORIGIN);
      await expect(
        http.request(CTX, { label: 'x', method, url: `${ORIGIN}/personal/anything` }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect(seen).toHaveLength(0);
    },
  );

  it('refuses a GET with a body', async () => {
    const http = new PhoneHttp(answering(200, '{}'), ORIGIN);
    await expect(
      http.request(CTX, { label: 'x', method: 'GET', url: `${ORIGIN}/a`, json: { a: 1 } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('never sends the token to another address', async () => {
    const seen: unknown[] = [];
    const http = new PhoneHttp(answering(200, '{}', seen), ORIGIN);
    for (const url of [
      'https://api.monobank.ua.evil.example/personal/client-info',
      'http://api.monobank.ua/personal/client-info',
      'https://example.com/',
    ]) {
      await expect(
        http.request(CTX, { label: 'x', method: 'GET', url, headers: { 'x-token': SECRET } }),
      ).rejects.toBeInstanceOf(AppError);
    }
    expect(seen).toHaveLength(0);
  });

  it('a network failure is reported in words with no token and no address in them', async () => {
    const failing: Wire = (url, init) =>
      Promise.reject(new Error(`connect failed ${url} ${JSON.stringify(init.headers)}`));
    const http = new PhoneHttp(failing, ORIGIN);
    const error = await http
      .request(CTX, {
        label: 'x',
        method: 'GET',
        url: `${ORIGIN}/personal/client-info`,
        headers: { 'x-token': SECRET },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    const shown = `${(error as AppError).message} ${String((error as AppError).cause)} ${(error as Error).stack}`;
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toContain('monobank.ua');
    expect((error as AppError).code).toBe('bank_unavailable');
  });

  it('gives up on a bank that does not answer in time', async () => {
    const hanging: Wire = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const http = new PhoneHttp(hanging, ORIGIN);
    await expect(
      http.request(CTX, { label: 'x', method: 'GET', url: `${ORIGIN}/a`, timeoutMs: 20 }),
    ).rejects.toMatchObject({
      code: 'bank_unavailable',
      message: 'The bank did not answer in time.',
    });
  });
});
