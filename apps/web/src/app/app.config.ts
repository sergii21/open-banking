import {
  type ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { Session } from './core/session';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Know who is looking (and whether they have connected) before the first screen, so the app starts in the right place.
    provideAppInitializer(() => inject(Session).load()),
  ],
};
