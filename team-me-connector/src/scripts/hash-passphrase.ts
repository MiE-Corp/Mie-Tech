import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { hashPassphrase } from '../auth/crypto.js';

// Prints the OWNER_PASSPHRASE_HASH value for a passphrase. Reads it from the
// PASSPHRASE environment variable, or asks for it.

const MIN_LENGTH = 12;

let passphrase = process.env.PASSPHRASE;
if (!passphrase) {
  const rl = createInterface({ input: stdin, output: stdout });
  passphrase = await rl.question(`Team Me passphrase (at least ${MIN_LENGTH} characters): `);
  rl.close();
}
if (passphrase.length < MIN_LENGTH) {
  console.error(`The passphrase must be at least ${MIN_LENGTH} characters.`);
  process.exit(1);
}
console.log(await hashPassphrase(passphrase));
