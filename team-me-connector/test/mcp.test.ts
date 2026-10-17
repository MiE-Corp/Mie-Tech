import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { API_KEY, signIn, start, type Running } from './helpers.js';

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function json(result: unknown): any {
  const r = result as TextResult;
  return JSON.parse(r.content[0]!.text);
}

describe('MCP tools', () => {
  let s: Running;
  let client: Client;

  before(async () => {
    s = await start();
    const { access_token } = await signIn(s.base);
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${access_token}` } } }),
    );
  });

  after(async () => {
    await client.close();
    await s.close();
  });

  it('introduces itself with instructions and the expected tools', async () => {
    assert.equal(client.getServerVersion()?.name, 'team-me');
    assert.match(client.getInstructions() ?? '', /approval/);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        'create_assignment',
        'get_assignment',
        'get_deliverable',
        'list_approvals',
        'list_assignments',
        'list_deliverables',
        'list_workspaces',
        'request_approval',
        'submit_deliverable',
        'update_assignment_status',
      ],
    );
    for (const t of tools) assert.ok(t.description && t.annotations, `${t.name} needs a description and annotations`);
    assert.equal(tools.find((t) => t.name === 'list_workspaces')?.annotations?.readOnlyHint, true);
    // Nothing on the connector can approve.
    assert.ok(!tools.some((t) => /approve|decide/.test(t.name) && t.name !== 'request_approval'));
  });

  it('lists the six Command Center workspaces', async () => {
    const workspaces = json(await client.callTool({ name: 'list_workspaces', arguments: {} }));
    assert.deepEqual(
      workspaces.map((w: { id: string }) => w.id),
      ['beat-on-me', 'mie-website', 'conservatory', 'chief-of-staff', 'communications', 'funding-compliance'],
    );
  });

  it('picks up an assignment from the Command Center, delivers it and asks for approval', async () => {
    // The Command Center queues work through the REST API.
    const queued = await fetch(`${s.base}/api/assignments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: 'mie-website', mode: 'build', request: 'Draft a partnership page.' }),
    });
    assert.equal(queued.status, 201);
    const { id } = (await queued.json()) as { id: string };

    const waiting = json(await client.callTool({ name: 'list_assignments', arguments: { status: 'queued' } }));
    assert.equal(waiting[0].id, id);
    assert.equal(waiting[0].source, 'command_center');

    json(await client.callTool({ name: 'update_assignment_status', arguments: { assignment_id: id, status: 'in_progress' } }));
    const delivered = json(
      await client.callTool({
        name: 'submit_deliverable',
        arguments: { assignment_id: id, title: 'Partnership page', content: '# Partner with us\n…', review: 'Checked against the build sheet.' },
      }),
    );
    assert.equal(delivered.workspaceId, 'mie-website');

    const approval = json(
      await client.callTool({
        name: 'request_approval',
        arguments: { assignment_id: id, title: 'Publish the partnership page', details: 'Adds /partners on mie.ngo. Undo by unpublishing the page.' },
      }),
    );
    assert.equal(approval.status, 'pending');
    assert.equal(approval.requestedBy, 'claude');

    const full = json(await client.callTool({ name: 'get_assignment', arguments: { assignment_id: id } }));
    assert.equal(full.assignment.status, 'completed');
    assert.equal(full.deliverables.length, 1);
    assert.equal(full.approvals.length, 1);

    // The owner decides in the Command Center; Claude sees the decision.
    const decided = await fetch(`${s.base}/api/approvals/${approval.id}/decision`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', note: 'Go ahead.' }),
    });
    assert.equal(decided.status, 200);
    const approvals = json(await client.callTool({ name: 'list_approvals', arguments: { status: 'approved' } }));
    assert.equal(approvals[0].id, approval.id);
    assert.equal(approvals[0].decisionNote, 'Go ahead.');

    const list = json(await client.callTool({ name: 'list_deliverables', arguments: { assignment_id: id } }));
    assert.equal(list[0].hasReview, true);
    assert.equal(list[0].content, undefined);
    const one = json(await client.callTool({ name: 'get_deliverable', arguments: { deliverable_id: list[0].id } }));
    assert.match(one.content, /Partner with us/);
  });

  it('lets Claude queue its own assignment', async () => {
    const created = json(
      await client.callTool({ name: 'create_assignment', arguments: { workspace_id: 'beat-on-me', mode: 'research', request: 'Compare piezo pads.' } }),
    );
    assert.equal(created.source, 'claude');
    assert.equal(created.status, 'queued');
    assert.equal(created.reviewDepth, 'standard');
  });

  it('reports unknown ids as tool errors instead of failing the call', async () => {
    const r = (await client.callTool({ name: 'create_assignment', arguments: { workspace_id: 'nope', mode: 'build', request: 'x' } })) as TextResult;
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /list_workspaces/);
    const d = (await client.callTool({ name: 'submit_deliverable', arguments: { title: 'x', content: 'y' } })) as TextResult;
    assert.equal(d.isError, true);
  });

  it('refuses GET and DELETE on /mcp because it is stateless', async () => {
    const { access_token } = await signIn(s.base);
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${s.base}/mcp`, { method, headers: { Authorization: `Bearer ${access_token}` } });
      assert.equal(res.status, 405);
    }
  });
});
