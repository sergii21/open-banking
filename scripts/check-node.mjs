// Fails fast on an unsupported Node version, before a confusing Angular/npm error does.
// Supported: Node ^24.15.0 (see .nvmrc and "engines" in package.json).
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major === 24 && minor >= 15;

if (!supported) {
  console.error(
    [
      '',
      `  Unsupported Node.js ${process.versions.node}. Ledger Lens needs Node ^24.15.0.`,
      '  Angular 22 rejects Node 25, and the API relies on the built-in node:sqlite module.',
      '',
      '  Fix:   nvm install 24 && nvm use        (this repo ships an .nvmrc)',
      '  or:    export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
