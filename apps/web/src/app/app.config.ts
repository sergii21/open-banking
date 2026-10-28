import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    // Fetch is the default HttpBackend in Angular 22 - no withFetch()/withXhr(). Angular's built-in
    // XSRF interceptor echoes the XSRF-TOKEN cookie into X-XSRF-TOKEN on mutating same-origin calls.
    provideHttpClient(withInterceptors([])),
  ],
};
