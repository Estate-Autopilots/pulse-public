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
  packages: Record<string, string>; match?: string[]; checks?: string[]; asset?: string;
  /** PM-BUILD-1 (2262), template format 3: the step's type, the clock it counts from, its work hours, a condition, other
   *  days per package, a gate's inputs and what the document said that the fields do not hold. */
  type?: string; from?: ClockKey; hours?: [number, number]; when?: string; byPackage?: Record<string, { start: number; end: number | null }>; gateInputs?: string[]; note?: string };
export type ClockKey = 'start' | 'day0' | 'live' | 'bought';
export type Clock = { key: ClockKey; label: string; day?: number; step?: string; inputs?: string[] };
export type Template = { key: string; name: string; stages: { n: number; key: string; label: string }[]; packages: { key: string; label: string }[];
  categories: { key: string; label: string; units: number }[]; bandwidth: { role: string; short: string; healthy: [number, number]; max: number; note?: string };
  milestones: { adsLive?: string; foundation?: string; resultCheck?: string[]; script?: string }; creativeColumns?: string[]; labels?: Record<string, string>; targets?: { key: string; label: string; unit?: string; dueStep?: string }[]; steps: Step[];
  format?: number; version?: number; clocks?: Clock[]; windows?: { key: string; label: string; from: ClockKey; start: number; end: number }[] };
export type PlanTask = { id: string; title: string; step: string | null; phase: string | null; status: string; due: string | null; start: string | null; doneOn: string | null;
  who: string | null; whoId: string | null; role: string | null; source: string; notes?: string | null; parentId?: string | null; cstate?: string | null };
export type Plan = { templateKey: string; package: string | null; category: string | null; kickoff: string; targets?: Record<string, string>;
  templateVersion?: number | null; day0On?: string | null; day0By?: string | null; liveOn?: string | null; liveBy?: string | null };

const OPEN = new Set(['open', 'in_progress', 'blocked', 'in_review', 'unknown']);
const DONE = new Set(['done', 'accepted']);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** What a project's tasks say about its plan. Pure, so it is unit-tested. */
export function planState(t: Template, plan: Plan, tasks: PlanTask[], today: string) {
  const stepOf = new Map(t.steps.map((s) => [s.id, s]));
  const typeOf = (id: string | null) => (id ? stepOf.get(id)?.type ?? stepOf.get(id)?.kind : null) ?? 'task';
  // PM-BUILD-1: running work (an ongoing or repeating step that has started) is never late and never counted as open.
  const running = (x: PlanTask) => x.status === 'in_progress' && ['ongoing', 'repeating'].includes(typeOf(x.step));
  const isLate = (x: PlanTask) => OPEN.has(x.status) && !!x.due && x.due < today && !running(x);
  const byStep = new Map<string, PlanTask[]>();
  for (const x of tasks) if (x.step) byStep.set(x.step, [...(byStep.get(x.step) ?? []), x]);
  const stageOf = (x: PlanTask) => x.phase && /^s\d+$/.test(x.phase) ? Number(x.phase.slice(1)) : (x.step ? t.steps.find((s) => s.id === x.step)?.stage ?? null : null);
  const planned = tasks.filter((x) => stageOf(x) !== null && x.status !== 'cancelled');
  const stages = t.stages.map((s) => {
    const mine = planned.filter((x) => stageOf(x) === s.n);
    return { n: s.n, label: s.label, total: mine.length, done: mine.filter((x) => DONE.has(x.status)).length, late: mine.filter(isLate).length, running: mine.filter(running).length };
  });
  // The stage is the first one with open dated work; ongoing work (no end day) does not hold a project back.
  const openDated = planned.filter((x) => OPEN.has(x.status) && x.due && !running(x));
  const current = openDated.length ? Math.min(...openDated.map((x) => stageOf(x)!)) : planned.some((x) => OPEN.has(x.status)) ? Math.max(...planned.filter((x) => OPEN.has(x.status)).map((x) => stageOf(x)!)) : planned.length ? Math.max(...planned.map((x) => stageOf(x)!)) : 0;
  const before = planned.filter((x) => stageOf(x)! < current && x.doneOn).map((x) => x.doneOn!).sort();
  const enteredOn = before.at(-1) ?? plan.kickoff;
  const done = planned.filter((x) => DONE.has(x.status)).length;
  const firstOf = (id?: string) => id ? (byStep.get(id) ?? [])[0] ?? null : null;
  const ads = firstOf(t.milestones.adsLive), found = firstOf(t.milestones.foundation);
  const adsLiveOn = plan.liveOn ?? (ads && DONE.has(ads.status) ? ads.doneOn : null);
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
  const next = planned.filter((x) => OPEN.has(x.status) && !running(x) && stageOf(x) === current).sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))[0]
    ?? planned.filter((x) => OPEN.has(x.status) && !running(x)).sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))[0] ?? null;
  const waitingClient = planned.filter((x) => OPEN.has(x.status) && (x.status === 'in_review' || x.status === 'blocked') && (x.notes ?? '').startsWith('Needs the client')).length;
  return {
    stage: current, stageLabel: t.stages.find((s) => s.n === current)?.label ?? null, stageOf: Math.max(0, t.stages.length - 1),
    progress: planned.length ? Math.round((done / planned.length) * 100) : 0, steps: planned.length, stepsDone: done,
    daysInStage: Math.max(0, days(enteredOn, today)), dayN: days(plan.kickoff, today), kickoff: plan.kickoff,
    adsLiveOn, adsPlanned, foundationDue, foundationLeft, foundationRisk, stuckGate: gates.some((g) => g.stuck), gates, stages,
    next: next ? { id: next.id, step: next.step, title: next.title.replace(new RegExp(`^${next.step ?? '#'}\\s`), ''), who: next.who, due: next.due, late: !!next.due && next.due < today } : null,
    waitingClient, late: planned.filter(isLate).length, running: planned.filter(running).map((x) => x.id),
    clocks: t.clocks?.length ? clockState(t, plan, tasks, today, running) : null,
  };
}

const CLOCK_DAY: Record<ClockKey, (p: Plan) => string | null> = { start: (p) => p.kickoff, day0: (p) => p.day0On ?? null, live: (p) => p.liveOn ?? null, bought: () => null };

/** PM-BUILD-1 (2262): where a plan stands on its clocks. The day number counts from day 0 once it is declared, before
 *  that from the plan's start on the template's scale (the invoice paid is Day −7, so it reads "Day −3"); going live and
 *  its windows (the claim window, live + 30 to + 45); and each clock's recording step with its inputs, done, running or
 *  open. Pure, so it is unit-tested. */
export function clockState(t: Template, plan: Plan, tasks: PlanTask[], today: string, running: (x: PlanTask) => boolean) {
  const clocks = t.clocks ?? [];
  const start = clocks.find((c) => c.key === 'start');
  const stepOf = new Map(t.steps.map((s) => [s.id, s]));
  const live = plan.liveOn ?? null, day0 = plan.day0On ?? null;
  const dayN = day0 ? days(day0, today) : days(plan.kickoff, today) + (start?.day ?? 0);
  const inputState = (id: string) => {
    const mine = tasks.filter((x) => x.step === id && !['cancelled', 'not_applicable', 'merged'].includes(x.status));
    if (!mine.length) return { id, title: stepOf.get(id)?.title ?? id, state: 'not_made' as const, taskId: null, who: null };
    const open = mine.find((x) => !DONE.has(x.status) && x.status !== 'in_review' && !running(x));
    const x = open ?? mine[0];
    return { id, title: stepOf.get(id)?.title ?? id, state: open ? 'open' as const : running(x) ? 'running' as const : 'done' as const, taskId: x.id, who: x.who };
  };
  const gates = clocks.filter((c) => (c.key === 'day0' || c.key === 'live') && c.step).map((c) => {
    const st = stepOf.get(c.step!);
    const ids = st?.gateInputs ?? st?.after ?? c.inputs ?? [];
    const inputs = ids.map(inputState).filter((x) => x.state !== 'not_made');
    const on = CLOCK_DAY[c.key](plan);
    return { key: c.key, label: c.label, step: c.step!, stepTitle: st?.title ?? c.step!, on, by: c.key === 'day0' ? plan.day0By ?? null : plan.liveBy ?? null,
      inputs, open: inputs.filter((x) => x.state === 'open').length,
      planned: on ? null : (() => { const s = st ? stepDay(t, plan, st) : null; return s?.due ?? null; })() };
  });
  const windows = (t.windows ?? []).map((w) => { const base = CLOCK_DAY[w.from](plan); return { key: w.key, label: w.label, opens: base ? plus(base, w.start) : null, closes: base ? plus(base, w.end) : null }; });
  return { dayN, fromDay0: !!day0, day0On: day0, liveOn: live, liveDay: live ? days(live, today) : null, startLabel: start?.label ?? null,
    labels: Object.fromEntries(clocks.map((c) => [c.key, c.label])) as Partial<Record<ClockKey, string>>, gates, windows };
}

/** A step's place on its clock, in words and (when the clock is recorded) dates: "Day 13 → Day 20", "Ads live + 0 → + 9". */
export function stepDay(t: Template, plan: Plan, s: Step) {
  const from = s.from ?? 'start';
  const c = (t.clocks ?? []).find((x) => x.key === from);
  const bp = plan.package ? s.byPackage?.[plan.package] : undefined;
  const a = bp?.start ?? s.start, b = bp ? bp.end : s.end;
  const base = CLOCK_DAY[from](plan);
  const onScale = from === 'day0' || (from === 'start' && c?.day !== undefined);
  const shift = from === 'start' ? c?.day ?? 0 : 0;
  const label = onScale ? `Day ${a + shift}${b !== null && b !== a ? ` → Day ${b + shift}` : b === null ? ' onward' : ''}`
    : `${c?.label ?? from} + ${a}${b !== null && b !== a ? ` → + ${b}` : b === null ? ' onward' : ''}`;
  return { label, start: base ? plus(base, Math.max(0, a)) : null, due: base && b !== null ? plus(base, b) : null, from };
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

/** The template a plan runs on: the version it was laid out from (PM-BUILD-1, 2262), else the current copy. */
export async function templateOf(c: PoolClient, all: Template[], plan: Plan): Promise<Template | null> {
  const cur = all.find((x) => x.key === plan.templateKey) ?? null;
  if (!cur || !plan.templateVersion || cur.version === plan.templateVersion) return cur;
  const r = (await c.query('select name,definition from pulse.delivery_template_version where key=$1 and version=$2', [plan.templateKey, plan.templateVersion])).rows[0];
  return r ? ({ key: plan.templateKey, name: r.name, ...r.definition } as Template) : cur;
}

export async function templates(c: PoolClient): Promise<Template[]> {
  return (await c.query('select key,name,definition from pulse.delivery_template order by name')).rows.map((r) => ({ key: r.key, name: r.name, ...r.definition }) as Template);
}

/** Plans and their tasks for a set of projects (read under the viewer's row security). */
export async function plansFor(c: PoolClient, ids: string[]): Promise<Map<string, { plan: Plan; tasks: PlanTask[] }>> {
  if (!ids.length) return new Map();
  const plans = (await c.query(`select project_id id,template_key "templateKey",package,category,kickoff::text kickoff,targets,template_version "templateVersion",
      day0_on::text "day0On",(select display_name from pulse.person where id=day0_by) "day0By",live_on::text "liveOn",(select display_name from pulse.person where id=live_by) "liveBy"
    from pulse.project_plan where project_id=any($1::uuid[])`, [ids])).rows;
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
    const t = (await templateOf(c, all, p.plan)) ?? fail(404, 'Delivery template not found');
    const s = planState(t, p.plan, p.tasks, day);
    // The team by role: whoever holds the project's planned work, grouped by the step owner's role.
    const team = new Map<string, Set<string>>();
    for (const x of tasks) if (x.role && x.who) team.set(x.role, (team.get(x.role) ?? new Set()).add(x.who));
    // PROJECTS-STAGES (1485): each stage's owner, and the milestones the template has (a starter has no foundation check).
    const stageOwners = (await c.query(`select o.stage,o.person_id id,pe.display_name name from pulse.project_stage_owner o join pulse.person pe on pe.id=o.person_id where o.project_id=$1`, [id])).rows;
    // PM-BUILD-1 (2262): on clocks, each step's place ("Day 13 → Day 20", "Ads live + 0 → + 9"), type and full owner, what
    // waits on it, and the steps of the package that were not made as cards (the system's own, or waiting on a condition).
    const clocked = !!t.clocks?.length;
    const used = new Set(tasks.map((x) => x.step).filter(Boolean));
    const steps = clocked ? Object.fromEntries(t.steps.filter((x) => used.has(x.id)).map((x) => [x.id, { type: x.type ?? x.kind, place: stepDay(t, p.plan, x).label, owner: x.owner,
      after: x.after ?? [], unlocks: t.steps.filter((y) => (y.after ?? []).includes(x.id) && used.has(y.id)).map((y) => y.id), hours: x.hours ?? null, note: x.note ?? null }])) : null;
    const sold = (x: Step) => (x.packages[p.plan.package ?? ''] ?? 'no') === 'yes';
    const notMade = clocked ? t.steps.filter((x) => sold(x) && !used.has(x.id) && ((x.type ?? x.kind) === 'auto' || x.when)).map((x) => ({ id: x.id, title: x.title, why: x.when ? 'condition' : 'auto' })) : [];
    return { today: day, canRun, plan: { ...p.plan, template: { key: t.key, name: t.name, version: t.version ?? null, stages: t.stages, packages: t.packages, categories: t.categories, bandwidth: t.bandwidth, creativeColumns: t.creativeColumns ?? null, labels: t.labels ?? {}, targets: t.targets ?? [], milestones: t.milestones ?? {}, clocks: t.clocks ?? null } },
      state: s, creatives: creatives(t, tasks, !!s.adsLiveOn), team: [...team].map(([role, who]) => ({ role, people: [...who] })), stageOwners, tasks, steps, notMade };
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
  // PM-BUILD-1 (2262): "Every input is in" (day 0) and "Went live": refused while the recording step's inputs are open.
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/:id/clock', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const id = UUID.test(req.params.id) ? req.params.id : fail(400, 'Choose a valid record'); await exists(c, id);
    const b = req.body ?? {};
    const clock = b.clock === 'day0' || b.clock === 'live' ? b.clock : fail(400, 'Choose which clock to record');
    const on = b.on === undefined || b.on === null || b.on === '' ? null : typeof b.on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.on) ? b.on : fail(400, 'Choose a valid day');
    return (await c.query(`select pulse.${clock === 'day0' ? 'project_day0_declare' : 'project_live_record'}($1,$2::date) r`, [id, on])).rows[0].r;
  }));
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
  // PM-BUILD-1 (2262): a plan step on its task's page (Kazuk's "anatomy of one card"): its code and phase, the role that
  // owns it, where it sits on its clock and its dates, its work hours, what it waits on and what finishing it opens, and
  // for a gate or a milestone the inputs still open. Only for a plan on clocks; null otherwise.
  app.get<{ Params: { id: string } }>('/api/v0/tasks/:id/plan-step', req => tx(req, async (c, v) => {
    work(v); person(v); const id = UUID.test(req.params.id) ? req.params.id : fail(400, 'Choose a valid record');
    const row = (await c.query('select project_id "projectId",template_step step,status from pulse.task where id=$1 and deleted_at is null', [id])).rows[0];
    if (!row?.projectId || !row.step) return { step: null };
    const p = (await plansFor(c, [row.projectId])).get(row.projectId); if (!p) return { step: null };
    const t = await templateOf(c, await templates(c), p.plan); if (!t?.clocks?.length) return { step: null };
    const st = t.steps.find((x) => x.id === row.step); if (!st) return { step: null };
    const day = (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d as string;
    const of = (sid: string) => p.tasks.filter((x) => x.step === sid && x.status !== 'cancelled');
    const typeOf = (sid: string) => { const x = t.steps.find((y) => y.id === sid); return x?.type ?? x?.kind ?? 'task'; };
    const state = (x: PlanTask | undefined, sid: string) => !x ? 'not_made' : DONE.has(x.status) || x.status === 'in_review' ? 'done'
      : x.status === 'in_progress' && ['ongoing', 'repeating'].includes(typeOf(sid)) ? 'running' : 'open';
    const ref = (sid: string) => { const x = of(sid)[0]; return { code: sid, title: t.steps.find((y) => y.id === sid)?.title ?? sid, taskId: x?.id ?? null, who: x?.who ?? null, state: state(x, sid) }; };
    const stage = t.stages.find((x) => x.n === st.stage);
    const type = st.type ?? st.kind;
    const inputs = ['gate', 'milestone'].includes(type) ? (st.gateInputs ?? st.after ?? []).map(ref).filter((x) => x.state !== 'not_made') : [];
    const clock = (t.clocks ?? []).find((x) => x.step === st.id && (x.key === 'day0' || x.key === 'live')) ?? null;
    // Where today sits on the step's clock: "Day 14" (start or day 0), "Ads live + 8"; null while that clock is not recorded.
    const from = st.from ?? 'start', base = CLOCK_DAY[from](p.plan), sc = (t.clocks ?? []).find((x) => x.key === from);
    const now = base ? (from === 'day0' || (from === 'start' && sc?.day !== undefined) ? `Day ${days(base, day) + (from === 'start' ? sc?.day ?? 0 : 0)}` : `${sc?.label ?? from} + ${days(base, day)}`) : null;
    return { step: { code: st.id, title: st.title, phase: stage?.label ?? null, owner: st.owner, type, place: stepDay(t, p.plan, st), hours: st.hours ?? null, note: st.note ?? null, now,
      clientInput: !!st.clientInput, waits: (st.after ?? []).map(ref).filter((x) => x.state !== 'not_made'),
      unlocks: t.steps.filter((x) => (x.after ?? []).includes(st.id)).map((x) => ref(x.id)).filter((x) => x.state !== 'not_made'),
      inputs, records: clock ? { key: clock.key, label: clock.label } : null, running: state(of(st.id).find((x) => x.id === id), st.id) === 'running', today: day } };
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
