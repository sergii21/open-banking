import type { App, AppContext } from './types';
import { APP_NAME, APP_VERSION } from './version';

/** Everything under `/api`. Session, CSRF and the feature modules are added here. */
export async function registerApi(app: App, ctx: AppContext): Promise<void> {
  await app.register(
    (api, _options, done) => {
      api.get('/meta', () => ({
        name: APP_NAME,
        version: APP_VERSION,
        environment: ctx.config.env,
        time: ctx.clock.now().toISOString(),
        providers: ctx.config.providers.mock.enabled ? ['mock'] : [],
      }));
      done();
    },
    { prefix: '/api' },
  );
}
