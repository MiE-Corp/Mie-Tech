import express, { type NextFunction, type Request, type Response } from 'express';
import * as z from 'zod/v4';
import type { Config } from '../config.js';
import { safeEqual } from '../auth/crypto.js';
import { APPROVAL_STATUSES, ASSIGNMENT_STATUSES, ConflictError, MODES, NotFoundError, type Store } from '../store.js';

// REST API for the Command Center at ai.mie.ngo, so it reads and writes the
// same assignments, deliverables and approvals that Claude sees through the
// connector. Every call needs `Authorization: Bearer <COMMAND_CENTER_API_KEY>`.
// The owner's approve/decline decisions only come in this way.

const id = z.string().min(1).max(64);
const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and dashes.');
const limit = z.coerce.number().int().min(1).max(100).optional();

const schemas = {
  workspace: z.object({
    name: z.string().min(1).max(120),
    subtitle: z.string().max(120).optional(),
    description: z.string().max(2000).optional(),
    url: z.url().max(500).nullable().optional(),
  }),
  listAssignments: z.object({ workspace_id: id.optional(), status: z.enum(ASSIGNMENT_STATUSES).optional(), limit }),
  createAssignment: z.object({
    workspace_id: id,
    mode: z.enum(MODES),
    request: z.string().min(1).max(20000),
    review_depth: z.string().min(1).max(40).optional(),
  }),
  updateAssignment: z.object({ status: z.enum(ASSIGNMENT_STATUSES).optional(), note: z.string().max(4000).optional() }),
  listDeliverables: z.object({ workspace_id: id.optional(), assignment_id: id.optional(), limit }),
  createDeliverable: z.object({
    assignment_id: id.optional(),
    workspace_id: id.optional(),
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(200000),
    draft: z.string().max(200000).optional(),
    review: z.string().max(50000).optional(),
    complete_assignment: z.boolean().optional(),
  }),
  listApprovals: z.object({ workspace_id: id.optional(), status: z.enum(APPROVAL_STATUSES).optional(), limit }),
  createApproval: z.object({
    assignment_id: id.optional(),
    workspace_id: id.optional(),
    title: z.string().min(1).max(200),
    details: z.string().min(1).max(20000),
  }),
  decision: z.object({ decision: z.enum(['approved', 'declined']), note: z.string().max(4000).optional() }),
  recent: z.object({ limit }),
};

class BadRequest extends Error {}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw new BadRequest(z.prettifyError(result.error));
  return result.data;
}

// Drops undefined values so optional fields stay absent instead of undefined.
function defined<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as never;
}

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;

const handle =
  (fn: Handler) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json(result);
    } catch (err) {
      next(err);
    }
  };

export function apiRouter(store: Store, config: Config): express.Router {
  const router = express.Router();

  router.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.commandCenterOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  router.use((req, res, next) => {
    if (!config.commandCenterApiKey) {
      res.status(503).json({ error: 'api_disabled', message: 'Set COMMAND_CENTER_API_KEY to turn on the Command Center API.' });
      return;
    }
    const header = req.headers.authorization ?? '';
    const [scheme, key] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !key || !safeEqual(key, config.commandCenterApiKey)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="team-me-api"');
      res.status(401).json({ error: 'unauthorized', message: 'Send the Command Center API key as a Bearer token.' });
      return;
    }
    next();
  });

  router.use(express.json({ limit: '1mb' }));

  router.get('/workspaces', handle(() => store.listWorkspaces()));

  router.put(
    '/workspaces/:id',
    handle((req) => {
      const workspaceId = parse(slug, req.params.id);
      const body = parse(schemas.workspace, req.body);
      return store.upsertWorkspace(defined({ id: workspaceId, ...body }));
    }),
  );

  router.get(
    '/assignments',
    handle((req) => {
      const q = parse(schemas.listAssignments, req.query);
      return store.listAssignments(defined({ workspaceId: q.workspace_id, status: q.status, limit: q.limit }));
    }),
  );

  router.post(
    '/assignments',
    handle(async (req, res) => {
      const b = parse(schemas.createAssignment, req.body);
      const created = await store.createAssignment(
        defined({ workspaceId: b.workspace_id, mode: b.mode, request: b.request, reviewDepth: b.review_depth, source: 'command_center' as const }),
      );
      res.status(201);
      return created;
    }),
  );

  router.get(
    '/assignments/:id',
    handle((req) => {
      const found = store.getAssignment(parse(id, req.params.id));
      if (!found) throw new NotFoundError('No such assignment.');
      return found;
    }),
  );

  router.patch(
    '/assignments/:id',
    handle((req) => {
      const b = parse(schemas.updateAssignment, req.body);
      return store.updateAssignment(parse(id, req.params.id), defined({ status: b.status, note: b.note }));
    }),
  );

  router.get(
    '/deliverables',
    handle((req) => {
      const q = parse(schemas.listDeliverables, req.query);
      return store.listDeliverables(defined({ workspaceId: q.workspace_id, assignmentId: q.assignment_id, limit: q.limit }));
    }),
  );

  router.post(
    '/deliverables',
    handle(async (req, res) => {
      const b = parse(schemas.createDeliverable, req.body);
      const created = await store.addDeliverable(
        defined({
          assignmentId: b.assignment_id,
          workspaceId: b.workspace_id,
          title: b.title,
          content: b.content,
          draft: b.draft,
          review: b.review,
          author: 'command_center' as const,
          completeAssignment: b.complete_assignment,
        }),
      );
      res.status(201);
      return created;
    }),
  );

  router.get(
    '/deliverables/:id',
    handle((req) => {
      const found = store.getDeliverable(parse(id, req.params.id));
      if (!found) throw new NotFoundError('No such deliverable.');
      return found;
    }),
  );

  router.get(
    '/approvals',
    handle((req) => {
      const q = parse(schemas.listApprovals, req.query);
      return store.listApprovals(defined({ workspaceId: q.workspace_id, status: q.status, limit: q.limit }));
    }),
  );

  router.post(
    '/approvals',
    handle(async (req, res) => {
      const b = parse(schemas.createApproval, req.body);
      const created = await store.requestApproval(
        defined({ assignmentId: b.assignment_id, workspaceId: b.workspace_id, title: b.title, details: b.details, requestedBy: 'command_center' as const }),
      );
      res.status(201);
      return created;
    }),
  );

  router.post(
    '/approvals/:id/decision',
    handle((req) => {
      const b = parse(schemas.decision, req.body);
      return store.decideApproval(parse(id, req.params.id), defined({ decision: b.decision, note: b.note }));
    }),
  );

  router.get(
    '/recent',
    handle((req) => store.recentWork(parse(schemas.recent, req.query).limit ?? 20)),
  );

  router.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'No such endpoint.' });
  });

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof BadRequest) return res.status(400).json({ error: 'invalid_request', message: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: 'not_found', message: err.message });
    if (err instanceof ConflictError) return res.status(409).json({ error: 'conflict', message: err.message });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'invalid_json', message: 'The body is not valid JSON.' });
    const status = (err as { status?: number }).status;
    if (status === 413) return res.status(413).json({ error: 'too_large', message: 'The body is over 1 MB.' });
    console.error('API error', err);
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong.' });
  });

  return router;
}
