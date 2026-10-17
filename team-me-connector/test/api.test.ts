import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { API_KEY, start, type Running } from './helpers.js';
import { MAX_UNUSED_CLIENTS, Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';

const auth = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

describe('Command Center API', () => {
  let s: Running;
  before(async () => {
    s = await start();
  });
  after(async () => {
    await s.close();
  });

  it('needs the API key', async () => {
    assert.equal((await fetch(`${s.base}/api/workspaces`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/workspaces`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${s.base}/api/workspaces`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${s.base}/api/workspaces`, { headers: { Authorization: `bearer  ${API_KEY}` } })).status, 200);
  });

  it('refuses an API key with spaces in it at startup', () => {
    assert.throws(() => loadConfig({ ...s.env, COMMAND_CENTER_API_KEY: 'a key with spaces that is long enough to pass' }), /must not contain spaces/);
  });

  it('does not accept an MCP access token as the API key', async () => {
    const res = await fetch(`${s.base}/api/workspaces`, { headers: { Authorization: 'Bearer tm1.e30.x' } });
    assert.equal(res.status, 401);
  });

  it('answers CORS preflights only for the Command Center origin', async () => {
    const ok = await fetch(`${s.base}/api/assignments`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://ai.mie.ngo', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://ai.mie.ngo');
    const other = await fetch(`${s.base}/api/assignments`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });

  it('updates and adds workspaces', async () => {
    const renamed = await fetch(`${s.base}/api/workspaces/conservatory`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ name: 'Conservatory', description: 'Conservatory of Music Science and Tech site.', url: 'https://www.music-science.tech' }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as { url: string }).url, 'https://www.music-science.tech');
    const bad = await fetch(`${s.base}/api/workspaces/Not%20A%20Slug`, { method: 'PUT', headers: auth, body: JSON.stringify({ name: 'x' }) });
    assert.equal(bad.status, 400);
  });

  it('validates input and reports missing records', async () => {
    const bad = await fetch(`${s.base}/api/assignments`, { method: 'POST', headers: auth, body: JSON.stringify({ workspace_id: 'beat-on-me', mode: 'paint' }) });
    assert.equal(bad.status, 400);
    const missing = await fetch(`${s.base}/api/assignments`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ workspace_id: 'nope', mode: 'build', request: 'x' }),
    });
    assert.equal(missing.status, 404);
    const broken = await fetch(`${s.base}/api/assignments`, { method: 'POST', headers: auth, body: '{not json' });
    assert.equal(broken.status, 400);
    for (const path of ['deliverables', 'approvals']) {
      const noIds = await fetch(`${s.base}/api/${path}`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 't', content: 'c', details: 'd' }) });
      assert.equal(noIds.status, 400, `${path} without ids`);
      assert.match(((await noIds.json()) as { message: string }).message, /assignment_id or workspace_id/);
    }
  });

  it('lists deliverables with a preview and returns the full text by id', async () => {
    const content = `# Funding report\n${'line\n'.repeat(200)}`;
    const created = await fetch(`${s.base}/api/deliverables`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ workspace_id: 'funding-compliance', title: 'Funding report', content, draft: 'first pass', review: 'looks right' }),
    });
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };
    const list = (await (await fetch(`${s.base}/api/deliverables?workspace_id=funding-compliance`, { headers: auth })).json()) as Array<Record<string, unknown>>;
    assert.equal(list[0]!.id, id);
    assert.equal(list[0]!.content, undefined);
    assert.ok(String(list[0]!.preview).startsWith('# Funding report'));
    assert.equal(list[0]!.hasDraft, true);
    const one = (await (await fetch(`${s.base}/api/deliverables/${id}`, { headers: auth })).json()) as Record<string, unknown>;
    assert.equal(one.content, content);
    assert.equal(one.review, 'looks right');
  });

  it('lets the owner decide an approval once', async () => {
    const created = await fetch(`${s.base}/api/approvals`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ workspace_id: 'communications', title: 'Send newsletter', details: 'To the donor list.' }),
    });
    const { id } = (await created.json()) as { id: string };
    const decide = (decision: string) =>
      fetch(`${s.base}/api/approvals/${id}/decision`, { method: 'POST', headers: auth, body: JSON.stringify({ decision }) });
    assert.equal((await decide('declined')).status, 200);
    assert.equal((await decide('approved')).status, 409);
    const recent = (await (await fetch(`${s.base}/api/recent`, { headers: auth })).json()) as Array<{ id: string; status: string }>;
    assert.equal(recent.find((r) => r.id === id)?.status, 'declined');
  });

  it('turns the API off when no key is configured', async () => {
    const off = await start({ COMMAND_CENTER_API_KEY: '' });
    try {
      assert.equal((await fetch(`${off.base}/api/workspaces`, { headers: auth })).status, 503);
    } finally {
      await off.close();
    }
  });
});

describe('Store file', () => {
  it('seeds a new file and keeps changes across reopen', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'team-me-'));
    try {
      const file = path.join(dir, 'nested', 'team-me.json');
      const store = await Store.open(file);
      await store.createAssignment({ workspaceId: 'beat-on-me', mode: 'build', request: 'Kit guide', source: 'owner' });
      const reopened = await Store.open(file);
      assert.equal(reopened.listAssignments().length, 1);
      assert.equal(reopened.listWorkspaces().length, 6);
      const raw = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(raw.version, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps deliverable text out of the main file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'team-me-'));
    try {
      const file = path.join(dir, 'team-me.json');
      const store = await Store.open(file);
      const content = `${'Dear friends, '.repeat(100)}See you at the concert.`;
      const d = await store.addDeliverable({ workspaceId: 'communications', title: 'Newsletter', content, author: 'claude' });
      // Only the 400-character preview is in the main file.
      assert.doesNotMatch(await readFile(file, 'utf8'), /See you at the concert/);
      assert.deepEqual(await readdir(path.join(dir, 'deliverables')), [`${d.id}.json`]);
      const reopened = await Store.open(file);
      assert.equal((await reopened.getDeliverable(d.id))?.content, d.content);
      // A failed save leaves no text behind.
      await assert.rejects(store.addDeliverable({ workspaceId: 'nope', title: 't', content: 'c', author: 'claude' }));
      assert.equal((await readdir(path.join(dir, 'deliverables'))).length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("doesn't undo another process's writes to the same file", async () => {
    // During a deploy the old and new revision both run for a short while.
    const dir = await mkdtemp(path.join(tmpdir(), 'team-me-'));
    try {
      const file = path.join(dir, 'team-me.json');
      const oldRevision = await Store.open(file);
      const approval = await oldRevision.requestApproval({ workspaceId: 'communications', title: 'Send', details: 'Newsletter', requestedBy: 'claude' });
      const newRevision = await Store.open(file);
      await oldRevision.decideApproval(approval.id, { decision: 'approved' });
      await newRevision.createAssignment({ workspaceId: 'beat-on-me', mode: 'build', request: 'Kit guide', source: 'owner' });
      await oldRevision.sync();
      assert.equal(oldRevision.listAssignments().length, 1);
      const onDisk = await Store.open(file);
      assert.equal(onDisk.listApprovals()[0]?.status, 'approved');
      assert.equal(onDisk.listAssignments().length, 1);
      assert.deepEqual((await readdir(dir)).filter((f) => f.includes('.tmp-')), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps only the newest app registrations that never signed in', async () => {
    const store = await Store.open();
    const client = (id: string) => ({ client_id: id, redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) as OAuthClientInformationFull;
    await store.saveOAuthClient(client('signed-in'), 1000);
    await store.rotateRefreshToken(undefined, 'key', { clientId: 'signed-in', scopes: ['team-me'], resource: 'https://x/mcp', expiresAt: 999999 }, 1000);
    for (let i = 0; i < MAX_UNUSED_CLIENTS + 5; i++) await store.saveOAuthClient(client(`junk-${i}`), 2000 + i);
    assert.ok(store.getOAuthClient('signed-in'));
    assert.equal(store.getOAuthClient('junk-0'), undefined);
    assert.equal(store.getOAuthClient('junk-4'), undefined);
    assert.ok(store.getOAuthClient('junk-5'));
    assert.ok(store.getOAuthClient(`junk-${MAX_UNUSED_CLIENTS + 4}`));
  });

  it('serializes concurrent writes', async () => {
    const store = await Store.open();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.createAssignment({ workspaceId: 'chief-of-staff', mode: 'research', request: `task ${i}`, source: 'owner' })),
    );
    assert.equal(store.listAssignments({ limit: 100 }).length, 25);
  });

  it('discards a change that fails validation', async () => {
    const store = await Store.open();
    await assert.rejects(store.addDeliverable({ title: 't', content: 'c', author: 'claude' }));
    assert.equal(store.listDeliverables().length, 0);
  });
});
