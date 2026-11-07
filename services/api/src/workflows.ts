import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, leadership, type Tx, type Viewer } from './routes.js';
import { normalizeDoc, type SopDoc } from './sop-model.js';
import { submissionRows } from './forms.js';
import { roleHolders } from './sops.js';
import { assignOrAsk } from './work.js';
import { advise, loadFacts } from './workflow-intel.js';
import { fromSop, normalizeTrigger, normalizeWorkflow, triggerWords, type Trigger, type WorkflowDef } from './workflow-model.js';

/** SOP-WORKFLOW part 2: workflows leadership designs (from an SOP or blank) and their runs on the task engine (0241).
 *  Leadership and admins design, publish and pause; leadership, HR, pod heads and project owners start runs; whoever
 *  does an approval answers it; Pip advises while designing (workflow-intel.ts). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const optId = (x: unknown) => x === undefined || x === null || x === '' ? null : id(x);
const body = { type: 'object' } as const;
const editor = (v: Viewer) => leadership(v);
const str = (x: unknown, max = 200) => typeof x === 'string' ? x.trim().slice(0, max) : '';
const PHOTO = (a: string) => `(select ph.updated_at from pulse.person_photo ph where ph.person_id=${a}.id)`;

async function categoryLabels(c: PoolClient) {
  return Object.fromEntries((await c.query('select key,label from pulse.work_category where active order by label')).rows.map((r) => [r.key, r.label])) as Record<string, string>;
}
const triggerText = (t: Trigger, cats: Record<string, string>, forms: Record<string, string> = {}) => triggerWords(t, { category: (k) => cats[k] ?? null, form: t.formId ? forms[t.formId] ?? null : null });

type Active = { id: string; title: string; position: number; kind: string; startedAt: string; dueAt: string | null; late: boolean; stuck: string | null;
  person: string | null; personId: string | null; photoAt: string | null; [k: string]: unknown };
export type RunRowT = { id: string; name: string; status: string; projectId: string | null; project: string | null; workflow: string; finishedAt: string | null;
  active: Active[]; late: number; stuck: string | null; [k: string]: unknown };

/** Runs with where each one stands: active steps (who, since when, due), late steps and why a run is stuck. */
export async function runRows(c: PoolClient, where: string, params: unknown[], limit = 100): Promise<RunRowT[]> {
  const runs = (await c.query(`select r.id,r.name,r.status,r.started_at "startedAt",r.finished_at "finishedAt",r.started_via "via",r.project_id "projectId",r.client_id "clientId",
     w.id "workflowId",w.name "workflow",coalesce(pr.title,pr.name) "project",cl.display_name "client",sb.display_name "startedBy",
     (select count(*)::int from pulse.workflow_run_step s where s.run_id=r.id) steps,(select count(*)::int from pulse.workflow_run_step s where s.run_id=r.id and s.status in ('done','skipped')) done
   from pulse.workflow_run r join pulse.workflow w on w.id=r.workflow_id left join pulse.project pr on pr.id=r.project_id left join pulse.client cl on cl.id=r.client_id
   left join pulse.person sb on sb.id=r.started_by where r.mode='live' and ${where} order by r.status='running' desc,r.started_at desc limit ${limit}`, params)).rows;
  if (!runs.length) return [];
  const active = (await c.query(`select s.run_id "runId",s.id,s.step_key "key",s.position,s.title,s.kind,s.started_at "startedAt",s.due_at "dueAt",s.late_at is not null or s.due_at<now() late,
     s.asked_id is not null and t.assignee_person_id is null "asked",s.note,s.assign_why "why",t.id "taskId",t.status "taskStatus",p.id "personId",p.display_name "person",${PHOTO('p')} "photoAt",
     ap.display_name "askedName",t.pool_scope is not null and t.assignee_person_id is null "pooled"
   from pulse.workflow_run_step s left join pulse.task t on t.id=s.task_id left join pulse.person p on p.id=coalesce(t.assignee_person_id,t.owner_id) left join pulse.person ap on ap.id=s.asked_id
   where s.run_id=any($1) and s.status='active' order by s.position`, [runs.map((r) => r.id)])).rows;
  return runs.map((r) => {
    const mine = active.filter((a) => a.runId === r.id).map((a) => ({ ...a, stuck: stuckWhy(a) }));
    return { ...r, active: mine, late: mine.filter((a) => a.late).length, stuck: mine.find((a) => a.stuck)?.stuck ?? null };
  });
}
/** Why a step holds its run up, in words, or null when it is simply in progress. */
function stuckWhy(a: { kind: string; personId: string | null; asked: boolean; askedName: string | null; pooled: boolean; taskStatus: string | null; late: boolean; note: string | null; startedAt: string }) {
  if (a.kind === 'wait') return null;
  if (a.note && /could not move on/i.test(a.note)) return a.note;
  if (a.taskStatus === 'cancelled') return 'Its task was cancelled';
  if (a.taskStatus === 'blocked') return 'Blocked';
  if (a.asked) return `Waiting for ${a.askedName?.split(' ')[0] ?? 'someone'} to accept`;
  if (a.pooled) return 'In the pool: nobody has claimed it';
  if (!a.personId) return 'Nobody to do it: choose someone';
  if (a.late) return 'Past its SLA';
  if (Date.now() - Date.parse(a.startedAt) > 7 * 86400000 && a.taskStatus === 'open') return 'Not started in a week';
  return null;
}

async function listWorkflows(c: PoolClient, v: Viewer) {
  const cats = await categoryLabels(c);
  const rows = (await c.query(`select w.id,w.name,w.purpose,w.status,w.trigger,w.version,w.definition,w.updated_at "updatedAt",w.published_at "publishedAt",w.sop_id "sopId",s.title "sopTitle",cl.display_name "clientName",
     (select count(*)::int from pulse.workflow_run r where r.workflow_id=w.id and r.mode='live' and r.status='running') running,(select count(*)::int from pulse.workflow_run r where r.workflow_id=w.id and r.mode='live' and r.status='done') finished,
     (select count(*)::int from pulse.workflow_run_step st join pulse.workflow_run r on r.id=st.run_id where r.workflow_id=w.id and r.mode='live' and r.status='running' and st.status='active' and st.due_at<now()) late,w.board_id "boardId"
   from pulse.workflow w left join pulse.sop s on s.id=w.sop_id left join pulse.client cl on cl.id=w.client_id where w.status<>'archived' or $1 order by w.status='live' desc,w.updated_at desc`, [editor(v)])).rows;
  const can = (await c.query('select pulse.workflow_can_start(null) ok')).rows[0].ok as boolean;
  return { canEdit: editor(v), canStart: can, workflows: rows.map(({ definition, trigger, ...r }) => { const d = definition as WorkflowDef;
    return { ...r, trigger: triggerText(trigger as Trigger, cats), triggerKind: (trigger as Trigger).kind, steps: d.steps.length, roles: [...new Set(d.steps.map((s) => s.role).filter(Boolean))],
      shape: d.steps.map((s) => ({ id: s.id, title: '', kind: s.kind, role: s.role, personId: s.personId, phase: s.phase, next: s.next })) }; }) };
}

async function readWorkflow(c: PoolClient, v: Viewer, wid: string) {
  const w = (await c.query(`select w.*,s.title "sopTitle",cl.display_name "clientName",pb.display_name "publishedByName" from pulse.workflow w left join pulse.sop s on s.id=w.sop_id
   left join pulse.client cl on cl.id=w.client_id left join pulse.person pb on pb.id=w.published_by where w.id=$1`, [wid])).rows[0] ?? fail(404, 'Workflow not found');
  const def = w.definition as WorkflowDef; const cats = await categoryLabels(c);
  const roles = [...new Set(def.steps.flatMap((s) => [s.role, s.assign?.by === 'role' ? s.assign.role : null]).filter((r): r is string => !!r))];
  const named = [...new Set(def.steps.flatMap((s) => [s.personId, s.assign?.personId]).filter(Boolean))] as string[];
  const persons = named.length ? (await c.query(`select p.id,p.display_name name,${PHOTO('p')} "photoAt",pp.pod,pp.role from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=any($1)`, [named])).rows : [];
  const runs = await runRows(c, 'r.workflow_id=$1', [wid], 30);
  const versions = (await c.query(`select v.version,v.published_at "publishedAt",p.display_name "publishedBy" from pulse.workflow_version v left join pulse.person p on p.id=v.published_by where v.workflow_id=$1 order by v.version desc limit 20`, [wid])).rows;
  const can = (await c.query('select pulse.workflow_can_start(null) ok')).rows[0].ok as boolean;
  return { canEdit: editor(v), canStart: can && w.status === 'live', categories: Object.entries(cats).map(([key, label]) => ({ key, label })),
    workflow: { id: w.id, name: w.name, purpose: w.purpose, status: w.status, definition: def, trigger: w.trigger, triggerText: triggerText(w.trigger, cats), version: w.version,
      sopId: w.sop_id, sopTitle: w.sopTitle, clientId: w.client_id, clientName: w.clientName, publishedAt: w.published_at, publishedBy: w.publishedByName, updatedAt: w.updated_at },
    people: await roleHolders(c, roles), persons, runs, versions };
}

async function readRun(c: PoolClient, v: Viewer, rid: string) {
  const r = (await runRows(c, 'r.id=$1', [rid], 1))[0] ?? fail(404, 'Run not found');
  const run = (await c.query(`select definition,context,started_by,cancel_note,(select display_name from pulse.person where id=cancelled_by) "cancelledBy" from pulse.workflow_run where id=$1`, [rid])).rows[0];
  const steps = (await c.query(`select s.id,s.step_key "key",s.position,s.title,s.kind,s.status,s.outcome,s.note,s.rounds,s.assign_why "why",s.started_at "startedAt",s.due_at "dueAt",s.done_at "doneAt",
     s.late_at is not null or (s.status='active' and s.due_at<now()) late,s.task_id "taskId",t.status "taskStatus",p.id "personId",p.display_name "person",${PHOTO('p')} "photoAt",ap.display_name "askedName",
     t.pool_scope is not null and t.assignee_person_id is null "pooled",s.asked_id is not null and t.assignee_person_id is null "asked",
     s.status='active' and s.kind in ('approval','decision') and (pulse.sop_editor() or $2::uuid=(select started_by from pulse.workflow_run where id=s.run_id) or (s.task_id is not null and pulse.task_can_edit(s.task_id))) "canDecide"
   from pulse.workflow_run_step s left join pulse.task t on t.id=s.task_id left join pulse.person p on p.id=coalesce(t.assignee_person_id,t.owner_id) left join pulse.person ap on ap.id=s.asked_id
   where s.run_id=$1 order by s.position`, [rid, v.person])).rows;
  const def = run.definition as WorkflowDef;
  const choices = (key: string) => (def.steps.find((s) => s.id === key)?.next ?? []).map((n) => n.label).filter((x): x is string => !!x);
  const canCancel = r.status === 'running' && (editor(v) || run.started_by === v.person || (r.projectId ? (await c.query('select pulse.work_project_can_manage($1) ok', [r.projectId])).rows[0].ok : false));
  const ids = [...new Set(steps.map((s) => s.personId).filter(Boolean))] as string[];
  const roles = [...new Set(def.steps.map((s) => s.role).filter((x): x is string => !!x))];
  return { run: { ...r, cancelNote: run.cancel_note, cancelledBy: run.cancelledBy, context: run.context }, definition: def, canCancel,
    steps: await Promise.all(steps.map(async (s) => { const formId = def.steps.find((x) => x.id === s.key)?.formId ?? null;
      return { ...s, formId, canFill: !!formId && s.status === 'active' && (await c.query('select pulse.form_step_fillable($1) ok', [s.id])).rows[0].ok,
        stuck: s.status === 'active' ? stuckWhy(s) : null, choices: s.kind === 'approval' ? (choices(s.key).length ? choices(s.key) : ['Approved', 'Send back']) : s.kind === 'decision' ? choices(s.key) : [] }; })),
    submissions: await submissionRows(c, 's.run_id=$1', [rid], 50),
    people: await roleHolders(c, roles), persons: ids.length ? (await c.query(`select p.id,p.display_name name,${PHOTO('p')} "photoAt",pp.pod from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=any($1)`, [ids])).rows : [] };
}

function workflowInput(b: Body) {
  const n = normalizeWorkflow(b.definition); if ('error' in n) fail(400, n.error);
  const t = normalizeTrigger(b.trigger); if ('error' in t) fail(400, t.error);
  const name = str(b.name); if (!name) fail(400, 'Name the workflow');
  return { name, purpose: str(b.purpose, 2000) || null, sopId: optId(b.sopId), clientId: optId(b.clientId), definition: (n as { def: WorkflowDef }).def, trigger: t as Trigger };
}

export function registerWorkflowRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/workflows', (req) => tx(req, (c, v) => listWorkflows(c, v)));
  app.get<{ Params: { id: string } }>('/api/v0/workflows/:id', (req) => tx(req, (c, v) => readWorkflow(c, v, id(req.params.id))));
  app.post<{ Body: Body }>('/api/v0/workflows', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins design workflows');
    return { id: (await c.query('select pulse.workflow_save(null,$1) id', [JSON.stringify(workflowInput(req.body))])).rows[0].id };
  }));
  // A draft workflow from an SOP: every step keeps its owner by role (or the person it names).
  app.post<{ Body: Body }>('/api/v0/workflows/from-sop', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins design workflows');
    const s = (await c.query('select id,title,purpose,doc,client_id from pulse.sop where id=$1', [id(req.body.sopId)])).rows[0] ?? fail(404, 'SOP not found');
    const n = normalizeDoc(s.doc); const doc = 'error' in n ? { steps: [], phases: [], roles: [], outputs: [], watch: [] } as SopDoc : n.doc;
    if (!doc.steps.length) fail(400, 'This SOP has no steps yet');
    const def = fromSop(doc);
    return { id: (await c.query('select pulse.workflow_save(null,$1) id', [JSON.stringify({ name: s.title, purpose: s.purpose, sopId: s.id, clientId: s.client_id, definition: def, trigger: { kind: 'manual' } })])).rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/workflows/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins design workflows');
    const wid = id(req.params.id);
    await c.query('select pulse.workflow_save($1,$2)', [wid, JSON.stringify(workflowInput(req.body))]);
    return readWorkflow(c, v, wid);
  }));
  app.post<{ Params: { id: string } }>('/api/v0/workflows/:id/publish', (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins publish workflows');
    const version = (await c.query('select pulse.workflow_publish($1) v', [id(req.params.id)])).rows[0].v as number; return { version };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/workflows/:id/status', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins pause and archive workflows');
    const status = str(req.body.status, 10); if (!['live', 'paused', 'archived', 'draft'].includes(status)) fail(400, 'Choose live, paused, draft or archived');
    await c.query('select pulse.workflow_set_status($1,$2)', [id(req.params.id), status]); return { status };
  }));
  // Start a run by hand: on a project (or a client), with a name and starting values.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/workflows/:id/start', { schema: { body } }, (req) => tx(req, async (c) => {
    const context = req.body.context && typeof req.body.context === 'object' && !Array.isArray(req.body.context) ? req.body.context : {};
    const rid = (await c.query('select pulse.workflow_start($1,$2) id', [id(req.params.id), JSON.stringify({ projectId: optId(req.body.projectId), clientId: optId(req.body.clientId), name: str(req.body.name, 300) || null, context })])).rows[0].id;
    return { id: rid };
  }));
  // Pip while designing: people, time, what to watch per step; management steps; earlier workflows to reuse.
  app.post<{ Body: Body }>('/api/v0/workflows/intel', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins design workflows');
    const n = normalizeWorkflow(req.body.definition); if ('error' in n) fail(400, n.error);
    const def = (n as { def: WorkflowDef }).def;
    const focus = { stepId: str(req.body.stepId, 40) || undefined, personId: optId(req.body.personId) ?? undefined };
    const facts = await loadFacts(c, v, def, { projectId: optId(req.body.projectId), exclude: [optId(req.body.workflowId), optId(req.body.sopId)].filter((x): x is string => !!x), focusPerson: focus.personId ?? null, focusStep: focus.stepId ?? null });
    return advise(def, facts, focus);
  }));

  app.get<{ Querystring: { status?: string; projectId?: string; workflowId?: string } }>('/api/v0/workflows/runs', (req) => tx(req, async (c) => {
    const q = req.query; const where = ['true']; const params: unknown[] = [];
    if (q.status === 'running' || q.status === 'done' || q.status === 'cancelled') { params.push(q.status); where.push(`r.status=$${params.length}`); }
    if (q.projectId) { params.push(id(q.projectId)); where.push(`r.project_id=$${params.length}`); }
    if (q.workflowId) { params.push(id(q.workflowId)); where.push(`r.workflow_id=$${params.length}`); }
    const runs = await runRows(c, where.join(' and '), params, 200);
    const now = Date.now();
    // SLA breaches: every late step of a running run, latest first; and the runs held up, with why.
    const late = runs.filter((r) => r.status === 'running').flatMap((r) => r.active.filter((a) => a.late && a.dueAt).map((a) => ({ ...a, run: r.name, workflow: r.workflow, project: r.project, projectId: r.projectId,
      lateHours: Math.round(((now - Date.parse(a.dueAt as string)) / 3600000) * 10) / 10 }))).sort((a, b) => b.lateHours - a.lateHours);
    // Held up for a reason other than lateness (late steps have their own list).
    const stuck = runs.filter((r) => r.status === 'running' && r.active.some((x) => x.stuck && x.stuck !== 'Past its SLA')).map((r) => { const a = r.active.find((x) => x.stuck && x.stuck !== 'Past its SLA')!; return { runId: r.id, run: r.name, workflow: r.workflow, project: r.project,
      stepId: a.id, step: a.title, position: a.position, why: a.stuck, since: a.startedAt, person: a.person, personId: a.personId, photoAt: a.photoAt }; });
    // Where runs wait longest: finished steps of the last 120 days, by workflow and step (median hours, SLA, how often late).
    const slow = (await c.query(`select w.id "workflowId",w.name workflow,s.title,count(*)::int n,
       percentile_cont(0.5) within group(order by extract(epoch from s.done_at-s.started_at)/3600) hours,max(s.sla_hours)::float sla,count(*) filter(where s.late_at is not null)::int late
     from pulse.workflow_run_step s join pulse.workflow_run r on r.id=s.run_id join pulse.workflow w on w.id=r.workflow_id
     where r.mode='live' and s.status='done' and s.task_id is not null and s.started_at is not null and s.done_at>s.started_at and s.done_at>now()-interval '120 days'
     group by 1,2,3 having percentile_cont(0.5) within group(order by extract(epoch from s.done_at-s.started_at)/3600)>=0.25 or count(*) filter(where s.late_at is not null)>0
     order by count(*) filter(where s.late_at is not null)::float/count(*) desc,5 desc limit 8`)).rows.map((x) => ({ ...x, hours: Math.round(Number(x.hours) * 10) / 10 }));
    const week = runs.filter((r) => r.status === 'done' && r.finishedAt && now - Date.parse(r.finishedAt) < 7 * 86400000);
    return { runs, late, stuck, slow, counts: { running: runs.filter((r) => r.status === 'running').length, late: late.length, stuck: stuck.length, finishedWeek: week.length } };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/workflows/runs/:id', (req) => tx(req, (c, v) => readRun(c, v, id(req.params.id))));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/workflows/runs/:id/cancel', { schema: { body } }, (req) => tx(req, async (c) => {
    await c.query('select pulse.workflow_run_cancel($1,$2)', [id(req.params.id), str(req.body.note, 500) || null]); return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/workflows/steps/:id/decide', { schema: { body } }, (req) => tx(req, async (c) => {
    const choice = str(req.body.choice, 80); if (!choice) fail(400, 'Choose an answer');
    await c.query('select pulse.workflow_step_decide($1,$2,$3)', [id(req.params.id), choice, str(req.body.note, 500) || null]); return { ok: true };
  }));
  // Give a step's task to someone (or ask them, outside their domains), with the viewer's own rights.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/workflows/steps/:id/assign', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const s = (await c.query(`select s.task_id from pulse.workflow_run_step s where s.id=$1 and s.status='active'`, [id(req.params.id)])).rows[0] ?? fail(404, 'Step not found');
    if (!s.task_id) fail(400, 'This step has no task');
    return assignOrAsk(c, v, s.task_id, id(req.body.personId), str(req.body.note, 300) || null);
  }));
  // The workflow step a task belongs to (the task page shows its run and, for approvals, the answers).
  app.get<{ Params: { id: string } }>('/api/v0/workflows/task/:id', (req) => tx(req, async (c, v) => {
    const s = (await c.query(`select s.id,s.run_id "runId",s.position,s.kind,s.status,s.title,r.name "run",w.name "workflow",(select count(*)::int from pulse.workflow_run_step x where x.run_id=s.run_id) "of",
       r.definition,s.status='active' and s.kind in ('approval','decision') and (pulse.sop_editor() or r.started_by=$2::uuid or pulse.task_can_edit(s.task_id)) "canDecide"
     from pulse.workflow_run_step s join pulse.workflow_run r on r.id=s.run_id join pulse.workflow w on w.id=r.workflow_id where s.task_id=$1 order by s.started_at desc limit 1`, [id(req.params.id), v.person])).rows[0];
    if (!s) return { step: null };
    const ds = (s.definition as WorkflowDef).steps[s.position - 1];
    const labels = (ds?.next ?? []).map((n) => n.label).filter((x): x is string => !!x);
    const { definition, ...rest } = s; void definition;
    const fill = ds?.formId && s.status === 'active' ? (await c.query('select pulse.form_step_fillable($1) ok', [s.id])).rows[0].ok as boolean : false;
    return { step: { ...rest, formId: ds?.formId ?? null, canFill: fill, choices: s.kind === 'approval' ? (labels.length ? labels : ['Approved', 'Send back']) : s.kind === 'decision' ? labels : [] } };
  }));
}
