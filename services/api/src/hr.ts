// Team & HR: attendance (check-in and out, breaks, late marks, work from home, regularisation), leave (types,
// balances, requests, holidays), the HR requests desk, the HR dashboard, payroll and the HR policy.
// A person sees their own records; their manager, HR and admins see and decide on them. Row-level security in
// migration 0007 enforces the same rules. Salary is read only through the logged database functions.
import { ORG_TZ } from "./org-time.js";
import { reconciliationBundle } from "./attendance-reconciliation.js";
import { attendanceStatistics, attendanceSummary, type Session } from "./attendance-statistics.js";
import {registerHrRuleRoutes,ruleVersions,ruleNotice} from "./hr-rule-routes.js";
import {activeRule,professionalTax} from "./hr-rules.js";
import {leaveNeedsHr} from "./hr-flow-policy.js";
import { registerHrFlowRoutes } from "./hr-flow.js";
import { attendanceEnabled, ATTENDANCE_OFF_MESSAGE } from "./attendance-policy.js";
import { payrollWindow } from "./onboarding-model.js";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { admin, fail, hr, type Tx, type Viewer } from "./routes.js";

type Body = Record<string, unknown>;
type Policy = { shiftStart: string; shiftEnd: string; graceMinutes: number; workDays: number[]; wfhPerMonth: number | null; leaveYearStart: number; trackingFrom: string; confirmedAt: string | null; attendanceEnabled: boolean };
type LeaveType = { key: string; name: string; paid: boolean; annualDays: number | null; accrual: "monthly" | "yearly" | "none"; carryForwardMax: number; active: boolean };
type Holiday = { day: string; name: string; optional: boolean };
export type Ctx = { today: string; clock: string; zone: string; policy: Policy; types: LeaveType[]; holidays: Holiday[]; fallbackWorkDays?: number[]; approvedWork?: Set<string>; dayWork?: Map<string, boolean>; off: Map<string, string> };
type Entry = Session & { id: string; personId: string; date: string; in: string; out: string | null; mode: string; late: number; missedOut: boolean; source: string; note: string | null; breakMinutes: number; onBreak: boolean; worked: number };
type Leave = { id: string; personId: string; fromDate: string; toDate: string; kind: string; status: string; halfDay: string | null; days: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CATEGORIES = ["payroll", "leave", "attendance", "equipment", "workplace", "grievance", "other"];
const TICKET_STATUS = ["open", "in_progress", "waiting", "resolved", "closed"];
const MODES = ["office", "wfh", "field"];
const REG_KINDS = ["missed_punch", "wfh", "on_duty", "late"];
export const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
const realDate = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(`${d}T00:00:00Z`)) && addDay(d, 0) === d;
const clockTime = (t: unknown): t is string => typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const longDayWords = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const eachDay = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to && out.length < 400; d = addDay(d, 1)) out.push(d); return out; };
const text = (raw: unknown, max: number) => String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const half = (n: number) => Math.floor(n * 2 + 1e-9) / 2;
const monthOf = (q: unknown, today: string) => typeof q === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : today.slice(0, 7);
const monthEnd = (month: string) => { const y = Number(month.slice(0, 4)), m = Number(month.slice(5)); return addDay(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`, -1); };
const mustId = (id: unknown, what: string): string => { if (typeof id !== "string" || !UUID.test(id)) fail(404, `${what} not found`); return id as string; };

const ENTRY = `e.id,e.person_id "personId",e.work_date::text "date",e.checked_in_at "in",e.checked_out_at "out",e.mode,e.late_minutes "late",
  e.missed_out "missedOut",e.source,e.note,b.rows breaks,
  exists(select 1 from pulse.attendance_regularisation r where r.person_id=e.person_id and r.work_date=e.work_date and r.kind='missed_punch' and r.status='pending') "pendingCorrection",b.minutes "breakMinutes",b.open "onBreak",
  greatest(0,round(extract(epoch from coalesce(e.checked_out_at,now())-e.checked_in_at)/60)-b.minutes)::int worked`;
const ENTRY_FROM = `pulse.attendance_effective e left join lateral (select coalesce(round(sum(extract(epoch from coalesce(x.ended_at,now())-x.started_at))/60),0)::int minutes,
  coalesce(bool_or(x.ended_at is null),false) open,
  coalesce(jsonb_agg(jsonb_build_object('in',x.started_at,'out',x.ended_at) order by x.started_at),'[]'::jsonb) rows from pulse.attendance_break x where x.entry_id=e.id) b on true`;
const entryRange = (from: string, to: string) => `(e.work_date between ${from}::date and ${to}::date or exists(select 1 from pulse.attendance_effective peer
  where peer.person_id=e.person_id and peer.work_date between ${from}::date and ${to}::date
  and e.checked_in_at<coalesce(peer.checked_out_at,now()) and coalesce(e.checked_out_at,now())>peer.checked_in_at))`;
const LEAVE = `l.id,l.person_id "personId",l.from_date::text "fromDate",l.to_date::text "toDate",l.leave_kind kind,l.status,l.half_day "halfDay",
  coalesce(l.days,(l.to_date-l.from_date)+1)::float days`;
const STAFF = `p.id,p.display_name name,pp.role,pp.pod,pp.department,pp.user_no "userNo",ph.updated_at "photoAt"`;
const STAFF_FROM = `pulse.person p join pulse.people_profile pp on pp.person_id=p.id left join pulse.person_photo ph on ph.person_id=p.id`;

/** The organisation's HR rules, today's date and the time on the company's clock (its time zone). */
export async function context(c: PoolClient): Promise<Ctx> {
  await c.query("select pulse.hr_flow_defaults()");
  const now = (await c.query(`select (now() at time zone ${ORG_TZ})::date::text today,to_char(now() at time zone ${ORG_TZ},'HH24:MI') clock,pulse.org_time_zone() zone`)).rows[0];
  const policy = (await c.query(`select to_char(shift_start,'HH24:MI') "shiftStart",to_char(shift_end,'HH24:MI') "shiftEnd",grace_minutes "graceMinutes",
    work_days "workDays",wfh_per_month "wfhPerMonth",leave_year_start "leaveYearStart",tracking_from::text "trackingFrom",confirmed_at "confirmedAt",
    attendance_enabled "attendanceEnabled" from pulse.hr_policy`)).rows[0] as Policy;
  policy.attendanceEnabled = policy.attendanceEnabled === true;
  const types = (await c.query(`select key,name,paid,annual_days::float "annualDays",accrual,carry_forward_max::float "carryForwardMax",active from pulse.leave_type order by sort,name`)).rows;
  const holidays: Holiday[] = (await c.query(`select day::text "day",name,optional from pulse.holiday where day >= $1::date - 400 order by day`, [now.today])).rows;
  const balanceRule=(await c.query("select pulse.hr_rule_at('leave_balance',$1) r",[now.today])).rows[0].r;
  if(balanceRule) {
    policy.leaveYearStart=Number(balanceRule.yearStart);
    const type=types.find((t:LeaveType)=>t.key===balanceRule.balanceKind);
    if(type){type.annualDays=Number(balanceRule.monthlyDays)*12;type.accrual='monthly';type.carryForwardMax=Number(balanceRule.carryMax);}
  }
  return { ...now, policy, types, holidays, off: new Map(holidays.filter(h => !h.optional).map(h => [h.day, h.name])) };
}
/** Use the person's effective shift in this work mode; overnight work belongs to its starting date. */
export async function shiftContext(c: PoolClient, x: Ctx, who: string, date: string, mode: string, overnight = false): Promise<Ctx> {
  const q = (await c.query(`select to_char(s.start_time,'HH24:MI') "shiftStart",to_char(s.end_time,'HH24:MI') "shiftEnd",s.grace_minutes "graceMinutes",s.work_days "workDays"
    from pulse.person_shift a join pulse.shift s on s.id=a.shift_id where a.person_id=$1 and a.mode=$2 and a.valid_from<=$3::date
    and (a.valid_to is null or a.valid_to >= $3::date) order by a.valid_from desc limit 1`,[who,mode,date])).rows[0];
  if (!q) return personalContext(c,x,who,date,date);
  const today = overnight && mins(q.shiftEnd)<=mins(q.shiftStart) && mins(x.clock)<mins(q.shiftEnd) ? addDay(date,-1) : x.today;
  return personalContext(c,{...x,today,fallbackWorkDays:q.workDays,policy:{...x.policy,...q}},who,today,today);
}
export async function personalContext(c: PoolClient, x: Ctx, who: string, from: string, to: string): Promise<Ctx> {
  const fallback=x.fallbackWorkDays??x.policy.workDays;
  const rows=(await c.query(`select d::date::text "day",exists(select 1 from pulse.hr_flow f where f.person_id=$1 and f.kind='work' and f.from_date=d::date and f.status='approved') approved,pulse.hr_working($1,d::date,
    coalesce((select s.work_days from pulse.person_shift a join pulse.shift s on s.id=a.shift_id where a.person_id=$1 and a.mode='office'
    and a.valid_from<=d::date and (a.valid_to is null or a.valid_to>=d::date) order by a.valid_from desc limit 1),$4::int[])) working
    from generate_series($2::date,$3::date,interval '1 day') d`,[who,from,to,fallback])).rows;
  const days=(await c.query('select pulse.hr_work_days($1,$2,$3) days',[who,x.today,fallback])).rows[0].days;
  return {...x,fallbackWorkDays:fallback,policy:{...x.policy,workDays:days},approvedWork:new Set(rows.filter(r=>r.approved).map(r=>r.day)),dayWork:new Map(rows.map(r=>[r.day,r.working]))};
}
export const working = (x: Ctx, d: string) => x.dayWork?.get(d) ?? (x.policy.workDays.includes(dow(d)) && !x.off.has(d));
export const lateFor = (x: Ctx, d: string, hhmm: string) => { const clock=mins(hhmm), start=mins(x.policy.shiftStart), end=mins(x.policy.shiftEnd); const late = clock - start + (end<=start && clock<end ? 1440 : 0); return working(x, d) && late > x.policy.graceMinutes ? late : 0; };
const leaveYear = (x: Ctx, d: string) => Number(d.slice(0, 4)) - (Number(d.slice(5, 7)) < x.policy.leaveYearStart ? 1 : 0);
const monthIndex = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;

const VIA = ["web", "widget", "desktop", "mobile", "chrome"];
const TRIGGERS = ["manual", "suggested", "auto", "reminder", "notification", "widget"];
/** Who recorded an attendance action (web widget, desktop, phone, Chrome), why (a tap, a suggestion at the office, an
 *  automatic check-in) and, for a tap saved offline, the moment it happened: accepted for up to 30 minutes and only
 *  from an offline queue (INTEGRITY: an older time, which would move a late mark, is a correction HR decides), kept
 *  visibly marked as synced late. Never coordinates: a place is an office or site id and the signal that matched. */
async function actionMeta(c: PoolClient, v: Viewer, raw: unknown, kind: "in" | "out" | "break") {
  const b = (raw && typeof raw === "object" ? raw : {}) as Body;
  if (b.expectedPersonId !== undefined && b.expectedPersonId !== v.person) fail(403, "Your sign-in changed. Reload My desk before retrying attendance.");
  let at: string | null = null;
  if (b.at !== undefined && b.at !== null) {
    const t = Date.parse(String(b.at));
    if (!Number.isFinite(t)) fail(400, "Use a valid time for the saved action");
    if (t > Date.now() + 120000) fail(400, "That time is in the future. Check the clock on your device.");
    if (t < Date.now() - 30 * 60000) fail(409, "This action was saved offline more than 30 minutes ago. Ask for a correction on My desk instead.");
    if (t < Date.now() - 120000 && !(typeof b.queueId === "string" && /^[A-Za-z0-9-]{8,64}$/.test(b.queueId))) fail(400, "A past time comes only from a saved offline action");
    at = new Date(t).toISOString();
  }
  const queueId = b.queueId === undefined || b.queueId === null ? null : typeof b.queueId === "string" && /^[A-Za-z0-9-]{8,64}$/.test(b.queueId) ? b.queueId : fail(400, "Invalid saved action");
  const via = VIA.includes(String(b.via)) ? String(b.via) : null;
  const trigger = TRIGGERS.includes(String(b.trigger)) ? String(b.trigger) : null;
  const p = b.place && typeof b.place === "object" ? b.place as Body : null;
  const place = p && ["office", "site"].includes(String(p.kind)) && UUID.test(String(p.id)) && ["region", "wifi", "gps"].includes(String(p.signal)) ? { kind: String(p.kind), id: String(p.id), signal: String(p.signal) } : null;
  if (trigger === "auto") {
    if (kind !== "in") fail(400, "Only a check-in can be automatic");
    if (place?.kind !== "office") fail(400, "Automatic check-in needs a registered office");
    if (!(await c.query("select presence_auto_checkin allowed from pulse.hr_policy")).rows[0]?.allowed) fail(403, "Automatic check-in is turned off by HR");
  }
  if (place && !(await c.query(place.kind === "office" ? "select 1 from pulse.presence_office where id=$1 and active" : "select 1 from pulse.project_location where id=$1 and precision in ('exact','building')", [place.id])).rows[0]) fail(400, "That place is no longer registered for check-in");
  if (trigger === "auto") fail(403,"Automatic check-in is confirmed by the server after office dwell. Send current presence instead.");
  const meta = via || trigger || place || at || queueId || v.nativeDevice ? { ...(via ? { via } : {}), ...(trigger ? { trigger } : {}), ...(place ? { place } : {}),
    ...(v.nativeDevice ? { device: v.nativeDevice } : {}), ...(queueId ? { queueId } : {}), ...(at ? { queued: true, recordedAt: new Date().toISOString() } : {}) } : null;
  return { at, queueId, meta };
}

/** People whose work mode is outcome-based (RT1): measured by work and KPIs, not by punches. */
export async function outcomePeople(c: PoolClient): Promise<Set<string>> {
  return new Set((await c.query("select person_id from pulse.person_work_terms where work_mode='outcome'")).rows.map(r => r.person_id as string));
}
/** One row per calendar day: what the records say about that day for one person. */
function dayRows(x: Ctx, from: string, to: string, entries: Entry[], leaves: Leave[], since: string | null, outcome = false) {
  // RT1: outcome-based people have no check-in requirement, so a day without one is "outcome", never absent; no late marks.
  if (outcome) entries = entries.map(e => ({ ...e, late: 0 }));
  const statistics = attendanceStatistics(entries);
  const byDate = new Map<string, Entry[]>(); for (const e of entries) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  return eachDay(from, to).map(date => {
    const sessions = byDate.get(date) ?? [], entry = sessions[0] ?? null;
    const attendance = entry ? statistics.days.get(`${entry.personId}:${date}`)! : null;
    const holiday = working(x,date) ? null : x.off.get(date) ?? null, weeklyOff = !working(x,date) && !holiday;
    const leave = leaves.find(l => l.status === "approved" && l.fromDate <= date && l.toDate >= date) ?? null;
    const pending = leaves.find(l => l.status === "pending" && l.fromDate <= date && l.toDate >= date) ?? null;
    const status = entry ? "present" : holiday ? "holiday" : weeklyOff ? "off" : leave ? "leave"
      : date > x.today ? "upcoming" : outcome ? "outcome" : date === x.today ? "today" : !since || date < since ? "untracked" : "absent";
    return { date, status, holiday, entry, sessions, attendance, workApproved:x.approvedWork?.has(date)??false, leave: leave && !weeklyOff && !holiday ? { kind: leave.kind, halfDay: leave.halfDay } : null, pendingLeave: !!pending };
  });
}
function summarise(days: ReturnType<typeof dayRows>) {
  const present = days.filter(d => d.entry);
  const statistics = attendanceSummary(present.map(d => d.attendance!), days[0]?.date ?? "", days.at(-1)?.date ?? "");
  return { present: present.length, wfh: present.filter(d => d.sessions.some(e => e.mode === "wfh")).length, late: present.filter(d => d.sessions.some(e => e.late > 0)).length,
    leave: days.reduce((n, d) => n + (d.leave ? (d.leave.halfDay ? 0.5 : 1) : 0), 0), absent: days.filter(d => d.status === "absent").length,
    missedOut: present.filter(d => d.sessions.some(e => e.missedOut)).length, ...statistics };
}

/** Leave balances for the current leave year. Accrual starts when leave tracking moved into Pulse; opening balances are adjustments. */
async function balances(c: PoolClient, x: Ctx, people: string[] | null) {
  const versions=await ruleVersions(c);
  const enabled=activeRule(versions,'leave_balance',x.today)||activeRule(versions,'late_marks',x.today);
  const filter = "($1::uuid[] is null or person_id=any($1))";
  const taken = (await c.query(`select person_id "personId",leave_kind kind,from_date::text "fromDate",status,coalesce(days,(to_date-from_date)+1)::float days
    from pulse.leave_request where status in ('approved','pending') and ${filter}`, [people])).rows;
  const adjusted = (await c.query(`select person_id "personId",type_key kind,leave_year "year",sum(days)::float days from pulse.leave_adjustment where ${filter} group by 1,2,3`, [people])).rows;
  const joined = new Map<string, string | null>((await c.query(`select person_id,joined_on::text j from pulse.people_profile where ${filter}`, [people])).rows.map(r => [r.person_id, r.j]));
  const ids = people ?? [...joined.keys()], thisYear = leaveYear(x, x.today), firstYear = Math.min(thisYear, leaveYear(x, x.policy.trackingFrom));
  const start = (year: number) => `${year}-${String(x.policy.leaveYearStart).padStart(2, "0")}-01`;
  const out = new Map<string, { key: string; accrued: number; carried: number; adjusted: number; used: number; pending: number; available: number }[]>();
  for (const id of ids) {
    out.set(id, x.types.filter(t => t.active && t.annualDays !== null).map(t => {
      let carried = 0, row = { key: t.key, accrued: 0, carried: 0, adjusted: 0, used: 0, pending: 0, available: 0 };
      for (let year = firstYear; year <= thisYear; year += 1) {
        const since = [start(year), x.policy.trackingFrom, joined.get(id) ?? ""].sort().at(-1)!;
        const last = monthIndex(start(year)) + 11, first = Math.max(monthIndex(since), monthIndex(start(year)));
        const months = Math.max(0, (t.accrual === "monthly" ? Math.min(last, monthIndex(x.today)) : last) - first + 1);
        const accrued = t.accrual === "none" ? t.annualDays! : half(t.annualDays! * months / 12);
        const mine = taken.filter(r => r.personId === id && r.kind === t.key && leaveYear(x, r.fromDate) === year);
        const used = mine.filter(r => r.status === "approved").reduce((n, r) => n + r.days, 0), pending = mine.filter(r => r.status === "pending").reduce((n, r) => n + r.days, 0);
        const adj = adjusted.filter(r => r.personId === id && r.kind === t.key && r.year === year).reduce((n, r) => n + r.days, 0);
        row = { key: t.key, accrued, carried, adjusted: adj, used, pending, available: accrued + carried + adj - used };
        carried = Math.min(t.carryForwardMax, Math.max(0, row.available));
      }
      return row;
    }));
  }
  if(enabled)for(const id of ids) {
    const rows=[];
    for(const t of x.types.filter(t=>t.active&&t.annualDays!==null&&t.key!=='comp_off'))rows.push((await c.query('select pulse.hr_balance_detail($1,$2,$3) data',[id,t.key,x.today])).rows[0].data);
    out.set(id,rows);
  }
  for(const id of ids) {
    const available=Number((await c.query('select pulse.hr_comp_balance($1,$2)::float available',[id,x.today])).rows[0].available);
    const rows=out.get(id)??[];
    const used=taken.filter(r=>r.personId===id && r.kind==='comp_off' && r.status==='approved').reduce((n,r)=>n+r.days,0);
    const pending=taken.filter(r=>r.personId===id && r.kind==='comp_off' && r.status==='pending').reduce((n,r)=>n+r.days,0);
    out.set(id,[...rows.filter(r=>r.key!=='comp_off'),{key:'comp_off',accrued:available+used,carried:0,adjusted:0,used,pending,available}]);
  }
  return out;
}

/** Deliveries through a person's linked accounts: weekly counts, the last four full weeks against the eight before, and quality signals. */
async function performance(c: PoolClient, x: Ctx, who: string) {
  const scope=`person:${who}`;
  const weeks = (await c.query(`select w::date::text "start",count(d.file_id)::int deliveries,count(*) filter(where d.kind='final')::int finals,
    count(*) filter(where d.kind='draft')::int drafts
    from generate_series(date_trunc('week',$2::date::timestamp) - interval '105 days',date_trunc('week',$2::date::timestamp),interval '7 days') w
    left join pulse.delivery d on pulse.delivery_matches(d.file_id,$1) and d.delivered_at >= (w at time zone ${ORG_TZ}) and d.delivered_at < ((w + interval '7 days') at time zone ${ORG_TZ})
    group by w order by w`, [scope, x.today])).rows as { start: string; deliveries: number; finals: number; drafts: number }[];
  const avg = (rows: typeof weeks) => rows.length ? rows.reduce((n, w) => n + w.deliveries, 0) / rows.length : 0;
  const recent = avg(weeks.slice(11, 15)), baseline = avg(weeks.slice(3, 11));
  const quality = (await c.query(`select count(*)::int total,count(*) filter(where d.kind='final')::int finals,
    count(*) filter(where (select count(*) from pulse.index_version iv where iv.org_id=d.org_id and iv.file_id=d.file_id) > 1)::int revised,
    count(distinct d.project_id)::int projects,count(distinct (d.delivered_at at time zone ${ORG_TZ})::date)::int "activeDays"
    from pulse.delivery d where pulse.delivery_matches(d.file_id,$1) and d.delivered_at >= now() - interval '56 days'`, [scope])).rows[0];
  const allTime = (await c.query("select count(*)::int n,min(delivered_at) first from pulse.delivery d where pulse.delivery_matches(d.file_id,$1)", [scope])).rows[0];
  return { linked: true as const, weeks: weeks.slice(4), thisWeek: weeks[15].deliveries, recent, baseline, quality, allTime: allTime.n, firstDeliveryAt: allTime.first };
}

/** The month as payroll will read it: days present, late marks, half days, leave and what is still waiting, with HR's
 *  cut-off date (hr_policy.payroll_cutoff_day). Waiting corrections and leave are what the person can still fix. */
async function payrollMonth(c: PoolClient, month: string, from: string, to: string, today: string, days: ReturnType<typeof dayRows>,
  ruleDays: { date: string; late: boolean; halfDay: boolean }[], regularisations: { date: string; status: string }[], leaves: (Leave & Record<string, unknown>)[]) {
  const cutoffDay = (await c.query("select payroll_cutoff_day d from pulse.hr_policy")).rows[0]?.d ?? null;
  const s = summarise(days), inMonth = (d: string) => d >= from && d <= to;
  return { month, cutoffDay, ...payrollWindow(month, today, cutoffDay), present: s.present, wfh: s.wfh, late: s.late, leave: s.leave, absent: s.absent, missedOut: s.missedOut,
    halfDays: ruleDays.filter(d => d.halfDay && d.date <= today).length + leaves.filter(l => l.status === "approved" && l.halfDay && l.fromDate >= from && l.fromDate <= to).length,
    pendingCorrections: regularisations.filter(r => r.status === "pending" && inMonth(r.date)).length,
    pendingLeave: leaves.filter(l => l.status === "pending" && l.toDate >= from && l.fromDate <= to).length };
}

export function registerHrRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  registerHrRuleRoutes(app,{tx});
  const body = { type: "object" } as const;
  const person = (v: Viewer): string => { if (!v.person) fail(403, "A shared login cannot act for a person"); return v.person as string; };
  const mustHr = (v: Viewer) => { if (!hr(v) || !v.person) fail(403, "This is for HR and organisation admins"); };
  const change = (c: PoolClient, v: Viewer, entity: string, id: string, field: string, from: string | null, to: string | null) =>
    c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values ($1,$2,$3,$4,$5,$6,$7)`, [v.org, entity, id, field, from, to, v.person]);
  const canDecide = async (c: PoolClient, v: Viewer, subject: string) => hr(v) || (await c.query("select pulse.manages($1) ok", [subject])).rows[0].ok;
  const entriesFor = async (c: PoolClient, who: string, from: string, to: string): Promise<Entry[]> =>
    (await c.query(`select ${ENTRY} from ${ENTRY_FROM} where e.person_id=$1 and ${entryRange("$2", "$3")} order by e.work_date,e.checked_in_at`, [who, from, to])).rows;

  app.post<{ Body: Body }>("/api/v0/hr/attendance-close-policy", { schema: { body } }, req => tx(req,async(c,v)=>{
    mustHr(v);const b=req.body;
    const values=[b.promptMinutes,b.capMinutes,b.minimumDays].map(Number);
    if(values.some(n=>!Number.isInteger(n)))fail(400,"Give whole minutes and sample days");
    const version=(await c.query("select pulse.attendance_policy_propose($1,$2,$3,$4,$5) version",[...values,text(b.timezone,80),text(b.longShiftRule,500)])).rows[0].version;
    return {version,mode:"suggestion",approved:false,automaticClosureEnabled:false};
  }));
  // ------------------------------------------------------------------------------------------------ attendance
  app.post<{ Body: Body }>("/api/v0/attendance/check-in", { schema: { body } }, req => tx(req, async (c, v) => {
    if (!(await attendanceEnabled(c))) fail(403, ATTENDANCE_OFF_MESSAGE);
    const who = person(v); await c.query("select pg_advisory_xact_lock(hashtext($1))", ["attendance:"+who]); const act = await actionMeta(c, v, req.body, "in"); let x = await context(c);
    const replay = act.queueId ? (await c.query("select id from pulse.attendance_effective where person_id=$1 and client->>'queueId'=$2 union all select entry_id id from pulse.attendance_break where person_id=$1 and client->>'queueId'=$2 and client->>'action'='check-in' limit 1", [who, act.queueId])).rows[0] : null;
    if (replay) return { id: replay.id, replayed: true };
    if (act.at) x = { ...x, ...(await c.query(`select ($1::timestamptz at time zone ${ORG_TZ})::date::text today,to_char($1::timestamptz at time zone ${ORG_TZ},'HH24:MI') clock`, [act.at])).rows[0] };
    const planned = (await c.query(`select kind from pulse.attendance_regularisation where person_id=$1 and work_date in ($2::date,$2::date-1) and status='approved' and kind in ('wfh','on_duty') order by work_date desc,created_at desc limit 1`, [who, x.today])).rows[0];
    const mode = MODES.includes(String(req.body?.mode)) ? String(req.body.mode) : planned ? (planned.kind === "wfh" ? "wfh" : "field") : "office";
    x = await shiftContext(c,x,who,x.today,mode,true);
    if(!working(x,x.today))fail(403,"Request work on this weekly off or holiday and wait for approval before checking in");
    const open = (await c.query(`select id,work_date::text "date",checked_in_at "in",mode from pulse.attendance_effective where person_id=$1 and checked_out_at is null`, [who])).rows[0];
    if (open?.date === x.today) fail(409, "You are already checked in");
    // UX-5A: a check-in on a day of approved (whole-day) leave never cancels the leave silently. `leave: "cancel"` (the
    // person said yes to "You're on leave today. Cancel the leave and check in?") cancels today's day of it and tells HR;
    // anything else records the check-in and raises it for HR to decide, once a day (a phone that cannot ask does this).
    const onLeave = (await c.query(`select l.id,l.leave_kind "kind",l.from_date::text "from",l.to_date::text "to" from pulse.leave_request l where l.person_id=$1 and l.status='approved'
      and l.half_day is null and l.from_date<=$2::date and l.to_date>=$2::date and not exists(select 1 from pulse.attendance_leave_overlap o where o.person_id=l.person_id and o.work_date=$2::date) limit 1`, [who, x.today])).rows[0] as { id: string; kind: string; from: string; to: string } | undefined;
    let leave: "cancelled" | "kept" | null = null;
    if (onLeave) {
      const inside = onLeave.from < x.today && onLeave.to > x.today;
      if (req.body?.leave === "cancel" && !(onLeave.kind === "comp_off" && inside)) {
        const px = await personalContext(c, await context(c), who, onLeave.from, onLeave.to);
        const count = (from: string, to: string) => from > to ? 0 : eachDay(from, to).filter(d => working(px, d)).length;
        await c.query("select pulse.leave_cancel_day($1,$2,$3,$4)", [onLeave.id, x.today, count(onLeave.from, addDay(x.today, -1)), count(addDay(x.today, 1), onLeave.to)]);
        leave = "cancelled";
      } else leave = "kept";
    }
    if (open && act.at && Date.parse(act.at) < Date.parse(open.in)) fail(409, "That check-in is earlier than your open one. Ask for a correction instead.");
    // Keep the original open punch; the proposed close is unresolved until independently reviewed.
    if (open) {
      const previous=await shiftContext(c,await context(c),who,open.date,open.mode);
      const close=(await c.query(`select greatest($1::timestamptz,least(coalesce($5::timestamptz,now()),
        (($2::date+case when $4::time<=$3::time then 1 else 0 end+$4::time) at time zone ${ORG_TZ}))) stamp`,
        [open.in,open.date,previous.policy.shiftStart,previous.policy.shiftEnd,act.at])).rows[0].stamp;
      await c.query("select pulse.attendance_propose_close($1,$2)", [open.id,close]);
    }
    const earlier = (await c.query("select id,checked_out_at \"out\" from pulse.attendance_effective where person_id=$1 and work_date=$2 and not exists(select 1 from pulse.attendance_correction_time t where t.entry_id=pulse.attendance_effective.id) and not exists(select 1 from pulse.attendance_provisional_close p where p.entry_id=pulse.attendance_effective.id) order by checked_in_at limit 1", [who, x.today])).rows[0];
    if (earlier) {      // back after checking out today: the gap is a break
      if (act.at && Date.parse(act.at) < Date.parse(earlier.out)) fail(409, "That check-in is earlier than today's check-out. Ask for a correction instead.");
      await c.query(`insert into pulse.attendance_break(org_id,entry_id,person_id,started_at,ended_at,client) select org_id,id,person_id,checked_out_at,coalesce($2::timestamptz,now()),$3 from pulse.attendance_effective where id=$1`, [earlier.id, act.at, { ...act.meta, action: "check-in" }]);
      await c.query("update pulse.attendance_entry set checked_out_at=null,out_client=null where id=$1", [earlier.id]);
      return { id: earlier.id, resumed: true };
    }
    // Outcome-based people may check in (an office day), but never get a late mark.
    const lateMinutes = (await c.query("select pulse.work_mode($1) mode", [who])).rows[0].mode === "outcome" ? 0 : lateFor(x, x.today, x.clock);
    const row = (await c.query(`insert into pulse.attendance_entry(org_id,person_id,work_date,mode,late_minutes,note,checked_in_at,client) values ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz,now()),$8)
      on conflict(org_id,person_id) where checked_out_at is null and not reconciled_open do nothing returning id`, [v.org, who, x.today, mode, lateMinutes, text(req.body?.note, 200) || null, act.at, act.meta])).rows[0];
    if (!row) fail(409, "You are already checked in");
    if (onLeave && leave) {
      const words = `${longDayWords(x.today)} (${onLeave.kind.replace(/_/g, " ")} leave)`;
      const ticket = leave === "kept" ? (await c.query("select pulse.hr_ticket_open('attendance',$1,$2,'normal') id", [`Checked in on approved leave: ${words}`.slice(0, 140),
        `I checked in at ${x.clock} on a day of approved leave and kept the leave. HR decides: keep the leave, or count the day as worked and give the leave back.`])).rows[0].id : null;
      await c.query(`insert into pulse.attendance_leave_overlap(org_id,person_id,leave_id,work_date,entry_id,decision,ticket_id,leave_kind) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
        [v.org, who, onLeave.id, x.today, row.id, leave, ticket, onLeave.kind]);
    }
    return { id: row.id, mode, late: lateMinutes, leave };
  }));
  app.post<{ Body: Body }>("/api/v0/attendance/check-out", req => tx(req, async (c, v) => {
    if (!(await attendanceEnabled(c))) fail(403, ATTENDANCE_OFF_MESSAGE);
    const who = person(v); await c.query("select pg_advisory_xact_lock(hashtext($1))", ["attendance:"+who]); const act = await actionMeta(c, v, req.body, "out");
    const replay = act.queueId ? (await c.query("select id from pulse.attendance_effective where person_id=$1 and out_client->>'queueId'=$2", [who, act.queueId])).rows[0] : null;
    if (replay) return { id: replay.id, replayed: true };
    const open = (await c.query(`select e.id,greatest(e.checked_in_at,coalesce((select max(b.ended_at) from pulse.attendance_break b where b.entry_id=e.id),e.checked_in_at),
      coalesce((select b.started_at from pulse.attendance_break b where b.entry_id=e.id and b.ended_at is null),e.checked_in_at)) "last"
      from pulse.attendance_effective e where e.person_id=$1 and e.checked_out_at is null`, [who])).rows[0];
    if (!open) fail(409, "Check in first");
    if (act.at && Date.parse(act.at) < Date.parse(open.last)) fail(409, "That check-out is earlier than your last check-in or break. Ask for a correction instead.");
    const row = (await c.query(`update pulse.attendance_entry set checked_out_at=coalesce($2::timestamptz,now()),out_client=$3 where id=$1 returning id`, [open.id, act.at, act.meta])).rows[0];
    await c.query("update pulse.attendance_break set ended_at=coalesce($2::timestamptz,now()),end_client=$3 where entry_id=$1 and ended_at is null", [row.id, act.at, act.meta]);
    return row;
  }));
  app.post<{ Body: Body }>("/api/v0/attendance/break", { schema: { body } }, req => tx(req, async (c, v) => {
    if (!(await attendanceEnabled(c))) fail(403, ATTENDANCE_OFF_MESSAGE);
    const who = person(v); await c.query("select pg_advisory_xact_lock(hashtext($1))", ["attendance:"+who]); const act = await actionMeta(c, v, req.body, "break"); const ending = req.body.action === "end";
    if (act.queueId) {
      const replay = (await c.query(`select id from pulse.attendance_break where person_id=$1 and ${ending ? "end_client" : "client"}->>'queueId'=$2`, [who, act.queueId])).rows[0];
      if (replay) return { id: replay.id, replayed: true };
    }
    const open = (await c.query(`select e.id,greatest(e.checked_in_at,coalesce((select max(b.ended_at) from pulse.attendance_break b where b.entry_id=e.id),e.checked_in_at)) "last",
      (select b.started_at from pulse.attendance_break b where b.entry_id=e.id and b.ended_at is null) "breakStart"
      from pulse.attendance_effective e where e.person_id=$1 and e.checked_out_at is null`, [who])).rows[0];
    if (!open) fail(409, "Check in first");
    if (ending) {
      if (act.at && open.breakStart && Date.parse(act.at) < Date.parse(open.breakStart)) fail(409, "That is earlier than the start of your break");
      const done = (await c.query("update pulse.attendance_break set ended_at=coalesce($2::timestamptz,now()),end_client=$3 where entry_id=$1 and ended_at is null returning id", [open.id, act.at, act.meta])).rows[0];
      if (!done) fail(409, "You are not on a break"); return done;
    }
    if (act.at && Date.parse(act.at) < Date.parse(open.last)) fail(409, "That break starts before your last check-in or break ended");
    const started = (await c.query(`insert into pulse.attendance_break(org_id,entry_id,person_id,started_at,client) values ($1,$2,$3,coalesce($4::timestamptz,now()),$5)
      on conflict(entry_id) where ended_at is null do nothing returning id`, [v.org, open.id, who, act.at, act.meta])).rows[0];
    if (!started) fail(409, "You are already on a break"); return started;
  }));
  // ATT: the one question Pulse asks when the signals conflict, answered in one tap: "Yes, I left at 18:40" (checks out at
  // the time Pulse saw them leave; their word and the signals agree, so it stands) or "Still working" (nothing asks again).
  app.post<{ Body: Body }>("/api/v0/attendance/answer", { schema: { body } }, req => tx(req, async (c, v) => {
    if (!(await attendanceEnabled(c))) fail(403, ATTENDANCE_OFF_MESSAGE);
    const who = person(v), entryId = String(req.body?.entryId ?? ""), answer = String(req.body?.answer ?? "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entryId) || !["left", "working"].includes(answer)) fail(400, "Answer “left” or “working” for one of your sessions");
    await c.query("select pg_advisory_xact_lock(hashtext($1))", ["attendance:" + who]);
    if (!(await c.query("select 1 from pulse.attendance_entry where id=$1 and person_id=$2", [entryId, who])).rowCount) fail(404, "That session is not yours");
    return (await c.query("select pulse.attendance_answer($1,$2) r", [entryId, answer])).rows[0].r;
  }));
  // The earlier, flat list of check-ins; kept for the home page and older clients.
  app.get("/api/v0/attendance", req => tx(req, async (c, v) => {
    const enabled = await attendanceEnabled(c);
    return { attendanceEnabled: enabled, role: v.role, person: v.person,
      ownOpen: enabled ? (await c.query("select exists(select 1 from pulse.attendance_effective where person_id=$1 and checked_out_at is null) open", [v.person])).rows[0].open : false,
      entries: enabled ? (await c.query(`select e.id,p.display_name name,e.checked_in_at "checkedInAt",e.checked_out_at "checkedOutAt"
        from pulse.attendance_effective e join pulse.person p on p.id=e.person_id
        where ($1::boolean or e.person_id=$2) order by checked_in_at desc limit 100`, [hr(v), v.person])).rows : [] };
  }));

  /** What approving a correction would write: the day's in and out times and how the day was worked. */
  async function planCorrection(c: PoolClient, x: Ctx, r: { personId: string; date: string; kind: string; inTime: string | null; outTime: string | null; entryId?: string | null }) {
    x = await shiftContext(c,x,r.personId,r.date,r.kind === "wfh" ? "wfh" : r.kind === "on_duty" ? "field" : "office");
    const existing = (await c.query(`select id,to_char(checked_in_at at time zone ${ORG_TZ},'HH24:MI') "in",
      case when checked_out_at is not null and not missed_out then to_char(checked_out_at at time zone ${ORG_TZ},'HH24:MI') end "out",mode
      from pulse.attendance_effective where person_id=$1 and work_date=$2 and ($3::uuid is null or id=$3) order by checked_in_at limit 1`, [r.personId, r.date,r.entryId??null])).rows[0];
    if(r.entryId&&!existing)fail(404,"That receipt does not belong to this person and day");
    if (r.kind === "late") { if (!existing) fail(400, "There is no check-in on that day to correct"); return { existing, write: false as const }; }
    const planned = r.kind !== "missed_punch" && r.date >= x.today && !existing;      // a day worked from home or on duty that has not happened yet
    if (planned) return { existing, write: false as const };
    const inTime = r.inTime ?? existing?.in ?? (r.kind === "missed_punch" ? null : x.policy.shiftStart);
    const outTime = r.outTime ?? existing?.out ?? (r.kind === "missed_punch" || r.date === x.today ? null : x.policy.shiftEnd);
    if (!inTime) fail(400, "Give the time you started");
    if (!outTime && (r.date < x.today || existing)) fail(400, "Give the time you finished for the receipt being reviewed");
    return { existing, write: true as const, inTime: inTime as string, outTime, mode: r.kind === "wfh" ? "wfh" : r.kind === "on_duty" ? "field" : existing?.mode ?? "office" };
  }
  async function applyCorrection(c: PoolClient, v: Viewer, x: Ctx, r: { personId: string; date: string; kind: string; inTime: string | null; outTime: string | null; entryId?: string | null }, sourceId?:string) {
    await c.query("select pg_advisory_xact_lock(hashtext($1))",["attendance:"+r.personId]);
    const plan = await planCorrection(c, x, r);
    if(sourceId)await c.query("select pulse.hr_correction_capture($1,$2)",[sourceId,plan.existing?.id??null]);
    if (r.kind === "late") { await c.query(`select pulse.attendance_accept_time($1,$2,checked_in_at,checked_out_at,mode,0) from pulse.attendance_effective where id=$2`, [sourceId,plan.existing.id]); return; }
    if (!plan.write) return;
    // A finish time at or before the start belongs to the next morning (an evening shift).
    const stamp = `(($2::date + $3::time) at time zone ${ORG_TZ})`, out = `case when $4::time is null then null when $4::time <= $3::time then (($2::date + 1 + $4::time) at time zone ${ORG_TZ}) else (($2::date + $4::time) at time zone ${ORG_TZ}) end`;
    const late = r.kind === "missed_punch" ? lateFor(x, r.date, plan.inTime) : 0;
    if (plan.existing) await c.query(`select pulse.attendance_accept_time($7,$1,${stamp},${out},$5,$6)`,
      [plan.existing.id, r.date, plan.inTime, plan.outTime, plan.mode, late,sourceId]);
    else await c.query(`insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at,checked_out_at,mode,late_minutes,source)
      values ($1,$7,$2,${stamp},${out},$5,$6,'regularised')`, [v.org, r.date, plan.inTime, plan.outTime, plan.mode, late, r.personId]);
  }
  const REG = `r.id,r.person_id "personId",p.display_name name,r.work_date::text "date",r.kind,to_char(r.in_time,'HH24:MI') "inTime",to_char(r.out_time,'HH24:MI') "outTime",
    r.reason,r.status,r.created_at "createdAt",r.decided_at "decidedAt",r.decision_note "decisionNote",d.display_name "decidedBy"`;
  const REG_FROM = "pulse.attendance_regularisation r join pulse.person p on p.id=r.person_id left join pulse.person d on d.id=r.decided_by";
  app.post<{ Body: Body }>("/api/v0/hr/regularisations", { schema: { body } }, req => tx(req, async (c, v) => {
    if (!(await attendanceEnabled(c))) fail(403, ATTENDANCE_OFF_MESSAGE);
    const me = person(v), x = await context(c), b = req.body;
    const subject = b.personId && b.personId !== me ? mustId(b.personId, "Person") : me, onBehalf = subject !== me;
    if (onBehalf) mustHr(v);
    await c.query("select pg_advisory_xact_lock(hashtext($1))",["attendance:"+subject]);
    const kind = String(b.kind ?? ""), date = String(b.date ?? ""), reason = text(b.reason, 500);
    if (!REG_KINDS.includes(kind)) fail(400, "Choose what needs correcting");
    if (!realDate(date)) fail(400, "Choose the day");
    if (date < addDay(x.today, -62) || date > addDay(x.today, 31)) fail(400, "Choose a day within the last two months or the next month");
    if ((kind === "missed_punch" || kind === "late") && date > x.today) fail(400, "That day has not happened yet");
    if (reason.length < 5) fail(400, "Give a reason, so the person approving knows what happened");
    const inTime = b.inTime ? (clockTime(b.inTime) ? b.inTime : fail(400, "Use a time such as 10:15")) : null;
    const outTime = b.outTime ? (clockTime(b.outTime) ? b.outTime : fail(400, "Use a time such as 19:00")) : null;
    if (!(await c.query("select 1 from pulse.person where id=$1 and side='staff'", [subject])).rows[0]) fail(404, "Person not found");
    if ((await c.query("select 1 from pulse.attendance_regularisation where person_id=$1 and work_date=$2 and kind=$3 and status='pending'", [subject, date, kind])).rows[0]) fail(409, "A request for this day is already waiting for a decision");
    const entryId=b.entryId?mustId(b.entryId,"Receipt"):null;
    const r = { personId: subject, date, kind, inTime, outTime,entryId };
    await planCorrection(c, x, r);      // refuses a request that could not be applied
    // INTEGRITY part 2 (1002): a correction HR files for someone waits for someone else's decision, like anyone's; the filer
    // never approves it (pulse.hr_flow_decide).
    const id = (await c.query(`insert into pulse.attendance_regularisation(org_id,person_id,work_date,kind,in_time,out_time,reason,status,entry_id,filed_by)
      values ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9) returning id`,
    [v.org, subject, date, kind, inTime, outTime, reason, entryId, onBehalf ? me : null])).rows[0].id;
    return { id, status: "pending" };
  }));
  // ------------------------------------------------------------------------------- features people want (R15d)
  // Time wallet, "Your day, written for you" and "Never marked late by mistake", for the person only. Presence evidence
  // comes from Pulse's own record of the person's authorized devices, never from the request.
  async function lateEvidence(c: PoolClient, who: string, date: string) {
    return (await c.query(`select min(least(s.dwell_started_at,s.last_present_at)) at,(array_agg(o.name order by s.dwell_started_at))[1] office,
      (array_agg(d.platform order by s.dwell_started_at))[1] platform
      from pulse.companion_presence s join pulse.native_device d on d.id=s.device_id and d.revoked_at is null join pulse.presence_office o on o.id=s.office_id
      where s.person_id=$1 and s.consent and (least(s.dwell_started_at,s.last_present_at) at time zone ${ORG_TZ})::date=$2::date`, [who, date])).rows[0] as { at: Date | null; office: string | null; platform: string | null };
  }
  app.get("/api/v0/companion/wallet", req => tx(req, async (c, v) => {
    const me = person(v); let x = await context(c);
    const enabled = x.policy.attendanceEnabled;
    x = await shiftContext(c, x, me, x.today, "office");
    const monthStart = `${x.today.slice(0, 7)}-01`;
    const entries = enabled ? await entriesFor(c, me, monthStart, x.today) : [];
    const shiftMinutes = ((mins(x.policy.shiftEnd) - mins(x.policy.shiftStart)) + 1440) % 1440 || 540;
    const worked = (e: Entry, at = Date.now()) => Math.max(0, Math.round(((e.out ? Date.parse(e.out) : at) - Date.parse(e.in)) / 60000) - (e.breakMinutes ?? 0));
    const closed = entries.filter(e => e.out);
    const extraMinutes = closed.reduce((n, e) => n + Math.max(0, worked(e) - shiftMinutes), 0);
    const types = new Map(x.types.map(t => [t.key, t.name]));
    const leave = ((await balances(c, x, [me])).get(me) ?? []).filter(b => b.available !== null && (types.has(b.key) || b.key === "comp_off"))
      .map(b => ({ key: b.key, label: b.key === "comp_off" ? "Comp-off" : types.get(b.key) ?? b.key, available: b.available, pending: b.pending }));
    const nextHoliday = x.holidays.find(h => h.day >= x.today && !h.optional) ?? null;
    const today = entries.filter(e => e.date === x.today);
    const first = today[0] ?? null;
    const evidence = enabled ? await lateEvidence(c, me, x.today) : null;
    const pendingLate = enabled ? (await c.query("select 1 from pulse.attendance_regularisation where person_id=$1 and work_date=$2 and kind='late' and status='pending'", [me, x.today])).rows[0] : null;
    const late = first && first.late > 0 ? { minutes: first.late, checkedInAt: first.in, arrivedAt: evidence?.at ?? null, office: evidence?.office ?? null,
      device: evidence?.platform ? (["windows", "macos"].includes(evidence.platform) ? "laptop" : "phone") : null,
      disputable: !!evidence?.at && Date.parse(String(evidence.at)) < Date.parse(first.in) && !pendingLate, pending: !!pendingLate } : null;
    const deliveries = (await c.query(`select count(*)::int n from pulse.delivery d where pulse.delivery_matches(d.file_id,$1) and (d.delivered_at at time zone ${ORG_TZ})::date=$2::date`, [`person:${me}`, x.today])).rows[0].n;
    const focus = (await c.query(`select e.data->>'tool' tool,sum((e.data->>'activeSeconds')::int)::int seconds from pulse.native_event e
      where e.person_id=$1 and e.kind='usage' and (e.at at time zone ${ORG_TZ})::date=$2::date group by 1 order by 2 desc limit 4`, [me, x.today])).rows;
    const manager = (await c.query(`select m.id,m.display_name name from pulse.people_profile pp join pulse.person m on m.id=pp.manager_id where pp.person_id=$1 and m.status='active'`, [me])).rows[0] ?? null;
    const workedToday = today.reduce((n, e) => n + worked(e), 0), breaks = today.reduce((n, e) => n + (e.breakMinutes ?? 0), 0);
    return {
      attendanceEnabled: enabled,
      wallet: { balances: leave, nextHoliday, month: enabled ? { present: new Set(entries.map(e => e.date)).size, late: new Set(entries.filter(e => e.late > 0).map(e => e.date)).size, extraMinutes } : { present: null, late: null, extraMinutes: null } },
      day: enabled && first ? { checkedInAt: first.in, checkedOutAt: today.at(-1)?.out ?? null, workedMinutes: workedToday, breakMinutes: breaks, office: evidence?.office ?? null, deliveries,
        focus: focus.map(f => ({ tool: f.tool, minutes: Math.round(f.seconds / 60) })).filter(f => f.minutes > 0), manager } : null,
      late: enabled ? late : null,
    };
  }));
  app.post<{ Body: Body }>("/api/v0/companion/late-dispute", { schema: { body } }, req => tx(req, async (c, v) => {
    if (!(await attendanceEnabled(c))) fail(403, ATTENDANCE_OFF_MESSAGE);
    const me = person(v), x = await context(c);
    const first = (await entriesFor(c, me, x.today, x.today))[0];
    if (!first || first.late <= 0) fail(400, "You were not marked late today");
    const evidence = await lateEvidence(c, me, x.today);
    if (!evidence?.at || Date.parse(String(evidence.at)) >= Date.parse(first.in)) fail(400, "Pulse has no office presence before your check-in today, so ask HR for a correction instead");
    const arrived = new Date(String(evidence.at)).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: x.zone });
    const device = evidence.platform && ["windows", "macos"].includes(evidence.platform) ? "laptop" : "phone";
    const reason = `Pulse saw my ${device} at ${evidence.office ?? "the office"} from ${arrived} (as my phone reported it; the phone's signals are not proof, so please check), before my check-in. Please remove today's late mark.`;
    if ((await c.query("select 1 from pulse.attendance_regularisation where person_id=$1 and work_date=$2 and kind='late' and status='pending'", [me, x.today])).rows[0]) fail(409, "Your request is already waiting for a decision");
    const r = { personId: me, date: x.today, kind: "late", inTime: arrived, outTime: null };
    await planCorrection(c, x, r);
    const id = (await c.query(`insert into pulse.attendance_regularisation(org_id,person_id,work_date,kind,in_time,out_time,reason,status) values ($1,$2,$3,'late',$4,null,$5,'pending') returning id`,
      [v.org, me, x.today, arrived, reason])).rows[0].id;
    return { id, status: "pending", arrivedAt: arrived, reason };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/hr/regularisations/:id", { schema: { body } }, req => tx(req, async (c, v) => {
    if (!(await attendanceEnabled(c))) fail(403, ATTENDANCE_OFF_MESSAGE);
    const me = person(v), id = mustId(req.params.id, "Request"), decision = String(req.body.decision ?? "");
    const r = (await c.query(`select person_id "personId",work_date::text "date",kind,to_char(in_time,'HH24:MI') "inTime",to_char(out_time,'HH24:MI') "outTime",entry_id "entryId",filed_by "filedBy"
      from pulse.attendance_regularisation where id=$1 and status='pending' for update`, [id])).rows[0];
    if (!r) fail(409, "This request is already decided or does not exist");
    if (decision === "cancelled") { if (r.personId !== me) fail(403, "Only the person who asked can withdraw it"); }
    else if (!["approved", "rejected"].includes(decision)) fail(400, "Approve or reject");
    else if (r.personId === me) fail(403, "Someone else has to decide your own request");
    else if (r.filedBy === me) fail(403, "Someone else decides what you filed for a colleague"); // INTEGRITY part 2 (1002)
    else if (!(await canDecide(c, v, r.personId))) fail(403, "HR or the person's manager decides this");
    const note = text(req.body.note, 300);
    if (decision === "rejected" && note.length < 3) fail(400, "Say why, so the person knows what to do next");
    if (decision === "approved") { await applyCorrection(c, v, await context(c), r,id); await c.query("select pulse.hr_correction_bind($1)",[id]); }
    await c.query("update pulse.attendance_regularisation set status=$1,decided_by=$2,decided_at=now(),decision_note=$3 where id=$4", [decision, me, note || null, id]);
    return { id, status: decision };
  }));

  registerHrFlowRoutes(app,{tx,correction:async(c,v,sourceId)=>{
    const r=(await c.query(`select person_id "personId",work_date::text "date",kind,to_char(in_time,'HH24:MI') "inTime",to_char(out_time,'HH24:MI') "outTime",entry_id "entryId" from pulse.attendance_regularisation where id=$1`,[sourceId])).rows[0];
    if(r){await applyCorrection(c,v,await context(c),r,sourceId);await c.query("select pulse.hr_correction_bind($1)",[sourceId]);}
  }});

  // ----------------------------------------------------------------------------------------------------- leave
  const LEAVE_ROW = `${LEAVE},p.display_name name,l.reason,l.created_at "createdAt",l.decided_at "decidedAt",l.decision_note "decisionNote",d.display_name "decidedBy"`;
  const LEAVE_FROM = "pulse.leave_request l join pulse.person p on p.id=l.person_id left join pulse.person d on d.id=l.decided_by";
  app.get("/api/v0/leave", req => tx(req, async (c, v) => ({ role: v.role,
    requests: (await c.query(`select ${LEAVE_ROW} from ${LEAVE_FROM} where ($1::boolean or l.person_id=$2) order by l.created_at desc limit 100`, [hr(v), v.person])).rows })));
  app.post<{ Body: Body }>("/api/v0/leave", { schema: { body } }, req => tx(req, async (c, v) => {
    const actor=person(v), who=req.body.personId?mustId(req.body.personId,"Person"):actor;
    if(who!==actor&&!hr(v)) fail(403,"HR can file leave for someone else");
    if(!(await c.query("select 1 from pulse.person where id=$1 and side='staff' and status='active'",[who])).rows[0]) fail(404,"Active staff record not found");
    let x=await context(c); const {fromDate,toDate}=req.body, kind=String(req.body.kind??"");
    if (!realDate(fromDate) || !realDate(toDate)) fail(400, "Invalid date");
    const from = fromDate as string, to = toDate as string;
    if (to < from) fail(400, "End date must be on or after start date");
    if (to > addDay(x.today, 366)) fail(400, "Choose dates within the next year");
    if (!x.types.some(t => t.key === kind && t.active)) fail(400, "Choose a leave type");
    const halfDay = req.body.halfDay ? String(req.body.halfDay) : null;
    if (halfDay && (!["first", "second"].includes(halfDay) || from !== to)) fail(400, "A half day is one date, first or second half");
    x=await personalContext(c,x,who,from,to);
    const days = eachDay(from, to).filter(d => working(x, d)).length * (halfDay ? 0.5 : 1);
    if (!days) fail(400, "There is no working day in these dates");
    await c.query("select pg_advisory_xact_lock(hashtext('hr-leave:'||$1))",[who]);
    if ((await c.query(`select 1 from pulse.leave_request where person_id=$1 and status in ('pending','approved') and to_date >= $2 and from_date <= $3`, [who, from, to])).rows[0])
      fail(409, "You already have leave on some of these dates");
    const balance=(await balances(c,x,[who])).get(who)?.find(b=>b.key===kind);
    const flowPolicy=(await c.query('select balance_buffer,max_leave_days from pulse.hr_flow_policy')).rows[0];
    const buffer=Number(flowPolicy.balance_buffer);
    if(kind==='comp_off' && Number((await c.query('select pulse.hr_comp_balance($1,$2)::float n',[who,to])).rows[0].n)-(balance?.pending??0)<days)fail(400,'Not enough unexpired comp-off for these dates');
    // INTEGRITY part 2 (1002): leave filed for a colleague is decided by someone other than the filer.
    const result=(await c.query(`insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,reason,half_day,days,filed_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id,status,days::float`, [v.org, who, from, to, kind, text(req.body.reason, 500) || null, halfDay, days, who === actor ? null : actor])).rows[0];
    const flow=(await c.query("select id from pulse.hr_flow where kind='leave' and source_id=$1",[result.id])).rows[0];
    const leaveType=x.types.find(t=>t.key===kind)!;
    const needs=leaveNeedsHr({days,paid:leaveType.paid,available:balance?.available??null,pending:balance?.pending??0,buffer,threshold:Number(flowPolicy.max_leave_days),special:req.body.special===true||/(special|emergency)/i.test(leaveType.key+' '+leaveType.name),compOff:kind==='comp_off'});
    const notice=await ruleNotice(c,who,from,to,days,x.today);
    if(notice.flag)await c.query("select pulse.hr_leave_notice($1,$2)",[flow.id,JSON.stringify(notice.flag)]);
    if(req.body.emergencyId)await c.query('select pulse.hr_emergency_record($1,$2)',[mustId(req.body.emergencyId,'Emergency'),result.id]);
    if(needs.length)await c.query('select pulse.hr_flow_needs($1,$2)',[flow.id,needs]);
    return {...result,flowId:flow.id};
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/leave/:id/decision", { schema: { body } }, req => tx(req, async (c, v) => {
    const me = person(v), id = mustId(req.params.id, "Request"), decision = String(req.body.decision ?? "");
    if (!["approved", "rejected", "cancelled"].includes(decision)) fail(400, "Approve or reject");
    const r = (await c.query(`select person_id "personId",status,from_date::text "fromDate",filed_by "filedBy" from pulse.leave_request where id=$1 for update`, [id])).rows[0];
    if (!r) fail(decision === "cancelled" ? 404 : hr(v) ? 409 : 403, hr(v) || decision === "cancelled" ? "Request is already decided, absent, or belongs to you" : "HR approval required");
    if (decision === "cancelled") {
      const today = (await context(c)).today;
      if (r.personId !== me) fail(403, "Only the person on leave can cancel it");
      if (!(r.status === "pending" || (r.status === "approved" && r.fromDate > today))) fail(409, "Only waiting requests and leave that has not started can be cancelled");
    } else {
      if (!(await canDecide(c, v, r.personId))) fail(403, "HR approval required");
      if (r.status !== "pending" || r.personId === me) fail(409, "Request is already decided, absent, or belongs to you");
      if (r.filedBy === me) fail(403, "Someone else decides what you filed for a colleague"); // INTEGRITY part 2 (1002)
    }
    const note = text(req.body.note, 300);
    if (decision === "rejected" && "note" in req.body && note.length < 3) fail(400, "Say why, so the person knows what to do next");
    return (await c.query(`update pulse.leave_request set status=$1,decided_by=$2,decided_at=now(),decision_note=$3 where id=$4 returning id,status`, [decision, me, note || null, id])).rows[0];
  }));

  // ------------------------------------------------------------------------------- one person's HR record
  // The same bundle feeds "My desk" and the profile's attendance tab: the person, their manager, HR and admins.
  async function bundle(c: PoolClient, v: Viewer, id: string, monthQuery: unknown) {
    let x = await context(c); const self = v.person === id, staff = hr(v);
    const enabled = x.policy.attendanceEnabled;
    const p = (await c.query(`select ${STAFF},p.status,pp.joined_on::text "joinedOn",pp.manager_id "managerId",m.display_name "managerName",pp.skills,pp.accounts,pp.phone,pp.email,
      pp.employment_type "employmentType",pp.username from ${STAFF_FROM} left join pulse.person m on m.id=pp.manager_id where p.id=$1 and p.side='staff'`, [id])).rows[0];
    if (!p) fail(404, "Person not found");
    const manager = !self && !staff && (await c.query("select pulse.manages($1) ok", [id])).rows[0].ok;
    if (!self && !staff && !manager) fail(403, "Attendance and leave are visible to the person, their manager, HR and admins");
    const month = monthOf(monthQuery, x.today), from = `${month}-01`, to = monthEnd(month);
    x=await personalContext(c,x,id,from,to);
    const entries = enabled ? await entriesFor(c, id, from, to) : [];
    const leaves: (Leave & Record<string, unknown>)[] = (await c.query(`select ${LEAVE_ROW} from ${LEAVE_FROM} where l.person_id=$1 order by l.from_date desc limit 60`, [id])).rows;
    const first = enabled ? (await c.query("select min(work_date)::text d from pulse.attendance_effective where person_id=$1", [id])).rows[0].d as string | null : null;
    const outcome = (await c.query("select pulse.work_mode($1) mode", [id])).rows[0].mode === "outcome";
    const days = enabled ? dayRows(x, from, to, entries, leaves, first, outcome) : [];
    const ruleDays=enabled ? (await c.query('select day::text date,late,half_day "halfDay",net_minutes::float "netMinutes" from pulse.hr_rule_days($1,$2,$3)',[id,from,to])).rows : [];
    const versions=await ruleVersions(c);
    const warningEnd=to<x.today?to:x.today,lateRule=enabled?activeRule(versions,'late_marks',warningEnd):null;
    const warningDays=enabled&&lateRule?.config.window==='calendar_week'?(await c.query("select day::text date,late from pulse.hr_rule_days($1,date_trunc('week',$2::date)::date,$2::date)",[id,warningEnd])).rows:ruleDays;
    const lateCount=warningDays.filter(d=>d.late&&d.date<=warningEnd&&(!lateRule||d.date>=lateRule.effectiveFrom)).length;
    const effects=new Map(ruleDays.map(d=>[d.date,d]));
    const todayEntry = !enabled ? null : month === x.today.slice(0, 7) ? entries.find(e => e.date === x.today) ?? null : (await entriesFor(c, id, x.today, x.today))[0] ?? null;
    const open = enabled ? (await c.query(`select ${ENTRY} from ${ENTRY_FROM} where e.person_id=$1 and e.checked_out_at is null`, [id])).rows[0] as Entry | undefined : undefined;
    const current = open ?? todayEntry, onLeave = leaves.find(l => l.status === "approved" && l.fromDate <= x.today && l.toDate >= x.today);
    const state = enabled ? current && !current.out ? (current.onBreak ? "break" : "in") : current ? "done"
      : !working(x,x.today) && x.off.has(x.today) ? "holiday" : !working(x,x.today) ? "off" : onLeave && !onLeave.halfDay ? "leave" : outcome ? "outcome" : "out"
      : !working(x,x.today) && x.off.has(x.today) ? "holiday" : !working(x,x.today) ? "off" : onLeave && !onLeave.halfDay ? "leave" : outcome ? "outcome" : "out";
    const wfhUsed = enabled ? (await c.query(`select count(*)::int n from pulse.attendance_effective where person_id=$1 and mode='wfh' and to_char(work_date,'YYYY-MM')=$2`, [id, x.today.slice(0, 7)])).rows[0].n : null;
    const regularisations = enabled ? (await c.query(`select ${REG} from ${REG_FROM} where r.person_id=$1 order by r.created_at desc limit 30`, [id])).rows : [];
    const tickets = self || staff ? (await c.query(`select t.id,t.no,t.category,t.subject,t.priority,t.status,t.created_at "createdAt",t.updated_at "updatedAt",a.display_name "assigneeName"
      from pulse.hr_ticket t left join pulse.person a on a.id=t.assignee_id where t.person_id=$1 order by t.created_at desc limit 30`, [id])).rows : [];
    const away = (await c.query(`select a.person_id "personId",p.display_name name,a.from_date::text "fromDate",a.to_date::text "toDate",a.half_day "halfDay"
      from pulse.team_away($1::date,$1::date + 21) a join pulse.person p on p.id=a.person_id where a.person_id<>$2 order by a.from_date,p.display_name limit 20`, [x.today, id])).rows;
    // A manager's own desk also shows the people who report to them and what is waiting for the manager's decision.
    const reports: string[] = self ? (await c.query("select pp.person_id id from pulse.people_profile pp join pulse.person p on p.id=pp.person_id where pulse.manages(pp.person_id) and pp.person_id<>$1 and p.status='active'", [id])).rows.map(r => r.id) : [];
    const teamRows = reports.length ? (await roster(c, x, x.today)).filter(m => reports.includes(m.id)) : [];
    const team = enabled ? teamRows : teamRows.map(m => ({ ...m, trackedFrom: null, status: ["leave", "holiday", "off"].includes(m.status) ? m.status : null, entry: null, sessions: [], attendance: null }));
    const approvals = reports.length ? {
      leave: (await c.query(`select ${LEAVE_ROW},ph.updated_at "photoAt" from ${LEAVE_FROM} left join pulse.person_photo ph on ph.person_id=l.person_id
        where l.status='pending' and l.person_id=any($1) order by l.from_date`, [reports])).rows,
      regularisations: enabled ? (await c.query(`select ${REG},ph.updated_at "photoAt" from ${REG_FROM} left join pulse.person_photo ph on ph.person_id=r.person_id
        where r.status='pending' and r.person_id=any($1) order by r.work_date`, [reports])).rows : [] } : { leave: [], regularisations: [] };
    // Delivery work is for the person and admins; HR sees the record, not the work.
    const seeWork = self || manager || v.role === "leadership" || admin(v);
    const { accounts, phone, email, ...publicPerson } = p;
    return { attendanceEnabled: enabled, person: { ...publicPerson, ...(self || staff ? { phone, email } : {}) }, self, today: x.today, clock: x.clock, policy: x.policy,
      can: { act: self && p.status === "active", decide: (staff || manager) && !self, record: staff && !self, performance: seeWork, adjust: staff },
      now: { state, entry: enabled ? current ?? null : null, holiday: x.off.get(x.today) ?? null, leave: onLeave ? { kind: onLeave.kind, halfDay: onLeave.halfDay } : null,
        // UX-5A: today's check-in on approved leave, and what became of the leave ("cancelled", or "kept" for HR to decide).
        leaveCheckIn: enabled ? (await c.query(`select decision,leave_kind "kind",ticket_id "ticketId" from pulse.attendance_leave_overlap where person_id=$1 and work_date=$2::date`, [id, x.today])).rows[0] ?? null : null },
      rules: {late:enabled&&lateRule?{count:lateCount,threshold:lateRule.config.threshold,deduction:lateRule.config.deduction,window:lateRule.config.window}:null},
      month: { key: month, from, to, days:enabled?days.map(d=>({...d,automaticHalfDay:effects.get(d.date)?.halfDay??false})):[], summary: enabled ? summarise(days) : null, trackedFrom: enabled ? first : null },
      // PRESENCE-ONBOARD: what payroll will use for this month, and until when it can still be fixed.
      payroll: enabled ? await payrollMonth(c, month, from, to, x.today, days, ruleDays, regularisations, leaves) : null,
      wfh: enabled ? { used: wfhUsed, allowance: x.policy.wfhPerMonth } : null,
      leave: { year: Number(x.today.slice(0,4))-(Number(x.today.slice(5,7))<Number(activeRule(versions,'leave_balance',x.today)?.config.yearStart??x.policy.leaveYearStart)?1:0), yearStartsMonth: Number(activeRule(versions,'leave_balance',x.today)?.config.yearStart??x.policy.leaveYearStart), provisional: !x.policy.confirmedAt, trackingFrom: x.policy.trackingFrom,
        types: x.types.filter(t => t.active), balances: self || staff ? (await balances(c, x, [id])).get(id) ?? [] : [], requests: leaves },
      regularisations, tickets, away, team, approvals, holidays: x.holidays.filter(h => h.day >= x.today).slice(0, 8),
      reconciliation: enabled && (self || staff) ? await reconciliationBundle(c,id,x.today,current?.mode??"office") : null,
      performance: seeWork ? await performance(c, x, id) : null };
  }
  app.get("/api/v0/hr/self", req => tx(req, (c, v) => {
    if (!v.person) fail(403, "My desk belongs to one person. This is a shared login, so it has no attendance, leave or requests of its own. Sign in with your own account to use it.");
    return bundle(c, v, v.person as string, (req.query as { month?: string }).month);
  }));
  // This is the employee-safe HR record. The database function binds every returned section to the
  // authenticated viewer and logs each restricted section read. Keep this response allowlisted.
  app.get("/api/v0/me/hr", { schema: { response: { 200: {
    type: "object", additionalProperties: false, required: ["attendanceEnabled", "employee", "history", "documents", "accessHistory"],
    properties: {
      attendanceEnabled: { type: "boolean" },
      employee: { type: "object", additionalProperties: false,
        required: ["name", "status", "role", "department", "employmentType", "joinedOn"],
        properties: {
          name: { type: "string" }, status: { type: "string", enum: ["active", "inactive", "offboarded"] },
          role: { type: ["string", "null"] }, department: { type: ["string", "null"] },
          employmentType: { type: ["string", "null"], enum: ["full_time", "part_time", "intern", "contract", "freelance", null] },
          joinedOn: { type: ["string", "null"], format: "date" },
        } },
      history: { type: "array", items: { type: "object", additionalProperties: false,
        required: ["field", "from", "to", "at", "by"], properties: {
          field: { type: "string", enum: ["department", "employmentType", "joinedOn", "role"] },
          from: { type: ["string", "null"] }, to: { type: ["string", "null"] },
          at: { type: "string", format: "date-time" }, by: { type: ["string", "null"] },
        } } },
      documents: { type: "array", items: { type: "object", additionalProperties: false,
        required: ["type", "seenAt"], properties: {
          type: { type: "string", enum: ["appointment_letter", "joining_letter", "offer_letter", "relieving_letter"] },
          seenAt: { type: "string", format: "date-time" },
        } } },
      accessHistory: { type: "array", items: { type: "object", additionalProperties: false,
        required: ["at", "viewer", "resource", "purpose"], properties: {
          at: { type: "string", format: "date-time" }, viewer: { type: "string" },
          resource: { type: "string" }, purpose: { type: "string" },
        } } },
    },
  } } } }, req => tx(req, async (c, v) => {
    if (!v.person) fail(403, "A personal HR record is available only to an individual account");
    const row = (await c.query("select pulse.hr_self_profile() data")).rows[0];
    if (!row?.data) fail(404, "Personal HR record not found");
    return { ...row.data, attendanceEnabled: await attendanceEnabled(c) };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/hr/person/:id", req => tx(req, (c, v) => bundle(c, v, mustId(req.params.id, "Person"), (req.query as { month?: string }).month)));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/people/:id/self", { schema: { body } }, req => tx(req, async (c, v) => {
    const id = mustId(req.params.id, "Person"); person(v);
    if (id !== v.person && !hr(v)) fail(403, "You can edit your own skills and phone; HR and admins can edit anyone's");
    const skills = Array.isArray(req.body.skills) ? [...new Map(req.body.skills.map(s => text(s, 32)).filter(Boolean).reverse().map(s => [s.toLowerCase(), s])).values()].reverse().slice(0, 24) : null;
    const phone = "phone" in req.body ? text(req.body.phone, 24) : null;
    const before = (await c.query("select array_to_string(skills,', ') skills,phone from pulse.people_profile where person_id=$1", [id])).rows[0];
    if (!before) fail(404, "Person not found");
    await c.query("select pulse.profile_self_update($1,$2,$3)", [id, skills, phone]);
    if (skills && skills.join(", ") !== before.skills) await change(c, v, "person", id, "skills", before.skills || null, skills.join(", ") || null);
    if (phone !== null && phone !== (before.phone ?? "")) await change(c, v, "person", id, "phone", before.phone, phone || null);
    return { ok: true };
  }));

  // -------------------------------------------------------------------------------------------------- HR desk
  /** Every current staff member on one day: in, on a break, done, on leave, not in. */
  async function roster(c: PoolClient, x: Ctx, date: string) {
    const staff = (await c.query(`select ${STAFF},pp.joined_on::text "joinedOn",
      (exists(select 1 from pulse.account a where a.holder_person_id=p.id and a.provider='google' and a.purpose like 'Workspace%')
        or exists(select 1 from pulse.login_credential lc where lc.person_id=p.id and lc.status='active')) "canSignIn",
      case when $1::boolean then (select min(work_date)::text from pulse.attendance_effective e where e.person_id=p.id) end "trackedFrom"
      from ${STAFF_FROM} where p.side='staff' and p.status='active' order by p.display_name`, [x.policy.attendanceEnabled])).rows;
    const entries: Entry[] = x.policy.attendanceEnabled ? (await c.query(`select ${ENTRY} from ${ENTRY_FROM} where ${entryRange("$1", "$1")} order by e.checked_in_at`, [date])).rows : [];
    const leaves: Leave[] = (await c.query(`select ${LEAVE} from pulse.leave_request l where l.status='approved' and l.from_date <= $1 and l.to_date >= $1`, [date])).rows;
    const outcome = await outcomePeople(c);
    return Promise.all(staff.map(async s => {
      const px=await personalContext(c,x,s.id,date,date);const day=working(px,date)?"working":x.off.has(date)?"holiday":"off";
      const sessions = entries.filter(e => e.personId === s.id && e.date === date);
      const statistics = attendanceStatistics(entries.filter(e => e.personId === s.id));
      const attendance = statistics.days.get(`${s.id}:${date}`) ?? null;
      const entry = sessions.at(-1) ?? null, leave = leaves.find(l => l.personId === s.id) ?? null;
      const status = entry ? (!entry.out ? (entry.onBreak ? "break" : "in") : "done") : day !== "working" ? day : leave ? "leave"
        : date > x.today ? "upcoming" : outcome.has(s.id) ? "outcome" : date === x.today ? "not_in" : s.trackedFrom && date >= s.trackedFrom ? "absent" : "untracked";
      return { ...s, status, workMode: outcome.has(s.id) ? "outcome" : "shift", entry: entry && outcome.has(s.id) ? { ...entry, late: 0 } : entry, sessions, attendance, leave: leave && day === "working" ? { kind: leave.kind, halfDay: leave.halfDay } : null };
    }));
  }
  app.get("/api/v0/hr/desk", req => tx(req, async (c, v) => {
    mustHr(v); const x = await context(c), q = req.query as { date?: string };
    const enabled = x.policy.attendanceEnabled;
    const date = realDate(q.date) && q.date <= x.today && q.date >= addDay(x.today, -400) ? q.date : x.today;
    const people = await roster(c, x, date);
    const n = (status: string[]) => people.filter(p => status.includes(p.status)).length;
    const visiblePeople = enabled ? people : people.map(p => ({ ...p, trackedFrom: null, status: ["leave", "holiday", "off"].includes(p.status) ? p.status : null, entry: null, sessions: [], attendance: null }));
    const pendingLeave = (await c.query(`select ${LEAVE_ROW},pp.user_no "userNo",ph.updated_at "photoAt" from ${LEAVE_FROM}
      left join pulse.people_profile pp on pp.person_id=l.person_id left join pulse.person_photo ph on ph.person_id=l.person_id
      where l.status='pending' order by l.from_date,l.created_at limit 50`)).rows;
    const pendingBalances = await balances(c, x, [...new Set(pendingLeave.map(l => l.personId as string))]);
    const pendingReg = enabled ? (await c.query(`select ${REG},ph.updated_at "photoAt" from ${REG_FROM} left join pulse.person_photo ph on ph.person_id=r.person_id
      where r.status='pending' order by r.work_date,r.created_at limit 50`)).rows : [];
    const tickets = (await c.query(`select count(*) filter(where status in ('open','in_progress','waiting'))::int open,
      count(*) filter(where status='open' and assignee_id is null)::int unassigned,count(*) filter(where status in ('open','in_progress','waiting') and priority='high')::int high from pulse.hr_ticket`)).rows[0];
    const upcoming = (await c.query(`select ${LEAVE_ROW} from ${LEAVE_FROM} where l.status='approved' and l.to_date >= $1 and l.from_date <= $1::date + 14 order by l.from_date,p.display_name limit 30`, [x.today])).rows;
    // Things HR may want to look at, from the last fourteen days. Each one names the records it comes from.
    const since = addDay(x.today, -13);
    const recent: Entry[] = enabled ? (await c.query(`select ${ENTRY} from ${ENTRY_FROM} where ${entryRange("$1", "$2")} order by e.work_date desc`, [since, x.today])).rows : [];
    const statistics = attendanceStatistics(recent);
    const attendance = enabled ? attendanceSummary([...statistics.days.values()].filter(d => d.date >= since && d.date <= x.today && people.some(p => p.id === d.personId)), since, x.today) : null;
    const name = new Map(people.map(p => [p.id as string, p.name as string]));
    const anomalies: { type: string; personId: string; name: string; date: string | null; detail: string }[] = [];
    for (const e of recent) {
      if (!name.has(e.personId)) continue;
      if (e.date < since || e.date > x.today) continue;
      const eligibility = statistics.days.get(`${e.personId}:${e.date}`)!;
      if (!anomalies.some(a => a.type === "statistics_excluded" && a.personId === e.personId && a.date === e.date) && !eligibility.eligible && (!e.out ? e.date < x.today || eligibility.reasons.some(r => r !== "open_session") : true))
        anomalies.push({ type: "statistics_excluded", personId: e.personId, name: name.get(e.personId)!, date: e.date, detail: `${eligibility.labels.join("; ")}. Day excluded from averages; review the attendance correction.` });
      if (e.breakMinutes > 120) anomalies.push({ type: "long_break", personId: e.personId, name: name.get(e.personId)!, date: e.date, detail: `Breaks added up to ${Math.floor(e.breakMinutes / 60)} h ${e.breakMinutes % 60} min.` });
    }
    const outcome = await outcomePeople(c);
    for (const [id, who] of name) {
      if (outcome.has(id)) continue;
      const late = recent.filter(e => e.personId === id && e.late > 0);
      if (late.length >= 3) anomalies.push({ type: "late", personId: id, name: who, date: late[0].date, detail: `Late ${late.length} times in the last 14 days.` });
    }
    const tracked = enabled ? people.filter(p => p.trackedFrom && !outcome.has(p.id)) : [];
    if (tracked.length) {
      const leaves: Leave[] = (await c.query(`select ${LEAVE} from pulse.leave_request l where l.status in ('approved','pending') and l.to_date >= $1 and l.person_id=any($2)`, [since, tracked.map(p => p.id)])).rows;
      for (const p of tracked) {
        const px=await personalContext(c,x,p.id,since,addDay(x.today,-1));
        const absent = dayRows(px, since, addDay(x.today, -1), recent.filter(e => e.personId === p.id), leaves.filter(l => l.personId === p.id), p.trackedFrom).filter(d => d.status === "absent" && !d.pendingLeave);
        if (absent.length) anomalies.push({ type: "absent", personId: p.id, name: p.name, date: absent.at(-1)!.date, detail: `${absent.length === 1 ? "One working day" : `${absent.length} working days`} without a check-in or approved leave.` });
      }
    }
    const trend = enabled ? (await c.query(`select g::date::text "date",count(distinct e.person_id)::int present,count(distinct e.person_id) filter(where e.mode='wfh')::int wfh,
      count(distinct e.person_id) filter(where e.late_minutes>0)::int late
      from generate_series($1::date - 13,$1::date,interval '1 day') g left join pulse.attendance_entry e on e.work_date=g::date group by g order by g`, [x.today])).rows : [];
    return { attendanceEnabled: enabled, date, today: x.today, clock: x.clock, policy: x.policy, day: x.off.has(date) ? { kind: "holiday", name: x.off.get(date) } : { kind: x.policy.workDays.includes(dow(date)) ? "working" : "off" },
      people: visiblePeople, attendance, counts: { ai: (await c.query("select pulse.agent_count() ai")).rows[0].ai, headcount: people.length, in: enabled ? n(["in", "break"]) : null, onBreak: enabled ? n(["break"]) : null, done: enabled ? n(["done"]) : null, wfh: enabled ? people.filter(p => p.entry?.mode === "wfh").length : null,
        late: enabled ? people.filter(p => (p.entry?.late ?? 0) > 0).length : null, leave: n(["leave"]), notIn: enabled ? people.filter(p => ["not_in", "absent"].includes(p.status) && (p.canSignIn || p.trackedFrom)).length : null, canSignIn: people.filter(p => p.canSignIn).length },
      pending: { leave: pendingLeave.map(l => ({ ...l, balance: pendingBalances.get(l.personId)?.find(b => b.key === l.kind) ?? null })), regularisations: enabled ? pendingReg : [] }, tickets, upcoming,
      holidays: x.holidays.filter(h => h.day >= x.today).slice(0, 4), anomalies: enabled ? anomalies.slice(0, 40) : [], trend, types: x.types, me: v.person };
  }));
  // A month for the whole team: one letter per person per day.
  app.get("/api/v0/hr/attendance", req => tx(req, async (c, v) => {
    mustHr(v); const x = await context(c), month = monthOf((req.query as { month?: string }).month, x.today), from = `${month}-01`, to = monthEnd(month);
    const dates = eachDay(from, to).map(date => ({ date, off: !x.policy.workDays.includes(dow(date)), holiday: x.off.get(date) ?? null }));
    if (!x.policy.attendanceEnabled) return { attendanceEnabled: false, month, from, to, today: x.today, dates, people: [] };
    const people = (await roster(c, x, x.today)).map(({ id, name, role, pod, userNo, photoAt, trackedFrom, canSignIn, workMode }) => ({ id, name, role, pod, userNo, photoAt, trackedFrom, canSignIn, workMode }));
    const entries: Entry[] = (await c.query(`select ${ENTRY} from ${ENTRY_FROM} where ${entryRange("$1", "$2")} order by e.work_date,e.checked_in_at`, [from, to])).rows;
    const leaves: Leave[] = (await c.query(`select ${LEAVE} from pulse.leave_request l where l.status in ('approved','pending') and l.to_date >= $1 and l.from_date <= $2`, [from, to])).rows;
    const rows = await Promise.all(people.map(async p => {
      const px=await personalContext(c,x,p.id,from,to);
      const days = dayRows(px, from, to, entries.filter(e => e.personId === p.id), leaves.filter(l => l.personId === p.id), p.trackedFrom, p.workMode === "outcome");
      const automatic=new Set((await c.query('select day::text from pulse.hr_rule_days($1,$2,$3) where half_day',[p.id,from,to])).rows.map(r=>r.day));
      return { ...p, summary: summarise(days), days: days.map(d => ({ status: d.status, mode: d.entry?.mode ?? null, late: d.entry?.late ?? 0, worked: d.attendance?.recordedMinutes ?? 0, attendance: d.attendance, half: !!d.leave?.halfDay||automatic.has(d.date), missedOut: d.sessions.some(e => e.missedOut), open: d.sessions.some(e => !e.out) })) };
    }));
    return { attendanceEnabled: true, month, from, to, today: x.today, policy: x.policy, dates, people: rows };
  }));
  app.get("/api/v0/hr/leave", req => tx(req, async (c, v) => {
    mustHr(v); const x = await context(c), month = monthOf((req.query as { month?: string }).month, x.today), from = `${month}-01`, to = monthEnd(month);
    const people = (await c.query(`select ${STAFF},pp.joined_on::text "joinedOn" from ${STAFF_FROM} where p.side='staff' and p.status='active' order by p.display_name`)).rows;
    const requests = (await c.query(`select ${LEAVE_ROW},ph.updated_at "photoAt" from ${LEAVE_FROM} left join pulse.person_photo ph on ph.person_id=l.person_id
      order by (l.status='pending') desc,l.from_date desc limit 200`)).rows;
    const all = await balances(c, x, null);
    const adjustments = (await c.query(`select a.id,a.person_id "personId",p.display_name name,a.type_key kind,a.leave_year "year",a.days::float,a.reason,a.created_at "createdAt",b.display_name "by"
      from pulse.leave_adjustment a join pulse.person p on p.id=a.person_id left join pulse.person b on b.id=a.created_by order by a.created_at desc limit 40`)).rows;
    const calendar = requests.filter(l => l.status !== "rejected" && l.status !== "cancelled" && l.toDate >= from && l.fromDate <= to);
    return { month, from, to, today: x.today, policy: x.policy, year: leaveYear(x, x.today), types: x.types, holidays: x.holidays.filter(h => h.day.slice(0, 4) >= x.today.slice(0, 4)),
      dates: eachDay(from, to).map(date => ({ date, off: !x.policy.workDays.includes(dow(date)), holiday: x.off.get(date) ?? null })),
      people: people.map(p => ({ ...p, balances: all.get(p.id) ?? [] })), requests, calendar, adjustments, me: v.person };
  }));
  app.post<{ Body: Body }>("/api/v0/hr/leave-adjustments", { schema: { body } }, req => tx(req, async (c, v) => {
    mustHr(v); const x = await context(c), id = mustId(req.body.personId, "Person"), kind = String(req.body.kind ?? ""), days = Number(req.body.days), reason = text(req.body.reason, 300);
    if (id === v.person) fail(403, "Someone else in HR adjusts your own leave balance"); // INTEGRITY part 2 (1002; the database refuses it too)
    if(kind==='comp_off')fail(400,"Comp-off credits come from approved day-off work; set the credit under Approvals & comp-off policy");
    if (!x.types.some(t => t.key === kind && t.annualDays !== null)) fail(400, "Choose a leave type that has an allowance");
    if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 60 || half(Math.abs(days)) !== Math.abs(days)) fail(400, "Give a number of days in halves, such as 2 or -0.5");
    if (reason.length < 3) fail(400, "Give a reason: it stays on the person's leave record");
    if (!(await c.query("select 1 from pulse.people_profile where person_id=$1", [id])).rows[0]) fail(404, "Person not found");
    return (await c.query(`insert into pulse.leave_adjustment(org_id,person_id,type_key,leave_year,days,reason,created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [v.org, id, kind, leaveYear(x, x.today), days, reason, v.person])).rows[0];
  }));

  // --------------------------------------------------------------------------------------------------- policy
  app.get("/api/v0/hr/policy", req => tx(req, async (c, v) => {
    const x = await context(c);
    const by = x.policy.confirmedAt ? (await c.query("select p.display_name name from pulse.hr_policy h left join pulse.person p on p.id=h.confirmed_by")).rows[0]?.name ?? null : null;
    return { attendanceEnabled: x.policy.attendanceEnabled, ruleVersions:await ruleVersions(c), policy: x.policy, confirmedBy: by, types: x.types, holidays: x.holidays.filter(h => h.day.slice(0, 4) >= x.today.slice(0, 4)), today: x.today, canEdit: hr(v) && !!v.person };
  }));
  app.post<{ Body: Body }>("/api/v0/hr/policy", { schema: { body } }, req => tx(req, async (c, v) => {
    mustHr(v); const x = await context(c), b = req.body, p = x.policy;
    if((await ruleVersions(c)).some(r=>r.key==='leave_balance')) {
      const stored=(await c.query('select leave_year_start year,tracking_from::text tracking from pulse.hr_policy')).rows[0];
      if(('leaveYearStart' in b&&![stored.year,p.leaveYearStart].includes(Number(b.leaveYearStart)))||('trackingFrom' in b&&b.trackingFrom!==stored.tracking))fail(400,'A balance transition is confirmed. Keep the earlier baseline; use audited balance adjustments.');
      b.leaveYearStart=stored.year;b.trackingFrom=stored.tracking;p.leaveYearStart=stored.year;p.trackingFrom=stored.tracking;
    }
    const shiftStart = "shiftStart" in b ? (clockTime(b.shiftStart) ? b.shiftStart : fail(400, "Use a start time such as 10:00")) : p.shiftStart;
    const shiftEnd = "shiftEnd" in b ? (clockTime(b.shiftEnd) ? b.shiftEnd : fail(400, "Use an end time such as 19:00")) : p.shiftEnd;
    const grace = "graceMinutes" in b ? Number(b.graceMinutes) : p.graceMinutes;
    if (!Number.isInteger(grace) || grace < 0 || grace > 240) fail(400, "Grace is a number of minutes from 0 to 240");
    const workDays = "workDays" in b ? [...new Set((Array.isArray(b.workDays) ? b.workDays : []).map(Number))].filter(d => Number.isInteger(d) && d >= 1 && d <= 7).sort() : p.workDays;
    if (!workDays.length) fail(400, "Choose at least one working day");
    const wfh = "wfhPerMonth" in b ? (b.wfhPerMonth === null || b.wfhPerMonth === "" ? null : Number(b.wfhPerMonth)) : p.wfhPerMonth;
    if (wfh !== null && (!Number.isInteger(wfh) || wfh < 0 || wfh > 31)) fail(400, "Work-from-home days per month is a number from 0 to 31, or empty for no limit");
    const yearStart = "leaveYearStart" in b ? Number(b.leaveYearStart) : p.leaveYearStart;
    if (!Number.isInteger(yearStart) || yearStart < 1 || yearStart > 12) fail(400, "Choose the month the leave year starts");
    const trackingFrom = "trackingFrom" in b ? (realDate(b.trackingFrom) ? b.trackingFrom : fail(400, "Choose the date balances start from")) : p.trackingFrom;
    const next = { shiftStart, shiftEnd, graceMinutes: grace, workDays, wfhPerMonth: wfh, leaveYearStart: yearStart, trackingFrom };
    await c.query(`update pulse.hr_policy set shift_start=$1,shift_end=$2,grace_minutes=$3,work_days=$4,wfh_per_month=$5,leave_year_start=$6,tracking_from=$7,
      confirmed_at=now(),confirmed_by=$8,updated_at=now()`, [shiftStart, shiftEnd, grace, workDays, wfh, yearStart, trackingFrom, v.person]);
    for (const [key, value] of Object.entries(next)) {
      const before = String((p as unknown as Record<string, unknown>)[key] ?? ""), after = String(value ?? "");
      if (before !== after) await change(c, v, "hr_policy", v.org, key, before || null, after || null);
    }
    if (!p.confirmedAt) await change(c, v, "hr_policy", v.org, "confirmed", null, "Confirmed by HR");
    return { ok: true };
  }));
  app.post<{ Body: Body }>("/api/v0/hr/leave-types", { schema: { body } }, req => tx(req, async (c, v) => {
    mustHr(v);const transition=(await ruleVersions(c)).find(r=>r.key==='leave_balance');
    if(transition&&req.body.key===transition.config.balanceKind)fail(400,'The confirmed balance rule owns this allowance. Use audited balance adjustments.');
    const x = await context(c), b = req.body, name = text(b.name, 40);
    if (name.length < 2) fail(400, "Give the leave type a name");
    const existing = b.key ? x.types.find(t => t.key === b.key) : undefined;
    if (b.key && !existing) fail(404, "Leave type not found");
    const annual = b.annualDays === null || b.annualDays === "" || b.annualDays === undefined ? null : Number(b.annualDays);
    if (annual !== null && (!Number.isFinite(annual) || annual < 0 || annual > 365 || half(annual) !== annual)) fail(400, "Days per year is a number in halves, or empty for no allowance");
    const accrual = annual === null ? "none" : ["monthly", "yearly", "none"].includes(String(b.accrual)) ? String(b.accrual) : "monthly";
    const carry = annual === null ? 0 : Number(b.carryForwardMax ?? 0);
    if (!Number.isFinite(carry) || carry < 0 || carry > 365) fail(400, "Carry forward is a number of days");
    if(existing?.key==='comp_off' && (annual!==0||accrual!=='none'||carry!==0))fail(400,"Set comp-off credit and expiry under Approvals & comp-off policy");
    const paid = b.paid !== false && b.paid !== "false", active = b.active !== false && b.active !== "false";
    if (x.types.some(t => t.name.toLowerCase() === name.toLowerCase() && t.key !== existing?.key)) fail(409, "A leave type with this name already exists");
    if (existing) {
      await c.query("update pulse.leave_type set name=$1,paid=$2,annual_days=$3,accrual=$4,carry_forward_max=$5,active=$6 where key=$7", [name, paid, annual, accrual, carry, active, existing.key]);
      await change(c, v, "leave_type", v.org, existing.key, `${existing.name}: ${existing.annualDays ?? "no"} days, ${existing.accrual}${existing.active ? "" : ", off"}`, `${name}: ${annual ?? "no"} days, ${accrual}${active ? "" : ", off"}`);
      return { key: existing.key };
    }
    let key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "").slice(0, 20) || "leave";
    if (key.length < 2) key = `${key}_leave`;
    for (let i = 2; x.types.some(t => t.key === key); i += 1) key = `${key.replace(/_\d+$/, "")}_${i}`;
    await c.query("insert into pulse.leave_type(org_id,key,name,paid,annual_days,accrual,carry_forward_max,sort) values ($1,$2,$3,$4,$5,$6,$7,$8)", [v.org, key, name, paid, annual, accrual, carry, x.types.length + 1]);
    await change(c, v, "leave_type", v.org, key, null, `${name}: ${annual ?? "no"} days, ${accrual}`);
    return { key };
  }));
  app.post<{ Body: Body }>("/api/v0/hr/holidays", { schema: { body } }, req => tx(req, async (c, v) => {
    mustHr(v); const day = req.body.day;
    if (!realDate(day)) fail(400, "Choose the date");
    if (req.body.action === "remove") {
      const gone = (await c.query("delete from pulse.holiday where day=$1 returning name", [day])).rows[0];
      if (gone) await change(c, v, "holiday", v.org, day as string, gone.name, null);
      return { ok: true };
    }
    const name = text(req.body.name, 80); if (name.length < 2) fail(400, "Name the holiday");
    const optional = req.body.optional === true || req.body.optional === "true";
    await c.query(`insert into pulse.holiday(org_id,day,name,optional) values ($1,$2,$3,$4) on conflict(org_id,day) do update set name=excluded.name,optional=excluded.optional`, [v.org, day, name, optional]);
    await change(c, v, "holiday", v.org, day as string, null, `${name}${optional ? " (optional)" : ""}`);
    return { ok: true };
  }));

  // -------------------------------------------------------------------------------------------- requests desk
  const TICKET = `t.id,t.no,t.person_id "personId",p.display_name name,ph.updated_at "photoAt",t.category,t.subject,t.priority,t.status,t.assignee_id "assigneeId",
    a.display_name "assigneeName",t.created_at "createdAt",t.updated_at "updatedAt",t.resolved_at "resolvedAt"`;
  const TICKET_FROM = "pulse.hr_ticket t join pulse.person p on p.id=t.person_id left join pulse.person a on a.id=t.assignee_id left join pulse.person_photo ph on ph.person_id=t.person_id";
  app.get("/api/v0/hr/tickets", req => tx(req, async (c, v) => {
    const all = hr(v) && (req.query as { scope?: string }).scope === "all";
    const tickets = (await c.query(`select ${TICKET},(select count(*)::int from pulse.hr_ticket_event x where x.ticket_id=t.id and x.kind='comment') comments from ${TICKET_FROM}
      where ($1::boolean or t.person_id=$2) order by (t.status in ('resolved','closed')),(t.priority='high') desc,t.updated_at desc limit 200`, [all, v.person])).rows;
    const assignees = all ? (await c.query(`select distinct p.id,p.display_name name from pulse.role_assignment r join pulse.person p on p.id=r.person_id
      where r.role_key in ('admin','hr') and current_date between r.valid_from and coalesce(r.valid_to,'infinity') order by p.display_name`)).rows : [];
    return { tickets, assignees, staff: hr(v), me: v.person, categories: CATEGORIES };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/hr/tickets/:id", req => tx(req, async (c, v) => {
    const t = (await c.query(`select ${TICKET},t.body,t.resolution from ${TICKET_FROM} where t.id=$1`, [mustId(req.params.id, "Request")])).rows[0];
    if (!t) fail(404, "Request not found");      // row-level security hides other people's requests
    const events = (await c.query(`select x.id,x.kind,x.body,x.internal,x.created_at "at",p.display_name "by",x.author_id "authorId" from pulse.hr_ticket_event x
      left join pulse.person p on p.id=x.author_id where x.ticket_id=$1 order by x.created_at`, [t.id])).rows;
    return { ...t, events, staff: hr(v), mine: t.personId === v.person };
  }));
  app.post<{ Body: Body }>("/api/v0/hr/tickets", { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const category = String(req.body.category ?? "other"), subject = text(req.body.subject, 140), priority = String(req.body.priority ?? "normal");
    if (!CATEGORIES.includes(category)) fail(400, "Choose what this is about");
    if (subject.length < 3) fail(400, "Say in a few words what you need");
    if (!["low", "normal", "high"].includes(priority)) fail(400, "Unknown priority");
    const id = (await c.query("select pulse.hr_ticket_open($1,$2,$3,$4) id", [category, subject, String(req.body.body ?? "").trim().slice(0, 4000), priority])).rows[0].id;
    return { id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/hr/tickets/:id", { schema: { body } }, req => tx(req, async (c, v) => {
    const me = person(v), id = mustId(req.params.id, "Request"), b = req.body, staff = hr(v);
    const t = (await c.query(`select person_id "personId",status,assignee_id "assigneeId",priority from pulse.hr_ticket where id=$1 for update`, [id])).rows[0];
    if (!t) fail(404, "Request not found");
    const event = (kind: string, body: string, internal = false) => c.query(`insert into pulse.hr_ticket_event(org_id,ticket_id,author_id,kind,body,internal) values ($1,$2,$3,$4,$5,$6)`, [v.org, id, me, kind, body, internal]);
    const comment = String(b.comment ?? "").trim().slice(0, 4000);
    if (comment) await event("comment", comment, staff && b.internal === true && t.personId !== me);      // no HR-only notes on your own request
    if ("assigneeId" in b) {
      if (!staff) fail(403, "HR assigns requests");
      const assignee = b.assigneeId ? mustId(b.assigneeId, "Person") : null;
      const who = assignee ? (await c.query(`select p.display_name name from pulse.person p where p.id=$1 and exists(select 1 from pulse.role_assignment r where r.person_id=p.id
        and r.role_key in ('admin','hr') and current_date between r.valid_from and coalesce(r.valid_to,'infinity'))`, [assignee])).rows[0] : null;
      if (assignee && !who) fail(400, "Requests are assigned to HR or an admin");
      if (assignee !== t.assigneeId) { await c.query("update pulse.hr_ticket set assignee_id=$1,updated_at=now() where id=$2", [assignee, id]); await event("assigned", who ? who.name : "Nobody"); }
    }
    if (typeof b.priority === "string" && b.priority !== t.priority) {
      if (!staff) fail(403, "HR sets the priority");
      if (!["low", "normal", "high"].includes(b.priority)) fail(400, "Unknown priority");
      await c.query("update pulse.hr_ticket set priority=$1,updated_at=now() where id=$2", [b.priority, id]);
    }
    if (typeof b.status === "string" && b.status !== t.status) {
      if (!TICKET_STATUS.includes(b.status)) fail(400, "Unknown status");
      // The person who raised it may close it or reopen it; everything else is HR's.
      if (!staff && !(t.personId === me && ["closed", "open"].includes(b.status))) fail(403, "HR moves a request along; you can close or reopen your own");
      const resolution = text(b.resolution, 1000);
      if (b.status === "resolved" && resolution.length < 3) fail(400, "Say how it was resolved; the person who raised it reads this");
      await c.query(`update pulse.hr_ticket set status=$1,updated_at=now(),resolved_at=case when $1 in ('resolved','closed') then coalesce(resolved_at,now()) else null end,
        resolution=case when $1='resolved' then $2 else resolution end where id=$3`, [b.status, resolution || null, id]);
      await event(b.status === "resolved" ? "resolved" : "status", b.status === "resolved" ? resolution : b.status);
    } else if (comment) await c.query("update pulse.hr_ticket set updated_at=now() where id=$1", [id]);
    return { ok: true };
  }));

  // -------------------------------------------------------------------------------------------------- payroll
  // The list of staff carries no figures. Figures come only when asked for, through the logged function.
  app.get("/api/v0/hr/payroll", req => tx(req, async (c, v) => {
    mustHr(v);
    const can = (await c.query("select pulse.hr_can('hr.salary.read') read,pulse.hr_can('hr.salary.write') write")).rows[0];
    if (!can.read) fail(403, "Your account does not have permission to read salary");
    const people = (await c.query(`select ${STAFF},p.status,pp.joined_on::text "joinedOn",pp.employment_type "employmentType" from ${STAFF_FROM} where p.side='staff'
      order by (p.status='active') desc,p.display_name`)).rows;
    const figures = (req.query as { figures?: string }).figures === "1";
    const rows = figures ? (await c.query(`select person_id "personId",effective_month::text "month",kind,amount::float,currency,entries,bank_on_file "bankOnFile" from pulse.hr_salary_overview()`)).rows : null;
    if(rows) {
      const versions=await ruleVersions(c),today=(await context(c)).today,rule=activeRule(versions,'professional_tax',monthEnd(today.slice(0,7)));
      for(const row of rows) {
        const source=(await c.query('select pulse.hr_payslip_source($1,$2) data',[row.personId,today.slice(0,7)+'-01'])).rows[0].data;
        const tax=professionalTax(rule,source?.ptGross??row.amount,source?.ptCategory,source?.ptState,source?.ptExempt??false,today.slice(0,7));
        if(rule&&source?.ptState==='MH'&&!source.ptExempt&&(source.currency??row.currency)!=='INR')tax.review=true;
        row.professionalTax=tax.amount;row.ptReview=tax.review;row.net=tax.review?null:(source?.gross??row.amount)+(source?.reimbursements??0)-(source?.deductions??0)-tax.amount;
      }
    }
    const log = (await c.query(`select at,viewer,people from pulse.hr_payroll_log(8)`)).rows;
    return { people, figures: rows, canWrite: can.write, log };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/people/:id/salary", { schema: { body } }, req => tx(req, async (c, v) => {
    mustHr(v); const id = mustId(req.params.id, "Person"), amount = Number(req.body.amount), kind = String(req.body.kind ?? "current"), month = String(req.body.month ?? "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail(400, "Choose the month it applies from");
    if (!["current", "increment", "monthly", "total"].includes(kind)) fail(400, "Choose the kind of entry");
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e8) fail(400, "Give the amount as a number");
    if (!(await c.query("select 1 from pulse.person where id=$1 and side='staff'", [id])).rows[0]) fail(404, "Person not found");
    const components:Record<string,number>={};for(const key of ['ctc','fixed','variable','bonus','reimbursements','deductions']){const raw=req.body[key];if(raw!==undefined&&raw!==null&&raw!==''){const n=Number(raw);if(!Number.isFinite(n)||n<0||n>1e10)fail(400,'Components must be non-negative amounts');components[key]=n;}}
    const from=String(req.body.effectiveFrom||`${month}-01`),to=req.body.effectiveTo?String(req.body.effectiveTo):null;if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||(to&&!/^\d{4}-\d{2}-\d{2}$/.test(to))||(to&&to<from))fail(400,'Check effective dates');
    await c.query("select pulse.hr_salary_components_write($1,$2,$3,$4,$5,$6,$7,$8)", [id, `${month}-01`, kind, amount, text(req.body.note, 200),JSON.stringify(components),from,to]);
    return { ok: true };      // the amount is never echoed, logged or written to the change history
  }));
}
