import { DemoActionRequest, DemoActionResponse } from '@ledger-lens/contracts';
import { AppError } from '../../errors';
import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';

/**
 * Demo controls reach failure states on the mock bank on demand (outage, rate limit, revoked or expiring consent).
 * They only exist when `DEMO_CONTROLS` is on, and only ever act on a connection owned by the caller's session.
 */
export function registerDemoRoutes(api: App, ctx: AppContext): void {
  api.post(
    '/demo/actions',
    { schema: { body: DemoActionRequest, response: { 200: DemoActionResponse } } },
    async (request) => {
      if (!ctx.config.demoControls) {
        throw new AppError('forbidden', 403, 'Demo controls are turned off on this server.');
      }
      const session = requireSession(request);
      const { action, connectionId } = request.body;

      const mock = ctx.providers.mock();
      if (!mock) throw new AppError('provider_not_available', 404, 'The mock bank is not enabled.');
      if (!connectionId) throw new AppError('validation_failed', 400, 'Choose a connection first.');

      const connection = ctx.connections.get(session.id, connectionId);
      if (connection.provider !== 'mock') {
        throw new AppError('validation_failed', 400, 'Demo controls only work on the mock bank.');
      }
      const tokens = ctx.access.loadTokens(connection);

      switch (action) {
        case 'bank_unavailable_next':
          mock.demo.failNext(tokens, 'unavailable');
          return {
            ok: true as const,
            message:
              'The next bank call will fail with 503. Press Refresh on an account to see it.',
          };
        case 'rate_limit_next':
          mock.demo.failNext(tokens, 'rate_limit');
          return {
            ok: true as const,
            message: 'The next bank call will be rate limited (429). Press Refresh to see it.',
          };
        case 'revoke_at_bank':
          mock.demo.revokeAtBank(tokens);
          return {
            ok: true as const,
            message:
              'The customer revoked consent in the bank app. Press Refresh to see how we detect it.',
          };
        case 'expire_consent_soon':
        case 'expire_consent_now': {
          mock.demo.expireConsent(tokens, action === 'expire_consent_now' ? 'now' : 'soon');
          try {
            // Re-read the consent so the dashboard reflects it straight away (this call shows in the Inspector).
            await ctx.access.withTokens(connection, async (fresh, provider, call) => {
              const consent = await provider.fetchConsent(fresh, call);
              ctx.repos.connections.update(
                connection.id,
                { consentExpiresAt: consent.expiresAt },
                ctx.clock.now().toISOString(),
              );
            });
          } catch (error) {
            // An expired consent is the expected outcome of "expire now"; withTokens already updated the status.
            if (!(error instanceof AppError)) throw error;
          }
          ctx.access.notify(connection.id);
          return {
            ok: true as const,
            message:
              action === 'expire_consent_now'
                ? 'The consent has ended.'
                : 'The consent now ends in 2 days.',
          };
        }
        case 'replay_last_webhook':
          throw new AppError(
            'validation_failed',
            400,
            'Webhook replay is available once payments are enabled.',
          );
      }
    },
  );
}
