const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

/** The same aliases Metro uses (`metro.config.js`), so the tests run the code the phone bundles, hash stand-in included. */
module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@api/(.*)$': path.join(repoRoot, 'apps/api/src/$1'),
    '^@web-shared/(.*)$': path.join(repoRoot, 'apps/web/src/app/shared/$1'),
    '^@ledger-lens/contracts$': path.join(repoRoot, 'packages/contracts/src/index.ts'),
    '^node:crypto$': '<rootDir>/src/platform/node-crypto.ts',
  },
};
