import {
  ConnectionList,
  ConnectWithTokenRequest,
  ConnectWithTokenResponse,
  CreateConnectionRequest,
  CreateConnectionResponse,
  Id,
  InstitutionList,
  InstitutionQuery,
} from '@ledger-lens/contracts';
import * as z from 'zod';
import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';

export function registerConnectionRoutes(api: App, ctx: AppContext): void {
  api.get(
    '/institutions',
    { schema: { querystring: InstitutionQuery, response: { 200: InstitutionList } } },
    async (request) => {
      const session = requireSession(request);
      const results = await Promise.all(
        ctx.providers
          .all()
          .map((provider) =>
            provider.listInstitutions(request.query, { sessionId: session.id, connectionId: null }),
          ),
      );
      return { items: results.flat().sort((a, b) => a.name.localeCompare(b.name)) };
    },
  );

  api.get('/connections', { schema: { response: { 200: ConnectionList } } }, (request) => ({
    items: ctx.connections.list(requireSession(request).id),
  }));

  api.post(
    '/connections',
    {
      // Each call opens a bank redirect, so cap it per browser session.
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
          keyGenerator: (r) => r.cookies[ctx.sessions.cookieName] ?? r.ip,
        },
      },
      schema: { body: CreateConnectionRequest, response: { 201: CreateConnectionResponse } },
    },
    async (request, reply) => {
      const response = await ctx.connections.start(requireSession(request).id, request.body);
      return reply.code(201).send(response);
    },
  );

  /** Token-based banks. Tight limit: every attempt is a call to the bank with a credential the caller typed. */
  api.post(
    '/connections/token',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (r) => r.cookies[ctx.sessions.cookieName] ?? r.ip,
        },
      },
      schema: { body: ConnectWithTokenRequest, response: { 201: ConnectWithTokenResponse } },
    },
    async (request, reply) => {
      const response = await ctx.connections.connectWithToken(
        requireSession(request).id,
        request.body,
        request.ip,
      );
      return reply.code(201).send(response);
    },
  );

  api.delete(
    '/connections/:id',
    { schema: { params: z.object({ id: Id }), response: { 204: z.null() } } },
    async (request, reply) => {
      await ctx.connections.revoke(requireSession(request).id, request.params.id);
      return reply.code(204).send(null);
    },
  );

  /**
   * Where the bank sends the browser back. Public on purpose: the pending row is found by `state` rather than by cookie,
   * because some banks return through a cross-site POST where a SameSite=Lax cookie would not be sent.
   */
  api.get(
    '/connections/callback',
    {
      config: { public: true },
      schema: { querystring: z.record(z.string(), z.string()) },
    },
    async (request, reply) => {
      const path = await ctx.connections.complete(request.query, request.ip);
      return reply.header('cache-control', 'no-store').redirect(path, 302);
    },
  );
}
