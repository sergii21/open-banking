import { registerAccountRoutes } from './modules/accounts/routes';
import { registerConnectionRoutes } from './modules/connections/routes';
import { registerDemoRoutes } from './modules/demo/routes';
import { registerEventRoutes } from './modules/events/routes';
import { registerInspectorRoutes } from './modules/inspector/routes';
import { registerPaymentRoutes } from './modules/payments/routes';
import { registerSessionRoutes } from './modules/session/routes';
import { registerTransactionRoutes } from './modules/transactions/routes';
import { registerSessionHooks } from './plugins/session';
import type { App, AppContext } from './types';
import { APP_NAME, APP_VERSION } from './version';

/** Everything under `/api`. Session lookup and CSRF run first for every route that is not marked public. */
export async function registerApi(app: App, ctx: AppContext): Promise<void> {
  await app.register(
    (api, _options, done) => {
      registerSessionHooks(api, ctx);

      api.get('/meta', { config: { public: true } }, () => ({
        name: APP_NAME,
        version: APP_VERSION,
        environment: ctx.config.env,
        time: ctx.clock.now().toISOString(),
        providers: ctx.providers.all().map((provider) => provider.id),
      }));

      registerSessionRoutes(api, ctx);
      registerConnectionRoutes(api, ctx);
      registerAccountRoutes(api, ctx);
      registerTransactionRoutes(api, ctx);
      registerPaymentRoutes(api, ctx);
      registerInspectorRoutes(api, ctx);
      registerEventRoutes(api, ctx);
      registerDemoRoutes(api, ctx);
      done();
    },
    { prefix: '/api' },
  );
}
