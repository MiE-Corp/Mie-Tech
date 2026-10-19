import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { loadConfig, type Config } from '../src/config.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
import { hashPassphrase } from '../src/auth/crypto.js';

export const PASSPHRASE = 'correct horse battery staple';
export const API_KEY = 'cc_test_key_0123456789abcdef0123456789abcdef';
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

let cachedHash: string | undefined;

export interface Running {
  base: string;
  env: Record<string, string>;
  config: Config;
  store: Store;
  close: () => Promise<void>;
}

// Starts the connector on a free port with an in-memory store.
export async function start(env: Record<string, string> = {}): Promise<Running> {
  cachedHash ??= await hashPassphrase(PASSPHRASE);
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const fullEnv = {
    PUBLIC_BASE_URL: base,
    OWNER_PASSPHRASE_HASH: cachedHash,
    TOKEN_SIGNING_SECRET: 'test-signing-secret-that-is-long-enough-1234567890',
    COMMAND_CENTER_API_KEY: API_KEY,
    TRUST_PROXY: '0',
    ...env,
  };
  let config: Config;
  try {
    config = loadConfig(fullEnv);
  } catch (err) {
    server.close();
    throw err;
  }
  const store = await Store.open();
  const { app } = createApp(config, store);
  server.on('request', app);
  return {
    base,
    env: fullEnv,
    config,
    store,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function register(base: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...body,
    }),
  });
}

export function authorizeUrl(base: string, clientId: string, challenge: string, extra: Record<string, string> = {}): string {
  const url = new URL('/authorize', base);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-123',
    scope: 'team-me',
    resource: `${base}/mcp`,
    ...extra,
  }).toString();
  return url.href;
}

export function requestIdFrom(html: string): string {
  const match = /name="request_id" value="([^"]+)"/.exec(html);
  if (!match?.[1]) throw new Error('No request_id in the sign-in page');
  return match[1];
}

export async function login(base: string, requestId: string, passphrase: string, action = 'approve'): Promise<Response> {
  return fetch(`${base}/oauth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_id: requestId, passphrase, action }).toString(),
  });
}

export async function token(base: string, params: Record<string, string>): Promise<Response> {
  return fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

// Runs the whole sign-in and returns the token response.
export async function signIn(base: string): Promise<{ clientId: string; access_token: string; refresh_token: string }> {
  const client = (await (await register(base)).json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const page = await (await fetch(authorizeUrl(base, client.client_id, challenge))).text();
  const res = await login(base, requestIdFrom(page), PASSPHRASE);
  const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
  const tokens = (await (
    await token(base, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: CLAUDE_CALLBACK,
      resource: `${base}/mcp`,
    })
  ).json()) as { access_token: string; refresh_token: string };
  return { clientId: client.client_id, ...tokens };
}
