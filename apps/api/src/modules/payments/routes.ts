import {
  CreatePaymentRequest,
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  Id,
  Payment,
  PaymentList,
  ProviderId,
  WebhookAck,
} from '@ledger-lens/contracts';
import * as z from 'zod';
import { AppError } from '../../errors';
import { stripQuery } from '../../logging';
import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';

export function registerPaymentRoutes(api: App, ctx: AppContext): void {
  const perSession = (max: number) => ({
    max,
    timeWindow: '1 minute',
    keyGenerator: (r: { cookies: Record<string, string | undefined>; ip: string }) =>
      r.cookies[ctx.sessions.cookieName] ?? r.ip,
  });

  api.get('/payments', { schema: { response: { 200: PaymentList } } }, (request) => ({
    items: ctx.payments.list(requireSession(request).id),
  }));

  api.post(
    '/payments',
    {
      // Each call can move (simulated) money, so cap it per browser session.
      config: { rateLimit: perSession(10) },
      schema: { body: CreatePaymentRequest, response: { 200: Payment, 201: Payment } },
    },
    async (request, reply) => {
      const session = requireSession(request);
      const header = request.headers[IDEMPOTENCY_HEADER];
      if (typeof header !== 'string' || header.length === 0) {
        throw new AppError(
          'idempotency_key_required',
          400,
          'Send an Idempotency-Key header with a fresh value for each payment attempt.',
        );
      }
      const key = IdempotencyKey.safeParse(header);
      if (!key.success) {
        throw new AppError('validation_failed', 400, key.error.issues[0]?.message, {
          errors: [{ path: 'Idempotency-Key', message: key.error.issues[0]?.message ?? 'Invalid' }],
        });
      }

      const { payment, replayed } = await ctx.payments.create(
        session.id,
        key.data,
        request.body,
        request.ip,
      );
      // Same key, same request: the answer to the first call, flagged so a client can tell it is not a new payment.
      if (replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(replayed ? 200 : 201).send(payment);
    },
  );

  /**
   * Where the bank sends the browser back. Public on purpose: the customer arrives from another site, so the session
   * cookie may not be sent, and the payment is found by the provider's own (unguessable) id.
   */
  api.get(
    '/payments/return',
    { config: { public: true }, schema: { querystring: z.record(z.string(), z.string()) } },
    async (request, reply) => {
      const path = await ctx.payments.handleReturn(request.query, request.ip);
      return reply.header('cache-control', 'no-store').redirect(path, 302);
    },
  );

  api.get(
    '/payments/:id',
    { schema: { params: z.object({ id: Id }), response: { 200: Payment } } },
    (request) => {
      const session = requireSession(request);
      return ctx.payments.toDto(ctx.payments.get(session.id, request.params.id));
    },
  );

  /** "Check now": ask the bank where the payment stands instead of waiting for its webhook. */
  api.post(
    '/payments/:id/sync',
    {
      config: { rateLimit: perSession(30) },
      schema: { params: z.object({ id: Id }), response: { 200: Payment } },
    },
    (request) => ctx.payments.sync(requireSession(request).id, request.params.id, request.ip),
  );

  // Webhooks are signed over the exact bytes the provider sent, so they need the raw body. The parser lives in its own
  // plugin scope so that every other JSON route keeps Fastify's normal parsing.
  api.register((hooks: App, _options, done) => {
    hooks.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );

    hooks.post(
      '/webhooks/:provider',
      {
        // Providers cannot hold a session cookie or an XSRF token: the signature is the authentication.
        config: {
          public: true,
          csrf: false,
          rateLimit: { max: 300, timeWindow: '1 minute' },
        },
        schema: { params: z.object({ provider: ProviderId }), response: { 200: WebhookAck } },
      },
      async (request) => {
        const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        return ctx.payments.handleWebhook(request.params.provider, {
          method: request.method,
          path: stripQuery(request.url),
          headers: request.headers,
          rawBody,
        });
      },
    );
    done();
  });
}
