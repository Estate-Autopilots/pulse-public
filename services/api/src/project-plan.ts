import { ORG_TZ } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, work, type Tx, type Viewer } from './routes.js';

/** KAZUK (28 Oct 2026): delivery plans (migration 1385). A company's delivery template (pack data: stages, packages,
 *  categories with bandwidth units, steps with day offsets, gates and asset codes) turns a project's tasks into the
 *  numbers its Projects screens show: the stage it is in, progress, gates, Days in stage, the kick-off and ads-live
 *  clocks, the foundation check, creatives by asset code, and a lead's bandwidth. A company without a template sees
 *  projects without stages. Every word here comes from the template, never from code. */
const person = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own staff account to use Projects');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DUE = `(t.due_at at time zone ${ORG_TZ})::date`;

export type Step = { after?: string[]; id: string; stage: number; title: string; kind: string; start: number; end: number | null; owner: string; clientInput: boolean;
  packages: Record<string, string>; match?: string[]; checks?: string[]; asset?: string };
export type Template = { key: string; name: string; stages: { n: number; key: string; label: string }[]; packages: { key: string; label: string }[];
  categories: { key: string; label: string; units: number }[]; bandwidth: { role: string; short: string; healthy: [number, number]; max: number; note?: string };
  milestones: { adsLive?: string; foundation?: string; resultCheck?: string[]; script?: string }; creativeColumns?: string[]; labels?: Record<string, string>; targets?: { key: string; label: string; unit?: string; dueStep?: string }[]; steps: Step[] };
export type PlanTask = { id: string; title: string; step: string | null; phase: string | null; status: string; due: string | null; start: string | null; doneOn: string | null;
  who: string | null; whoId: string | null; role: string | null; source: string; notes?: string | null; parentId?: string | null; cstate?: string | null };
export type Plan = { templateKey: string; package: string | null; category: string | null; kickoff: string; targets?: Record<string, string> };

const OPEN = new Set(['open', 'in_progress', 'blocked', 'in_review', 'unknown']);
const DONE = new Set(['done', 'accepted']);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** What a project's tasks say about its plan. Pure, so it is unit-tested. */
export function planState(t: Template, plan: Plan, tasks: PlanTask[], today: string) {
  const byStep = new Map<string, PlanTask[]>();
  for (const x of tasks) if (x.step) byStep.set(x.step, [...(byStep.get(x.step) ?? []), x]);
  const stageOf = (x: PlanTask) => x.phase && /^s\d+$/.test(x.phase) ? Number(x.phase.slice(1)) : (x.step ? t.steps.find((s) => s.id === x.step)?.stage ?? null : null);
  const planned = tasks.filter((x) => stageOf(x) !== null && x.status !== 'cancelled');
  const stages = t.stages.map((s) => {
    const mine = planned.filter((x) => stageOf(x) === s.n);
    return { n: s.n, label: s.label, total: mine.length, done: mine.filter((x) => DONE.has(x.status)).length, late: mine.filter((x) => OPEN.has(x.status) && x.due && x.due < today).length };
  });
  // The stage is the first one with open dated work; ongoing work (no end day) does not hold a project back.
  const openDated = planned.filter((x) => OPEN.has(x.status) && x.due);
  const current = openDated.length ? Math.min(...openDated.map((x) => stageOf(x)!)) : planned.some((x) => OPEN.has(x.status)) ? Math.max(...planned.filter((x) => OPEN.has(x.status)).map((x) => stageOf(x)!)) : planned.length ? Math.max(...planned.map((x) => stageOf(x)!)) : 0;
  const before = planned.filter((x) => stageOf(x)! < current && x.doneOn).map((x) => x.doneOn!).sort();
  const enteredOn = before.at(-1) ?? plan.kickoff;
  const done = planned.filter((x) => DONE.has(x.status)).length;
  const firstOf = (id?: string) => id ? (byStep.get(id) ?? [])[0] ?? null : null;
  const ads = firstOf(t.milestones.adsLive), found = firstOf(t.milestones.foundation);
  const adsLiveOn = ads && DONE.has(ads.status) ? ads.doneOn : null;
  const adsPlanned = ads?.due ?? (t.steps.find((s) => s.id === t.milestones.adsLive)?.end != null ? plus(plan.kickoff, t.steps.find((s) => s.id === t.milestones.adsLive)!.end!) : null);
  const foundationDue = found?.due ?? null, foundationDone = !!found && DONE.has(found.status);
  const foundationLeft = foundationDue ? days(today, foundationDue) : null;
  const goLive = t.stages.length > 5 ? 5 : t.stages.length - 1;
  const foundationRisk = !!foundationDue && !foundationDone && (foundationLeft! < 0 || (foundationLeft! <= 10 && !adsLiveOn && current < goLive + 1));
  const gates = t.steps.filter((s) => s.kind === 'gate').map((s) => {
    const x = firstOf(s.id); const checks = (x?.notes ?? '').split('\n').filter((l) => /^\d+\.\s/.test(l)).length;
    return { id: s.id, label: s.title.replace(/^\S+\s/, ''), short: s.title.split(':')[0], stage: s.stage, taskId: x?.id ?? null, done: !!x && DONE.has(x.status),
      due: x?.due ?? null, stuck: !!x && OPEN.has(x.status) && !!x.due && days(x.due, today) > 3, checks };
  });
  const next = planned.filter((x) => OPEN.has(x.status) && stageOf(x) === current).sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))[0]
    ?? planned.filter((x) => OPEN.has(x.status)).sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))[0] ?? null;
  const waitingClient = planned.filter((x) => OPEN.has(x.status) && (x.status === 'in_review' || x.status === 'blocked') && (x.notes ?? '').startsWith('Needs the client')).length;
  return {
    stage: current, stageLabel: t.stages.find((s) => s.n === current)?.label ?? null, stageOf: Math.max(0, t.stages.length - 1),
    progress: planned.length ? Math.round((done / planned.length) * 100) : 0, steps: planned.length, stepsDone: done,
    daysInStage: Math.max(0, days(enteredOn, today)), dayN: days(plan.kickoff, today), kickoff: plan.kickoff,
    adsLiveOn, adsPlanned, foundationDue, foundationLeft, foundationRisk, stuckGate: gates.some((g) => g.stuck), gates, stages,
    next: next ? { id: next.id, step: next.step, title: next.title.replace(new RegExp(`^${next.step ?? '#'}\\s`), ''), who: next.who, due: next.due, late: !!next.due && next.due < today } : null,
    waitingClient,
  };
}

/** A lead's bandwidth: units of their active projects' categories, against the template's healthy and maximum load. */
export function bandwidth(t: Template, units: number) {
  const [, healthyTop] = t.bandwidth.healthy;
  const state = units > t.bandwidth.max ? 'over' : units > healthyTop ? 'max' : units >= t.bandwidth.healthy[0] ? 'healthy' : 'room';
  return { units: Math.round(units * 10) / 10, state };
}

/** Creatives: one card per asset code (MV-01, IMG-01 ...), in the template's columns, from the tasks' states. */
export function creatives(t: Template, tasks: PlanTask[], adsLive: boolean) {
  const cols = t.creativeColumns ?? ['Script', 'Making', 'Review', 'Ready', 'Live'];
  const script = t.milestones.script ? tasks.find((x) => x.step === t.milestones.script) : null;
  const scriptDone = !script || DONE.has(script.status);
  const count = new Map<string, number>();
  return tasks.filter((x) => x.step && t.steps.find((s) => s.id === x.step)?.asset && x.status !== 'cancelled').map((x) => {
    const pre = t.steps.find((s) => s.id === x.step)!.asset!; const n = (count.get(pre) ?? 0) + 1; count.set(pre, n);
    const at = (i: number) => cols[Math.min(i, cols.length - 1)];
    // Read from the task when nobody moved the card: the last column is live, the one before ready, review is the middle one.
    const wide = cols.length >= 7;
    const derived = DONE.has(x.status) ? (adsLive ? at(cols.length - 1) : at(cols.length - 2)) : x.status === 'in_review' ? at(wide ? 3 : 2)
      : !scriptDone && x.status === 'open' ? at(0) : x.status === 'in_progress' ? at(wide ? 2 : 1) : at(1);
    const state = x.cstate && cols.includes(x.cstate) ? x.cstate : derived;
    return { id: x.id, code: `${pre}-${String(n).padStart(2, '0')}`, title: x.title.replace(/^\S+\s/, ''), who: x.who, due: x.due, column: state };
  });
}

export async function templates(c: PoolClient): Promise<Template[]> {
  return (await c.query('select key,name,definition from pulse.delivery_template order by name')).rows.map((r) => ({ key: r.key, name: r.name, ...r.definition }) as Template);
}

/** Plans and their tasks for a set of projects (read under the viewer's row security). */
export async function plansFor(c: PoolClient, ids: string[]): Promise<Map<string, { plan: Plan; tasks: PlanTask[] }>> {
  if (!ids.length) return new Map();
  const plans = (await c.query(`select project_id id,template_key "templateKey",package,category,kickoff::text kickoff,targets from pulse.project_plan where project_id=any($1::uuid[])`, [ids])).rows;
  if (!plans.length) return new Map();
  const tasks = (await c.query(`select t.id,t.project_id "projectId",t.title,t.template_step step,t.phase_key phase,t.status,${DUE}::text due,t.work_on::text start,
      (coalesce(t.done_at,t.accepted_at) at time zone ${ORG_TZ})::date::text "doneOn",(select display_name from pulse.person where id=coalesce(t.assignee_person_id,t.owner_id)) who,
      coalesce(t.assignee_person_id,t.owner_id) "whoId",t.role_key role,t.source,t.notes,t.parent_id "parentId",(select cs.state from pulse.creative_state cs where cs.task_id=t.id) cstate
    from pulse.task t where t.project_id=any($1::uuid[]) and t.deleted_at is null`, [plans.map((p) => p.id)])).rows;
  const out = new Map<string, { plan: Plan; tasks: PlanTask[] }>();
  for (const p of plans) out.set(p.id, { plan: p, tasks: tasks.filter((x) => x.projectId === p.id) });
  return out;
}

export function registerProjectPlanRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // The company's delivery templates (for the plan dialog and the project page).
  app.get('/api/v0/projects/templates', req => tx(req, async (c, v) => { work(v); person(v); return { templates: (await templates(c)).map(({ steps, ...t }) => ({ ...t, steps: steps.length })) }; }));
  // One project's plan: stages, gates, clocks, its tasks with step and where they came from, creatives and the team by role.
  app.get<{ Params: { id: string } }>('/api/v0/projects/:id/plan', req => tx(req, async (c, v) => {
    work(v); person(v); const id = UUID.test(req.params.id) ? req.params.id : fail(400, 'Choose a valid record');
    const day = (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d as string;
    const all = await templates(c);
    const p = (await plansFor(c, [id])).get(id) ?? null;
    const tasks = (await c.query(`select t.id,t.title,t.template_step step,t.phase_key phase,t.status,${DUE}::text due,coalesce(t.work_on,(t.started_at at time zone ${ORG_TZ})::date)::text start,
        (coalesce(t.done_at,t.accepted_at) at time zone ${ORG_TZ})::date::text "doneOn",(select display_name from pulse.person where id=coalesce(t.assignee_person_id,t.owner_id)) who,
        coalesce(t.assignee_person_id,t.owner_id) "whoId",t.role_key role,t.source,t.notes,t.parent_id "parentId",
        (select display_name from pulse.person where id=t.created_by) "createdBy",(t.created_at at time zone ${ORG_TZ})::date::text "createdOn",
        (select cs.state from pulse.creative_state cs where cs.task_id=t.id) cstate
      from pulse.task t where t.project_id=$1 and t.deleted_at is null and t.status<>'cancelled' order by t.due_at nulls last,t.created_at limit 500`, [id])).rows;
    // Where a task came from: the chat it was sent in (the chats the viewer may read), else the plan, the quotation or by hand.
    const chats = tasks.length ? (await c.query(`select distinct on (a->>'task') a->>'task' task,ch.name channel,ch.kind,(select display_name from pulse.person where id=m.author_id) "by",
        (m.created_at at time zone ${ORG_TZ})::date::text "on"
      from pulse.chat_message m cross join lateral jsonb_array_elements(case when jsonb_typeof(m.attachments)='array' then m.attachments else '[]'::jsonb end) a
      join pulse.chat_channel ch on ch.id=m.channel_id
      where m.removed_at is null and a ? 'task' and a->>'task'=any($1::text[]) order by a->>'task',m.created_at`, [tasks.map((x) => x.id)])).rows : [];
    for (const x of tasks) x.chat = chats.find((m) => m.task === x.id) ?? null;
    const canRun = (await c.query('select pulse.project_can_run($1) ok', [id])).rows[0].ok as boolean;
    if (!p) return { today: day, plan: null, templates: all.map(({ steps, ...t }) => ({ ...t, steps: steps.length })), canRun, tasks };
    const t = all.find((x) => x.key === p.plan.templateKey) ?? fail(404, 'Delivery template not found');
    const s = planState(t, p.plan, p.tasks, day);
    // The team by role: whoever holds the project's planned work, grouped by the step owner's role.
    const team = new Map<string, Set<string>>();
    for (const x of tasks) if (x.role && x.who) team.set(x.role, (team.get(x.role) ?? new Set()).add(x.who));
    return { today: day, canRun, plan: { ...p.plan, template: { key: t.key, name: t.name, stages: t.stages, packages: t.packages, categories: t.categories, bandwidth: t.bandwidth, creativeColumns: t.creativeColumns ?? null, labels: t.labels ?? {}, targets: t.targets ?? [] } },
      state: s, creatives: creatives(t, tasks, !!s.adsLiveOn), team: [...team].map(([role, who]) => ({ role, people: [...who] })), tasks };
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/:id/plan', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const id = UUID.test(req.params.id) ? req.params.id : fail(400, 'Choose a valid record');
    if (!(await c.query('select 1 from pulse.project where id=$1 and deleted_at is null', [id])).rows[0]) fail(404, 'Project not found');
    if (!(await c.query('select pulse.project_can_run($1) ok', [id])).rows[0].ok) fail(403, 'Only the project\'s lead, its manager and leadership plan it');
    const b = req.body ?? {};
    const str = (x: unknown) => x === null || x === undefined || x === '' ? null : String(x).slice(0, 60);
    const kickoff = typeof b.kickoff === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.kickoff) ? b.kickoff : fail(400, 'Choose the kick-off day');
    const lead = b.leadId ? (UUID.test(String(b.leadId)) ? String(b.leadId) : fail(400, 'Choose a valid lead')) : null;
    return (await c.query('select pulse.project_plan_set($1,$2,$3,$4,$5,$6) r', [id, str(b.template), str(b.package), str(b.category), kickoff, lead])).rows[0].r;
  }));
  const exists = async (c: PoolClient, id: string) => { if (!(await c.query('select 1 from pulse.project where id=$1 and deleted_at is null', [id])).rows[0]) fail(404, 'Project not found'); };
  // Handover targets (screen 2): the template's list, values kept on the plan.
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/:id/targets', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const id = UUID.test(req.params.id) ? req.params.id : fail(400, 'Choose a valid record'); await exists(c, id);
    const t = req.body?.targets; const vals = t && typeof t === 'object' && !Array.isArray(t) ? Object.fromEntries(Object.entries(t as Record<string, unknown>).slice(0, 20).map(([k, x]) => [k.slice(0, 40), String(x ?? '').slice(0, 40)])) : {};
    return { targets: (await c.query('select pulse.project_targets_set($1,$2::jsonb) r', [id, JSON.stringify(vals)])).rows[0].r };
  }));
  // A creative's column on the board (Rough cut, 2 PM session ...).
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/:id/creative', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const id = UUID.test(req.params.id) ? req.params.id : fail(400, 'Choose a valid record'); await exists(c, id);
    const b = req.body ?? {}; const task = UUID.test(String(b.taskId ?? '')) ? String(b.taskId) : fail(400, 'Choose a valid task');
    if (!(await c.query('select 1 from pulse.task where id=$1 and project_id=$2', [task, id])).rows[0]) fail(404, 'Task not found');
    return (await c.query('select pulse.creative_move($1,$2) r', [task, String(b.state ?? '').slice(0, 40)])).rows[0].r;
  }));
  // Screen 3: the project a chat belongs to, and the plan step a task's words suggest (for /task's card).
  app.get<{ Params: { channel: string }; Querystring: { text?: string } }>('/api/v0/projects/for-chat/:channel', req => tx(req, async (c, v) => {
    work(v); person(v); const ch = UUID.test(req.params.channel) ? req.params.channel : fail(400, 'Choose a valid record');
    const p = (await c.query(`select p.id,coalesce(p.title,p.name) title from pulse.chat_group_info g join pulse.project p on p.id=g.project_id where g.channel_id=$1 and p.deleted_at is null`, [ch])).rows[0] ?? null;
    if (!p) return { project: null, step: null, steps: [] };
    const plan = (await plansFor(c, [p.id])).get(p.id); const t = plan ? (await templates(c)).find((x) => x.key === plan.plan.templateKey) : null;
    const text = String(req.query.text ?? '').toLowerCase().slice(0, 300);
    const sold = t ? t.steps.filter((s) => (s.packages[plan!.plan.package ?? ''] ?? 'no') !== 'no' && s.kind !== 'gate') : [];
    const hit = text ? sold.find((s) => (s.match ?? []).some((m) => text.includes(m.toLowerCase()))) ?? null : null;
    return { project: p, step: hit ? { id: hit.id, title: hit.title } : null, steps: sold.map((s) => ({ id: s.id, title: s.title })) };
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/:id/step', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const id = UUID.test(req.params.id) ? req.params.id : fail(400, 'Choose a valid record');
    if (!(await c.query('select 1 from pulse.project where id=$1 and deleted_at is null', [id])).rows[0]) fail(404, 'Project not found');
    const b = req.body ?? {}; const task = UUID.test(String(b.taskId ?? '')) ? String(b.taskId) : fail(400, 'Choose a valid task');
    if (!(await c.query('select 1 from pulse.task where id=$1 and project_id=$2', [task, id])).rows[0]) fail(404, 'Task not found');
    return (await c.query('select pulse.project_task_step($1,$2) r', [task, String(b.step ?? '').slice(0, 20)])).rows[0].r;
  }));
}
