import { registerConnectionRoutes } from './modules/connection/routes';
import { registerEventRoutes } from './modules/events/routes';
import { registerInspectorRoutes } from './modules/inspector/routes';
import { registerAppRoutes } from './modules/routes';
import { registerSessionRoutes } from './modules/session/routes';
import { registerSessionHooks } from './plugins/session';
import type { App, AppContext } from './types';
import { APP_NAME, APP_VERSION } from './version';

/** Everything under `/api`. Session lookup and CSRF run first for every route that is not marked public. */
export async function registerApi(app: App, ctx: AppContext): Promise<void> {
  await app.register(
    (api, _options, done) => {
      registerSessionHooks(api, ctx);

      // Everything here is per-customer: no browser or proxy should keep a copy.
      api.addHook('onSend', (_request, reply, payload, next) => {
        if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
        next(null, payload);
      });

      api.get('/meta', { config: { public: true } }, () => ({
        name: APP_NAME,
        version: APP_VERSION,
        environment: ctx.config.env,
        time: ctx.clock.now().toISOString(),
        live: ctx.config.live,
      }));

      registerSessionRoutes(api, ctx);
      registerConnectionRoutes(api, ctx);
      registerAppRoutes(api, ctx);
      registerInspectorRoutes(api, ctx);
      registerEventRoutes(api, ctx);
      done();
    },
    { prefix: '/api' },
  );
}
