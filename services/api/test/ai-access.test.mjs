// AI-ACCESS (2536): every API v1 operation falls in exactly one of the five parts a company's AI rules govern (read, work,
// messages, money, delete), the parts match what the owner named ("create tasks/leads/quotes; send messages; finance;
// delete/archive"), and an approval is for the exact input (any key order, never the request id).
import assert from 'node:assert/strict';
import test from 'node:test';
import '../dist/app.js';
import { v1Operations } from '../dist/v1.js';
import { AI_GROUPS, AI_META, inputHash, summarize, toolGroup } from '../dist/v1-ai-access.js';

const byTool = () => new Map(v1Operations().map((op) => [op.mcp?.name ?? op.operationId, op]));

test('every operation has one part; every read is "read"', () => {
  const ops = v1Operations();
  assert.ok(ops.length > 100);
  for (const op of ops) {
    const g = toolGroup(op);
    assert.ok(AI_GROUPS.includes(g), `${op.operationId}: ${g}`);
    if (op.method === 'GET') assert.equal(g, 'read', op.operationId);
    else assert.notEqual(g, 'read', `${op.operationId} writes, so it is not "read"`);
  }
});

test('the parts the owner named', () => {
  const tools = byTool();
  const expect = {
    work: ['undo_change', 'create_task', 'update_task', 'complete_task', 'create_quotation', 'createQuoteLead', 'find_or_create_client', 'create_doc', 'create_project', 'create_contract'],
    messages: ['send_message', 'send_quotation', 'send_contract', 'send_doc', 'emailInvoice', 'postQuotationToChat'],
    money: ['record_payment', 'issue_invoice', 'create_invoice', 'record_expense', 'approve_quotation', 'add_contract_transaction'],
    delete: ['delete_project', 'discard_quotation_draft', 'revoke_ai_employee_key', 'delete_webhook'],
  };
  let seen = 0;
  for (const [group, names] of Object.entries(expect)) for (const name of names) {
    const op = tools.get(name);
    if (!op) continue; // an area this build does not register
    seen++;
    assert.equal(toolGroup(op), group, `${name} is ${group}`);
  }
  assert.ok(seen >= 20, `checked ${seen}`);
});

test('who am I, my organisations and switching are never held back', () => {
  for (const id of ['whoAmI', 'listMyOrganisations', 'useOrganisation']) {
    assert.ok(AI_META.has(id));
    assert.ok(v1Operations().some((op) => op.operationId === id), `${id} is registered`);
  }
  const use = v1Operations().find((op) => op.operationId === 'useOrganisation');
  assert.equal(use.mcp.name, 'use_organisation'); assert.equal(use.mcp.needsOrg, true);
});

test('an approval is for the exact input', () => {
  const op = { operationId: 'createTask', summary: 'Create a task', mcp: { title: 'Create a task' } };
  const a = inputHash(op, { params: {}, query: {}, body: { title: 'x', priority: 'high' } });
  assert.equal(a, inputHash(op, { params: {}, query: {}, body: { priority: 'high', title: 'x' } }));
  assert.notEqual(a, inputHash(op, { params: {}, query: {}, body: { priority: 'low', title: 'x' } }));
  assert.notEqual(a, inputHash({ ...op, operationId: 'updateTask' }, { params: {}, query: {}, body: { title: 'x', priority: 'high' } }));
  const s = summarize(op, { params: {}, query: {}, body: { title: 'Call the client', notes: 'n'.repeat(500) } });
  assert.match(s, /^Create a task: “Call the client”; notes: n+…$/); assert.ok(s.length <= 600);
});
