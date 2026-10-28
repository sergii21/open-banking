// Generates the EC P-521 (ES512) key pair TrueLayer Payments v3 uses for request signing.
// The PRIVATE key stays on this machine (git-ignored); you upload only the PUBLIC key in the TrueLayer Console.
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const privatePath = resolve(
  import.meta.dirname,
  '../apps/api/.secrets/truelayer-signing-private.pem',
);
const publicPath = resolve(
  import.meta.dirname,
  '../apps/api/.secrets/truelayer-signing-public.pem',
);

if (existsSync(privatePath) && !process.argv.includes('--force')) {
  console.error(`A signing key already exists at ${privatePath}.`);
  console.error(
    'Re-run with --force to replace it (you would have to upload the new public key again).',
  );
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'secp521r1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'sec1', format: 'pem' },
});

mkdirSync(dirname(privatePath), { recursive: true });
writeFileSync(privatePath, privateKey, { mode: 0o600 });
chmodSync(privatePath, 0o600);
writeFileSync(publicPath, publicKey);

console.log(`
Signing key pair created.

  private key (never share, git-ignored): ${privatePath}
  public key:                             ${publicPath}

Next steps
  1. Open the TrueLayer Console (sandbox, "Live" toggle OFF) and add this PUBLIC key under your
     Payments signing keys. The Console shows a key id (kid) once it is uploaded.
  2. Put that id in apps/api/.env:

       TRUELAYER_SIGNING_KEY_ID=<the kid shown in the Console>
       TRUELAYER_PRIVATE_KEY_PATH=./.secrets/truelayer-signing-private.pem

PUBLIC KEY (safe to paste into the Console)
${publicKey}`);
