import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Storage key for a refresh token. Keyed by the signing secret, so changing
// TOKEN_SIGNING_SECRET retires every refresh token as well as every access
// token.
export function tokenKey(secret: string, token: string): string {
  return createHmac('sha256', secret).update(`refresh:${token}`).digest('hex');
}

// Compares two secrets without leaking where they differ or how long they are.
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

// ---- Signed access tokens ----
// Format: tm1.<base64url JSON payload>.<base64url HMAC-SHA256>. They are
// checked without a database lookup, so they survive restarts; revocation is
// a short deny list in the store.

export interface AccessTokenPayload {
  typ: 'access';
  jti: string;
  cid: string; // OAuth client id
  scp: string[];
  res: string; // RFC 8707 resource the token is for
  iat: number;
  exp: number;
}

const PREFIX = 'tm1';

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function signAccessToken(payload: AccessTokenPayload, secret: string): string {
  const body = `${PREFIX}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${body}.${hmac(secret, body).toString('base64url')}`;
}

// Returns the payload when the signature is valid, otherwise undefined.
// Expiry is checked by the caller.
export function verifyAccessTokenSignature(token: string, secret: string): AccessTokenPayload | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return undefined;
  const [prefix, encoded, signature] = parts as [string, string, string];
  const expected = hmac(secret, `${prefix}.${encoded}`);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AccessTokenPayload;
    if (payload.typ !== 'access' || typeof payload.exp !== 'number' || typeof payload.cid !== 'string') return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

// ---- Owner passphrase ----
// Stored as scrypt:N:r:p:salt:hash (salt and hash base64url), produced by
// `npm run hash-passphrase`. Colons rather than $ so shells and the Azure CLI
// don't expand it.

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

function scryptAsync(passphrase: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: 256 * n * r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassphrase(passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(passphrase, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), key.toString('base64url')].join(':');
}

export function isPassphraseHash(value: string): boolean {
  const parts = value.split(':');
  return parts.length === 6 && parts[0] === 'scrypt' && [1, 2, 3].every((i) => /^\d+$/.test(parts[i] ?? ''));
}

export async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
  if (!isPassphraseHash(stored)) return false;
  const [, n, r, p, salt, hash] = stored.split(':') as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64url');
  const key = await scryptAsync(passphrase, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}
