import type { Request, Response } from 'express';
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
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Config } from '../config.js';
import { isLoopbackHost } from '../config.js';
import { ConflictError, type Store } from '../store.js';
import { randomToken, sha256, signAccessToken, verifyAccessTokenSignature, verifyPassphrase } from './crypto.js';
import { sendLoginPage, sendMessagePage } from './loginPage.js';

export const SCOPE = 'team-me';

const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_PASSPHRASE_ATTEMPTS = 5;
const MAX_PENDING = 100;

interface PendingAuthorization {
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
      getClient: (clientId: string) => this.store.getOAuthClient(clientId),
      registerClient: async (client) => {
        for (const uri of client.redirect_uris) {
          if (!this.isAllowedRedirectUri(uri)) {
            throw new InvalidClientMetadataError(`redirect_uri ${uri} is not allowed on this server.`);
          }
        }
        return this.store.saveOAuthClient(client as OAuthClientInformationFull);
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

  private grantedScopes(requested: string[] | undefined): string[] {
    for (const s of requested ?? []) {
      if (s !== SCOPE && s !== 'offline_access') throw new InvalidScopeError(`Unknown scope "${s}". This server offers "${SCOPE}".`);
    }
    return [SCOPE];
  }

  private checkResource(resource: URL | string | undefined): void {
    if (resource !== undefined && !sameResource(String(resource), this.resourceUrl)) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.resourceUrl}.`);
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    const scopes = this.grantedScopes(params.scopes);
    this.prune();
    if (this.pending.size >= MAX_PENDING) {
      sendMessagePage(res, 429, 'Too many sign-ins in progress', 'Wait a few minutes, then connect again from Claude.');
      return;
    }
    const requestId = randomToken();
    this.pending.set(requestId, {
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

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const hash = sha256(refreshToken);
    const record = this.store.getRefreshToken(hash);
    const nowSeconds = Math.floor(this.now() / 1000);
    if (!record || record.clientId !== client.client_id || record.expiresAt < nowSeconds) {
      throw new InvalidGrantError('The refresh token is invalid or has expired.');
    }
    this.checkResource(resource);
    const granted = scopes && scopes.length ? this.grantedScopes(scopes) : record.scopes;
    return this.issueTokens(client.client_id, granted, record.resource, hash);
  }

  private async issueTokens(clientId: string, scopes: string[], resource: string, oldRefreshHash: string | undefined): Promise<OAuthTokens> {
    const nowSeconds = Math.floor(this.now() / 1000);
    const accessToken = signAccessToken(
      { typ: 'access', jti: randomToken(12), cid: clientId, scp: scopes, res: resource, iat: nowSeconds, exp: nowSeconds + this.config.accessTokenTtlSeconds },
      this.config.tokenSigningSecret,
    );
    const refreshToken = randomToken();
    try {
      await this.store.rotateRefreshToken(
        oldRefreshHash,
        sha256(refreshToken),
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
    if (payload.exp < Math.floor(this.now() / 1000)) throw new InvalidTokenError('Access token has expired.');
    if (this.store.isAccessTokenRevoked(payload.jti)) throw new InvalidTokenError('Access token was revoked.');
    if (!this.store.getOAuthClient(payload.cid)) throw new InvalidTokenError('The app this token was issued to is no longer registered.');
    return { token, clientId: payload.cid, scopes: payload.scp, expiresAt: payload.exp, resource: new URL(payload.res) };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = sha256(request.token);
    const refresh = this.store.getRefreshToken(hash);
    if (refresh) {
      if (refresh.clientId === client.client_id) await this.store.deleteRefreshToken(hash);
      return;
    }
    const payload = verifyAccessTokenSignature(request.token, this.config.tokenSigningSecret);
    if (payload && payload.cid === client.client_id) {
      await this.store.revokeAccessToken(payload.jti, payload.exp, Math.floor(this.now() / 1000));
    }
  }
}
