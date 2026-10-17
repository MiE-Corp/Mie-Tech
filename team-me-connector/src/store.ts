import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

// Shared state for the Command Center and Claude: workspaces, assignments,
// deliverables and the approval queue, plus the connector's OAuth records.
// Everything lives in one JSON file, so run a single replica.

export const MODES = ['research', 'build', 'action'] as const;
export type Mode = (typeof MODES)[number];

export const ASSIGNMENT_STATUSES = ['queued', 'in_progress', 'completed', 'cancelled'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'declined'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

// Who wrote a record. The owner is whoever holds the Command Center API key
// and is the only one who can decide approvals.
export type Actor = 'command_center' | 'claude' | 'owner';

export interface Workspace {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Assignment {
  id: string;
  workspaceId: string;
  mode: Mode;
  request: string;
  reviewDepth: string;
  status: AssignmentStatus;
  source: Actor;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Deliverable {
  id: string;
  workspaceId: string;
  assignmentId?: string;
  title: string;
  content: string;
  draft?: string;
  review?: string;
  author: Actor;
  createdAt: string;
}

export interface Approval {
  id: string;
  workspaceId: string;
  assignmentId?: string;
  title: string;
  details: string;
  status: ApprovalStatus;
  requestedBy: Actor;
  createdAt: string;
  decidedAt?: string;
  decisionNote?: string;
}

export interface RefreshTokenRecord {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number; // seconds since epoch
}

interface Data {
  version: 1;
  workspaces: Workspace[];
  assignments: Assignment[];
  deliverables: Deliverable[];
  approvals: Approval[];
  oauthClients: Record<string, OAuthClientInformationFull>;
  // Keyed by the SHA-256 of the refresh token, never the token itself.
  refreshTokens: Record<string, RefreshTokenRecord>;
  // Revoked access token ids, kept until the token would have expired.
  revokedAccessTokens: Record<string, number>;
}

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

// The workspaces shown in the Command Center on 2026-10-17. The Command Center
// can rename or add workspaces through PUT /api/workspaces/:id.
const SEED_WORKSPACES: Array<Omit<Workspace, 'createdAt' | 'updatedAt'>> = [
  { id: 'beat-on-me', name: 'Beat On Me', subtitle: 'NJIT Propelus · Team 112', description: '' },
  {
    id: 'mie-website',
    name: 'MIE Website',
    subtitle: 'Squarespace studio',
    description: 'Develop mission, programs, partnerships, donations, SEO, and site integrations.',
    url: 'https://www.mie.ngo',
  },
  { id: 'conservatory', name: 'Conservatory', subtitle: 'Squarespace studio', description: '' },
  { id: 'chief-of-staff', name: 'Chief of Staff', subtitle: 'Daily operations', description: '' },
  { id: 'communications', name: 'Communications', subtitle: 'Drafting desk', description: '' },
  { id: 'funding-compliance', name: 'Funding & Compliance', subtitle: 'Evidence desk', description: '' },
];

function emptyData(now: string): Data {
  return {
    version: 1,
    workspaces: SEED_WORKSPACES.map((w) => ({ ...w, createdAt: now, updatedAt: now })),
    assignments: [],
    deliverables: [],
    approvals: [],
    oauthClients: {},
    refreshTokens: {},
    revokedAccessTokens: {},
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface ListOptions {
  workspaceId?: string;
  limit?: number;
}

export class Store {
  private data: Data;
  private readonly file: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  private constructor(data: Data, file: string | undefined, now: () => Date) {
    this.data = data;
    this.file = file;
    this.now = now;
  }

  // Opens the store at `file`, creating it with the seed workspaces if it does
  // not exist yet. Without a file the store lives in memory only (tests).
  static async open(file?: string, now: () => Date = () => new Date()): Promise<Store> {
    if (!file) return new Store(emptyData(now().toISOString()), undefined, now);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as Data;
      if (parsed.version !== 1) throw new Error(`Unsupported data file version in ${file}`);
      return new Store(parsed, file, now);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const store = new Store(emptyData(now().toISOString()), file, now);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await store.persist();
      return store;
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  // Runs `fn` against the data and saves the result. Writes are serialized so
  // two requests never interleave a read-modify-write. If `fn` throws, the
  // change is discarded.
  private mutate<T>(fn: (data: Data) => T): Promise<T> {
    const run = async (): Promise<T> => {
      const draft = clone(this.data);
      const result = fn(draft);
      const previous = this.data;
      this.data = draft;
      try {
        await this.persist();
      } catch (err) {
        this.data = previous;
        throw err;
      }
      return clone(result);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // ---- Workspaces ----

  listWorkspaces(): Workspace[] {
    return clone(this.data.workspaces);
  }

  getWorkspace(id: string): Workspace | undefined {
    const ws = this.data.workspaces.find((w) => w.id === id);
    return ws ? clone(ws) : undefined;
  }

  private requireWorkspace(data: Data, id: string): Workspace {
    const ws = data.workspaces.find((w) => w.id === id);
    if (!ws) throw new NotFoundError(`No workspace with id "${id}". Call list_workspaces for the ids.`);
    return ws;
  }

  upsertWorkspace(input: { id: string; name: string; subtitle?: string; description?: string; url?: string | null }): Promise<Workspace> {
    return this.mutate((data) => {
      const now = this.nowIso();
      const existing = data.workspaces.find((w) => w.id === input.id);
      if (existing) {
        existing.name = input.name;
        if (input.subtitle !== undefined) existing.subtitle = input.subtitle;
        if (input.description !== undefined) existing.description = input.description;
        if (input.url === null) delete existing.url;
        else if (input.url !== undefined) existing.url = input.url;
        existing.updatedAt = now;
        return existing;
      }
      const ws: Workspace = {
        id: input.id,
        name: input.name,
        subtitle: input.subtitle ?? '',
        description: input.description ?? '',
        ...(input.url ? { url: input.url } : {}),
        createdAt: now,
        updatedAt: now,
      };
      data.workspaces.push(ws);
      return ws;
    });
  }

  // ---- Assignments ----

  listAssignments(opts: ListOptions & { status?: AssignmentStatus } = {}): Assignment[] {
    const rows = this.data.assignments
      .filter((a) => (!opts.workspaceId || a.workspaceId === opts.workspaceId) && (!opts.status || a.status === opts.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return clone(rows.slice(0, opts.limit ?? 20));
  }

  getAssignment(id: string): { assignment: Assignment; deliverables: Deliverable[]; approvals: Approval[] } | undefined {
    const assignment = this.data.assignments.find((a) => a.id === id);
    if (!assignment) return undefined;
    return clone({
      assignment,
      deliverables: this.data.deliverables.filter((d) => d.assignmentId === id),
      approvals: this.data.approvals.filter((p) => p.assignmentId === id),
    });
  }

  createAssignment(input: { workspaceId: string; mode: Mode; request: string; reviewDepth?: string; source: Actor }): Promise<Assignment> {
    return this.mutate((data) => {
      this.requireWorkspace(data, input.workspaceId);
      const now = this.nowIso();
      const assignment: Assignment = {
        id: newId('asg'),
        workspaceId: input.workspaceId,
        mode: input.mode,
        request: input.request,
        reviewDepth: input.reviewDepth ?? 'standard',
        status: 'queued',
        source: input.source,
        createdAt: now,
        updatedAt: now,
      };
      data.assignments.push(assignment);
      return assignment;
    });
  }

  updateAssignment(id: string, input: { status?: AssignmentStatus; note?: string }): Promise<Assignment> {
    return this.mutate((data) => {
      const assignment = data.assignments.find((a) => a.id === id);
      if (!assignment) throw new NotFoundError(`No assignment with id "${id}".`);
      if (input.status) assignment.status = input.status;
      if (input.note !== undefined) assignment.note = input.note;
      assignment.updatedAt = this.nowIso();
      return assignment;
    });
  }

  // ---- Deliverables ----

  listDeliverables(opts: ListOptions & { assignmentId?: string } = {}): Deliverable[] {
    const rows = this.data.deliverables
      .filter(
        (d) =>
          (!opts.workspaceId || d.workspaceId === opts.workspaceId) &&
          (!opts.assignmentId || d.assignmentId === opts.assignmentId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return clone(rows.slice(0, opts.limit ?? 20));
  }

  getDeliverable(id: string): Deliverable | undefined {
    const d = this.data.deliverables.find((x) => x.id === id);
    return d ? clone(d) : undefined;
  }

  // Saves a deliverable. With an assignment id, the workspace comes from the
  // assignment and, unless `completeAssignment` is false, the assignment is
  // marked completed.
  addDeliverable(input: {
    workspaceId?: string;
    assignmentId?: string;
    title: string;
    content: string;
    draft?: string;
    review?: string;
    author: Actor;
    completeAssignment?: boolean;
  }): Promise<Deliverable> {
    return this.mutate((data) => {
      let workspaceId = input.workspaceId;
      let assignment: Assignment | undefined;
      if (input.assignmentId) {
        assignment = data.assignments.find((a) => a.id === input.assignmentId);
        if (!assignment) throw new NotFoundError(`No assignment with id "${input.assignmentId}".`);
        if (workspaceId && workspaceId !== assignment.workspaceId) {
          throw new ConflictError(`Assignment ${assignment.id} belongs to workspace "${assignment.workspaceId}", not "${workspaceId}".`);
        }
        workspaceId = assignment.workspaceId;
      }
      if (!workspaceId) throw new ConflictError('Give either an assignment id or a workspace id.');
      this.requireWorkspace(data, workspaceId);
      const now = this.nowIso();
      const deliverable: Deliverable = {
        id: newId('dlv'),
        workspaceId,
        ...(assignment ? { assignmentId: assignment.id } : {}),
        title: input.title,
        content: input.content,
        ...(input.draft ? { draft: input.draft } : {}),
        ...(input.review ? { review: input.review } : {}),
        author: input.author,
        createdAt: now,
      };
      data.deliverables.push(deliverable);
      if (assignment && input.completeAssignment !== false) {
        assignment.status = 'completed';
        assignment.updatedAt = now;
      }
      return deliverable;
    });
  }

  // ---- Approvals ----

  listApprovals(opts: ListOptions & { status?: ApprovalStatus } = {}): Approval[] {
    const rows = this.data.approvals
      .filter((p) => (!opts.workspaceId || p.workspaceId === opts.workspaceId) && (!opts.status || p.status === opts.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return clone(rows.slice(0, opts.limit ?? 50));
  }

  requestApproval(input: { workspaceId?: string; assignmentId?: string; title: string; details: string; requestedBy: Actor }): Promise<Approval> {
    return this.mutate((data) => {
      let workspaceId = input.workspaceId;
      if (input.assignmentId) {
        const assignment = data.assignments.find((a) => a.id === input.assignmentId);
        if (!assignment) throw new NotFoundError(`No assignment with id "${input.assignmentId}".`);
        if (workspaceId && workspaceId !== assignment.workspaceId) {
          throw new ConflictError(`Assignment ${assignment.id} belongs to workspace "${assignment.workspaceId}", not "${workspaceId}".`);
        }
        workspaceId = assignment.workspaceId;
      }
      if (!workspaceId) throw new ConflictError('Give either an assignment id or a workspace id.');
      this.requireWorkspace(data, workspaceId);
      const approval: Approval = {
        id: newId('apr'),
        workspaceId,
        ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
        title: input.title,
        details: input.details,
        status: 'pending',
        requestedBy: input.requestedBy,
        createdAt: this.nowIso(),
      };
      data.approvals.push(approval);
      return approval;
    });
  }

  // Only the owner decides. The MCP tools never call this.
  decideApproval(id: string, input: { decision: 'approved' | 'declined'; note?: string }): Promise<Approval> {
    return this.mutate((data) => {
      const approval = data.approvals.find((p) => p.id === id);
      if (!approval) throw new NotFoundError(`No approval with id "${id}".`);
      if (approval.status !== 'pending') throw new ConflictError(`Approval ${id} was already ${approval.status}.`);
      approval.status = input.decision;
      approval.decidedAt = this.nowIso();
      if (input.note) approval.decisionNote = input.note;
      return approval;
    });
  }

  // ---- Recent work (the Command Center's "Recent work" list) ----

  recentWork(limit = 20): Array<{ kind: 'assignment' | 'deliverable' | 'approval'; at: string; workspaceId: string; id: string; title: string; status?: string }> {
    const items = [
      ...this.data.assignments.map((a) => ({
        kind: 'assignment' as const,
        at: a.updatedAt,
        workspaceId: a.workspaceId,
        id: a.id,
        title: a.request.slice(0, 140),
        status: a.status,
      })),
      ...this.data.deliverables.map((d) => ({ kind: 'deliverable' as const, at: d.createdAt, workspaceId: d.workspaceId, id: d.id, title: d.title })),
      ...this.data.approvals.map((p) => ({
        kind: 'approval' as const,
        at: p.decidedAt ?? p.createdAt,
        workspaceId: p.workspaceId,
        id: p.id,
        title: p.title,
        status: p.status,
      })),
    ];
    items.sort((a, b) => b.at.localeCompare(a.at));
    return items.slice(0, limit);
  }

  // ---- OAuth records ----

  getOAuthClient(clientId: string): OAuthClientInformationFull | undefined {
    const c = this.data.oauthClients[clientId];
    return c ? clone(c) : undefined;
  }

  saveOAuthClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    return this.mutate((data) => {
      data.oauthClients[client.client_id] = client;
      return client;
    });
  }

  getRefreshToken(hash: string): RefreshTokenRecord | undefined {
    const r = this.data.refreshTokens[hash];
    return r ? clone(r) : undefined;
  }

  // Swaps one refresh token for another in a single write, so a rotated token
  // can never be used twice. `oldHash` must still exist.
  rotateRefreshToken(oldHash: string | undefined, newHash: string, record: RefreshTokenRecord, nowSeconds: number): Promise<void> {
    return this.mutate((data) => {
      if (oldHash !== undefined) {
        if (!data.refreshTokens[oldHash]) throw new ConflictError('Refresh token was already used.');
        delete data.refreshTokens[oldHash];
      }
      data.refreshTokens[newHash] = record;
      for (const [h, r] of Object.entries(data.refreshTokens)) if (r.expiresAt < nowSeconds) delete data.refreshTokens[h];
    });
  }

  deleteRefreshToken(hash: string): Promise<boolean> {
    return this.mutate((data) => {
      const existed = Boolean(data.refreshTokens[hash]);
      delete data.refreshTokens[hash];
      return existed;
    });
  }

  isAccessTokenRevoked(jti: string): boolean {
    return this.data.revokedAccessTokens[jti] !== undefined;
  }

  revokeAccessToken(jti: string, expiresAt: number, nowSeconds: number): Promise<void> {
    return this.mutate((data) => {
      data.revokedAccessTokens[jti] = expiresAt;
      for (const [id, exp] of Object.entries(data.revokedAccessTokens)) if (exp < nowSeconds) delete data.revokedAccessTokens[id];
    });
  }
}
