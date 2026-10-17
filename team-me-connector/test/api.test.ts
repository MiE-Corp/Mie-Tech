import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { API_KEY, start, type Running } from './helpers.js';
import { Store } from '../src/store.js';

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
