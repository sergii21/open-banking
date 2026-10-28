import { defineConfig } from 'vitest/config';

// Opt-in checks against real services. `npm run test:live -w @ledger-lens/api`
export default defineConfig({
  test: { environment: 'node', include: ['test/live/**/*.live.ts'], testTimeout: 60_000 },
});
