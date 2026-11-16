// AC-PLAN-TOOLS (owner, 13 Nov 2026; the AC handoff of 13 Nov, section 3): apply_plan, get_goal_tree, blockers and
// "waiting on", folders by path, whoami's scopes, briefs on get_*, decisions and the workflow log, over API v1 and MCP on
// real PostgreSQL and tenant row security. Synthetic people and words only. Run by tests/core/test_plan_import.py.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const W = JSON.parse(process.env.TEST_W);
const pool = new Pool({ ...JSON.parse(process.env.TEST_API_CONFIG), max: 3 }), app = createApp(pool, pool);
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const json = r => { try { return r.json(); } catch { return r.body; } };
async function api(token, method, url, payload, { status } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (method !== 'GET') headers['idempotency-key'] = randomUUID();
  const r = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });
  if (status !== undefined) { assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`); checks++; }
  return { status: r.statusCode, body: json(r) };
}
const get = (t, url, o) => api(t, 'GET', url, undefined, o);
const post = (t, url, body, o) => api(t, 'POST', url, body, o);
async function rpc(token, method, params = {}) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/mcp', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    payload: { jsonrpc: '2.0', id: 1, method, params } });
  assert.equal(r.statusCode, 200, r.body);
  const v = r.body.split('\n').filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5))).find(x => x.id === 1);
  return v.result ?? v;
}

const MEETING = '# Synthetic meeting, 1 Jan 2026\n\nWe agreed the first flow.\n\n## Decisions\n\n| # | Decision |\n|---|---|\n| D1 | Flow one first |\n';
const plan = (over = {}) => ({
  title: 'Synthetic plan', key: 'synthetic-plan', notify: 'digest',
  folders: [{ key: 'f-plan', path: 'Synthetic plans/Launch plan', access: 'people', people: ['@plan.editor'] }],
  docs: [{ key: 'doc-meeting', title: 'Synthetic meeting notes', folder: 'f-plan', markdown: MEETING, category: 'Meeting notes', tags: ['meeting', 'plan'] }],
  goals: [{ key: 'G1', title: 'Synthetic launch ready', why: 'Customers wait; working first, then better.', level: 'company', targetOn: '2026-12-31', brief: 'doc-meeting',
    projects: [
      { id: W.project, key: 'P-pilot', docs: ['doc-meeting'] },
      { key: 'P1', name: 'Synthetic flow one', summary: 'One whole flow, polished to base level.', owner: '@plan.admin', dueOn: '2026-12-20', brief: 'doc-meeting',
        tasks: [
          { key: 'T1', title: 'Synthetic write the flow', assignee: '@plan.editor', priority: 'high', dueOn: '2026-12-10', notes: 'Screen by screen.',
            checklist: ['Synthetic step one', { label: 'Synthetic step two', done: true }],
            subtasks: [{ key: 'T1.1', title: 'Synthetic step one', assignee: '@plan.editor', subtasks: [{ key: 'T1.1.1', title: 'Synthetic tiny step', assignee: '@plan.editor' }] }] },
          { key: 'T2', title: 'Synthetic polish the flow', assignee: '@plan.editor', blockedBy: ['T1'] },
          { key: 'T3', title: 'Synthetic wait for the folder', assignee: '@plan.admin', waitingOn: '@plan.editor2: send the synthetic folder' },
          { key: 'T4', title: 'Synthetic wait for a device', assignee: '@plan.admin', waitingOn: 'A synthetic device from outside' },
        ] },
    ] }],
  decisions: [
    { key: 'D1', kind: 'decision', ref: 'D1', text: 'Flow one first', saidBy: 'Synthetic lead', saidOn: '2026-01-01', quote: 'flow one first', doc: 'doc-meeting', goal: 'G1', drives: ['T1'] },
    { key: 'O1', kind: 'question', ref: 'O1', text: 'Home or not?', status: 'open', owner: '@plan.admin', doc: 'doc-meeting' },
  ],
  ...over,
});

try {
  // ------------------------------------------------------------------ whoami: granted and missing areas, and how to add them
  const me = (await get(W.narrow, '/api/v1/people/me', { status: 200 })).body;
  ok(me.scopes.granted.includes('tasks.write') && me.scopes.missing.includes('docs.write') && /Connected apps/.test(me.scopes.how), 'whoami lists granted and missing areas and how to add them');
  eq((await get(W.admin, '/api/v1/people/me')).body.scopes.missing.includes('docs.write'), false, 'a full key misses no docs area');

  // ------------------------------------------------------------------ dry run: everything happens, then nothing stays
  const dry = (await post(W.admin, '/api/v1/projects/plans', plan({ dryRun: true, goals: [{ ...plan().goals[0], key: 'G1', title: 'Synthetic dry goal' }] }), { status: 200 })).body;
  ok(dry.dryRun === true && dry.counts.task.created >= 6 && dry.goals[0].projects.length === 2, 'a dry run returns the whole tree it would write');
  const dryGoal = dry.keys.find(k => k.kind === 'goal').id;
  await get(W.admin, `/api/v1/projects/goals/${dryGoal}/tree`, { status: 404 });

  // ------------------------------------------------------------------ the real thing, in one call
  const first = (await post(W.admin, '/api/v1/projects/plans', plan(), { status: 200 })).body;
  eq([first.dryRun, first.counts.goal.created, first.counts.project.created, first.counts.doc.created, first.counts.decision.created], [false, 1, 1, 1, 2], 'made once');
  ok(first.counts.task.created === 7, `seven tasks (six and the wait task): ${JSON.stringify(first.counts.task)}`);
  ok(first.counts.notified === 2 && first.changeId, 'one digest per person (the editor and editor 2), recorded once');
  const ids = Object.fromEntries(first.keys.map(k => [`${k.kind}:${k.key}`, k.id]));
  const tree = (await get(W.admin, `/api/v1/projects/goals/${ids['goal:G1']}/tree`, { status: 200 })).body.goal;
  eq([tree.key, tree.title, tree.brief?.title, tree.projects.map(p => p.key).sort()], ['G1', 'Synthetic launch ready', 'Synthetic meeting notes', ['P-pilot', 'P1'].sort()], 'the goal, its brief and both projects');
  const p1 = tree.projects.find(p => p.key === 'P1');
  eq([p1.summary, p1.brief?.title], ['One whole flow, polished to base level.', 'Synthetic meeting notes'], 'a project has its summary and brief');
  const t1 = p1.tasks.find(t => t.key === 'T1'), t2 = p1.tasks.find(t => t.key === 'T2'), t3 = p1.tasks.find(t => t.key === 'T3'), t4 = p1.tasks.find(t => t.key === 'T4');
  eq(t1.steps, [{ label: 'Synthetic step one', done: false }, { label: 'Synthetic step two', done: true }], 'checklist steps, the ticked one ticked');
  eq([t1.subtasks[0].key, t1.subtasks[0].subtasks[0].key], ['T1.1', 'T1.1.1'], 'sub-tasks three levels deep');
  eq([t2.status, t2.blockedBy.map(b => b.id)], ['blocked', [t1.id]], 'T2 waits on T1');
  ok(t3.status === 'blocked' && t3.blockedBy.length === 1 && /synthetic folder/.test(t3.blockedBy[0].title), 'waitingOn @person makes their task and waits on it');
  eq(t4.status, 'blocked', 'waitingOn outside words marks it blocked');
  ok(tree.decisions.some(d => d.ref === 'D1' && d.kind === 'decision') && tree.decisions.some(d => d.ref === 'O1' && d.status === 'open'), 'decisions and open questions come back');

  // ------------------------------------------------------------------ waiting on
  const wait = (await get(W.editorToken, '/api/v1/tasks/waiting', { status: 200 })).body;
  ok(wait.waitingOn.some(x => x.taskId === t2.id && x.on.id === t1.id), 'the editor waits on T1 for T2');
  ok(wait.waitingOnMe.some(x => x.taskId === t1.id && x.waiter.id === t2.id), 'and T1 holds up T2');
  const adminWait = (await get(W.admin, '/api/v1/tasks/waiting')).body;
  ok(adminWait.waitingOn.some(x => x.taskId === t4.id && x.on.kind === 'outside'), 'outside waits are listed');
  // Finishing the blocker unblocks the waiter by itself.
  const t9 = (await post(W.admin, '/api/v1/tasks', { title: 'Synthetic blocker to clear', assigneeId: W.adminId }, { status: 200 })).body;
  await post(W.admin, `/api/v1/tasks/${t4.id}/blockers`, { blockerId: t9.id }, { status: 200 });
  await api(W.admin, 'DELETE', `/api/v1/tasks/${t4.id}/blockers/${t9.id}`, undefined, { status: 200 });

  // ------------------------------------------------------------------ again: idempotent, by key
  const again = (await post(W.admin, '/api/v1/projects/plans', plan(), { status: 200 })).body;
  eq([again.counts.goal.created, again.counts.project.created, again.counts.task.created, again.counts.doc.created, again.counts.decision.created, again.counts.folder.created], [0, 0, 0, 0, 0, 0], 'nothing twice');
  eq(again.keys.map(k => k.id).sort(), first.keys.map(k => k.id).sort(), 'the same records');
  ok(again.counts.notified === 0, 'no digest when no task is new');
  const changed = (await post(W.admin, '/api/v1/projects/plans', plan({ goals: [{ ...plan().goals[0], title: 'Synthetic launch ready now' }] }), { status: 200 })).body;
  eq([changed.counts.goal.updated, changed.goals[0].title], [1, 'Synthetic launch ready now'], 'a changed field is changed in place');

  // ------------------------------------------------------------------ one refusal: nothing changes
  const bad = await post(W.admin, '/api/v1/projects/plans', { goals: [{ key: 'G-bad', title: 'Synthetic half plan', projects: [{ key: 'P-bad', name: 'Synthetic half', tasks: [{ key: 'T-bad', title: 'x', assignee: '@nobody.here' }] }] }] });
  ok(bad.status === 400 && /nobody\.here/.test(bad.body.detail), `a bad assignee refuses the plan: ${JSON.stringify(bad.body)}`);
  const none = await post(W.admin, '/api/v1/projects/plans', { goals: [{ key: 'G-bad', title: 'Synthetic half plan' }], dryRun: true });
  eq(none.body.counts.goal.created, 1, 'and left no goal behind (the key is still free)');
  ok((await post(W.admin, '/api/v1/projects/plans', { goals: [{ title: 'No key' }] })).status === 400, 'every item needs a key or an id');

  await post(W.admin, '/api/v1/projects/plans', { projects: [{ id: W.otherProject, key: 'foreign-project', summary: 'Synthetic forbidden change' }] }, { status: 404 });
  await get(W.admin, `/api/v1/projects/${W.otherProject}`, { status: 404 });

  // ------------------------------------------------------------------ scopes: a key without docs neither writes nor reads them
  const noDocs = await post(W.narrow, '/api/v1/projects/plans', plan());
  ok(noDocs.status === 403 && /docs\.write/.test(noDocs.body.detail), 'a plan with docs needs docs.write');
  const narrowTask = (await get(W.narrow, `/api/v1/tasks/${t1.id}`, { status: 200 })).body;
  eq([narrowTask.brief, narrowTask.docs], [null, []], 'no docs.read: no brief words');
  const narrowTree = (await get(W.narrow, `/api/v1/projects/goals/${ids['goal:G1']}/tree`, { status: 200 })).body.goal;
  eq([narrowTree.brief, narrowTree.docs, narrowTree.decisions], [null, [], []], 'no docs.read also hides decisions sourced from a doc');
  const fullProject = (await get(W.admin, `/api/v1/projects/${ids['project:P1']}`, { status: 200 })).body;
  ok(fullProject.brief?.title === 'Synthetic meeting notes' && /first flow/.test(fullProject.brief.markdown), 'get_project brings its brief\'s words');
  const goalRead = (await get(W.admin, `/api/v1/projects/goals/${ids['goal:G1']}`, { status: 200 })).body;
  eq(goalRead.brief?.id, ids['doc:doc-meeting'], 'get_goal brings its brief');

  // ------------------------------------------------------------------ folders by path, private to chosen people
  const f = (await post(W.admin, '/api/v1/docs/folders/ensure', { path: 'Synthetic plans/Launch plan' }, { status: 200 })).body;
  eq([f.created, f.folder.id, f.folder.access], [false, ids['folder:f-plan'], 'people'], 'the same folder, private');
  const made = (await post(W.admin, '/api/v1/docs/folders/ensure', { path: 'Synthetic plans/Second', access: 'people', people: [W.editorId] }, { status: 200 })).body;
  ok(made.created && made.folder.people.some(p => p.personId === W.editorId), 'a new private folder for chosen people');
  // The included editor reads it; editor 2 stays excluded under row security.
  const included = await get(W.editorToken, `/api/v1/docs/${ids['doc:doc-meeting']}`);
  eq(included.status, 200, 'the editor is one of the folder\'s people');

  await get(W.excludedToken, `/api/v1/docs/${ids['doc:doc-meeting']}`, { status: 404 });
  const excludedTree = (await get(W.excludedToken, `/api/v1/projects/goals/${ids['goal:G1']}/tree`, { status: 200 })).body.goal;
  eq([excludedTree.brief, excludedTree.docs, excludedTree.decisions], [null, [], []], 'private brief and its decisions stay out of an excluded member tree');
  const excludedFolders = (await get(W.excludedToken, '/api/v1/docs/folders', { status: 200 })).body;
  ok(!JSON.stringify(excludedFolders).includes(ids['folder:f-plan']), 'excluded member cannot list the private folder');

  // Two immediate assignments and two silent assignments, verified against persisted notices by Python.
  for (const mode of ['now', 'none']) {
    await post(W.admin, '/api/v1/projects/plans', { notify: mode, tasks: [1, 2].map(n => ({
      key: `notify-${mode}-${n}`, title: `Synthetic ${mode} assignment ${n}`, assignee: W.editor2Id,
    })) }, { status: 200 });
  }

  const restricted = await post(W.admin, '/api/v1/projects/plans', { docs: [{ id: ids['doc:doc-meeting'], access: 'private' }] }, { status: 200 });
  eq(restricted.body.counts.doc.updated, 1, 'changing only doc access updates the existing doc');
  await get(W.editorToken, `/api/v1/docs/${ids['doc:doc-meeting']}`, { status: 404 });
  await post(W.admin, '/api/v1/projects/plans', { docs: [{ id: ids['doc:doc-meeting'], access: 'company' }] }, { status: 200 });

  // ------------------------------------------------------------------ MCP: the same operations as tools
  const tools = (await rpc(W.admin, 'tools/list')).tools.map(t => t.name);
  for (const n of ['apply_plan', 'get_goal_tree', 'list_waiting', 'block_task', 'unblock_task', 'ensure_doc_folder', 'log_workflow_run', 'list_workflow_runs']) ok(tools.includes(n), `MCP has ${n}`);
  const viaMcp = await rpc(W.admin, 'tools/call', { name: 'get_goal_tree', arguments: { goalId: ids['goal:G1'] } });
  ok(!viaMcp.isError && JSON.parse(viaMcp.content[0].text).goal.key === 'G1', 'get_goal_tree over MCP');
  const mcpPlan = await rpc(W.admin, 'tools/call', { name: 'apply_plan', arguments: { ...plan(), dryRun: true, requestId: randomUUID() } });
  ok(!mcpPlan.isError && JSON.parse(mcpPlan.content[0].text).counts.task.created === 0, 'apply_plan over MCP (a dry re-run makes nothing new)');

  // ------------------------------------------------------------------ the workflow log (T7.2)
  const run = { lane: 'SYNTHETIC-LANE', workflow: 'Synthetic plan import', startedAt: '2026-01-01T10:00:00Z', endedAt: '2026-01-01T10:42:00Z', outcome: 'partial',
    steps: [{ name: 'Read the brief', minutes: 10, ok: true }, { name: 'Land', minutes: 32, ok: false, note: 'gate held' }],
    failures: [{ step: 'Land', what: 'cooldown held the gate', why: 'CPU guard', fix: 'run at night' }], why: 'The gate waited.', lesson: 'Land small slices early.', runKey: 'synthetic-run-1' };
  await post(W.admin, '/api/v1/projects/workflow-runs', { ...run, runKey: 'synthetic-missing-task', taskId: randomUUID() }, { status: 404 });
  const r1 = (await post(W.admin, '/api/v1/projects/workflow-runs', run, { status: 200 })).body;
  const r2 = (await post(W.admin, '/api/v1/projects/workflow-runs', run, { status: 200 })).body;
  eq([r1.created, r2.created, r2.id], [true, false, r1.id], 'a run key makes a retry change nothing');
  const runs = (await get(W.admin, '/api/v1/projects/workflow-runs?lane=SYNTHETIC-LANE', { status: 200 })).body.items;
  eq([runs.length, runs[0].durationS, runs[0].lesson], [1, 2520, 'Land small slices early.'], 'the run, its duration and its lesson');

  // The editor's notices (one digest for the plan's tasks) are counted by the Python side as the owner.
  console.log(JSON.stringify({ ok: true, checks, editorNotices: 1 }));
} finally {
  await app.close();
  await pool.end();
}
