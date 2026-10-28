import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS } from '@angular/material/form-field';
import { MatIconRegistry } from '@angular/material/icon';
import { MAT_SNACK_BAR_DEFAULT_OPTIONS } from '@angular/material/snack-bar';
import {
  provideRouter,
  TitleStrategy,
  withComponentInputBinding,
  withInMemoryScrolling,
} from '@angular/router';
import { routes } from './app.routes';
import { problemInterceptor } from './core/interceptors/problem.interceptor';
import { SessionService } from './core/session/session';
import { ThemeService } from './core/theme/theme';
import { AppTitleStrategy } from './core/title-strategy';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' }),
    ),
    // Fetch is the default HttpBackend in Angular 22 - no withFetch()/withXhr(). Angular's built-in XSRF interceptor
    // echoes the XSRF-TOKEN cookie into X-XSRF-TOKEN on mutating same-origin calls.
    provideHttpClient(withInterceptors([problemInterceptor])),
    { provide: TitleStrategy, useClass: AppTitleStrategy },
    { provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: { appearance: 'outline' } },
    {
      provide: MAT_SNACK_BAR_DEFAULT_OPTIONS,
      useValue: { duration: 5000, horizontalPosition: 'center' },
    },
    provideAppInitializer(() => {
      inject(MatIconRegistry).setDefaultFontSetClass('material-icons-outlined');
      inject(ThemeService); // apply the saved theme before first paint
      // Start the anonymous demo session (cookie + XSRF token) before any other call is made.
      return inject(SessionService).bootstrap();
    }),
  ],
};
