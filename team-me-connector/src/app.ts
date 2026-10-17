import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import type { Store } from './store.js';
import { SCOPE, TeamMeOAuthProvider } from './auth/provider.js';
import { buildMcpServer, SERVER_VERSION } from './mcp/server.js';
import { apiRouter } from './api/routes.js';

export interface App {
  app: express.Express;
  provider: TeamMeOAuthProvider;
}

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

export function createApp(config: Config, store: Store): App {
  const provider = new TeamMeOAuthProvider(store, config);
  const mcpUrl = new URL('/mcp', config.publicBaseUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);

  const app = express();
  app.disable('x-powered-by');
  // Azure Container Apps puts one proxy in front of the app; rate limits key
  // on the client address it forwards.
  app.set('trust proxy', config.trustProxy);

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: SERVER_VERSION });
  });

  app.get('/', (_req, res) => {
    res.json({
      name: 'Team Me connector',
      connector_url: mcpUrl.href,
      how_to_connect: 'In Claude, open Settings > Connectors > Add custom connector and paste the connector URL.',
    });
  });

  // OAuth: /authorize, /token, /register, /revoke and the metadata documents.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicBaseUrl,
      baseUrl: config.publicBaseUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported: [SCOPE],
      resourceName: 'Team Me',
      // Claude registers once; a secret that expires would silently break the
      // connector after 30 days.
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );

  // Some clients look for protected resource metadata at the root path too.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
      resource: mcpUrl.href,
      authorization_servers: [config.publicBaseUrl.href],
      scopes_supported: [SCOPE],
      resource_name: 'Team Me',
    });
  });

  app.post(
    '/oauth/login',
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }),
    express.urlencoded({ extended: false, limit: '10kb' }),
    (req, res, next) => {
      provider.handleLogin(req, res).catch(next);
    },
  );

  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [SCOPE],
    resourceMetadataUrl,
    expectedResource: mcpUrl,
  });

  // Streamable HTTP, stateless: every POST gets its own server and transport.
  app.post('/mcp', bearer, express.json({ limit: '4mb' }), async (req, res) => {
    const server = buildMcpServer(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed', err);
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error');
    }
  });

  // No sessions, so there is no stream to open (GET) or session to end (DELETE).
  app.all('/mcp', bearer, (_req, res) => {
    res.setHeader('Allow', 'POST');
    jsonRpcError(res, 405, 'Method not allowed. This server is stateless; send JSON-RPC with POST.');
  });

  app.use('/api', apiRouter(store, config));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) return res.status(status).json({ error: 'bad_request' });
    console.error('Unhandled error', err);
    return res.status(500).json({ error: 'server_error' });
  });

  return { app, provider };
}
