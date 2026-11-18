// SOP-WORKFLOW part 2 acceptance against the built API on the synthetic agency (tests/core/test_sop.py::test_workflow_api):
// a workflow made from an SOP, Pip's advice, publishing, a run on a project, approvals, giving a step to someone,
// the task page's step, the runs list, stopping a run, and who may do what.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const P = JSON.parse(process.env.TEST_PEOPLE); const domain = process.env.TEST_DOMAIN; const project = process.env.TEST_PROJECT;
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app = createApp(pool, pool);
let checks = 0; const ok = (c, m) => { checks++; assert.ok(c, m); }; const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const call = async (who, url, payload, method = payload ? 'POST' : 'GET') => {
  const r = await app.inject({ url, method, headers: { 'cf-access-authenticated-user-email': `${who}@${domain}`, 'x-pulse-client-ip': crypto.randomUUID() }, ...(payload ? { payload } : {}) });
  return { status: r.statusCode, data: r.headers['content-type']?.includes('json') ? r.json() : r.body };
};
const done = async (who, taskId) => eq((await call(who, `/api/v0/tasks/${taskId}/move`, { status: "done" })).status, 200, `${who} finishes ${taskId}`);

try {
  let r = await call('kabir', '/api/v0/workflows'); eq(r.status, 200); eq(r.data.canEdit, false); eq(r.data.canStart, false); eq(r.data.workflows, []);
  const sops = (await call('kedab', '/api/v0/sops')).data.sops; const onboarding = sops.find((s) => s.title === 'Client onboarding');
  eq((await call('kabir', '/api/v0/workflows/from-sop', { sopId: onboarding.id })).status, 403);
  r = await call('kedab', '/api/v0/workflows/from-sop', { sopId: onboarding.id }); eq(r.status, 200); const wid = r.data.id;
  r = await call('kedab', `/api/v0/workflows/${wid}`); eq(r.data.workflow.status, 'draft'); eq(r.data.workflow.triggerText, 'Started by hand');
  const def = r.data.workflow.definition;
  eq(def.steps.map((s) => s.assign.by), ['role', 'role', 'role', 'role', 'role', 'role', 'role', 'role']);
  ok(r.data.people.PGS.length === 2, 'who holds each role');

  // Pip: candidates, flags, effect of a person, management steps; the source SOP is not offered for reuse.
  r = await call('kedab', '/api/v0/workflows/intel', { definition: def, workflowId: wid, sopId: onboarding.id, stepId: 's5', personId: P.sana }); eq(r.status, 200);
  const brief = r.data.steps[0]; eq(brief.candidates.map((c) => c.name).sort(), ['Asha Rao', 'Vikram Jivop']);
  ok(r.data.steps[4].flags.some((f) => /^Only Kabir holds/.test(f.text)), 'one designer is a bottleneck');
  ok(r.data.steps.find((s) => s.stepId === 's6').candidates.length === 0, 'the client\'s own step proposes nobody');
  ok(r.data.steps[4].effect?.name === 'Sana Qipedot' && r.data.steps[4].effect.lines.some((l) => /^Sana has \d+ open task/.test(l)), 'the effect of trying Sana on the brand step');
  ok(r.data.suggestions.some((s) => s.key === 'close'), 'suggests a close-out');
  eq(r.data.reuse.filter((x) => x.id === onboarding.id), []);
  eq((await call('kabir', '/api/v0/workflows/intel', { definition: def })).status, 403);

  // Design: give the brand step to a person by name, add an approval branch, a review; save and publish.
  def.steps[4].assign = { by: 'person', personId: P.kabir };
  r = await call('kedab', `/api/v0/workflows/${wid}`, { name: 'Client onboarding', definition: def, trigger: { kind: 'manual' } }); eq(r.status, 200);
  eq((await call('kedab', `/api/v0/workflows/${wid}`, { name: 'x', definition: { steps: [{ title: 'Which?', kind: 'decision' }] }, trigger: { kind: 'manual' } })).status, 400);
  eq((await call('kedab', `/api/v0/workflows/${wid}`, { name: 'x', definition: def, trigger: { kind: 'milestone' } })).status, 400);
  eq((await call('vikram', `/api/v0/workflows/${wid}/start`, { projectId: project })).status, 400, 'not live yet');
  r = await call('kedab', `/api/v0/workflows/${wid}/publish`, {}); eq(r.data.version, 1);
  r = await call('kabir', '/api/v0/workflows'); eq(r.data.workflows.map((w) => w.name), ['Client onboarding'], 'live workflows are everyone\'s to read');
  eq((await call('kabir', `/api/v0/workflows/${wid}/start`, { projectId: project })).status, 403, 'members do not start runs');

  // A PGS (pod head) starts a run on the project: the first step is a task for a PGS.
  r = await call('vikram', `/api/v0/workflows/${wid}/start`, { projectId: project }); eq(r.status, 200); const rid = r.data.id;
  r = await call('vikram', `/api/v0/workflows/runs/${rid}`); eq(r.status, 200);
  eq(r.data.run.status, 'running'); eq(r.data.steps[0].status, 'active'); ok(['Asha Rao', 'Vikram Jivop'].includes(r.data.steps[0].person), r.data.steps[0].why);
  const first = r.data.steps[0];
  r = await call('kedab', `/api/v0/workflows/task/${first.taskId}`); eq(r.data.step.position, 1); eq(r.data.step.workflow, 'Client onboarding'); eq(r.data.step.of, 8);
  // Give the first step to Vikram explicitly, then walk the run to the approval.
  r = await call('kedab', `/api/v0/workflows/steps/${first.id}/assign`, { personId: P.vikram }); ok(r.data.assigned || r.data.unchanged, JSON.stringify(r.data));
  for (let i = 0; i < 5; i++) {
    const s = (await call('kedab', `/api/v0/workflows/runs/${rid}`)).data.steps.find((x) => x.status === 'active');
    await done('kedab', s.taskId);
  }
  r = await call('kedab', `/api/v0/workflows/runs/${rid}`);
  const approval = r.data.steps.find((s) => s.status === 'active'); eq(approval.key, 's6'); eq(approval.choices, ['Approved', 'Send back']); eq(approval.canDecide, true);
  eq(r.data.steps[4].person, 'Kabir Mifos', 'the brand step went to the person named on it');
  eq((await call('kabir', `/api/v0/workflows/steps/${approval.id}/decide`, { choice: 'Approved' })).status, 403);
  eq((await call('kedab', `/api/v0/workflows/steps/${approval.id}/decide`, { choice: 'Send back', note: 'Tone is off' })).status, 200);
  r = await call('kedab', `/api/v0/workflows/runs/${rid}`); eq(r.data.steps.find((s) => s.status === 'active').key, 's4'); eq(r.data.steps[5].outcome, 'Send back');

  // The runs list: one running, where it stands.
  r = await call('kedab', '/api/v0/workflows/runs?status=running'); eq(r.data.counts.running, 1); eq(r.data.runs[0].active[0].key, 's4');
  r = await call('kabir', '/api/v0/workflows/runs'); eq(r.data.runs.length, 1, 'Kabir had a step in it');
  r = await call('ishaan', '/api/v0/workflows/runs'); eq(r.data.runs.length, 0, 'others do not see it');
  eq((await call('ishaan', `/api/v0/workflows/runs/${rid}/cancel`, {})).status, 404);
  eq((await call('kedab', `/api/v0/workflows/runs/${rid}/cancel`, { note: 'Client paused' })).status, 200);
  r = await call('kedab', `/api/v0/workflows/runs/${rid}`); eq(r.data.run.status, 'cancelled'); eq(r.data.run.cancelNote, 'Client paused');
  eq((await call('kedab', `/api/v0/workflows/${wid}/status`, { status: 'paused' })).data.status, 'paused');
  eq((await call('vikram', `/api/v0/workflows/${wid}/start`, {})).status, 400, 'a paused workflow does not start');

  // WORKFLOW BUILDER (0530): a board with two tabs joined by a hand-off; a wire whose types do not match is refused; a test
  // run goes to whoever holds the role, its checklist is ticked, it hands over, and it stays out of the live runs.
  eq((await call('kabir', '/api/v0/workflows/boards', { name: 'X' })).status, 403);
  r = await call('kedab', '/api/v0/workflows/blocks'); ok(r.data.blocks.length >= 15 && r.data.types.lead === 'Lead', 'the block list');
  r = await call('kedab', '/api/v0/workflows/boards', { name: 'Quote to install', firstTab: 'Sales', role: 'PGS' }); eq(r.status, 200); const bid = r.data.id;
  r = await call('kedab', `/api/v0/workflows/boards/${bid}/tabs`, { name: 'Site team', role: 'Graphic Designer', start: 'handoff' }); eq(r.status, 200); const site = r.data.id;
  r = await call('kedab', `/api/v0/workflows/boards/${bid}`); eq(r.data.tabs.map((t) => t.name), ['Sales', 'Site team']); const sales = r.data.tabs[0].id;
  eq(r.data.tabs[1].definition.steps[0].module, 'handoff_in');
  r = await call('kedab', `/api/v0/workflows/${sales}`, { name: 'Sales', trigger: { kind: 'manual' }, definition: { steps: [
    { id: 'a', title: 'Lead', module: 'lead_capture', next: [{ to: 'f', port: 'lead' }] }, { id: 'f', title: 'Follow', module: 'follow_up' }] } });
  eq(r.status, 400); ok(/adapter/.test(r.data.error), r.data.error);
  r = await call('kedab', `/api/v0/workflows/${sales}`, { name: 'Sales', trigger: { kind: 'manual' }, definition: { steps: [
    { id: 'b1', title: 'Lead capture', module: 'lead_capture', kind: 'task', next: [{ to: 'b2', port: 'lead' }] },
    { id: 'b2', title: 'Brief', module: 'checklist', kind: 'task', role: 'PGS', assign: { by: 'role', role: 'PGS' }, detail: '• One\n• Two', next: [{ to: 'b3', port: 'done' }] },
    { id: 'b3', title: 'To the site team', module: 'handoff', kind: 'task', handoff: { workflowId: site }, next: [] }] } });
  eq(r.status, 200);
  eq((await call('kabir', `/api/v0/workflows/${sales}/test`, { projectId: project })).status, 403);
  r = await call('kedab', `/api/v0/workflows/${sales}/test`, { projectId: project }); eq(r.status, 200); const test = r.data.id;
  r = await call('kedab', `/api/v0/workflows/waiting?mode=test&board=${bid}`); const item = r.data.items.find((i) => i.runId === test);
  eq(item.checklist, ['One', 'Two']); ok(item.person, 'the block goes to whoever holds PGS'); eq(item.values.find((v) => v.key === 'record.project')?.value, 'Pilot project');
  eq((await call('kedab', `/api/v0/workflows/steps/${item.id}/check`, { index: 1 })).data.checks, [1]);
  eq((await call('kabir', '/api/v0/workflows/waiting?mode=test')).status, 403);
  eq((await call('kedab', `/api/v0/workflows/steps/${item.id}/test-done`, { values: { note: 'Called' } })).status, 200);
  r = await call('kedab', `/api/v0/workflows/test-runs/${test}`); eq(r.data.runs.map((x) => [x.workflow, x.status]), [['Sales', 'done'], ['Site team', 'done']], 'handed over to the site tab');
  r = await call('kedab', '/api/v0/workflows/runs'); ok(!r.data.runs.some((x) => x.id === test), 'test runs stay out of the live runs');
  eq((await call('kedab', '/api/v0/workflows/waiting')).status, 200);
  r = await call('kabir', '/api/v0/workflows/boards'); eq(r.data.boards.length, 1); eq(r.data.boards[0].tabs, [], 'members do not see draft tabs');

  // Stop stops the whole test: the site tab now waits on a person, and stopping the finished sales run stops it too.
  r = await call('kedab', `/api/v0/workflows/${site}`, { name: 'Site team', trigger: { kind: 'manual' }, definition: { steps: [
    { id: 'in', title: 'From sales', module: 'handoff_in', kind: 'task', next: [{ to: 'v', port: 'lead' }] },
    { id: 'v', title: 'Visit', module: 'checklist', kind: 'task', role: 'PGS', assign: { by: 'role', role: 'PGS' }, next: [] }] } }); eq(r.status, 200);
  r = await call('kedab', `/api/v0/workflows/${sales}/test`, { projectId: project }); const t2 = r.data.id;
  const brief2 = (await call('kedab', `/api/v0/workflows/waiting?mode=test&run=${t2}`)).data.items[0];
  eq((await call('kedab', `/api/v0/workflows/steps/${brief2.id}/test-done`, {})).status, 200);
  r = await call('kedab', `/api/v0/workflows/test-runs/${t2}`); eq(r.data.runs.map((x) => x.status), ['done', 'running'], 'the site tab waits');
  eq((await call('kedab', `/api/v0/workflows/test-runs/${t2}/stop`, {})).status, 200);
  r = await call('kedab', `/api/v0/workflows/test-runs/${t2}`); eq(r.data.runs.map((x) => x.status), ['done', 'cancelled'], 'stopping the test stops its hand-offs');

  // SOPs into blocks: leadership reads the Drive SOPs by folder, in the folder's order; each SOP becomes a Checklist block.
  eq((await call('kabir', '/api/v0/workflows/sop-sources')).status, 403);
  r = await call('kedab', '/api/v0/workflows/sop-sources'); eq(r.status, 200);
  const srcs = r.data.sources.filter((s) => s.folder === 'My Drive / SOPs'); eq(srcs.map((s) => s.name), ['#1 - PGS Workflow', '#2 - Visit SOP']);
  eq((await call('kedab', '/api/v0/workflows/sop-blocks', { sourceIds: [] })).status, 400);
  eq((await call('kabir', '/api/v0/workflows/sop-blocks', { sourceIds: srcs.map((s) => s.id) })).status, 403);
  r = await call('kedab', '/api/v0/workflows/sop-blocks', { sourceIds: srcs.map((s) => s.id).reverse() }); eq(r.status, 200);
  eq(r.data.blocks.length, srcs.reduce((n, s) => n + s.parts.length, 0)); eq(r.data.blocks[0].source, '#1 - PGS Workflow', 'in the folder order');
  ok(r.data.blocks.every((b) => b.detail && b.detail.split('\n').every((l) => l.startsWith('• '))), 'each SOP step is a line of the checklist');

  await writeFile(process.env.TEST_REPORT, JSON.stringify({ checks }));
  console.log(`workflow-runner: ${checks} checks`);
} finally { await app.close(); await pool.end(); }
