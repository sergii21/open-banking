import type { App } from '../../types';
import type { Transport } from '../transport';

/** Virtual hosts the mock adapter "calls". They never resolve: the transport routes them in-process. */
export const MOCK_AUTH_ORIGIN = 'https://auth.mockbank.example';
export const MOCK_API_ORIGIN = 'https://api.mockbank.example';

const ROUTES: Record<string, string> = {
  'auth.mockbank.example': '/mock-bank/auth',
  'api.mockbank.example': '/mock-bank/api',
};

type InjectMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Delivers the mock adapter's HTTP requests to the mock bank routes inside this process (light-my-request), so
 * there is no port to know about and the full HTTP semantics (status, headers, body) still apply.
 */
export function createMockTransport(app: App): Transport {
  return async (url, init) => {
    const target = new URL(url);
    const prefix = ROUTES[target.hostname];
    if (!prefix)
      throw new TypeError(`The mock transport does not know the host ${target.hostname}`);

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    const response = await app.inject({
      method: (init.method ?? 'GET') as InjectMethod,
      url: `${prefix}${target.pathname}${target.search}`,
      headers,
      ...(typeof init.body === 'string' ? { payload: init.body } : {}),
    });

    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') responseHeaders.set(name, value);
    }
    const noBody = response.statusCode === 204 || response.statusCode === 304;
    return new Response(noBody ? null : response.body, {
      status: response.statusCode,
      headers: responseHeaders,
    });
  };
}
