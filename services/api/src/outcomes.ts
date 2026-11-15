import { ORG_TZ } from './org-time.js';
import type { PoolClient } from 'pg';

/** TASKS-3: what a person's outcome page and a leader's summary need beyond RT1's: twelve weeks of accepted work split by
 *  project and by domain, tasks done (accepted or waiting), hours, extra work and why it counts, streaks, and accepted vs
 *  pending. INTEGRITY (0910): a task carries no value, so the numbers are tasks someone else accepted (one each), never
 *  points; nobody moves them alone. "Extra" is pulse.work_credit_kind (0184); "above plan" is worked out here per week
 *  against the person's usual week. Pure helpers are exported for tests. */
export const WEEKS = 12;
/** INTEGRITY: work that counts: accepted by someone other than the person who did it (one per task, never points). */
export const ACCEPTED_BY_OTHERS = (t: string, who: string) =>
  `coalesce(${t}.assignee_person_id,${t}.owner_id)=${who} and ${t}.status='accepted' and ${t}.deleted_at is null and ${t}.accepted_by is not null and ${t}.accepted_by<>${who}`;
const DAY = 86400000;
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const weekList = (thisWeek: string, n = WEEKS) => Array.from({ length: n }, (_, i) => addDays(thisWeek, (i - n + 1) * 7));
/** The usual week: the median value of the weeks before (at least three with credit), else none. */
export function usualWeek(values: number[]) {
  const seen = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (seen.length < 3) return null;
  const m = Math.floor(seen.length / 2);
  return seen.length % 2 ? seen[m] : Math.round((seen[m - 1] + seen[m]) / 2);
}
/** Value above the usual week, for each week (the usual week is read from the eight weeks before it). */
export function abovePlan(values: number[]) {
  return values.map((v, i) => { const usual = usualWeek(values.slice(Math.max(0, i - 8), i)); return { usual, above: usual === null ? 0 : Math.max(0, v - usual) }; });
}
/** Longest and current run of consecutive keys (weeks or days) present in `set`, stepping back by `step` days. */
export function runs(present: Set<string>, last: string, step: number, count: number, skip: (d: string) => boolean = () => false) {
  let best = 0, run = 0, current = 0, started = false;
  for (let i = count - 1; i >= 0; i--) {
    const d = addDays(last, -i * step); if (skip(d)) continue;
    if (present.has(d)) { run++; best = Math.max(best, run); } else run = 0;
  }
  for (let d = last, i = 0; i < count; i++, d = addDays(d, -step)) {
    if (skip(d)) continue;
    if (present.has(d)) { current++; started = true; } else if (started || i > 0) break; // today may still be empty
  }
  return { best, current };
}
type Series = { key: string; label: string; values: number[] };
/** Top `n` keys by total, the rest folded into "Other" (never a ninth colour). */
export function fold(rows: { key: string | null; label: string; week: string; points: number }[], weeks: string[], n: number, otherLabel = 'Other'): Series[] {
  const totals = new Map<string, { label: string; total: number }>();
  for (const r of rows) { const k = r.key ?? '·none'; const t = totals.get(k) ?? { label: r.label, total: 0 }; t.total += r.points; totals.set(k, t); }
  const top = [...totals.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, n).map(([k]) => k);
  const out = new Map<string, Series>(top.map((k) => [k, { key: k, label: totals.get(k)!.label, values: weeks.map(() => 0) }]));
  const other: Series = { key: '·other', label: otherLabel, values: weeks.map(() => 0) };
  for (const r of rows) { const i = weeks.indexOf(r.week); if (i < 0) continue; const s = out.get(r.key ?? '·none') ?? other; s.values[i] += r.points; }
  return [...out.values(), ...(other.values.some(Boolean) ? [other] : [])];
}

export async function outcomeCharts(c: PoolClient, who: string, thisWeek: string, today: string) {
  const weeks = weekList(thisWeek), from = weeks[0];
  const credits = (await c.query(`select x.*,date_trunc('week',x.day::date)::date::text week from (
    select t.id "taskId",t.title,1 points,coalesce(k.extra,'{}') extra,k.domain_id "domainId",d.title "domainTitle",(t.accepted_at at time zone ${ORG_TZ})::date::text "day",
     t.project_id "projectId",coalesce(pr.title,pr.name) "projectName",case when t.claimed_by=$1 then 'pool' else 'assigned' end via
    from pulse.task t cross join lateral pulse.work_credit_kind(t.id,$1) k left join pulse.project pr on pr.id=t.project_id left join pulse.work_domain d on d.id=k.domain_id
    where ${ACCEPTED_BY_OTHERS('t', '$1')} and t.accepted_at>=$2::date::timestamp at time zone ${ORG_TZ}) x order by x.day desc`, [who, from])).rows as
    { taskId: string; title: string; points: number; extra: string[]; domainId: string | null; domainTitle: string | null; day: string; week: string; projectId: string | null; projectName: string | null; via: string }[];
  const hasDomains = (await c.query("select exists(select 1 from pulse.work_domain where person_id=$1 and status='active') ok", [who])).rows[0].ok as boolean;
  const value = weeks.map((w) => credits.filter((k) => k.week === w).reduce((n, k) => n + k.points, 0));
  const extraValue = weeks.map((w) => credits.filter((k) => k.week === w && k.extra.length).reduce((n, k) => n + k.points, 0));
  const plan = abovePlan(value);
  const byProject = fold(credits.map((k) => ({ key: k.projectId, label: k.projectName ?? 'No project', week: k.week, points: k.points })), weeks, 4);
  const byDomain = fold(credits.map((k) => ({ key: k.domainId ?? (k.extra.includes('outside_domains') ? '·outside' : '·none'),
    label: k.domainTitle ?? (k.extra.includes('outside_domains') ? 'Outside your domains' : hasDomains ? 'No domain' : 'No domains agreed yet'), week: k.week, points: k.points })), weeks, 4);
  const done = (await c.query(`select date_trunc('week',(t.done_at at time zone ${ORG_TZ})::date)::date::text week,(t.done_at at time zone ${ORG_TZ})::date::text "day",t.status
   from pulse.task t where coalesce(t.assignee_person_id,t.owner_id)=$1 and t.status in ('done','accepted','in_review') and t.done_at>=$2::date::timestamp at time zone ${ORG_TZ}`, [who, addDays(today, -400)])).rows as
    { week: string; day: string; status: string }[];
  const tasks = weeks.map((w) => ({ accepted: done.filter((d) => d.week === w && d.status === 'accepted').length, waiting: done.filter((d) => d.week === w && d.status !== 'accepted').length }));
  const hours = (await c.query(`with w as (select unnest($2::date[]) wk)
    select w.wk::text week,coalesce(sum(e.minutes) filter(where e.status='confirmed'),0)::int confirmed,coalesce(sum(e.minutes) filter(where e.status='proposed'),0)::int proposed
    from w left join pulse.time_entry e on e.person_id=$1 and e.retired_at is null and e.work_date>=w.wk and e.work_date<w.wk+7 group by w.wk order by w.wk`, [who, weeks])).rows as { week: string; confirmed: number; proposed: number }[];
  const hoursByProject = (await c.query(`select coalesce(e.project_id,t.project_id) "projectId",coalesce(pr.title,pr.name,'No project') name,sum(e.minutes)::int minutes
    from pulse.time_entry e left join pulse.task t on t.id=e.task_id left join pulse.project pr on pr.id=coalesce(e.project_id,t.project_id)
    where e.person_id=$1 and e.retired_at is null and e.status='confirmed' and e.work_date>=$2::date group by 1,2 order by 3 desc limit 6`, [who, from])).rows;
  // Streaks: weeks with something finished, and working days (Sundays are the usual weekly off and are skipped).
  const doneWeeks = new Set(done.map((d) => d.week)), doneDays = new Set(done.map((d) => d.day));
  const weekly = runs(doneWeeks, thisWeek, 7, 52), daily = runs(doneDays, today, 1, 120, (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0);
  const days = Array.from({ length: 84 }, (_, i) => addDays(today, i - 83)).map((d) => ({ day: d, done: done.filter((x) => x.day === d).length }));
  const pending = (await c.query(`select t.id,t.title,rv.display_name reviewer,(t.done_at at time zone ${ORG_TZ})::date::text "doneOn"
   from pulse.task t left join pulse.person rv on rv.id=t.review_owner_id where coalesce(t.assignee_person_id,t.owner_id)=$1 and t.status in ('done','in_review') order by t.done_at limit 30`, [who])).rows;
  const accepted = (await c.query(`select count(*)::int points,count(*)::int tasks,count(*) filter(where cardinality(k.extra)>0)::int extra
   from pulse.task t cross join lateral pulse.work_credit_kind(t.id,$1) k where ${ACCEPTED_BY_OTHERS('t', '$1')}`, [who])).rows[0];
  const reasons = { outside_domains: 0, pool: 0, volunteered: 0, above_plan: plan.reduce((n, p) => n + p.above, 0) };
  for (const k of credits) for (const r of k.extra) reasons[r as keyof typeof reasons] += k.points;
  return {
    weeks, value, byProject, byDomain, tasks, hours, hoursByProject,
    extra: { points: extraValue.reduce((a, b) => a + b, 0), weeks: extraValue, plan, reasons, hasDomains, share: value.reduce((a, b) => a + b, 0) ? Math.round((100 * extraValue.reduce((a, b) => a + b, 0)) / value.reduce((a, b) => a + b, 0)) : 0,
      items: credits.filter((k) => k.extra.length).slice(0, 20).map((k) => ({ taskId: k.taskId, title: k.title, points: k.points, reasons: k.extra, day: k.day, projectName: k.projectName })) },
    streaks: { weeks: weekly.current, bestWeeks: weekly.best, days: daily.current, bestDays: daily.best, calendar: days },
    accepted, pending: { points: pending.length, tasks: pending.length, items: pending },
  };
}

/** A leader's summary: one row per person in view with this week against their usual week, extra, waiting and streaks. */
export async function teamOutcomes(c: PoolClient, people: string[], thisWeek: string) {
  const weeks = weekList(thisWeek, 9);
  const rows = (await c.query(`with w as (select unnest($2::date[]) wk), p as (select unnest($1::uuid[]) id)
    select p.id,w.wk::text week,count(t.id)::int value,count(t.id) filter(where cardinality(coalesce((select k.extra from pulse.work_credit_kind(t.id,p.id) k),'{}'))>0)::int extra
    from p cross join w left join pulse.task t on ${ACCEPTED_BY_OTHERS('t', 'p.id')} and t.accepted_at>=w.wk::timestamp at time zone ${ORG_TZ} and t.accepted_at<(w.wk+7)::timestamp at time zone ${ORG_TZ}
    group by p.id,w.wk`, [people, weeks])).rows as
    { id: string; week: string; value: number; extra: number }[];
  const extra = (await c.query(`select p.id,(select count(*)::int from pulse.task t where coalesce(t.assignee_person_id,t.owner_id)=p.id and t.status in ('done','accepted','in_review')
      and t.done_at>=$2::date::timestamp at time zone ${ORG_TZ}) done,
     (select count(*)::int from pulse.task t where coalesce(t.assignee_person_id,t.owner_id)=p.id and t.status in ('done','in_review') and t.deleted_at is null) pending,
     (select coalesce(sum(minutes),0)::int from pulse.time_entry e where e.person_id=p.id and e.status='confirmed' and e.retired_at is null and e.work_date>=$2::date) minutes,
     array(select distinct date_trunc('week',t.done_at at time zone ${ORG_TZ})::date::text from pulse.task t where coalesce(t.assignee_person_id,t.owner_id)=p.id and t.done_at>now()-interval '1 year') "doneWeeks"
    from (select unnest($1::uuid[]) id) p`, [people, thisWeek])).rows as { id: string; done: number; pending: number; minutes: number; doneWeeks: string[] }[];
  return people.map((id) => {
    const mine = weeks.map((w) => rows.find((r) => r.id === id && r.week === w) ?? { value: 0, extra: 0 });
    const values = mine.map((r) => r.value); const usual = usualWeek(values.slice(0, -1));
    const e = extra.find((x) => x.id === id);
    return { id, values, value: values.at(-1) ?? 0, usual, extraWeek: mine.at(-1)?.extra ?? 0, extra8: mine.slice(1).reduce((n, r) => n + r.extra, 0), done: e?.done ?? 0, pending: e?.pending ?? 0,
      minutes: e?.minutes ?? 0, streak: runs(new Set(e?.doneWeeks ?? []), thisWeek, 7, 52).current };
  });
}
