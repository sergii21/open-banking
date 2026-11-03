import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';

bootstrapApplication(App, appConfig).catch(() => {
  document.body.textContent = 'Ledger Lens could not start. Reload the page, or restart ./start.sh.';
});
