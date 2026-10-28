import { ORG_TZ } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, work, type Tx, type Viewer } from './routes.js';
import { bandwidth, planState, plansFor, templates, type Template } from './project-plan.js';

/** KAZUK (27 Oct 2026): the Projects tab Kazuk designed ("EA Projects TAB under Pulse": PGS "My projects" and CEO
 *  "All projects"). It answers "which project needs me first", from the work itself, not from Drive delivery counts:
 *  - each project with open work: its stage (the live process step when a run exists), the next step and who has it,
 *    the Day-N clock from kick-off, open and late tasks, and a health word with the reason it is there;
 *  - "Needs you today": the viewer's own late and due-today tasks across projects;
 *  - leadership and HR see every pod with a pod switcher (Kazuk's CEO screen); a pod head their pods; everyone else
 *    the projects they lead or hold work in. Tasks are read under the viewer's row security, so nobody sees a task
 *    they could not open.
 *  The per-person table ("People this week") belongs to WORK-TAB's Work → People and is linked, not rebuilt. */
const person = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own staff account to use Projects');
const OPEN = `t.status in ('open','in_progress','blocked','in_review')`;
const DUE = `(t.due_at at time zone ${ORG_TZ})::date`;

export type Health = 'blocked' | 'waiting' | 'at_risk' | 'watch' | 'on_track';
export type HealthRow = {
  id: string; title: string; location: string | null; client: string | null; clientId: string | null; pod: string | null;
  leadId: string | null; lead: string | null; status: string; kind: string; startsOn: string | null; dueOn: string | null;
  open: number; late: number; blocked: number; dueToday: number; soon: number; noOwner: number; noDue: number; review: number;
  waitingClient: number; mine: boolean; stage: string | null; stageDone: number | null; stageOf: number | null;
  next: { id: string; title: string; who: string | null; due: string | null; late: boolean } | null;
  lastActivity: string | null; health: Health; why: string; score: number;
  plan?: (ReturnType<typeof planState> & { package: string | null; category: string | null; units: number; templateKey: string }) | null;
};

/** Health in one word, with the reason a lead reads beside it. Pure, so it is unit-tested. */
export function judge(r: { open: number; late: number; blocked: number; soon: number; noOwner: number; noDue: number; waitingClient: number; dueOn: string | null }, today: string): { health: Health; why: string; score: number } {
  const parts: string[] = [];
  if (r.blocked) parts.push(`${r.blocked} blocked`);
  if (r.waitingClient) parts.push(`${r.waitingClient} waiting on the client`);
  if (r.late) parts.push(`${r.late} late`);
  if (r.dueOn && r.dueOn < today) parts.push('past its end date');
  if (r.noOwner) parts.push(`${r.noOwner} with nobody on it`);
  if (r.soon) parts.push(`${r.soon} due in the next 2 days`);
  if (r.noDue && !parts.length) parts.push(`${r.noDue} with no due day`);
  const health: Health = r.blocked ? 'blocked' : r.waitingClient ? 'waiting' : r.late || (r.dueOn && r.dueOn < today) ? 'at_risk' : r.noOwner || r.soon ? 'watch' : 'on_track';
  // Worst first: blocked, then waiting on the client, then late work (more late is worse), then what is due soon.
  const score = (health === 'blocked' ? 4000 : health === 'waiting' ? 3000 : health === 'at_risk' ? 2000 : health === 'watch' ? 1000 : 0) + r.late * 10 + r.blocked * 10 + r.noOwner * 3 + r.soon * 2 + Math.min(r.open, 50) / 100;
  return { health, why: parts.length ? parts.join(' · ') : 'On track', score };
}

async function today(c: PoolClient) {
  return (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d as string;
}

/** Projects with open work or a running process, with their task numbers. `archived` lists paused, done and cancelled. */
export async function projectHealth(c: PoolClient, me: string, day: string, archived: boolean) {
  const rows = (await c.query(`with base as (
      select p.id,coalesce(p.title,p.name) title,p.location,cl.display_name client,p.client_id "clientId",coalesce(u.name,nullif(wp.pod,'')) pod,
        coalesce(p.lead_person_id,wp.owner_id) "leadId",coalesce(nullif(wp.status,''),p.status,'active') status,coalesce(p.kind,'client_work') kind,
        coalesce(wp.starts_on,p.starts_on)::text "startsOn",coalesce(wp.due_on,p.ends_on)::text "dueOn"
      from pulse.project p left join pulse.work_project wp on wp.project_id=p.id and wp.deleted_at is null
      left join pulse.unit u on u.id=p.unit_id left join pulse.client cl on cl.id=p.client_id
      where p.deleted_at is null and not exists(select 1 from pulse.record_merge r where r.entity_type='project' and r.gone_id=p.id and r.undone_at is null)),
    tk as (select t.project_id,count(*)::int open,count(*) filter(where ${DUE}<$2::date)::int late,count(*) filter(where t.status='blocked')::int blocked,
        count(*) filter(where ${DUE}=$2::date)::int "dueToday",count(*) filter(where ${DUE}>$2::date and ${DUE}<=$2::date+2)::int soon,
        count(*) filter(where coalesce(t.assignee_person_id,t.owner_id) is null)::int "noOwner",count(*) filter(where t.due_at is null)::int "noDue",
        count(*) filter(where t.status='in_review')::int review,bool_or(coalesce(t.assignee_person_id,t.owner_id)=$1::uuid) mine,
        max(coalesce(t.updated_at,t.created_at)) touched
      from pulse.task t where t.deleted_at is null and ${OPEN} and t.project_id is not null group by 1),
    fr as (select distinct on (r.project_id) r.project_id,r.id run from pulse.flow_run r where r.status='running' and r.mode is distinct from 'demo' and r.project_id is not null order by r.project_id,r.started_at desc),
    bl as (select b.project_id,count(*) filter(where b.owner_side='client')::int client from pulse.blocker b where b.closed_at is null and b.project_id is not null group by 1)
    select b.*,(select display_name from pulse.person where id=b."leadId") lead,
      coalesce(tk.open,0) open,coalesce(tk.late,0) late,coalesce(tk.blocked,0) blocked,coalesce(tk."dueToday",0) "dueToday",coalesce(tk.soon,0) soon,
      coalesce(tk."noOwner",0) "noOwner",coalesce(tk."noDue",0) "noDue",coalesce(tk.review,0) review,
      coalesce(tk.mine,false) or b."leadId"=$1::uuid mine,tk.touched::text "lastActivity",
      coalesce(bl.client,0)+coalesce((select count(*)::int from pulse.flow_run_step s where s.run_id=fr.run and s.state='in_review' and s.sent_at is not null),0) "waitingClient",
      (select s.stage from pulse.flow_run_step s where s.run_id=fr.run and s.state not in ('done','skipped','confirmed') order by s.position limit 1) stage,
      (select count(*)::int from pulse.flow_run_step s where s.run_id=fr.run and s.state in ('done','confirmed')) "stageDone",
      (select count(*)::int from pulse.flow_run_step s where s.run_id=fr.run and s.state<>'skipped') "stageOf",
      (select jsonb_build_object('id',t.id,'title',t.title,'who',(select display_name from pulse.person where id=coalesce(t.assignee_person_id,t.owner_id)),
          'due',${DUE}::text,'late',coalesce(${DUE}<$2::date,false))
        from pulse.task t where t.project_id=b.id and t.deleted_at is null and ${OPEN} and t.parent_id is null
        order by (t.status='blocked') desc,t.due_at nulls last,t.created_at limit 1) next
    from base b left join tk on tk.project_id=b.id left join fr on fr.project_id=b.id left join bl on bl.project_id=b.id
    where case when $3::boolean then b.status in ('paused','done','cancelled') else b.status not in ('paused','done','cancelled') and (tk.open>0 or fr.run is not null) end`,
  [me, day, archived])).rows as Omit<HealthRow, 'health' | 'why' | 'score'>[];
  return rows.map((r) => ({ ...r, ...judge(r, day) }) as HealthRow).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

export function registerProjectHealthRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Querystring: { scope?: string; pod?: string } }>('/api/v0/projects/health', req => tx(req, async (c, v) => {
    work(v); const me = person(v);
    const { role, pods: headPods } = (await c.query('select pulse.work_role() role,pulse.work_head_pods() pods')).rows[0] as { role: string; pods: string[] | null };
    const everyone = role === 'leadership' || role === 'hr';
    const asked = ['mine', 'pod', 'all', 'archived'].includes(String(req.query.scope)) ? String(req.query.scope) : null;
    const scope = asked ?? (everyone ? 'all' : role === 'pod_head' ? 'pod' : 'mine');
    const day = await today(c);
    const all = await projectHealth(c, me, day, scope === 'archived');
    const myPods = (await c.query(`select array_remove(array_agg(distinct x),null) p from (select nullif(pp.pod,'') x from pulse.people_profile pp where pp.person_id=$1
      union all select unnest(coalesce(pulse.work_head_pods(),'{}'))) s`, [me])).rows[0].p as string[] ?? [];
    const pods = [...new Set(all.map((r) => r.pod).filter((p): p is string => !!p))].sort();
    const pod = typeof req.query.pod === 'string' && req.query.pod.length <= 80 && req.query.pod ? req.query.pod : null;
    let rows = all;
    if (scope === 'mine') rows = all.filter((r) => r.mine);
    else if (scope === 'pod') rows = all.filter((r) => r.mine || (!!r.pod && (myPods.includes(r.pod) || (headPods ?? []).includes(r.pod))));
    else if (scope === 'all' && !everyone) rows = all.filter((r) => r.mine || r.open > 0);
    if (pod && scope !== 'mine') rows = rows.filter((r) => r.pod === pod);
    // Needs you today: the viewer's own late and due-today work in projects, worst first.
    const today_ = (await c.query(`select t.id,t.title,t.status,${DUE}::text due,coalesce(${DUE}<$2::date,false) late,t.project_id "projectId",coalesce(p.title,p.name) project
      from pulse.task t join pulse.project p on p.id=t.project_id
      where t.deleted_at is null and ${OPEN} and coalesce(t.assignee_person_id,t.owner_id)=$1 and (${DUE}<=$2::date or t.status='blocked')
      order by (t.status='blocked') desc,t.due_at nulls last limit 12`, [me, day])).rows;
    // Delivery plans (1370): the stage, clocks, gates and waiting-on-client of each planned project, and leads' bandwidth.
    const tpls = await templates(c); const tplOf = (k: string) => tpls.find((t) => t.key === k) ?? null;
    const plans = await plansFor(c, all.map((r) => r.id));
    for (const r of all) {
      const p = plans.get(r.id); const t = p ? tplOf(p.plan.templateKey) : null;
      if (!p || !t) { r.plan = null; continue; }
      const st = planState(t, p.plan, p.tasks, day);
      r.plan = { ...st, package: p.plan.package, category: p.plan.category, templateKey: t.key, units: t.categories.find((x) => x.key === p.plan.category)?.units ?? 0 };
      r.stage = `${st.stage} · ${st.stageLabel ?? ''}`; r.stageDone = st.stepsDone; r.stageOf = st.steps;
      if (st.next) r.next = { id: st.next.id, title: `${st.next.step ?? ''} ${st.next.title}`.trim(), who: st.next.who, due: st.next.due, late: st.next.late };
      if (st.waitingClient) r.waitingClient += st.waitingClient;
      Object.assign(r, judge(r, day));
    }
    rows.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const t0: Template | null = tpls[0] ?? null;
    const unitsBy = new Map<string, { units: number; projects: number }>();
    for (const r of all) if (r.plan && r.leadId && r.status === 'active') { const u = unitsBy.get(r.leadId) ?? { units: 0, projects: 0 }; u.units += r.plan.units; u.projects++; unitsBy.set(r.leadId, u); }
    const leadIds = [...unitsBy.keys()];
    const names = leadIds.length ? (await c.query(`select p.id,p.display_name name,pp.pod,pp.role from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=any($1::uuid[])`, [leadIds])).rows : [];
    const bw = t0 ? {
      role: t0.bandwidth.role, short: t0.bandwidth.short, healthy: t0.bandwidth.healthy, max: t0.bandwidth.max, note: t0.bandwidth.note ?? null,
      categories: t0.categories,
      me: unitsBy.has(me) ? { ...bandwidth(t0, unitsBy.get(me)!.units), projects: unitsBy.get(me)!.projects } : null,
      people: (everyone || role === 'pod_head') ? names.filter((n) => everyone || (n.pod && (myPods.includes(n.pod) || (headPods ?? []).includes(n.pod))) || n.id === me)
        .map((n) => ({ id: n.id as string, name: n.name as string, pod: n.pod as string | null, ...bandwidth(t0, unitsBy.get(n.id)!.units), projects: unitsBy.get(n.id)!.projects })).sort((a, b) => b.units - a.units) : [],
    } : null;
    const agent = (await c.query(`select am.person_id id,p.display_name name,pp.username from pulse.agent_member am join pulse.person p on p.id=am.person_id
      left join pulse.people_profile pp on pp.person_id=p.id where am.disabled_at is null and p.status='active' order by am.chief desc,am.created_at limit 1`)).rows[0] ?? null;
    const viewer = (await c.query(`select p.display_name name,pp.role,nullif(pp.pod,'') pod from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=$1`, [me])).rows[0] ?? null;
    // The CEO's screen: where the projects are, the headline numbers, money at risk and same-day alerts.
    let ceo = null;
    if (everyone && scope === 'all') {
      const planned = rows.filter((r) => r.plan);
      const inDays = (n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
      const stages = t0 ? t0.stages.map((s) => ({ n: s.n, label: s.label, projects: planned.filter((r) => r.plan!.stage === s.n).length })) : [];
      const money: { title: string; detail: string; projects: { id: string; title: string }[] }[] = [];
      const ending = rows.filter((r) => r.dueOn && r.dueOn >= day && r.dueOn <= inDays(30));
      if (ending.length) money.push({ title: `${ending.length} ${ending.length === 1 ? 'project ends' : 'projects end'} in 30 days`, detail: 'Raise the renewal quotation before the end date', projects: ending.map((r) => ({ id: r.id, title: r.title })) });
      const found = planned.filter((r) => r.plan!.foundationRisk);
      if (found.length) money.push({ title: `${found.length} foundation ${found.length === 1 ? 'check' : 'checks'} at risk`, detail: 'Ads are not live and the foundation check is close or past', projects: found.map((r) => ({ id: r.id, title: r.title })) });
      const resultIds = t0?.milestones.resultCheck ?? [];
      const result = planned.filter((r) => (plans.get(r.id)?.tasks ?? []).some((x) => x.step && resultIds.includes(x.step) && !['done', 'accepted', 'cancelled'].includes(x.status) && !!x.due && x.due <= inDays(10)));
      if (result.length) money.push({ title: `${result.length} result ${result.length === 1 ? 'check' : 'checks'} in the next 10 days`, detail: 'The refund or assurance rule applies', projects: result.map((r) => ({ id: r.id, title: r.title })) });
      const quoted = (await c.query(`select q.project_id id,(pulse.project_scope(q.project_id)->>'outside')::int outside from (select distinct project_id from pulse.project_quote) q where q.project_id=any($1::uuid[])`, [rows.map((r) => r.id)])).rows.filter((x: { id: string; outside: number }) => x.outside > 0) as { id: string; outside: number }[];
      if (quoted.length) money.push({ title: `${quoted.reduce((n, x) => n + x.outside, 0)} tasks outside the signed quote`, detail: 'No add-on quotation raised yet', projects: quoted.map((x) => ({ id: x.id as string, title: rows.find((r) => r.id === x.id)?.title ?? '' })) });
      const alerts: { title: string; detail: string; projectId: string; project: string }[] = [];
      const to = (r: HealthRow) => r.lead ? `To ${r.lead}` : 'No lead yet';
      for (const r of planned) for (const g of r.plan!.gates.filter((g) => g.stuck)) alerts.push({ title: `${g.short} waiting for more than 3 days`, detail: to(r), projectId: r.id, project: r.title });
      for (const r of rows) if (r.blocked) alerts.push({ title: `${r.blocked} blocked`, detail: to(r), projectId: r.id, project: r.title });
      for (const r of rows) if (r.noOwner || r.noDue) alerts.push({ title: `${r.noOwner + r.noDue} ${r.noOwner + r.noDue === 1 ? 'task' : 'tasks'} with no owner or due date`, detail: to(r), projectId: r.id, project: r.title });
      ceo = {
        stages, money, alerts: alerts.slice(0, 8),
        tiles: { adsLive: planned.filter((r) => r.plan!.adsLiveOn).length, foundationRisk: found.length, stuckGate: planned.filter((r) => r.plan!.stuckGate).length },
        decisions: rows.filter((r) => r.health !== 'on_track' && r.health !== 'watch').slice(0, 8)
          .map((r) => ({ id: r.id, title: r.title, pod: r.pod, lead: r.lead, stage: r.plan ? `${r.plan.stage} ${r.plan.stageLabel ?? ''}` : null, daysInStage: r.plan?.daysInStage ?? null, why: r.why, late: r.late })),
      };
    }
    const lateProjects = rows.filter((r) => r.late > 0).length;
    return {
      today: day, role, everyone, scope, pod, pods, rows, viewer, agent, bandwidth: bw, ceo, labels: t0?.labels ?? {},
      totals: {
        active: rows.length, late: rows.reduce((n, r) => n + r.late, 0), lateProjects, blocked: rows.filter((r) => r.health === 'blocked').length,
        waiting: rows.filter((r) => r.waitingClient > 0).length, atRisk: rows.filter((r) => r.health === 'at_risk' || r.health === 'blocked').length,
        noOwner: rows.reduce((n, r) => n + r.noOwner, 0), noDue: rows.reduce((n, r) => n + r.noDue, 0), needYou: today_.length,
      },
      needsYou: today_,
    };
  }));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (x: unknown, label: string) => x === null || x === undefined || x === '' ? null : typeof x === 'string' && DAY.test(x) ? x : fail(400, `Enter ${label} as a date`);
const pid = (x: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x) ? x : fail(400, 'Choose a valid record');

/** Screens 5 and 6: a project's timeline (its tasks as bars, Day 0 = kick-off), its date changes and its status history. */
export function registerProjectRunRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Params: { id: string } }>('/api/v0/projects/:id/timeline', req => tx(req, async (c, v) => {
    work(v); person(v); const id = pid(req.params.id);
    const p = (await c.query(`select p.id,coalesce(p.title,p.name) title,p.status,coalesce(wp.starts_on,p.starts_on)::text "startsOn",coalesce(wp.due_on,p.ends_on)::text "dueOn",
        (select display_name from pulse.person where id=coalesce(p.lead_person_id,wp.owner_id)) lead,pulse.project_can_run(p.id) "canRun",(now() at time zone ${ORG_TZ})::date::text today
      from pulse.project p left join pulse.work_project wp on wp.project_id=p.id and wp.deleted_at is null where p.id=$1 and p.deleted_at is null`, [id])).rows[0] ?? fail(404, 'Project not found');
    const tasks = (await c.query(`select t.id,t.title,t.status,t.parent_id "parentId",t.template_step step,t.phase_key phase,(select display_name from pulse.person where id=coalesce(t.assignee_person_id,t.owner_id)) who,
        coalesce(t.work_on,(t.started_at at time zone ${ORG_TZ})::date,(t.created_at at time zone ${ORG_TZ})::date)::text start,${DUE}::text due,
        (coalesce(t.done_at,t.accepted_at) at time zone ${ORG_TZ})::date::text "doneOn",
        (select jsonb_build_object('start',d.from_start,'due',d.from_due) from pulse.project_date_change d where d.task_id=t.id order by d.changed_at limit 1) was,
        (select count(*)::int from pulse.task_link l where l.blocker_id=t.id and l.cleared_at is null) waiting,
        (select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'step',b.template_step,'title',b.title,'due',(b.due_at at time zone ${ORG_TZ})::date::text) order by b.due_at),'[]'::jsonb)
           from pulse.task_link l join pulse.task b on b.id=l.blocker_id where l.task_id=t.id and l.cleared_at is null and b.deleted_at is null) "waitsFor"
      from pulse.task t where t.project_id=$1 and t.deleted_at is null and t.status<>'cancelled'
      order by coalesce(t.work_on,(t.started_at at time zone ${ORG_TZ})::date,${DUE},(t.created_at at time zone ${ORG_TZ})::date),t.created_at limit 400`, [id])).rows;
    const changes = (await c.query(`select d.id,t.title,d.from_start::text "fromStart",d.from_due::text "fromDue",d.to_start::text "toStart",d.to_due::text "toDue",d.reason_kind reason,d.note,
        cardinality(d.moved) moved,(select display_name from pulse.person where id=d.changed_by) who,d.changed_at::text at
      from pulse.project_date_change d join pulse.task t on t.id=d.task_id where d.project_id=$1 order by d.changed_at desc limit 50`, [id])).rows;
    const history = (await c.query(`select s.to_status status,s.from_status "from",s.reason,s.starts_on::text "startsOn",s.restart_on::text "restartOn",s.stops,s.shifted_days "shiftedDays",
        (select display_name from pulse.person where id=s.changed_by) who,s.changed_at::text at from pulse.project_status_change s where s.project_id=$1 order by s.changed_at desc limit 20`, [id])).rows;
    // A planned project groups its timeline by stage (Kazuk's screen 5), with the template's stage names.
    const plan = (await c.query(`select pp.kickoff::text kickoff,dt.definition->'stages' stages,dt.definition->'labels' labels from pulse.project_plan pp
      join pulse.delivery_template dt on dt.org_id=pp.org_id and dt.key=pp.template_key where pp.project_id=$1`, [id])).rows[0] ?? null;
    if (plan?.kickoff) p.startsOn = plan.kickoff;
    return { project: p, tasks, changes, history, stages: plan?.stages ?? null, labels: plan?.labels ?? {} };
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/:id/status', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const b = req.body ?? {};
    const stops = b.stops && typeof b.stops === 'object' && !Array.isArray(b.stops) ? Object.fromEntries(Object.entries(b.stops as Record<string, unknown>).slice(0, 10).map(([k, x]) => [k.slice(0, 40), !!x])) : {};
    return (await c.query('select pulse.project_set_status($1,$2,$3,$4,$5,$6,$7) r', [pid(req.params.id), String(b.status ?? ''), String(b.reason ?? '').slice(0, 600),
      day(b.from, 'the first day'), day(b.restart, 'the expected restart'), JSON.stringify(stops), b.shift === true])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/:id/reschedule', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); pid(req.params.id); const b = req.body ?? {};
    const task = pid(String(b.taskId ?? ''));
    const inProject = (await c.query('select 1 from pulse.task where id=$1 and project_id=$2', [task, req.params.id])).rows[0];
    if (!inProject) fail(404, 'Task not found');
    return (await c.query('select pulse.project_reschedule($1,$2,$3,$4,$5,$6) r', [task, day(b.start, 'the start'), day(b.due, 'the end'), String(b.reason ?? ''),
      b.note === undefined || b.note === null ? null : String(b.note).slice(0, 400), b.cascade === true])).rows[0].r;
  }));
}

/** Screen 0: quote signed → the project builds itself (pulse.project_from_quote, migration 1301), and sold against delivered. */
export function registerProjectQuoteRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Params: { id: string } }>('/api/v0/projects/from-quote/:id', req => tx(req, async (c, v) => {
    work(v); person(v); const doc = pid(req.params.id);
    const row = (await c.query(`select p.id "projectId",coalesce(p.title,p.name) title from pulse.erp_document d
      left join pulse.project_quote q on q.org_id=d.org_id and q.document_id=d.id join pulse.project p on p.id=coalesce(q.project_id,d.project_id)
      where d.id=$1 and p.deleted_at is null`, [doc])).rows[0];
    return row ?? { projectId: null, title: null };
  }));
  app.post<{ Body: Record<string, unknown> }>('/api/v0/projects/from-quote', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v);
    // Refuse before reading the body, as Billing does (role matrix: a person gets 403, not 400).
    if (!(await c.query('select pulse.erp_can(true) ok')).rows[0].ok) fail(403, 'Starting a project from a quotation is for leadership and the Finance role');
    const b = req.body ?? {};
    const lead = b.leadId === null || b.leadId === undefined || b.leadId === '' ? null : pid(String(b.leadId));
    return (await c.query('select pulse.project_from_quote($1,$2,$3) r', [pid(String(b.documentId ?? '')), lead, day(b.startsOn, 'the kick-off day')])).rows[0].r;
  }));
  app.get<{ Params: { id: string } }>('/api/v0/projects/:id/scope', req => tx(req, async (c, v) => {
    work(v); person(v);
    return (await c.query('select pulse.project_scope($1) r', [pid(req.params.id)])).rows[0].r;
  }));
}
