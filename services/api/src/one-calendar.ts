// FIX-PR-CALENDAR (owner, 10 Nov 2026: "Build ONE calendar component used in PR Studio, My day, meetings, leaves and
// tasks with due dates") and CALENDAR-HUB (owner, 13 Nov 2026, OWNER-FEEDBACK-1113 P2.1: "a huge calendar feature can be
// reused everywhere, just like documents"): what the one calendar shows a person, in one company. Each part is read under
// the person's own row security, and inside a savepoint: a part someone may not see (HR leave, PR Studio) is simply left
// out, never an error and never someone else's.
//   task        the person's own open tasks with a due date (a due day alone, kept as 18:00, is an all-day item)
//   milestone   project milestones the person may see: plan steps the project's template marks as a gate or a milestone
//   leave       leave the person may see (their own, their team's, HR's view), approved or waiting for an OK
//   attendance  the person's own time at work (check-in to check-out)
//   meeting     client appointments they booked or may see (pulse.appointment_list), and recorded meetings they may see
//   event       the person's own calendar events: made here from a slot, or read from their Google Calendar (calendar.ts)
//   post        PR Studio posts on brands they work on, with the creative's picture
// Times leave as wall-clock text in the company's zone ("YYYY-MM-DDTHH:mm"), as kit/calendar draws them.
// Screens ask for what they show: ?kinds=post&brand=<id> (PR Studio), ?kinds=task,milestone&project=<id> (a project),
// ?kinds=leave,attendance (HR). GET /api/v0/calendar/companies reads every company the person works in, each inside
// itself as them (the founder view's way, my-day.ts inSeat), for "which company takes which day and hours".
// LAND-CAPTAIN-10: GET /api/v0/calendar/items in one-calendar.ts. GAP-FOUNDER-VIEW's Google Calendar link (calendar.ts)
// landed first with GET /api/v0/calendar (its connection state); one path cannot answer both.
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { fail, type Tx } from './routes.js';
import { ORG_TZ } from './org-time.js';
import { inSeat, MAX_SEATS, seatsOf } from './my-day.js';
import { updatePost } from './pr-flow.js';
import { googleEventChange } from './calendar.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CAL_KINDS = ['task', 'milestone', 'meeting', 'event', 'post', 'leave', 'attendance'] as const;
export type CalKind = typeof CAL_KINDS[number];
export type CalItem = { id: string; kind: CalKind; title: string; start: string; end?: string; allDay?: boolean; source?: 'pulse' | 'google';
  href?: string; meta?: string; status?: string; who?: string; note?: string; thumb?: string; editable?: boolean };
type Row = Record<string, unknown>;
type Body = Record<string, unknown>;

export const addDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** The window to read: what was asked (at most 400 days), else five weeks back to ten weeks ahead of today. */
export function calWindow(q: Record<string, string | undefined>, today: string) {
  const from = q.from && DAY.test(q.from) ? q.from : addDays(today, -35);
  const to = q.to && DAY.test(q.to) ? q.to : addDays(today, 70);
  if (Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`)) || to < from) fail(400, 'Pick a start day before the end day (YYYY-MM-DD)');
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 > 400) fail(400, 'Ask for 400 days or fewer');
  return { from, to };
}
/** The kinds a screen asked for (?kinds=a,b); every kind when it asked for none. Unknown names are left out. */
export function kindsOf(q: string | undefined): Set<CalKind> {
  const asked = String(q ?? '').split(',').map((x) => x.trim()).filter((x): x is CalKind => (CAL_KINDS as readonly string[]).includes(x));
  return new Set(asked.length ? asked : CAL_KINDS);
}
/** An instant as wall-clock text in a time zone ("2026-11-10T12:30"); null for a bad time. */
export function wallClock(ms: number, timeZone: string): string | null {
  if (!Number.isFinite(ms)) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/** Wall-clock text plus some minutes (both as text, no time zone involved). */
export const plusMinutes = (stamp: string, minutes: number) => wallClock(Date.parse(`${stamp}:00Z`) + minutes * 60_000, 'UTC')!;
const STAGE: Record<string, string> = { idea: 'Idea', draft: 'Draft', design: 'Picture', review: 'Needs your OK', approved: 'Approved', scheduled: 'Scheduled', posted: 'Posted', measured: 'Measured' };
const CHANNEL: Record<string, string> = { linkedin: 'LinkedIn', x: 'X', instagram: 'Instagram', whatsapp_status: 'WhatsApp Status', newsletter: 'Newsletter' };
const STATUS: Record<string, string> = { open: 'To do', in_progress: 'Doing', blocked: 'Stuck', in_review: 'In review', done: 'Done' };

async function part<T>(c: PoolClient, name: string, f: () => Promise<T>): Promise<T | null> {
  await c.query(`savepoint cal_${name}`);
  try { const r = await f(); await c.query(`release savepoint cal_${name}`); return r; }
  catch { await c.query(`rollback to savepoint cal_${name}`); return null; }
}

/** What the one calendar shows, in this company. `mine` keeps to the person's own time (the companies view). */
export async function calendar(c: PoolClient, q: Record<string, string | undefined>, opts: { mine?: boolean } = {}) {
  const clock = (await c.query(`select to_char(now() at time zone ${ORG_TZ},'YYYY-MM-DD"T"HH24:MI') now,${ORG_TZ} tz`)).rows[0] as { now: string; tz: string };
  const { from, to } = calWindow(q, clock.now.slice(0, 10));
  const want = kindsOf(q.kinds);
  const project = q.project && UUID.test(q.project) ? q.project : null;
  const brand = q.brand && UUID.test(q.brand) ? q.brand : null;
  const args = [from, to, clock.tz];
  const items: CalItem[] = [];
  const read: Record<string, boolean> = {};
  const wall = (col: string) => `to_char(${col} at time zone $3,'YYYY-MM-DD"T"HH24:MI')`;

  if (want.has('task')) {
    const tasks = await part(c, 'tasks', async () => (await c.query(`select t.id,t.title,t.status,${wall('t.due_at')} due,coalesce(nullif(t.estimate_minutes,0),30) minutes,
        (select p.name from pulse.project p where p.id=t.project_id) project
      from pulse.task t where t.assignee_person_id=pulse.current_viewer() and t.due_at is not null and t.status not in ('cancelled') and t.deleted_at is null
        and ($4::uuid is null or t.project_id=$4::uuid)
        and (t.due_at at time zone $3)::date between $1::date and $2::date order by t.due_at limit 500`, [...args, project])).rows as Row[]);
    read.tasks = tasks !== null;
    for (const t of tasks ?? []) {
      const due = String(t.due), allDay = due.slice(11) === '18:00';
      items.push({ id: String(t.id), kind: 'task', title: String(t.title), start: allDay ? due.slice(0, 10) : due, ...(allDay ? {} : { end: plusMinutes(due, Math.min(240, Number(t.minutes) || 30)) }),
        allDay, href: `/tasks/${t.id}`, meta: t.project ? String(t.project) : 'Your task', status: STATUS[String(t.status)] ?? String(t.status), editable: t.status !== 'done' });
    }
  }

  // Milestones: plan steps the project's template marks as a gate, or names as a milestone (ads live, foundation,
  // script), on projects the person may see. They move inside the project (a date change there asks for a reason).
  if (want.has('milestone') && !opts.mine) {
    const ms = await part(c, 'milestones', async () => (await c.query(`select t.id,t.title,t.status,(t.due_at at time zone $3)::date::text due,t.project_id project,
        pr.name project_name,s.step->>'title' step
      from pulse.task t join pulse.project pr on pr.id=t.project_id join pulse.project_plan pp on pp.project_id=t.project_id
        join pulse.delivery_template dt on dt.org_id=pp.org_id and dt.key=pp.template_key
        cross join lateral (select x step from jsonb_array_elements(coalesce(dt.definition->'steps','[]'::jsonb)) x where x->>'id'=t.template_step limit 1) s
      where t.deleted_at is null and t.status<>'cancelled' and t.due_at is not null and ($4::uuid is null or t.project_id=$4::uuid)
        and (s.step->>'kind'='gate' or t.template_step in (dt.definition->'milestones'->>'adsLive',dt.definition->'milestones'->>'foundation',dt.definition->'milestones'->>'script'))
        and (t.due_at at time zone $3)::date between $1::date and $2::date order by t.due_at limit 300`, [...args, project])).rows as Row[]);
    read.milestones = ms !== null;
    // A milestone is a task too: when it is also the person's own task it shows once, as the milestone (it moves in
    // the project, where a new date asks for a reason).
    const isMilestone = new Set((ms ?? []).map((m) => String(m.id)));
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'task' && isMilestone.has(items[i].id)) items.splice(i, 1);
    for (const m of ms ?? []) {
      // A template's step title may lead with an emoji ("🚦 Gate: …"): the calendar says the words.
      const title = String(m.step ?? m.title).replace(/^[^\p{L}\p{N}]+/u, '').trim() || String(m.title);
      items.push({ id: String(m.id), kind: 'milestone', title, start: String(m.due), allDay: true, href: `/projects/${m.project}`,
        meta: String(m.project_name ?? 'Project'), status: STATUS[String(m.status)] ?? String(m.status) });
    }
  }

  if (want.has('leave')) {
    const leave = await part(c, 'leave', async () => (await c.query(`select l.id,l.from_date::text "from",l.to_date::text "to",l.status,l.leave_kind kind,p.display_name who
      from pulse.leave_request l join pulse.person p on p.id=l.person_id
      where l.status in ('approved','pending') and l.to_date>=$1::date and l.from_date<=$2::date and (not $3::boolean or l.person_id=pulse.current_viewer())
      order by l.from_date limit 500`, [from, to, !!opts.mine])).rows as Row[]);
    read.leave = leave !== null;
    for (const l of leave ?? []) {
      // The name alone: the palm icon, the amber colour and the line under it ("Annual leave") say it is leave.
      items.push({ id: String(l.id), kind: 'leave', title: String(l.who), start: String(l.from), end: String(l.to), allDay: true, href: '/hr?tab=leave',
        who: String(l.who), status: l.status === 'pending' ? 'Waiting for an OK' : 'Approved', meta: l.kind ? `${String(l.kind)[0].toUpperCase()}${String(l.kind).slice(1).replace(/_/g, ' ')} leave` : 'Leave' });
    }
  }

  if (want.has('attendance')) {
    const att = await part(c, 'attendance', async () => (await c.query(`select a.id,${wall('a.checked_in_at')} s,
        ${wall(`coalesce(a.checked_out_at,least(now(),a.checked_in_at+interval '14 hours'))`)} e,a.checked_out_at is null open
      from pulse.attendance_entry a where a.person_id=pulse.current_viewer() and (a.checked_in_at at time zone $3)::date between $1::date and $2::date
      order by a.checked_in_at limit 400`, args)).rows as Row[]);
    read.attendance = att !== null;
    for (const a of att ?? []) {
      const s = String(a.s), e = String(a.e);
      if (e <= s) continue;
      // Whose time it is, in the words (HR's view too); only a day still open gets a status.
      // The hours it came to ("3h 30m at work"), to the nearest 5 minutes.
      const m = Math.round((Date.parse(`${e}:00Z`) - Date.parse(`${s}:00Z`)) / 300_000) * 5, h = Math.floor(m / 60), r = m % 60;
      const took = h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`;
      items.push({ id: String(a.id), kind: 'attendance', title: a.open ? 'You are at work now' : 'You at work', start: s, end: e, href: '/me',
        meta: a.open ? `${took} so far` : took, ...(a.open ? { status: 'Checked in' } : {}) });
    }
  }

  if (want.has('meeting')) {
    const appts = await part(c, 'appointments', async () => ((await c.query('select pulse.appointment_list(null) l')).rows[0]?.l ?? {}) as { upcoming?: Row[]; past?: Row[] });
    read.appointments = appts !== null;
    for (const a of [...(appts?.upcoming ?? []), ...(appts?.past ?? [])]) {
      if (a.status === 'cancelled' || !a.startsAt) continue;
      if (opts.mine && a.mine === false) continue;
      const at = Date.parse(String(a.startsAt));
      const s = wallClock(at, clock.tz), e = wallClock(at + (Number(a.minutes) || 30) * 60_000, clock.tz);
      if (!s || !e || s.slice(0, 10) < from || s.slice(0, 10) > to) continue;
      items.push({ id: `appt-${a.id}`, kind: 'meeting', title: a.client ? `Meeting with ${a.client}` : 'Client meeting', start: s, end: e, href: '/appointments', meta: 'Client meeting', status: 'Booked',
        who: a.by ? `Booked by ${a.by}` : undefined, note: [a.place, a.note].filter(Boolean).join(' · ') || undefined });
    }
    // Meetings are read through pulse.meeting_list (the API role has no grant on the table; meeting_can decides per meeting).
    const meetings = await part(c, 'meetings', async () => ((await c.query('select pulse.meeting_list() l')).rows[0]?.l ?? []) as Row[]);
    read.meetings = meetings !== null;
    for (const m of meetings ?? []) {
      const at = Date.parse(String(m.startedAt ?? ''));
      const s = wallClock(at, clock.tz);
      if (!s || s.slice(0, 10) < from || s.slice(0, 10) > to) continue;
      const secs = Number(m.seconds) || 0;
      const e = secs > 0 ? wallClock(at + secs * 1000, clock.tz) : null;
      items.push({ id: `meeting-${m.id}`, kind: 'meeting', title: String(m.title), start: s, ...(e && e > s ? { end: e } : {}), href: `/meetings/${m.id}`,
        meta: m.client ? `Recorded meeting · ${m.client}` : 'Recorded meeting', status: 'Recorded', who: m.byName ? `Started by ${m.byName}` : undefined });
    }
  }

  if (want.has('event')) {
    // The companies view (`mine`) counts only events made in this company: a copy of the person's Google Calendar
    // belongs to no company, and each company that links the same Google account keeps its own copy (counted twice).
    const ev = await part(c, 'events', async () => (await c.query(`select e.id,e.title,e.all_day,e.source,e.note,e.place,
        ${wall('e.starts_at')} s,${wall('e.ends_at')} e,(e.starts_at at time zone $3)::date::text sd,((e.ends_at - interval '1 second') at time zone $3)::date::text ed
      from pulse.calendar_event e where e.person_id=pulse.current_viewer() and e.ends_at >= ($1::date::timestamp at time zone $3) and e.starts_at < (($2::date+1)::timestamp at time zone $3)
        and (not $4::boolean or e.source='pulse')
      order by e.starts_at limit 800`, [...args, !!opts.mine])).rows as Row[]);
    read.events = ev !== null;
    for (const e of ev ?? []) {
      const google = e.source === 'google';
      items.push({ id: String(e.id), kind: 'event', title: String(e.title), allDay: !!e.all_day, source: google ? 'google' : 'pulse',
        // No "Your event" line: the peek's kind says Event, and a Google one says "From Google Calendar" itself.
        start: e.all_day ? String(e.sd) : String(e.s), end: e.all_day ? String(e.ed) : String(e.e),
        ...(e.note ? { note: String(e.note) } : {}), ...(e.place ? { who: String(e.place) } : {}), editable: true });
    }
  }

  if (want.has('post') && !opts.mine) {
    const posts = await part(c, 'posts', async () => (await c.query(`select p.id,p.title,p.stage,p.channel,p.brand_id brand,b.name brand_name,
        to_char(p.slot_at at time zone coalesce(s.time_zone,$3),'YYYY-MM-DD"T"HH24:MI') slot,
        (select coalesce(a.slides->0->>'thumb',a.slides->0->>'file') from pulse.pr_asset a where a.id=p.asset_id) thumb
      from pulse.pr_post p join pulse.pr_brand b on b.id=p.brand_id left join pulse.pr_strategy s on s.brand_id=p.brand_id
      where p.slot_at is not null and not b.archived and ($4::uuid is null or p.brand_id=$4::uuid)
        and (p.slot_at at time zone coalesce(s.time_zone,$3))::date between $1::date and $2::date
      order by p.slot_at limit 500`, [...args, brand])).rows as Row[]);
    read.posts = posts !== null;
    for (const p of posts ?? []) {
      items.push({ id: String(p.id), kind: 'post', title: String(p.title), start: String(p.slot), href: `/pr?brand=${p.brand}&view=kit&post=${p.id}`,
        meta: `${CHANNEL[String(p.channel)] ?? p.channel} · ${p.brand_name}`, status: STAGE[String(p.stage)] ?? String(p.stage), editable: !['posted', 'measured'].includes(String(p.stage)),
        ...(typeof p.thumb === 'string' && /^[0-9a-f-]{36}$/.test(p.thumb) ? { thumb: `/api/v0/pr/flow/files/${p.thumb}` } : {}) });
    }
  }
  return { now: clock.now, tz: clock.tz, from, to, items, read };
}

// ------------------------------------------------------------------------------------------------ the person's own events
const text = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export type When = { start: string; end: string; allDay: boolean };
/** A wall-clock start and end from a body: timed ("YYYY-MM-DDTHH:mm") or all day ("YYYY-MM-DD", end = the last day). */
export function whenOf(b: Body): When {
  const allDay = b.allDay === true;
  const start = String(b.start ?? ''), end = String(b.end ?? '');
  if (allDay) {
    if (!DAY.test(start) || Number.isNaN(Date.parse(`${start}T00:00:00Z`))) fail(400, 'Pick a day (YYYY-MM-DD)');
    const last = DAY.test(end) ? end : start;
    if (last < start) fail(400, 'The last day is before the first day');
    if ((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 > 30) fail(400, 'An event lasts 31 days or fewer');
    return { start, end: last, allDay };
  }
  if (!STAMP.test(start) || Number.isNaN(Date.parse(`${start}:00Z`))) fail(400, 'Pick a day and a start time');
  const stop = STAMP.test(end) ? end : plusMinutes(start, 60);
  if (stop <= start) fail(400, 'The end time is before the start time');
  if ((Date.parse(`${stop}:00Z`) - Date.parse(`${start}:00Z`)) / 86_400_000 > 31) fail(400, 'An event lasts 31 days or fewer');
  return { start, end: stop, allDay };
}
/** SQL for a when: wall-clock text in the company's zone to instants (an all-day end is the day after the last day). */
const AT = (i: number) => `($${i}::timestamp at time zone ${ORG_TZ})`;
export const whenArgs = (w: When) => (w.allDay ? [`${w.start}T00:00`, `${addDays(w.end, 1)}T00:00`] : [w.start, w.end]);

async function ownEvent(c: PoolClient, id: string) {
  if (!UUID.test(id)) fail(400, 'Choose an event');
  return ((await c.query('select id,source,google_id,title,all_day,starts_at,ends_at from pulse.calendar_event where id=$1', [id])).rows[0] as Row | undefined) ?? fail(404, 'Event not found');
}

export function registerOneCalendarRoutes(app: FastifyInstance, { tx, pool }: { tx: Tx; pool: Pool }) {
  app.get<{ Querystring: Record<string, string> }>('/api/v0/calendar/items', (req) => tx(req, (c) => calendar(c, req.query ?? {})));

  // Create from a slot: the person's own event in this company (it goes to their Google Calendar at the next sync).
  app.post<{ Body: Body }>('/api/v0/calendar/events', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Sign in as yourself to add to your calendar');
    const b = req.body ?? {};
    const title = text(b.title, 200) || fail(400, 'Say what it is');
    const w = whenOf(b);
    const r = await c.query(`insert into pulse.calendar_event(org_id,person_id,title,starts_at,ends_at,all_day,note,place)
      values(pulse.current_org(),pulse.current_viewer(),$1,${AT(2)},${AT(3)},$4,$5,$6) returning id`,
    [title, ...whenArgs(w), w.allDay, text(b.note, 1000) || null, text(b.place, 300) || null]);
    return { id: r.rows[0].id as string };
  }));

  // Change one of the person's own events (a Google one changes in Google first, then here).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/calendar/events/:id', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Sign in as yourself to change your calendar');
    const e = await ownEvent(c, req.params.id), b = req.body ?? {};
    const title = 'title' in b ? text(b.title, 200) || fail(400, 'Say what it is') : String(e.title);
    const w = 'start' in b ? whenOf(b) : null;
    const note = 'note' in b ? text(b.note, 1000) || null : undefined;
    if (e.source === 'google') await googleEventChange(c, v.org, v.person!, String(e.google_id), { title, ...(w ? { when: w } : {}) });
    const vals: unknown[] = [e.id, title];
    const set = ['title=$2', 'updated_at=now()'];
    if (w) { vals.push(...whenArgs(w), w.allDay); set.push(`starts_at=${AT(3)}`, `ends_at=${AT(4)}`, 'all_day=$5'); }
    if (note !== undefined) { vals.push(note); set.push(`note=$${vals.length}`); }
    await c.query(`update pulse.calendar_event set ${set.join(',')} where id=$1`, vals);
    return { ok: true };
  }));

  app.post<{ Params: { id: string } }>('/api/v0/calendar/events/:id/delete', (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Sign in as yourself to change your calendar');
    const e = await ownEvent(c, req.params.id);
    if (e.source === 'google') await googleEventChange(c, v.org, v.person!, String(e.google_id), { remove: true });
    await c.query('delete from pulse.calendar_event where id=$1', [e.id]);
    return { ok: true };
  }));

  // Drag to reschedule: a task's due time, a post's slot or an event's start (its length stays). Each goes through the
  // path its own screen uses (task_save, PR Studio's updatePost), so the same rules decide who may move it.
  app.post<{ Body: Body }>('/api/v0/calendar/move', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Sign in as yourself to change your calendar');
    const b = req.body ?? {};
    const kind = String(b.kind ?? ''), id = String(b.id ?? ''), start = String(b.start ?? '');
    if (kind === 'milestone') fail(400, 'Open the project to move a milestone: a new date there asks for a reason');
    if (!['task', 'post', 'event'].includes(kind)) fail(400, 'Only tasks, posts and your own events move on the calendar');
    if (!UUID.test(id)) fail(400, 'Choose what to move');
    if (!(DAY.test(start) && !Number.isNaN(Date.parse(`${start}T00:00:00Z`))) && !(STAMP.test(start) && !Number.isNaN(Date.parse(`${start}:00Z`)))) fail(400, 'Pick a day (YYYY-MM-DD) or a day and time (YYYY-MM-DDTHH:mm)');
    if (kind === 'task') {
      const fields = DAY.test(start) ? { dueOn: start } : { dueAt: ((await c.query(`select ${AT(1)} v`, [start])).rows[0].v as Date).toISOString() };
      await c.query('select pulse.task_save($1,$2)', [id, JSON.stringify(fields)]);
      return { ok: true };
    }
    if (kind === 'post') {
      if (!STAMP.test(start)) fail(400, 'A post needs a time');
      await updatePost(c, id, { day: start.slice(0, 10), time: start.slice(11, 16) });
      return { ok: true };
    }
    const e = await ownEvent(c, id);
    const mins = Math.round((new Date(e.ends_at as string).getTime() - new Date(e.starts_at as string).getTime()) / 60_000);
    const at = STAMP.test(start) ? start : `${start}T09:00`;
    const w: When = e.all_day ? { start: start.slice(0, 10), end: addDays(start.slice(0, 10), Math.max(0, Math.round(mins / 1440) - 1)), allDay: true }
      : { start: at, end: plusMinutes(at, mins), allDay: false };
    if (e.source === 'google') await googleEventChange(c, v.org, v.person!, String(e.google_id), { title: String(e.title), when: w });
    await c.query(`update pulse.calendar_event set starts_at=${AT(2)},ends_at=${AT(3)},updated_at=now() where id=$1`, [e.id, ...whenArgs(w)]);
    return { ok: true };
  }));

  // "Which company takes which day and hours": each company the person works in, read inside itself as them (read only),
  // their own time only (tasks with a time, meetings, events, attendance, their own leave). Never two companies in one query.
  app.get<{ Querystring: Record<string, string> }>('/api/v0/calendar/companies', async (req) => {
    const { seats, actor } = await tx(req, async (c, v) => { if (!v.person) fail(403, 'Sign in as yourself'); return { seats: await seatsOf(c), actor: v.email }; });
    const q = { from: req.query?.from, to: req.query?.to, kinds: 'task,meeting,event,attendance,leave' };
    const companies: { org: string; name: string; handle: string | null; current: boolean; accent: string | null; now: string; tz: string; items: CalItem[] }[] = [];
    const unavailable: string[] = [];
    let window: { from: string; to: string } | null = null;
    for (const s of seats.slice(0, MAX_SEATS)) {
      if (s.kind !== 'staff') continue;
      try {
        const r = await inSeat(pool, s, actor, false, async (c) => {
          const cal = await calendar(c, q, { mine: true });
          const accent = ((await c.query('select accent from pulse.org_brand where org_id=pulse.current_org()')).rows[0]?.accent ?? null) as string | null;
          return { ...cal, accent };
        });
        window ??= { from: r.from, to: r.to };
        companies.push({ org: s.org, name: s.name, handle: s.handle, current: s.current, accent: r.accent && /^#[0-9a-f]{6}$/i.test(r.accent) ? r.accent : null,
          now: r.now, tz: r.tz, items: r.items.map(({ editable: _e, ...x }) => x) });
      } catch (e) {
        req.log.warn({ err: e, org: s.org }, 'calendar seat unavailable');
        unavailable.push(s.name);
      }
    }
    return { from: window?.from ?? null, to: window?.to ?? null, companies, unavailable, more: Math.max(0, seats.length - MAX_SEATS) };
  });
}
