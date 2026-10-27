import { ORG_TZ } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from './routes.js';

/** WORK-TAB (27 Oct 2026): performance and quality per person, Kazuk's number 1. Each person's output and quality in
 *  the last four weeks, read from the work itself, never from points (INTEGRITY 0910):
 *  - output: tasks finished this week against the person's own usual week (the role targets are not set yet);
 *  - on time: finished tasks that had a due day and were finished by it;
 *  - right first time: tasks someone else accepted that were never sent back;
 *  - sent back and review quality, when reviewers rate.
 *  The first 30 days of a newcomer are coaching only (Kazuk's CS scorecard), which the page says beside their row.
 *  Leadership and HR see everyone, a pod head their pods and the people they manage (as the team dashboard). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const person = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own staff account to use Work');
const PHOTO = (alias: string) => `(select ph.updated_at from pulse.person_photo ph where ph.person_id=${alias}.id)`;
const OPEN = `t.status in ('open','in_progress','blocked')`;
const FINISHED = `t.status in ('done','accepted','in_review')`;
const DUE = `(t.due_at at time zone ${ORG_TZ})::date`;
const DONE_DAY = `(coalesce(t.done_at,t.work_on::timestamptz) at time zone ${ORG_TZ})::date`;
const MINE = `coalesce(t.assignee_person_id,t.owner_id)=s.id and t.deleted_at is null`;

export type Score = { id: string; name: string; pod: string | null; role: string | null; photoAt: string | null; joinedOn: string | null; newcomer: boolean;
  open: number; late: number; blocked: number; doneWeek: number; doneLastWeek: number; usual: number | null;
  onTime: { n: number; of: number }; firstTime: { n: number; of: number }; returned: number; quality: number | null; now: { id: string; title: string } | null };

async function today(c: PoolClient) {
  return (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d,date_trunc('week',now() at time zone ${ORG_TZ})::date::text w`)).rows[0] as { d: string; w: string };
}

/** The scorecard rows for a set of people (the caller decides who may be seen). */
export async function scores(c: PoolClient, ids: string[]): Promise<{ today: string; week: string; rows: Score[] }> {
  const day = await today(c);
  if (!ids.length) return { today: day.d, week: day.w, rows: [] };
  const rows = (await c.query(`select s.id,s.display_name name,pp.pod,pp.role,${PHOTO('s')} "photoAt",pp.joined_on::text "joinedOn",
    coalesce(pp.joined_on>$1::date-30,false) newcomer,
    (select count(*)::int from pulse.task t where ${MINE} and ${OPEN}) open,
    (select count(*)::int from pulse.task t where ${MINE} and ${OPEN} and ${DUE}<$1::date) late,
    (select count(*)::int from pulse.task t where ${MINE} and t.status='blocked') blocked,
    (select count(*)::int from pulse.task t where ${MINE} and ${FINISHED} and ${DONE_DAY}>=$2::date) "doneWeek",
    (select count(*)::int from pulse.task t where ${MINE} and ${FINISHED} and ${DONE_DAY}>=$2::date-7 and ${DONE_DAY}<$2::date) "doneLastWeek",
    (select count(*)::int from pulse.task t where ${MINE} and ${FINISHED} and ${DONE_DAY}>=$2::date-28 and ${DONE_DAY}<$2::date) "done4",
    (select count(*)::int from pulse.task t where ${MINE} and t.created_at<$2::date-28) "olderTasks",
    (select jsonb_build_object('n',count(*) filter(where ${DONE_DAY}<=${DUE}),'of',count(*)) from pulse.task t
      where ${MINE} and ${FINISHED} and t.due_at is not null and ${DONE_DAY}>$1::date-28) "onTime",
    (select jsonb_build_object('n',count(*) filter(where not exists(select 1 from pulse.task_event e where e.task_id=t.id and e.kind='returned')),'of',count(*)) from pulse.task t
      where ${MINE} and (
        (t.status='accepted' and t.accepted_by is not null and t.accepted_by<>s.id and (t.accepted_at at time zone ${ORG_TZ})::date>$1::date-28)
        or exists(select 1 from pulse.task_event e where e.task_id=t.id and e.kind='returned' and (e.at at time zone ${ORG_TZ})::date>$1::date-28))) "firstTime",
    (select count(*)::int from pulse.task_event e join pulse.task t on t.id=e.task_id where ${MINE} and e.kind='returned' and (e.at at time zone ${ORG_TZ})::date>$1::date-28) returned,
    (select round(avg(t.review_quality)::numeric,1)::float from pulse.task t where ${MINE} and t.review_kind='rated' and (t.accepted_at at time zone ${ORG_TZ})::date>$1::date-28) quality,
    (select jsonb_build_object('id',t.id,'title',t.title) from pulse.task t where ${MINE} and t.status='in_progress' order by t.started_at desc nulls last limit 1) now
   from pulse.person s left join pulse.people_profile pp on pp.person_id=s.id where s.id=any($3::uuid[]) order by s.display_name`, [day.d, day.w, ids])).rows;
  return { today: day.d, week: day.w, rows: rows.map(({ done4, olderTasks, ...r }) => ({ ...r, usual: olderTasks > 0 || done4 > 0 ? Math.round(done4 / 4 * 10) / 10 : null }) as Score) };
}

/** Eight weeks of one person's output and quality, for their page. */
export async function scoreWeeks(c: PoolClient, who: string) {
  const day = await today(c);
  return (await c.query(`with w as (select generate_series($2::date-interval '7 weeks',$2::date,interval '1 week')::date wk), s as (select $1::uuid id)
   select w.wk::text week,
    (select count(*)::int from pulse.task t,s where ${MINE} and ${FINISHED} and ${DONE_DAY}>=w.wk and ${DONE_DAY}<w.wk+7) done,
    (select count(*)::int from pulse.task t,s where ${MINE} and ${FINISHED} and t.due_at is not null and ${DONE_DAY}>=w.wk and ${DONE_DAY}<w.wk+7) "withDue",
    (select count(*)::int from pulse.task t,s where ${MINE} and ${FINISHED} and t.due_at is not null and ${DONE_DAY}<=${DUE} and ${DONE_DAY}>=w.wk and ${DONE_DAY}<w.wk+7) "onTime",
    (select count(*)::int from pulse.task t,s where ${MINE} and t.status='accepted' and t.accepted_by is not null and t.accepted_by<>s.id and (t.accepted_at at time zone ${ORG_TZ})::date>=w.wk and (t.accepted_at at time zone ${ORG_TZ})::date<w.wk+7) accepted,
    (select count(*)::int from pulse.task_event e join pulse.task t on t.id=e.task_id,s where ${MINE} and e.kind='returned' and (e.at at time zone ${ORG_TZ})::date>=w.wk and (e.at at time zone ${ORG_TZ})::date<w.wk+7) returned
   from w order by w.wk`, [who, day.w])).rows as { week: string; done: number; withDue: number; onTime: number; accepted: number; returned: number }[];
}

/** Who the viewer may see on the scorecard: everyone for leadership and HR, a pod head their pods and their people. */
async function inView(c: PoolClient, v: Viewer, pod: string | null) {
  const me = person(v);
  const role = (await c.query('select pulse.work_role() r')).rows[0].r as string;
  const everyone = role === 'leadership' || role === 'hr';
  if (!everyone && role !== 'pod_head') fail(403, 'The people view is for leadership, HR and pod heads');
  let pods = everyone ? (await c.query("select name from pulse.unit where kind='pod' and valid_to is null order by name")).rows.map((r) => r.name as string)
    : (await c.query('select pulse.work_head_pods() p')).rows[0].p as string[] ?? [];
  // A company that has not set its pods up as units yet still has them on people's profiles.
  if (everyone && !pods.length) pods = (await c.query(`select distinct pp.pod from pulse.person p join pulse.people_profile pp on pp.person_id=p.id
   where p.side='staff' and p.status='active' and pp.pod is not null and pp.pod<>'' order by pp.pod`)).rows.map((r) => r.pod as string);
  const chosen = pod && pods.includes(pod) ? pod : null;
  const ids = (await c.query(`select p.id from pulse.person p join pulse.people_profile pp on pp.person_id=p.id
   where p.side='staff' and p.status='active' and ($1::boolean or pp.pod=any(pulse.work_head_pods()) or pulse.manages(p.id)) and p.id<>$2 and ($3::text is null or pp.pod=$3)`,
   [everyone, me, chosen])).rows.map((r) => r.id as string);
  return { role, everyone, pods, pod: chosen, ids };
}

export function registerWorkScorecardRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Querystring: { pod?: string } }>('/api/v0/work/scorecard', req => tx(req, async (c, v) => {
    const pod = typeof req.query.pod === 'string' && req.query.pod.length <= 80 ? req.query.pod : null;
    const s = await inView(c, v, pod);
    const r = await scores(c, s.ids);
    const t = r.rows.reduce((a, x) => ({ open: a.open + x.open, late: a.late + x.late, blocked: a.blocked + x.blocked, doneWeek: a.doneWeek + x.doneWeek, doneLastWeek: a.doneLastWeek + x.doneLastWeek,
      onTime: a.onTime + x.onTime.n, withDue: a.withDue + x.onTime.of, first: a.first + x.firstTime.n, reviewed: a.reviewed + x.firstTime.of }),
      { open: 0, late: 0, blocked: 0, doneWeek: 0, doneLastWeek: 0, onTime: 0, withDue: 0, first: 0, reviewed: 0 });
    // Kazuk's same-day alerts on the work itself: a task with no owner or no due day cannot be tracked or credited.
    const fix = (await c.query(`select count(*) filter(where coalesce(t.assignee_person_id,t.owner_id) is null and $1::boolean)::int "noOwner",
      count(*) filter(where t.due_at is null and coalesce(t.assignee_person_id,t.owner_id)=any($2::uuid[]))::int "noDue",
      count(*) filter(where ${DUE}<(now() at time zone ${ORG_TZ})::date and coalesce(t.assignee_person_id,t.owner_id)=any($2::uuid[]))::int late
     from pulse.task t where t.deleted_at is null and ${OPEN}`, [s.everyone && !s.pod, s.ids])).rows[0] as { noOwner: number; noDue: number; late: number };
    const targets = (await c.query('select pulse.work_role_targets() t')).rows[0].t as { role: string; perWeek: number; unit: string | null }[];
    const target = (role: string | null) => role ? targets.find((x) => x.role.toLowerCase() === role.toLowerCase()) ?? null : null;
    return { today: r.today, week: r.week, role: s.role, everyone: s.everyone, pods: s.pods, pod: s.pod, totals: t, fix, targets,
      rows: r.rows.map((x) => ({ ...x, target: target(x.role) })) };
  }));
  // A role's weekly target (leadership and admins; decided in the database, 1181).
  app.post<{ Body: { role?: unknown; perWeek?: unknown; unit?: unknown } }>('/api/v0/work/role-targets', { schema: { body: { type: 'object' } } }, req => tx(req, async (c) => {
    const b = req.body ?? {};
    const per = b.perWeek === null || b.perWeek === undefined || b.perWeek === '' ? null : Number(b.perWeek);
    if (per !== null && !Number.isInteger(per)) fail(400, 'Enter a whole number of tasks per week');
    const targets = (await c.query('select pulse.work_role_target_set($1,$2,$3) t', [String(b.role ?? '').slice(0, 80), per, b.unit === null || b.unit === undefined ? null : String(b.unit).slice(0, 60)])).rows[0].t;
    return { targets };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/work/scorecard/:id', req => tx(req, async (c, v) => {
    const who = UUID.test(req.params.id) ? req.params.id : fail(400, 'Choose a valid record');
    const me = person(v);
    if (who !== me) {
      const role = (await c.query('select pulse.work_role() r,pulse.manages($1) m', [who])).rows[0];
      if (!(role.r === 'leadership' || role.r === 'hr' || role.m)) fail(403, 'This view is for the person, their head, HR and leadership');
    }
    const r = await scores(c, [who]);
    return { today: r.today, week: r.week, self: who === me, score: r.rows[0] ?? fail(404, 'Person not found'), weeks: await scoreWeeks(c, who) };
  }));
}
