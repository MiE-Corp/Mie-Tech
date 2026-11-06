import { isPassphraseHash } from './auth/crypto.js';

export interface Config {
  port: number;
  // Public origin of this server, e.g. https://mcp.mie.ngo. It is the OAuth
  // issuer, and `${publicBaseUrl}/mcp` is the connector URL.
  publicBaseUrl: URL;
  ownerPassphraseHash: string;
  tokenSigningSecret: string;
  // Bearer key the Command Center uses for /api. Unset turns /api off.
  commandCenterApiKey?: string;
  commandCenterOrigins: string[];
  dataFile?: string;
  allowedRedirectUris: string[];
  allowLoopbackRedirects: boolean;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  trustProxy: number;
}

// Claude's hosted apps (web, desktop, mobile) all return to this address.
export const DEFAULT_REDIRECT_URIS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];

function list(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined || value.trim() === '') return fallback;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(name: string, value: string | undefined, fallback: number, min: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}.`);
  return n;
}

function bool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (['1', 'true', 'yes'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no'].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be true or false.`);
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  let publicBaseUrl: URL | undefined;
  try {
    publicBaseUrl = new URL(env.PUBLIC_BASE_URL ?? '');
    if (publicBaseUrl.pathname !== '/' || publicBaseUrl.search || publicBaseUrl.hash) {
      problems.push('PUBLIC_BASE_URL must be an origin with no path, like https://mcp.mie.ngo');
    } else if (publicBaseUrl.protocol !== 'https:' && !isLoopbackHost(publicBaseUrl.hostname)) {
      problems.push('PUBLIC_BASE_URL must use https (http is only allowed for localhost).');
    }
  } catch {
    problems.push('PUBLIC_BASE_URL is required, like https://mcp.mie.ngo');
  }

  const ownerPassphraseHash = env.OWNER_PASSPHRASE_HASH ?? '';
  if (!isPassphraseHash(ownerPassphraseHash)) {
    problems.push('OWNER_PASSPHRASE_HASH is required. Make one with `npm run hash-passphrase`.');
  }

  const tokenSigningSecret = env.TOKEN_SIGNING_SECRET ?? '';
  if (tokenSigningSecret.length < 32) {
    problems.push('TOKEN_SIGNING_SECRET is required and must be at least 32 characters (try `openssl rand -base64 48`).');
  }

  const commandCenterApiKey = env.COMMAND_CENTER_API_KEY || undefined;
  if (commandCenterApiKey !== undefined && commandCenterApiKey.length < 32) {
    problems.push('COMMAND_CENTER_API_KEY must be at least 32 characters when set.');
  } else if (commandCenterApiKey !== undefined && /\s/.test(commandCenterApiKey)) {
    problems.push('COMMAND_CENTER_API_KEY must not contain spaces (try `openssl rand -hex 32`).');
  }

  const allowedRedirectUris = list(env.ALLOWED_REDIRECT_URIS, DEFAULT_REDIRECT_URIS);
  for (const uri of allowedRedirectUris) {
    try {
      const u = new URL(uri);
      if (u.protocol !== 'https:') problems.push(`ALLOWED_REDIRECT_URIS entry ${uri} must use https.`);
    } catch {
      problems.push(`ALLOWED_REDIRECT_URIS entry ${uri} is not a URL.`);
    }
  }

  let config: Config | undefined;
  try {
    config = {
      port: int('PORT', env.PORT, 8080, 0),
      publicBaseUrl: publicBaseUrl ?? new URL('http://localhost'),
      ownerPassphraseHash,
      tokenSigningSecret,
      ...(commandCenterApiKey ? { commandCenterApiKey } : {}),
      commandCenterOrigins: list(env.COMMAND_CENTER_ORIGINS, ['https://ai.mie.ngo']),
      ...(env.DATA_FILE ? { dataFile: env.DATA_FILE } : {}),
      allowedRedirectUris,
      allowLoopbackRedirects: bool('ALLOW_LOOPBACK_REDIRECTS', env.ALLOW_LOOPBACK_REDIRECTS, true),
      accessTokenTtlSeconds: int('ACCESS_TOKEN_TTL_SECONDS', env.ACCESS_TOKEN_TTL_SECONDS, 3600, 60),
      refreshTokenTtlSeconds: int('REFRESH_TOKEN_TTL_DAYS', env.REFRESH_TOKEN_TTL_DAYS, 30, 1) * 86400,
      trustProxy: int('TRUST_PROXY', env.TRUST_PROXY, 1, 0),
    };
  } catch (err) {
    problems.push((err as Error).message);
  }

  if (problems.length || !config) {
    throw new Error(`Team Me connector is not configured:\n- ${problems.join('\n- ')}`);
  }
  return config;
}
