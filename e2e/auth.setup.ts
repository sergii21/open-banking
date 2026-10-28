import path from 'node:path';
import { expect, test as setup } from '@playwright/test';

const authFile = path.join(import.meta.dirname, '.auth/user.json');

// There is no login: Ledger Lens uses an anonymous demo session. This project opens the app once so the
// BFF issues the session cookie, then stores it for every other test (same pattern as a login setup).
setup('start an anonymous demo session', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('api-status')).toContainText('is up');
  await page.context().storageState({ path: authFile });
});
