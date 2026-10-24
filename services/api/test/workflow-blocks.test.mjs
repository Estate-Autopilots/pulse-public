import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adapters, BLOCKS, outType, portProblem, specOf } from '../dist/workflow-blocks.js';
import { normalizeWorkflow, wireOrder } from '../dist/workflow-model.js';

const step = (id, module, next = [], over = {}) => ({ id, title: id, module, kind: BLOCKS.find((b) => b.module === module).kind, next, ...over });

test('every block names its kind and typed ports; stubs say so', () => {
  const keys = new Set();
  for (const b of BLOCKS) {
    assert.ok(!keys.has(b.module), b.module); keys.add(b.module);
    assert.ok(['live', 'auto', 'partial', 'stub'].includes(b.engine) && b.status.length > 10, b.module);
    for (const p of [...b.inputs, ...b.outputs]) assert.match(p.key, /^[a-z_]+$/);
  }
  for (const m of ['lead_capture', 'sales_xray', 'quotation', 'approval', 'follow_up', 'site_visit', 'data_capture', 'checklist', 'handoff', 'wait', 'notify', 'tax_invoice', 'webhook']) assert.ok(keys.has(m), m);
  assert.deepEqual(BLOCKS.filter((b) => b.engine === 'stub').map((b) => b.module), ['sales_xray', 'notify', 'webhook']);
  assert.equal(specOf({ kind: 'approval' }).module, 'approval');
  assert.equal(specOf({ kind: 'task' }).module, 'checklist');
});

test('wires join matching types; a pass-through block passes its type on; adapters turn one into another', () => {
  const steps = [step('lead', 'lead_capture', [{ to: 'call', port: 'lead' }]), step('call', 'sales_xray', [{ to: 'quote', port: 'items' }]), step('quote', 'quotation', [{ to: 'check', port: 'quote' }]),
    step('check', 'checklist', [{ to: 'follow', port: 'done' }]), step('follow', 'follow_up')];
  assert.equal(portProblem(steps), null);
  assert.equal(outType(steps, 'check', 'done'), 'quote');
  const bad = [step('lead', 'lead_capture', [{ to: 'follow', port: 'lead' }]), step('follow', 'follow_up')];
  assert.match(portProblem(bad), /gives Lead, and “follow” takes Quote: put an adapter block/);
  assert.match(portProblem([step('a', 'checklist', [{ to: 'b', port: 'done' }]), step('b', 'lead_capture')]), /starts a run/);
  assert.ok(adapters('lead', 'quote').includes('quotation'));
  assert.ok(adapters('lead', 'call').includes('sales_xray'));
});

test('a saved definition keeps blocks, places, ports and hand-offs, and refuses wrong wires', () => {
  const wid = '11111111-2222-4333-8444-555555555555';
  const r = normalizeWorkflow({ steps: [
    { id: 'lead', title: 'Lead capture', module: 'lead_capture', kind: 'task', pos: { x: 40.4, y: 99999 }, next: [{ to: 'brief', port: 'lead' }] },
    { id: 'brief', title: 'Brief', module: 'checklist', kind: 'task', next: [{ to: 'ok', port: 'done' }] },
    { id: 'ok', title: 'Approve', module: 'approval', kind: 'approval', next: [{ to: 'go', port: 'approved' }, { to: 'brief', port: 'back' }] },
    { id: 'go', title: 'Hand over', module: 'handoff', kind: 'task', handoff: { workflowId: wid }, next: [] },
    { id: 'x', title: 'Odd', module: 'not-a-block', kind: 'task', next: [] }] });
  assert.ok('def' in r, r.error);
  const [lead, , ok, go, x] = r.def.steps;
  assert.deepEqual(lead.pos, { x: 40, y: 8000 });
  assert.equal(lead.module, 'lead_capture');
  assert.deepEqual(ok.next.map((n) => [n.to, n.port, n.label]), [['go', 'approved', 'Approved'], ['brief', 'back', 'Send back']], 'an approval\'s ports are its answers');
  assert.deepEqual(go.handoff, { workflowId: wid });
  assert.equal(x.module, undefined, 'an unknown module is dropped');
  assert.match(normalizeWorkflow({ steps: [{ id: 'a', title: 'A', module: 'approval', kind: 'task' }] }).error, /keep its kind/);
  assert.match(normalizeWorkflow({ steps: [{ id: 'a', title: 'A', module: 'lead_capture', next: [{ to: 'b', port: 'lead' }] }, { id: 'b', title: 'B', module: 'follow_up' }] }).error, /adapter/);
  // Blocks are kept in wire order (an adapter added last sits between its two blocks); Send back wires point back.
  const ordered = normalizeWorkflow({ steps: [step('lead', 'lead_capture', [{ to: 'quote', port: 'lead' }]), step('follow', 'follow_up'),
    step('quote', 'quotation', [{ to: 'follow', port: 'quote' }])] });
  assert.deepEqual(ordered.def.steps.map((s) => s.id), ['lead', 'quote', 'follow']);
  assert.deepEqual(wireOrder(r.def.steps).map((s) => s.id), ['lead', 'brief', 'ok', 'go', 'x'], 'an order that fits is kept');
  assert.deepEqual(wireOrder([{ id: 'a', next: [{ to: 'b' }] }, { id: 'b', next: [{ to: 'a' }] }]).map((s) => s.id), ['a', 'b'], 'a loop keeps the list order');
  // SOP steps without modules save as before.
  const sop = normalizeWorkflow({ steps: [{ id: 's1', title: 'One' }, { id: 's2', title: 'Two' }] });
  assert.equal(sop.def.steps[0].next, null);
  assert.equal(sop.def.steps[0].module, undefined);
});
