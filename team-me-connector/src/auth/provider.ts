import type { Request, Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  AccessDeniedError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Config } from '../config.js';
import { isLoopbackHost } from '../config.js';
import { ConflictError, refreshTokenUsable, type Store } from '../store.js';
import { randomToken, signAccessToken, tokenKey, verifyAccessTokenSignature, verifyPassphrase } from './crypto.js';
import { sendLoginPage, sendMessagePage } from './loginPage.js';

export const SCOPE = 'team-me';

const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_PASSPHRASE_ATTEMPTS = 5;
// Sign-ins waiting for the passphrase, in total and per network address.
const MAX_PENDING = 1000;
const MAX_PENDING_PER_SOURCE = 10;
const MAX_STATE_LENGTH = 1024;
// Registration is open, so keep what an app can store small.
const MAX_REDIRECT_URIS = 5;
const MAX_CLIENT_METADATA_LENGTH = 8192;

interface PendingAuthorization {
  source: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
  attempts: number;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

function sameResource(a: string, b: string): boolean {
  const norm = (v: string) => v.split('#')[0]!.replace(/\/$/, '');
  return norm(a) === norm(b);
}

function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.href;
}

// A single-owner OAuth 2.1 authorization server for the connector. Claude
// registers itself (dynamic client registration), the owner approves on the
// passphrase page, and Claude gets a short-lived access token plus a rotating
// refresh token. Pending sign-ins and codes are kept in memory: a restart in
// the middle of a sign-in just means connecting again.
export class TeamMeOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  readonly resourceUrl: string;

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.resourceUrl = new URL('/mcp', config.publicBaseUrl).href;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => {
        await this.store.sync();
        return this.store.getOAuthClient(clientId);
      },
      registerClient: async (client) => {
        if (client.redirect_uris.length > MAX_REDIRECT_URIS) {
          throw new InvalidClientMetadataError(`Register at most ${MAX_REDIRECT_URIS} redirect_uris.`);
        }
        for (const uri of client.redirect_uris) {
          if (!this.isAllowedRedirectUri(uri)) {
            throw new InvalidClientMetadataError(`redirect_uri ${uri} is not allowed on this server.`);
          }
        }
        // Keys and software statements are never used here, and can be large.
        // The token endpoint reads the client secret from the form body only.
        const { jwks: _jwks, software_statement: _statement, ...kept } = client;
        const info = {
          ...kept,
          token_endpoint_auth_method: kept.token_endpoint_auth_method === 'none' ? 'none' : 'client_secret_post',
        } as OAuthClientInformationFull;
        if (JSON.stringify(info).length > MAX_CLIENT_METADATA_LENGTH) {
          throw new InvalidClientMetadataError('The client metadata is too large.');
        }
        return this.store.saveOAuthClient(info, Math.floor(this.now() / 1000));
      },
    };
  }

  isAllowedRedirectUri(uri: string): boolean {
    if (this.config.allowedRedirectUris.includes(uri)) return true;
    if (!this.config.allowLoopbackRedirects) return false;
    try {
      const u = new URL(uri);
      // Claude Code and other local clients use http://localhost:<port>/callback.
      return u.protocol === 'http:' && isLoopbackHost(u.hostname) && !u.username && !u.password && !u.hash;
    } catch {
      return false;
    }
  }

  private prune(): void {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt < t) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < t) this.codes.delete(k);
  }

  private checkResource(resource: URL | string | undefined): void {
    if (resource !== undefined && !sameResource(String(resource), this.resourceUrl)) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.resourceUrl}.`);
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    if (params.state !== undefined && params.state.length > MAX_STATE_LENGTH) throw new InvalidRequestError('state is too long.');
    // An S256 challenge is always 43 base64url characters.
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('code_challenge must be an S256 challenge.');
    // The one scope is always granted. Others in the request (claude.ai has
    // sent "claudeai") are ignored rather than refused (RFC 6749 section 3.3).
    const scopes = [SCOPE];
    this.prune();
    // Floods only push out the flooders' own sign-ins: an address at its limit
    // gives up its oldest, and when the queue is full the address holding the
    // most does. A newcomer, such as the owner, always gets in.
    const source = ipKeyGenerator(res.req.ip ?? '', 56);
    const bySource = new Map<string, string[]>();
    for (const [id, p] of this.pending) {
      const ids = bySource.get(p.source);
      if (ids) ids.push(id);
      else bySource.set(p.source, [id]);
    }
    const own = bySource.get(source) ?? [];
    if (own.length >= MAX_PENDING_PER_SOURCE) {
      this.pending.delete(own[0]!);
    } else if (this.pending.size >= MAX_PENDING) {
      let busiest: string[] = [];
      for (const ids of bySource.values()) if (ids.length > busiest.length) busiest = ids;
      this.pending.delete(busiest[0]!);
    }
    const requestId = randomToken();
    this.pending.set(requestId, {
      source,
      clientId: client.client_id,
      clientName: client.client_name || 'Unnamed app',
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      ...(params.state !== undefined ? { state: params.state } : {}),
      scopes,
      resource: this.resourceUrl,
      expiresAt: this.now() + PENDING_TTL_MS,
      attempts: 0,
    });
    sendLoginPage(res, { requestId, clientName: client.client_name || 'Unnamed app', redirectUri: params.redirectUri });
  }

  // POST /oauth/login, from the passphrase page.
  async handleLogin(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
    const action = body.action === 'deny' ? 'deny' : 'approve';

    this.prune();
    const pending = this.pending.get(requestId);
    if (!pending) {
      sendMessagePage(res, 400, 'This sign-in has expired', 'Go back to Claude and connect Team Me again.');
      return;
    }

    if (action === 'deny') {
      this.pending.delete(requestId);
      res.redirect(302, redirectWith(pending.redirectUri, { error: 'access_denied', error_description: 'The owner denied access.', state: pending.state }));
      return;
    }

    const ok = passphrase.length > 0 && passphrase.length <= 1024 && (await verifyPassphrase(passphrase, this.config.ownerPassphraseHash));
    if (!ok) {
      pending.attempts += 1;
      if (pending.attempts >= MAX_PASSPHRASE_ATTEMPTS) {
        this.pending.delete(requestId);
        const err = new AccessDeniedError('Too many wrong passphrases.');
        res.redirect(302, redirectWith(pending.redirectUri, { error: err.errorCode, error_description: err.message, state: pending.state }));
        return;
      }
      sendLoginPage(
        res,
        { requestId, clientName: pending.clientName, redirectUri: pending.redirectUri, error: 'That passphrase is not right. Try again.' },
        401,
      );
      return;
    }

    this.pending.delete(requestId);
    const code = randomToken();
    this.codes.set(code, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      resource: pending.resource,
      expiresAt: this.now() + CODE_TTL_MS,
    });
    res.redirect(302, redirectWith(pending.redirectUri, { code, state: pending.state }));
  }

  private liveCode(client: OAuthClientInformationFull, code: string): AuthorizationCode {
    const record = this.codes.get(code);
    if (!record || record.expiresAt < this.now() || record.clientId !== client.client_id) {
      throw new InvalidGrantError('The authorization code is invalid or has expired.');
    }
    return record;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.liveCode(client, authorizationCode).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.liveCode(client, authorizationCode);
    // Single use, even if the rest of this exchange fails.
    this.codes.delete(authorizationCode);
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the one used to authorize.');
    }
    this.checkResource(resource);
    return this.issueTokens(client.client_id, record.scopes, record.resource, undefined);
  }

  // A refreshed token keeps the scope it was first granted.
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    await this.store.sync();
    const key = tokenKey(this.config.tokenSigningSecret, refreshToken);
    const record = this.store.getRefreshToken(key);
    if (!record || record.clientId !== client.client_id || !refreshTokenUsable(record, Math.floor(this.now() / 1000))) {
      throw new InvalidGrantError('The refresh token is invalid or has expired.');
    }
    this.checkResource(resource);
    return this.issueTokens(client.client_id, record.scopes, record.resource, key);
  }

  private async issueTokens(clientId: string, scopes: string[], resource: string, oldRefreshKey: string | undefined): Promise<OAuthTokens> {
    const nowSeconds = Math.floor(this.now() / 1000);
    const accessToken = signAccessToken(
      { typ: 'access', jti: randomToken(12), cid: clientId, scp: scopes, res: resource, iat: nowSeconds, exp: nowSeconds + this.config.accessTokenTtlSeconds },
      this.config.tokenSigningSecret,
    );
    const refreshToken = randomToken();
    try {
      await this.store.rotateRefreshToken(
        oldRefreshKey,
        tokenKey(this.config.tokenSigningSecret, refreshToken),
        { clientId, scopes, resource, expiresAt: nowSeconds + this.config.refreshTokenTtlSeconds },
        nowSeconds,
      );
    } catch (err) {
      if (err instanceof ConflictError) throw new InvalidGrantError('The refresh token was already used.');
      throw err;
    }
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = verifyAccessTokenSignature(token, this.config.tokenSigningSecret);
    if (!payload) throw new InvalidTokenError('Invalid access token.');
    await this.store.sync();
    if (payload.exp < Math.floor(this.now() / 1000)) throw new InvalidTokenError('Access token has expired.');
    if (this.store.isAccessTokenRevoked(payload.jti)) throw new InvalidTokenError('Access token was revoked.');
    if (!this.store.getOAuthClient(payload.cid)) throw new InvalidTokenError('The app this token was issued to is no longer registered.');
    return { token, clientId: payload.cid, scopes: payload.scp, expiresAt: payload.exp, resource: new URL(payload.res) };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.store.sync();
    const key = tokenKey(this.config.tokenSigningSecret, request.token);
    const refresh = this.store.getRefreshToken(key);
    if (refresh) {
      if (refresh.clientId === client.client_id) await this.store.deleteRefreshToken(key);
      return;
    }
    const payload = verifyAccessTokenSignature(request.token, this.config.tokenSigningSecret);
    if (payload && payload.cid === client.client_id) {
      await this.store.revokeAccessToken(payload.jti, payload.exp, Math.floor(this.now() / 1000));
    }
  }
}
