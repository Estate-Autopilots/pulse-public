import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, leadership, type Tx, type Viewer } from './routes.js';
import { orgRoles, roleHolders } from './sops.js';
import { parseSop } from './sop-parse.js';
import { BLOCKS, PORT_TYPES, specOf } from './workflow-blocks.js';
import type { WorkflowDef, WorkflowStep } from './workflow-model.js';

/** WORKFLOW BUILDER (owner, 18 Oct 2026; 0530): boards of workflows, one tab per person's or role's job, built from
 *  blocks on a canvas and joined by Hand-off blocks; what waits for each person; and test runs, which follow a workflow
 *  as it is now on a copy of a real project's values, as the people it would go to, without a task or a message.
 *  Leadership and admins design and test (as in workflows.ts); everyone sees what waits for them. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const optId = (x: unknown) => x === undefined || x === null || x === '' ? null : id(x);
const body = { type: 'object' } as const;
const str = (x: unknown, max = 200) => typeof x === 'string' ? x.trim().slice(0, max) : '';
const PHOTO = (a: string) => `(select ph.updated_at from pulse.person_photo ph where ph.person_id=${a}.id)`;
const editorOnly = (v: Viewer) => { if (!leadership(v)) fail(403, 'Leadership and admins design workflows'); };
/** A block's checklist: the lines of its SOP ("How", one point per line). */
const lines = (detail: string | null | undefined) => (detail ?? '').split('\n').map((l) => l.replace(/^\s*(•|-|\*|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 40);

/** A new tab starts with the block its runs start from: a lead, or the work another tab hands over. */
function firstBlock(start: 'lead' | 'handoff') {
  const spec = BLOCKS.find((b) => b.module === (start === 'handoff' ? 'handoff_in' : 'lead_capture'))!;
  return { id: 'b1', title: spec.label, module: spec.module, kind: spec.kind, detail: spec.checklist.map((l) => `• ${l}`).join('\n'), assign: { by: 'starter' }, pos: { x: 40, y: 120 }, next: [] };
}

async function tabsOf(c: PoolClient, where: string, params: unknown[]) {
  return (await c.query(`select w.id,w.name,w.purpose,w.status,w.version,w.definition,w.trigger,w.board_id "boardId",w.board_position "position",w.sop_id "sopId",w.client_id "clientId",w.tab_role "tabRole",w.tab_person_id "tabPersonId",
     p.display_name "tabPerson",${PHOTO('p')} "tabPhotoAt",w.updated_at "updatedAt",w.published_at "publishedAt",
     (select count(*)::int from pulse.workflow_run r where r.workflow_id=w.id and r.mode='live' and r.status='running') running
   from pulse.workflow w left join pulse.person p on p.id=w.tab_person_id where ${where} order by w.board_position nulls last,w.created_at`, params)).rows;
}

async function listBoards(c: PoolClient, v: Viewer) {
  const boards = (await c.query(`select b.id,b.name,b.purpose,b.status,b.updated_at "updatedAt" from pulse.workflow_board b where b.status='active' or $1 order by b.status='active' desc,b.updated_at desc`, [leadership(v)])).rows;
  const tabs = boards.length ? await tabsOf(c, 'w.board_id=any($1)', [boards.map((b) => b.id)]) : [];
  return { canEdit: leadership(v), boards: boards.map((b) => ({ ...b, tabs: tabs.filter((t) => t.boardId === b.id).map(({ definition, trigger, ...t }) => { void trigger;
    const d = definition as WorkflowDef; return { ...t, blocks: d.steps.length, modules: [...new Set(d.steps.map((s) => specOf(s).module))] }; }) })) };
}

/** The step states of test runs, newest first: drawn on the canvas, and the run the tester follows. */
async function testRuns(c: PoolClient, where: string, params: unknown[], limit = 12) {
  const runs = (await c.query(`select r.id,r.name,r.status,r.workflow_id "workflowId",w.name "workflow",r.started_at "startedAt",r.finished_at "finishedAt",r.parent_run_id "parentRunId",
     r.context,coalesce(pr.title,pr.name) "project",r.project_id "projectId",cl.display_name "client",sb.display_name "startedBy"
   from pulse.workflow_run r join pulse.workflow w on w.id=r.workflow_id left join pulse.project pr on pr.id=r.project_id left join pulse.client cl on cl.id=r.client_id
   left join pulse.person sb on sb.id=r.started_by where r.mode='test' and ${where} order by r.started_at desc limit ${limit}`, params)).rows;
  if (!runs.length) return [];
  const steps = (await c.query(`select s.run_id "runId",s.id,s.step_key "key",s.position,s.title,s.kind,s.status,s.outcome,s.note,s.assign_why "why",s.checks,s.started_at "startedAt",s.done_at "doneAt",
     p.id "personId",p.display_name "person",${PHOTO('p')} "photoAt"
   from pulse.workflow_run_step s left join pulse.person p on p.id=s.test_person where s.run_id=any($1) order by s.position`, [runs.map((r) => r.id)])).rows;
  return runs.map((r) => ({ ...r, steps: steps.filter((s) => s.runId === r.id) }));
}

async function readBoard(c: PoolClient, v: Viewer, bid: string) {
  const board = (await c.query('select id,name,purpose,status,updated_at "updatedAt" from pulse.workflow_board where id=$1', [bid])).rows[0] ?? fail(404, 'Board not found');
  const tabs = await tabsOf(c, 'w.board_id=$1 and (w.status<>$2 or $3)', [bid, 'archived', false]);
  const defs = tabs.map((t) => t.definition as WorkflowDef);
  const roles = [...new Set(defs.flatMap((d) => d.steps.flatMap((s) => [s.role, s.assign?.by === 'role' ? s.assign.role : null])).filter((r): r is string => !!r))];
  const named = [...new Set([...defs.flatMap((d) => d.steps.flatMap((s) => [s.personId, s.assign?.personId])), ...tabs.map((t) => t.tabPersonId)].filter(Boolean))] as string[];
  const persons = named.length ? (await c.query(`select p.id,p.display_name name,${PHOTO('p')} "photoAt",pp.pod,pp.role from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=any($1)`, [named])).rows : [];
  const forms = (await c.query(`select id,name,fields from pulse.field_form where status='live' order by name`)).rows
    .map((f) => ({ id: f.id, name: f.name, photo: (f.fields as { type: string }[]).some((x) => x.type === 'photo'), fields: (f.fields as { key: string; label: string; type: string }[]).map((x) => ({ key: x.key, label: x.label, type: x.type })) }));
  const others = (await c.query(`select w.id,w.name,w.status,b.name "board" from pulse.workflow w left join pulse.workflow_board b on b.id=w.board_id where w.status<>'archived' order by w.board_id=$1 desc nulls last,w.name limit 200`, [bid])).rows;
  const can = (await c.query('select pulse.workflow_can_start(null) ok')).rows[0].ok as boolean;
  const categories = (await c.query('select key,label from pulse.work_category where active order by label')).rows;
  return { canEdit: leadership(v), canStart: can, board, blocks: BLOCKS, types: PORT_TYPES, categories, forms, workflows: others,
    tabs: tabs.map(({ trigger, ...t }) => ({ ...t, trigger })), people: await roleHolders(c, roles), persons,
    tests: leadership(v) ? await testRuns(c, 'w.board_id=$1', [bid]) : [] };
}

/** What waits for a person: live steps whose task is theirs (or that they were asked to take), or, in test runs, the
 *  blocks that would be theirs. Leadership may look as anyone; everyone else sees their own. */
async function waiting(c: PoolClient, v: Viewer, q: { mode?: string; as?: string; board?: string; run?: string }) {
  const test = q.mode === 'test';
  if (test) editorOnly(v);
  const as = q.as ? id(q.as) : test ? null : v.person;
  if (!test && as !== v.person && !leadership(v)) fail(403, 'Leadership sees what waits for someone else');
  if (!as && !test) return { items: [] };
  const params: unknown[] = [as]; const where = [`s.status='active' and r.status='running'`];
  if (test) { where.push(`r.mode='test'`); if (as) where.push('s.test_person=$1'); else where.push('$1::uuid is null'); }
  else where.push(`r.mode='live' and (coalesce(t.assignee_person_id,t.owner_id)=$1 or (s.asked_id=$1 and t.assignee_person_id is null)) and t.status not in ('done','accepted','cancelled')`);
  if (q.board) { params.push(id(q.board)); where.push(`w.board_id=$${params.length}`); }
  if (test && q.run) {
    params.push(id(q.run));
    where.push(`r.id in (with recursive down(id,n) as (select $${params.length}::uuid,0 union all select x.id,down.n+1 from pulse.workflow_run x join down on x.parent_run_id=down.id where down.n<20) select id from down)`);
  }
  const rows = (await c.query(`select s.id,s.run_id "runId",s.step_key "key",s.position,s.title,s.kind,s.started_at "startedAt",s.due_at "dueAt",s.late_at is not null or s.due_at<now() late,
     s.checks,s.assign_why "why",s.task_id "taskId",t.status "taskStatus",r.name "run",r.project_id "projectId",r.context,r.definition,r.workflow_id "workflowId",coalesce(w.name,r.name) "workflow",w.board_id "boardId",b.name "board",
     p.id "personId",p.display_name "person",${PHOTO('p')} "photoAt"
   from pulse.workflow_run_step s join pulse.workflow_run r on r.id=s.run_id left join pulse.workflow w on w.id=r.workflow_id left join pulse.workflow_board b on b.id=w.board_id
   left join pulse.task t on t.id=s.task_id left join pulse.person p on p.id=${test ? 's.test_person' : 'coalesce(t.assignee_person_id,t.owner_id,s.asked_id)'}
   where ${where.join(' and ')} order by s.due_at nulls last,s.started_at limit 100`, params)).rows;
  return { items: await Promise.all(rows.map(async ({ definition, context, ...s }) => {
    const d = (definition as WorkflowDef).steps.find((x) => x.id === s.key) as WorkflowStep | undefined;
    const spec = specOf({ module: d?.module, kind: s.kind });
    const labels = (d?.next ?? []).map((n) => n.label).filter((x): x is string => !!x);
    const canFill = !test && !!d?.formId && (await c.query('select pulse.form_step_fillable($1) ok', [s.id])).rows[0].ok as boolean;
    // The values the block takes in: the run's values (a copy of the record, earlier blocks' outputs), short.
    const values = Object.entries((context ?? {}) as Record<string, unknown>).filter(([, x]) => x !== null && typeof x !== 'object').slice(0, 24).map(([k, x]) => ({ key: k, value: String(x).slice(0, 200) }));
    return { ...s, module: spec.module, block: spec.label, engine: spec.engine, link: spec.link ?? null, checklist: lines(d?.detail), formId: d?.formId ?? null, canFill, values,
      outputs: spec.outputs.filter((o) => o.type !== 'any').map((o) => ({ key: o.key, label: o.label, type: o.type })),
      choices: s.kind === 'approval' ? (labels.length ? labels : ['Approved', 'Send back']) : s.kind === 'decision' ? labels : [] };
  })) };
}

/** A copy of a real record's values for a test run: what the project and its client say, never their contacts. */
async function snapshot(c: PoolClient, projectId: string | null, clientId: string | null) {
  const out: Record<string, string> = {};
  if (projectId) {
    const p = (await c.query(`select coalesce(pr.title,pr.name) name,pr.status,cl.display_name client,o.display_name owner from pulse.project pr left join pulse.client cl on cl.id=pr.client_id
      left join pulse.work_project wp on wp.project_id=pr.id left join pulse.person o on o.id=wp.owner_id where pr.id=$1`, [projectId])).rows[0] ?? fail(404, 'Project not found');
    Object.assign(out, Object.fromEntries(Object.entries({ 'record.project': p.name, 'record.status': p.status, 'record.client': p.client, 'record.owner': p.owner }).filter(([, x]) => x)));
  }
  if (clientId) {
    const cl = (await c.query('select display_name name from pulse.client where id=$1', [clientId])).rows[0] ?? fail(404, 'Client not found');
    out['record.client'] = cl.name;
  }
  out['record.copied'] = new Date().toISOString();
  return out;
}

/** SOPs into blocks: the Drive documents the Drive refresh found (pulse.sop_source, as in From Drive), by folder, in the
 *  order the folder numbers them ("#1", "#2", ...). Each SOP a document reads as becomes one Checklist block: its steps
 *  are the block's checklist and its owner's role does it. Nothing is saved here; the builder adds the blocks to the
 *  tab's draft. */
const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
function folderOf(path: string | null, name: string) {
  const p = (path ?? '').split('/').map((x) => x.trim()).filter(Boolean);
  if (p.length && p[p.length - 1] === name.trim()) p.pop();
  return p.join(' / ') || 'Drive';
}
async function sopSources(c: PoolClient) {
  const known = (await orgRoles(c)).map((r) => r.role);
  const rows = (await c.query(`select id,name,path,status,body from pulse.sop_source where status<>'gone' limit 300`)).rows;
  return { sources: rows.map((r) => ({ id: r.id as string, name: r.name as string, folder: folderOf(r.path, r.name), status: r.status as string,
    parts: parseSop({ title: r.name, text: r.body, knownRoles: known }).map((p) => ({ title: p.title, steps: p.doc.steps.length, ownerRole: p.ownerRole })) }))
    .sort((a, b) => natural(a.folder, b.folder) || natural(a.name, b.name)) };
}
async function sopBlocks(c: PoolClient, raw: unknown) {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map(id))].slice(0, 40);
  if (!ids.length) fail(400, 'Choose the SOPs to bring in');
  const rows = (await c.query(`select id,name,path,body from pulse.sop_source where id=any($1) and status<>'gone'`, [ids])).rows;
  if (rows.length !== ids.length) fail(404, 'One of those SOPs is no longer listed');
  const known = (await orgRoles(c)).map((r) => r.role);
  return { blocks: rows.sort((a, b) => natural(folderOf(a.path, a.name), folderOf(b.path, b.name)) || natural(a.name, b.name)).flatMap((r) => parseSop({ title: r.name, text: r.body, knownRoles: known }).map((p) => {
    const roles = p.doc.steps.map((s) => s.role).filter((x): x is string => !!x);
    const role = p.ownerRole ?? roles.sort((a, b) => roles.filter((x) => x === b).length - roles.filter((x) => x === a).length)[0] ?? null;
    const steps = p.doc.steps.map((s) => `• ${s.title}`.slice(0, 300));
    return { title: (p.title || r.name).slice(0, 300), detail: steps.slice(0, 40).join('\n') || null, role, source: r.name as string, cut: steps.length > 40 };
  })) };
}

export function registerWorkflowBoardRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/workflows/blocks', (req) => tx(req, async () => ({ blocks: BLOCKS, types: PORT_TYPES })));
  app.get('/api/v0/workflows/boards', (req) => tx(req, (c, v) => listBoards(c, v)));
  app.post<{ Body: Body }>('/api/v0/workflows/boards', { schema: { body } }, (req) => tx(req, async (c, v) => {
    editorOnly(v);
    const name = str(req.body.name); if (!name) fail(400, 'Name the board');
    const bid = (await c.query('select pulse.workflow_board_save(null,$1) id', [JSON.stringify({ name, purpose: str(req.body.purpose, 2000) || null })])).rows[0].id as string;
    const first = str(req.body.firstTab, 200) || 'Sales';
    const wid = (await c.query('select pulse.workflow_save(null,$1) id', [JSON.stringify({ name: first, definition: { steps: [firstBlock('lead')] }, trigger: { kind: 'manual' } })])).rows[0].id;
    await c.query('select pulse.workflow_board_tab($1,$2)', [wid, JSON.stringify({ boardId: bid, position: 1, role: str(req.body.role, 80) || null, personId: optId(req.body.personId) })]);
    return { id: bid };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/workflows/boards/:id', (req) => tx(req, (c, v) => readBoard(c, v, id(req.params.id))));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/workflows/boards/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    editorOnly(v);
    const name = str(req.body.name); if (!name) fail(400, 'Name the board');
    const status = req.body.status === 'archived' ? 'archived' : 'active';
    await c.query('select pulse.workflow_board_save($1,$2)', [id(req.params.id), JSON.stringify({ name, purpose: str(req.body.purpose, 2000) || null, status })]);
    return { ok: true };
  }));
  // A new tab: a blank workflow whose first block is a lead (or what another tab hands over), or an existing workflow.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/workflows/boards/:id/tabs', { schema: { body } }, (req) => tx(req, async (c, v) => {
    editorOnly(v);
    const bid = id(req.params.id);
    let wid = optId(req.body.workflowId);
    if (!wid) {
      const name = str(req.body.name); if (!name) fail(400, 'Name the workflow');
      wid = (await c.query('select pulse.workflow_save(null,$1) id', [JSON.stringify({ name, definition: { steps: [firstBlock(req.body.start === 'handoff' ? 'handoff' : 'lead')] }, trigger: { kind: 'manual' } })])).rows[0].id;
    }
    await c.query('select pulse.workflow_board_tab($1,$2)', [wid, JSON.stringify({ boardId: bid, role: str(req.body.role, 80) || null, personId: optId(req.body.personId) })]);
    return { id: wid };
  }));
  // Whose job a tab is, its place on the board, or off the board (boardId null).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/workflows/:id/tab', { schema: { body } }, (req) => tx(req, async (c, v) => {
    editorOnly(v);
    const position = req.body.position === undefined || req.body.position === null ? null : Number(req.body.position);
    if (position !== null && !(Number.isInteger(position) && position >= 1 && position <= 50)) fail(400, 'Choose a place for the tab');
    await c.query('select pulse.workflow_board_tab($1,$2)', [id(req.params.id), JSON.stringify({ boardId: optId(req.body.boardId), position, role: str(req.body.role, 80) || null, personId: optId(req.body.personId) })]);
    return { ok: true };
  }));

  // Test mode: the workflow as it is now, on a copy of a project's (or client's) values. No task, nothing sent.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/workflows/:id/test', { schema: { body } }, (req) => tx(req, async (c, v) => {
    editorOnly(v);
    const projectId = optId(req.body.projectId), clientId = optId(req.body.clientId);
    const context = { ...(await snapshot(c, projectId, clientId)), 'test.as': str(req.body.asName, 120) || null };
    const rid = (await c.query('select pulse.workflow_test_start($1,$2) id', [id(req.params.id), JSON.stringify({ projectId, clientId, name: str(req.body.name, 300) || null, context })])).rows[0].id;
    return { id: rid };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/workflows/test-runs/:id', (req) => tx(req, async (c, v) => {
    editorOnly(v);
    const rid = id(req.params.id);
    // The run and the runs its hand-offs started (and theirs), so the tester follows the work from tab to tab.
    const ids = (await c.query(`with recursive down(id,n) as (select $1::uuid,0 union all select r.id,down.n+1 from pulse.workflow_run r join down on r.parent_run_id=down.id where down.n<20) select id from down`, [rid])).rows.map((r) => r.id);
    const runs = await testRuns(c, 'r.id=any($1)', [ids], 25);
    if (!runs.length) fail(404, 'Run not found');
    return { runs: runs.reverse() };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/workflows/test-runs/:id/stop', (req) => tx(req, async (c, v) => {
    editorOnly(v);
    const r = (await c.query(`select mode from pulse.workflow_run where id=$1`, [id(req.params.id)])).rows[0] ?? fail(404, 'Run not found');
    if (r.mode !== 'test') fail(400, 'Only a test run is stopped here');
    // The whole test stops: the run it started from and every run its hand-offs started.
    const runs = (await c.query(`with recursive up(id,parent,n) as (select id,parent_run_id,0 from pulse.workflow_run where id=$1 union all
        select x.id,x.parent_run_id,up.n+1 from pulse.workflow_run x join up on x.id=up.parent where up.n<20),
      root as (select id from up order by n desc limit 1),
      down(id,n) as (select id,0 from root union all select x.id,down.n+1 from pulse.workflow_run x join down on x.parent_run_id=down.id where down.n<20)
      select r.id from down join pulse.workflow_run r on r.id=down.id where r.mode='test' and r.status='running'`, [req.params.id])).rows;
    for (const x of runs) await c.query('select pulse.workflow_run_cancel($1,$2)', [x.id, 'Test stopped']);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/workflows/steps/:id/test-done', { schema: { body } }, (req) => tx(req, async (c) => {
    const raw = req.body.values && typeof req.body.values === 'object' && !Array.isArray(req.body.values) ? req.body.values as Record<string, unknown> : {};
    const values = Object.fromEntries(Object.entries(raw).filter(([k, x]) => /^[a-z_]{1,24}$/.test(k) && (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')).slice(0, 12)
      .map(([k, x]) => [k, typeof x === 'string' ? x.trim().slice(0, 500) : x]));
    await c.query('select pulse.workflow_test_done($1,$2,$3)', [id(req.params.id), str(req.body.choice, 80) || null, JSON.stringify(values)]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/workflows/steps/:id/check', { schema: { body } }, (req) => tx(req, async (c) => {
    // The database finds the step (and who may tick it) before it reads the line.
    const n = Number(req.body.index); const index = Number.isInteger(n) && n >= 0 && n < 40 ? n : null;
    const checks = (await c.query('select pulse.workflow_step_check($1,$2,$3) c', [id(req.params.id), index, req.body.done !== false])).rows[0].c as number[];
    return { checks };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/workflows/steps/:id/retry', (req) => tx(req, async (c, v) => {
    editorOnly(v);
    await c.query('select pulse.workflow_step_retry($1)', [id(req.params.id)]);
    return { ok: true };
  }));
  app.get('/api/v0/workflows/sop-sources', (req) => tx(req, async (c, v) => { editorOnly(v); return sopSources(c); }));
  app.post<{ Body: Body }>('/api/v0/workflows/sop-blocks', { schema: { body } }, (req) => tx(req, async (c, v) => { editorOnly(v); return sopBlocks(c, req.body.sourceIds); }));
  app.get<{ Querystring: { mode?: string; as?: string; board?: string; run?: string } }>('/api/v0/workflows/waiting', (req) => tx(req, (c, v) => waiting(c, v, req.query)));
}
