import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

// Shared state for the Command Center and Claude: workspaces, assignments,
// deliverables and the approval queue, plus the connector's OAuth records.
// Everything lives in one JSON file, with the text of each deliverable in its
// own file in a `deliverables` folder next to it. Run a single replica. During
// a deploy the old and new revision overlap briefly; every write re-reads the
// file first if the other one changed it, so neither undoes the other's work.

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

// What lists show. The full text is only read for one deliverable at a time.
export interface DeliverableSummary {
  id: string;
  workspaceId: string;
  assignmentId?: string;
  title: string;
  author: Actor;
  createdAt: string;
  preview: string;
  hasDraft: boolean;
  hasReview: boolean;
}

export interface DeliverableText {
  content: string;
  draft?: string;
  review?: string;
}

export type Deliverable = Omit<DeliverableSummary, 'preview'> & DeliverableText;

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
  rotatedAt?: number; // when it was first exchanged for a new one
}

interface StoredClient {
  info: OAuthClientInformationFull;
  registeredAt: number; // seconds since epoch
  signedInAt?: number; // first time it got tokens
}

interface Data {
  version: 1;
  workspaces: Workspace[];
  assignments: Assignment[];
  deliverables: DeliverableSummary[];
  approvals: Approval[];
  oauthClients: Record<string, StoredClient>;
  // Keyed by tokenKey(), never the token itself.
  refreshTokens: Record<string, RefreshTokenRecord>;
  // Revoked access token ids, kept until the token would have expired.
  revokedAccessTokens: Record<string, number>;
}

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

// A used refresh token keeps working this long, so two requests that refresh
// at once, or a retry after a lost response, don't sign Claude out.
export const REFRESH_REUSE_GRACE_SECONDS = 60;

// Registration is open to anyone, so only this many registered apps that never
// finished signing in are kept; the oldest go first.
export const MAX_UNUSED_CLIENTS = 100;

const PREVIEW_LENGTH = 400;

export function refreshTokenUsable(record: RefreshTokenRecord, nowSeconds: number): boolean {
  return record.expiresAt >= nowSeconds && (record.rotatedAt === undefined || nowSeconds - record.rotatedAt <= REFRESH_REUSE_GRACE_SECONDS);
}

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

function preview(content: string): string {
  return content.length <= PREVIEW_LENGTH ? content : `${content.slice(0, PREVIEW_LENGTH)}…`;
}

function withText(summary: DeliverableSummary, text: DeliverableText): Deliverable {
  const { preview: _preview, ...rest } = summary;
  return { ...rest, ...text };
}

// Identifies one version of the data file: every write replaces the file, so
// a change from another process shows up as a new inode, size or mtime.
interface Stamp {
  ino: number;
  size: number;
  mtimeMs: number;
}

const stampOf = (s: Stats): Stamp => ({ ino: s.ino, size: s.size, mtimeMs: s.mtimeMs });
const sameStamp = (a: Stamp, b: Stamp): boolean => a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

// Writes `file` through a uniquely named temporary file and a rename, so
// readers only ever see a whole file. Returns the stats of what was written.
async function writeAtomic(file: string, contents: string): Promise<Stats> {
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    const handle = await fs.open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Stat the temporary file, which only this process touches; the rename
    // keeps its inode, size and mtime.
    const stats = await fs.stat(tmp);
    await fs.rename(tmp, file);
    return stats;
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

function parseData(raw: string, file: string): Data {
  const parsed = JSON.parse(raw) as Data;
  if (parsed.version !== 1) throw new Error(`Unsupported data file version in ${file}`);
  return parsed;
}

export interface ListOptions {
  workspaceId?: string;
  limit?: number;
}

export class Store {
  private data: Data;
  private readonly file: string | undefined;
  private stamp: Stamp | undefined;
  // Deliverable text when there is no file (tests).
  private readonly texts = new Map<string, DeliverableText>();
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
    const store = new Store(emptyData(now().toISOString()), file, now);
    if (!file) return store;
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (!(await store.reloadIfChanged())) await store.persist(store.data);
    return store;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  // Loads the file if another process replaced it since this one last read or
  // wrote it. Returns false if there is no file yet.
  private async reloadIfChanged(): Promise<boolean> {
    if (!this.file) return true;
    let stats: Stats;
    try {
      stats = await fs.stat(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    const stamp = stampOf(stats);
    if (this.stamp && sameStamp(stamp, this.stamp)) return true;
    this.data = parseData(await fs.readFile(this.file, 'utf8'), this.file);
    this.stamp = stamp;
    return true;
  }

  private async persist(data: Data): Promise<void> {
    if (!this.file) return;
    this.stamp = stampOf(await writeAtomic(this.file, JSON.stringify(data)));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // Picks up changes another revision wrote. Call before reading.
  async sync(): Promise<void> {
    await this.enqueue(() => this.reloadIfChanged());
  }

  // Runs `fn` against the latest data and saves the result. Writes are
  // serialized so two requests never interleave a read-modify-write, and the
  // change only becomes visible once it is saved. If `fn` throws, nothing
  // changes.
  private mutate<T>(fn: (data: Data) => T): Promise<T> {
    return this.enqueue(async () => {
      await this.reloadIfChanged();
      const draft = clone(this.data);
      const result = fn(draft);
      await this.persist(draft);
      this.data = draft;
      return clone(result);
    });
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

  getAssignment(id: string): { assignment: Assignment; deliverables: DeliverableSummary[]; approvals: Approval[] } | undefined {
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

  private textPath(id: string): string {
    if (!/^dlv_[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Not a deliverable id: ${id}`);
    return path.join(path.dirname(this.file!), 'deliverables', `${id}.json`);
  }

  private async writeText(id: string, text: DeliverableText): Promise<void> {
    if (!this.file) {
      this.texts.set(id, text);
      return;
    }
    const target = this.textPath(id);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeAtomic(target, JSON.stringify(text));
  }

  private async readText(id: string): Promise<DeliverableText | undefined> {
    if (!this.file) return this.texts.get(id);
    try {
      return JSON.parse(await fs.readFile(this.textPath(id), 'utf8')) as DeliverableText;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  private async removeText(id: string): Promise<void> {
    if (!this.file) this.texts.delete(id);
    else await fs.rm(this.textPath(id), { force: true });
  }

  listDeliverables(opts: ListOptions & { assignmentId?: string } = {}): DeliverableSummary[] {
    const rows = this.data.deliverables
      .filter(
        (d) =>
          (!opts.workspaceId || d.workspaceId === opts.workspaceId) &&
          (!opts.assignmentId || d.assignmentId === opts.assignmentId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return clone(rows.slice(0, opts.limit ?? 20));
  }

  async getDeliverable(id: string): Promise<Deliverable | undefined> {
    const summary = this.data.deliverables.find((x) => x.id === id);
    if (!summary) return undefined;
    const text = await this.readText(summary.id);
    if (!text) throw new NotFoundError(`The text of deliverable ${id} is missing from the data folder.`);
    return withText(clone(summary), text);
  }

  // Saves a deliverable. With an assignment id, the workspace comes from the
  // assignment and, unless `completeAssignment` is false, the assignment is
  // marked completed.
  async addDeliverable(input: {
    workspaceId?: string;
    assignmentId?: string;
    title: string;
    content: string;
    draft?: string;
    review?: string;
    author: Actor;
    completeAssignment?: boolean;
  }): Promise<Deliverable> {
    const id = newId('dlv');
    const text: DeliverableText = {
      content: input.content,
      ...(input.draft ? { draft: input.draft } : {}),
      ...(input.review ? { review: input.review } : {}),
    };
    // The text is written once, before the record that points at it.
    await this.writeText(id, text);
    try {
      const summary = await this.mutate((data) => {
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
        const summary: DeliverableSummary = {
          id,
          workspaceId,
          ...(assignment ? { assignmentId: assignment.id } : {}),
          title: input.title,
          author: input.author,
          createdAt: now,
          preview: preview(input.content),
          hasDraft: Boolean(text.draft),
          hasReview: Boolean(text.review),
        };
        data.deliverables.push(summary);
        if (assignment && input.completeAssignment !== false) {
          assignment.status = 'completed';
          assignment.updatedAt = now;
        }
        return summary;
      });
      return withText(summary, text);
    } catch (err) {
      await this.removeText(id).catch(() => undefined);
      throw err;
    }
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
    return c ? clone(c.info) : undefined;
  }

  saveOAuthClient(client: OAuthClientInformationFull, nowSeconds: number): Promise<OAuthClientInformationFull> {
    return this.mutate((data) => {
      data.oauthClients[client.client_id] = { info: client, registeredAt: nowSeconds };
      const unused = Object.entries(data.oauthClients)
        .filter(([, c]) => c.signedInAt === undefined)
        .sort(([, a], [, b]) => a.registeredAt - b.registeredAt);
      for (const [id] of unused.slice(0, Math.max(0, unused.length - MAX_UNUSED_CLIENTS))) delete data.oauthClients[id];
      return client;
    });
  }

  getRefreshToken(key: string): RefreshTokenRecord | undefined {
    const r = this.data.refreshTokens[key];
    return r ? clone(r) : undefined;
  }

  // Records a new refresh token and, when `oldKey` is given, marks that one as
  // used. A used token keeps working for REFRESH_REUSE_GRACE_SECONDS, then it
  // is refused and dropped.
  rotateRefreshToken(oldKey: string | undefined, newKey: string, record: RefreshTokenRecord, nowSeconds: number): Promise<void> {
    return this.mutate((data) => {
      if (oldKey !== undefined) {
        const old = data.refreshTokens[oldKey];
        if (!old || !refreshTokenUsable(old, nowSeconds)) throw new ConflictError('Refresh token was already used.');
        old.rotatedAt ??= nowSeconds;
      }
      data.refreshTokens[newKey] = record;
      const client = data.oauthClients[record.clientId];
      if (client && client.signedInAt === undefined) client.signedInAt = nowSeconds;
      for (const [k, r] of Object.entries(data.refreshTokens)) if (!refreshTokenUsable(r, nowSeconds)) delete data.refreshTokens[k];
    });
  }

  deleteRefreshToken(key: string): Promise<boolean> {
    return this.mutate((data) => {
      const existed = Boolean(data.refreshTokens[key]);
      delete data.refreshTokens[key];
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
