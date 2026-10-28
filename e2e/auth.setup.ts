import path from 'node:path';
import { test as setup } from '@playwright/test';
import { connectAndFinish } from './support';

const authFile = path.join(import.meta.dirname, '.auth/user.json');

// There is no login: Ledger Lens uses an anonymous demo session (HttpOnly cookie). This project starts one, connects
// the mock bank once through the real UI journey, and stores the cookies, so most specs start with data on screen.
// Specs that mutate state (refresh, demo controls, delete) or need a pristine start use their own fresh session instead.
setup('start a demo session with Mock Bank connected', async ({ page }) => {
  await connectAndFinish(page);
  await page.context().storageState({ path: authFile });
});
