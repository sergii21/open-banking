import { Service } from '@angular/core';
import type { Problem } from '@ledger-lens/contracts';

/** What the server (or the network) said went wrong, in a shape the screens can react to. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly fields: readonly { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The server cannot be reached at all: it is not running, or the network is down. */
  get offline(): boolean {
    return this.status === 0;
  }
}

const xsrf = (): string => {
  const match = /(?:^|; )XSRF-TOKEN=([^;]+)/.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
};

/** The only way the app talks to the server: same origin, cookie session, CSRF header echoed on writes. */
@Service()
export class Api {
  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(method === 'GET' ? {} : { 'x-xsrf-token': xsrf() }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(0, 'offline', 'Ledger Lens cannot be reached.');
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const problem = json as Partial<Problem> | undefined;
      throw new ApiError(
        response.status,
        problem?.code ?? 'error',
        problem?.detail ?? problem?.title ?? `The server answered ${response.status}.`,
        problem?.retryAfterSeconds,
        problem?.errors,
      );
    }
    return json as T;
  }

  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>('GET', path, undefined, signal);
  }
  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
  delete(path: string): Promise<void> {
    return this.request<void>('DELETE', path);
  }
}
