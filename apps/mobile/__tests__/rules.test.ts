import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const read = (file: string): string => readFileSync(join(root, file), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}
const files = [...sources('src'), 'App.tsx', 'index.ts'];

describe('the rules the phone keeps', () => {
  it('nothing is printed: no console, so a token or a transaction cannot end up in a log', () => {
    for (const file of files)
      expect([file, /\bconsole\s*\./.test(read(file))]).toEqual([file, false]);
  });

  it('the app has two ways to the network: the bank, which it only reads, and the family relay', () => {
    const callers = files.filter((file) =>
      /\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(read(file)),
    );
    expect(callers).toEqual(['src/bank/http.ts', 'src/family/relay.ts']);
    // Only the relay client can write, and what it writes was sealed on this phone first.
    const writers = files.filter((file) => /['"`](POST|PUT|PATCH|DELETE)['"`]/.test(read(file)));
    expect(writers).toEqual(['src/family/relay.ts']);
    expect(read('src/family/relay.ts')).not.toMatch(/['"`](POST|PATCH)['"`]/);
    expect(read('src/bank/http.ts')).toContain("method: 'GET'");
  });

  it('the bank token and the family secret never meet', () => {
    for (const file of sources('src/family')) {
      expect([
        file,
        /keychainVault|TokenVault|vault\.read|from '\.\.\/bank\//.test(read(file)),
      ]).toEqual([file, false]);
    }
    expect(read('src/family/relay.ts')).toContain("startsWith('https://')");
  });

  it('the token is read back in one place and kept on this device only', () => {
    const readers = files.filter((file) => /expo-secure-store/.test(read(file)));
    expect(readers).toEqual(['src/platform/keychain.ts']);
    expect(read('src/platform/keychain.ts')).toContain('WHEN_UNLOCKED_THIS_DEVICE_ONLY');
    const vaultUsers = files.filter((file) => /vault\.read\(\)/.test(read(file)));
    expect(vaultUsers).toEqual(['src/bank/sync.ts']);
    const secretUsers = files.filter((file) => /keyring\.load\(\)/.test(read(file)));
    expect(secretUsers).toEqual(['src/family/service.ts']);
  });

  it('the build settings are the ones the deploy guide describes', () => {
    const app = JSON.parse(read('app.json')) as {
      expo: { name: string; slug: string; ios: { bundleIdentifier: string }; extra?: unknown };
    };
    expect(app.expo).toMatchObject({
      name: 'Ledger Lens',
      slug: 'ledger-lens',
      ios: { bundleIdentifier: 'ua.ledgerlens.app' },
    });
    const eas = JSON.parse(read('eas.json')) as {
      cli: { appVersionSource: string };
      build: Record<string, { autoIncrement?: boolean; distribution?: string }>;
      submit: { production: { ios: Record<string, unknown> } };
    };
    expect(eas.cli.appVersionSource).toBe('remote');
    expect(Object.keys(eas.build)).toEqual(['development', 'preview', 'production']);
    expect(eas.build['production']?.autoIncrement).toBe(true);
    // The repository is public: no Apple ID, team or App Store Connect id is written into it.
    expect(JSON.stringify(eas.submit)).not.toMatch(/appleId|ascAppId|appleTeamId/);
    expect(read('DEPLOY.md')).toContain('ua.ledgerlens.app');
  });
});
