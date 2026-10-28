import type { FastifyServerOptions } from 'fastify';
import type { AppConfig } from './config';

/**
 * Paths whose values must never reach a log line. Request URLs are logged without their query string
 * (OAuth callbacks carry `code` and `state` there), and no request or response bodies are logged at all.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.access_token',
  '*.refresh_token',
  '*.client_secret',
  '*.code_verifier',
  '*.resource_token',
  '*.iban',
  '*.accountNumber',
];

export function stripQuery(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

export function loggerOptions(config: AppConfig): FastifyServerOptions['logger'] {
  if (config.logLevel === 'silent') return false;
  return {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      req(request: { method?: string; url?: string; hostname?: string; ip?: string }) {
        return {
          method: request.method,
          url: stripQuery(request.url ?? ''),
          host: request.hostname,
          remoteAddress: request.ip,
        };
      },
    },
    ...(config.env === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}
