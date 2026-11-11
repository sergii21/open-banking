// Metro for a workspace inside the Ledger Lens monorepo. The phone reuses plain TypeScript that lives in the other
// workspaces (the monobank adapter, the ФОП report, the QR encoder), so three things are added to Expo's defaults:
// the aliases those imports use, the repository root as a watched folder, and a stand-in for `node:crypto`, which the
// reused files import for hashing and which does not exist on a phone.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '../..');
const config = getDefaultConfig(projectRoot);

const ALIASES = {
  '@api/': path.join(repoRoot, 'apps/api/src') + path.sep,
  '@web-shared/': path.join(repoRoot, 'apps/web/src/app/shared') + path.sep,
};
const CRYPTO_SHIM = path.join(projectRoot, 'src/platform/node-crypto.ts');

config.watchFolders = [...new Set([...(config.watchFolders ?? []), repoRoot])];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'node:crypto') return { type: 'sourceFile', filePath: CRYPTO_SHIM };
  for (const [prefix, target] of Object.entries(ALIASES)) {
    if (moduleName.startsWith(prefix)) {
      return context.resolveRequest(context, target + moduleName.slice(prefix.length), platform);
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
