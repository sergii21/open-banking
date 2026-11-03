// `npm run app`: the daily-use shape. Builds when the sources are newer than the build (or there is none), then serves the
// app and the API from one Node process on http://localhost:3000. No dev server, nothing to configure.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const web = join(root, 'apps/web/dist/web/browser/index.html');
const api = join(root, 'apps/api/dist/server.js');

function newest(path) {
  let latest = 0;
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.mtimeMs;
  for (const name of readdirSync(path)) {
    if (name === 'node_modules' || name === 'dist' || name === '.angular') continue;
    latest = Math.max(latest, newest(join(path, name)));
  }
  return latest;
}

const sources = [
  'apps/web/src',
  'apps/web/public',
  'apps/web/angular.json',
  'apps/api/src',
  'packages/contracts/src',
];
const sourceTime = Math.max(...sources.map((s) => newest(join(root, s))));
const builtTime = Math.min(
  existsSync(web) ? statSync(web).mtimeMs : 0,
  existsSync(api) ? statSync(api).mtimeMs : 0,
);

if (builtTime < sourceTime) {
  process.stdout.write('Building Ledger Lens (this takes about 20 seconds the first time)...\n');
  const build = spawnSync('npm', ['run', 'build', '--silent'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) {
    process.stderr.write('\nThe build failed. The messages above say why.\n');
    process.exit(build.status ?? 1);
  }
}

const child = spawn(process.execPath, [api], {
  cwd: root,
  stdio: 'inherit',
  env: { NODE_ENV: 'production', ...process.env },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
