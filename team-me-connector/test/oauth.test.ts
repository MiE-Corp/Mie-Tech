import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_CALLBACK,
  PASSPHRASE,
  authorizeUrl,
  login,
  pkce,
  register,
  requestIdFrom,
  signIn,
  start,
  token,
  type Running,
} from './helpers.js';

describe('OAuth sign-in', () => {
  let s: Running;
  before(async () => {
    s = await start();
  });
  after(async () => {
    await s.close();
  });

  it('answers an unauthenticated MCP call with a 401 that points at the resource metadata', async () => {
    const res = await fetch(`${s.base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
    const header = res.headers.get('www-authenticate') ?? '';
    assert.match(header, /^Bearer /);
    assert.match(header, new RegExp(`resource_metadata="${s.base}/.well-known/oauth-protected-resource/mcp"`));
  });

  it('publishes protected resource and authorization server metadata', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const prm = (await (await fetch(`${s.base}${path}`)).json()) as Record<string, unknown>;
      assert.equal(prm.resource, `${s.base}/mcp`);
      assert.deepEqual(prm.authorization_servers, [`${s.base}/`]);
    }
    const as = (await (await fetch(`${s.base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    assert.equal(as.registration_endpoint, `${s.base}/register`);
    assert.equal(as.authorization_endpoint, `${s.base}/authorize`);
    assert.equal(as.token_endpoint, `${s.base}/token`);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  });

  it('registers Claude and Claude Code callbacks but refuses other redirect URIs', async () => {
    assert.equal((await register(s.base)).status, 201);
    assert.equal((await register(s.base, { redirect_uris: ['http://localhost:53682/callback'] })).status, 201);
    const evil = await register(s.base, { redirect_uris: ['https://evil.example/callback'] });
    assert.equal(evil.status, 400);
    assert.equal(((await evil.json()) as { error: string }).error, 'invalid_client_metadata');
  });

  it('registers confidential clients with a secret that does not expire', async () => {
    const res = await register(s.base, { token_endpoint_auth_method: 'client_secret_post' });
    const body = (await res.json()) as { client_secret?: string; client_secret_expires_at?: number };
    assert.ok(body.client_secret);
    assert.equal(body.client_secret_expires_at, 0);
  });

  it('runs the whole sign-in: passphrase page, code, tokens, single-use code', async () => {
    const client = (await (await register(s.base)).json()) as { client_id: string };
    const { verifier, challenge } = pkce();

    const page = await fetch(authorizeUrl(s.base, client.client_id, challenge));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.match(page.headers.get('content-security-policy') ?? '', /form-action 'self' https:\/\/claude\.ai/);
    const requestId = requestIdFrom(await page.text());

    const wrong = await login(s.base, requestId, 'not the passphrase');
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /not right/);

    const ok = await login(s.base, requestId, PASSPHRASE);
    assert.equal(ok.status, 302);
    const location = new URL(ok.headers.get('location')!);
    assert.equal(`${location.origin}${location.pathname}`, CLAUDE_CALLBACK);
    assert.equal(location.searchParams.get('state'), 'state-123');
    const code = location.searchParams.get('code')!;
    assert.ok(code);

    const params = {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: CLAUDE_CALLBACK,
      resource: `${s.base}/mcp`,
    };
    const badVerifier = await token(s.base, { ...params, code_verifier: pkce().verifier });
    assert.equal(badVerifier.status, 400);

    const res = await token(s.base, params);
    assert.equal(res.status, 200);
    const tokens = (await res.json()) as Record<string, unknown>;
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.scope, 'team-me');
    assert.ok(typeof tokens.access_token === 'string' && typeof tokens.refresh_token === 'string');

    const replay = await token(s.base, params);
    assert.equal(replay.status, 400);
    assert.equal(((await replay.json()) as { error: string }).error, 'invalid_grant');
  });

  it('reuses a sign-in request only until it is used', async () => {
    const client = (await (await register(s.base)).json()) as { client_id: string };
    const page = await (await fetch(authorizeUrl(s.base, client.client_id, pkce().challenge))).text();
    const requestId = requestIdFrom(page);
    assert.equal((await login(s.base, requestId, PASSPHRASE)).status, 302);
    const again = await login(s.base, requestId, PASSPHRASE);
    assert.equal(again.status, 400);
    assert.match(await again.text(), /expired/);
  });

  it('sends access_denied back to Claude when the owner denies or keeps guessing', async () => {
    const client = (await (await register(s.base)).json()) as { client_id: string };

    const denied = await login(s.base, requestIdFrom(await (await fetch(authorizeUrl(s.base, client.client_id, pkce().challenge))).text()), '', 'deny');
    assert.equal(denied.status, 302);
    assert.equal(new URL(denied.headers.get('location')!).searchParams.get('error'), 'access_denied');

    const requestId = requestIdFrom(await (await fetch(authorizeUrl(s.base, client.client_id, pkce().challenge))).text());
    for (let i = 0; i < 4; i++) assert.equal((await login(s.base, requestId, `guess ${i}`)).status, 401);
    const locked = await login(s.base, requestId, 'guess 5');
    assert.equal(locked.status, 302);
    assert.equal(new URL(locked.headers.get('location')!).searchParams.get('error'), 'access_denied');
    // The right passphrase no longer helps once the request is locked.
    assert.equal((await login(s.base, requestId, PASSPHRASE)).status, 400);
  });

  it('refuses tokens for another resource and unknown scopes', async () => {
    const client = (await (await register(s.base)).json()) as { client_id: string };
    const other = await fetch(authorizeUrl(s.base, client.client_id, pkce().challenge, { resource: 'https://elsewhere.example/mcp' }), { redirect: 'manual' });
    assert.equal(other.status, 302);
    assert.equal(new URL(other.headers.get('location')!).searchParams.get('error'), 'invalid_target');
    const scope = await fetch(authorizeUrl(s.base, client.client_id, pkce().challenge, { scope: 'admin' }), { redirect: 'manual' });
    assert.equal(new URL(scope.headers.get('location')!).searchParams.get('error'), 'invalid_scope');
  });

  it('rotates refresh tokens and refuses a used one', async () => {
    const t = await signIn(s.base);
    const first = await token(s.base, { grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh_token });
    assert.equal(first.status, 200);
    const next = (await first.json()) as { access_token: string; refresh_token: string };
    assert.notEqual(next.refresh_token, t.refresh_token);
    const reused = await token(s.base, { grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh_token });
    assert.equal(reused.status, 400);
    // Another client cannot use it either.
    const other = (await (await register(s.base)).json()) as { client_id: string };
    const stolen = await token(s.base, { grant_type: 'refresh_token', client_id: other.client_id, refresh_token: next.refresh_token });
    assert.equal(stolen.status, 400);
  });

  it('stops accepting an access token once it is revoked', async () => {
    const t = await signIn(s.base);
    const call = () =>
      fetch(`${s.base}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    assert.equal((await call()).status, 200);
    const revoke = await fetch(`${s.base}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: t.clientId, token: t.access_token }).toString(),
    });
    assert.equal(revoke.status, 200);
    assert.equal((await call()).status, 401);
  });

  it('rejects a tampered access token', async () => {
    const t = await signIn(s.base);
    const [prefix, payload, sig] = t.access_token.split('.');
    const forged = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    forged.exp += 86400;
    const tampered = `${prefix}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;
    const res = await fetch(`${s.base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tampered}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 401);
  });
});
