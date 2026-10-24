// Pulse Companion: one small "today" answer for the desktop panel, phone, Chrome popup and web widget, HR's office
// presence settings (locations, radius, Wi-Fi), and browser pairing so an app signs in with the person's Pulse account.
// The day follows the same rules as My desk (shift, grace, holidays, leave); the actions are the My desk attendance API.
import { ORG_TZ } from "./org-time.js";
import { cleanRanges, updatePresence } from "./companion-presence.js";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { addDay, context, shiftContext, personalContext, working, type Ctx } from "./hr.js";
import { companionAttendanceEnabled } from "./companion-attendance.js";
import { admin, fail, hr, sessionHash, type Open, type Tx, type Viewer } from "./routes.js";

type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const PLATFORMS = ["ios", "android", "windows", "macos", "chrome"];
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";       // 32 letters and digits, no I/O/0/1
const SITE_RADIUS: Record<string, number> = { exact: 120, building: 150 };
const SITE_LIMIT = 15;
const ABOUT = { type: "object", additionalProperties: false, required: ["product", "company", "pairing"], properties: {
  product: { type: "string", const: "Pulse" },
  company: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" } } },
  pairing: { type: "object", additionalProperties: false, required: ["approval"], properties: { approval: { type: "string", enum: ["self", "admin"] } } },
} } as const;
const text = (raw: unknown, max: number) => String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const secret = () => randomBytes(32).toString("base64url");
const pairCode = () => { const b = randomBytes(8); let s = ""; for (const x of b) s += CODE_ALPHABET[x % 32]; return `${s.slice(0, 4)}-${s.slice(4)}`; };
/** "abcd efgh", "ABCDEFGH" or "ABCD-EFGH" → "ABCD-EFGH"; anything else is not a code. */
export const normalCode = (raw: unknown) => { const s = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""); return /^[A-HJ-NP-Z2-9]{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : null; };

/** Office settings as HR enters them: bounded, trimmed, MAC addresses lower-case with colons. */
export function cleanOffices(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 20) fail(400, "Add up to 20 offices");
  return (raw as Body[]).map((o, i) => {
    if (!o || typeof o !== "object") fail(400, `Office ${i + 1} is incomplete`);
    const name = text(o.name, 80), lat = Number(o.lat), lng = Number(o.lng), radius = Math.round(Number(o.radius ?? 150));
    if (!name) fail(400, `Office ${i + 1} needs a name`);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) fail(400, `Check the location of ${name}`);
    if (!Number.isFinite(radius) || radius < 50 || radius > 1000) fail(400, `The radius of ${name} is 50 to 1000 metres`);
    if (o.id !== undefined && o.id !== null && !UUID.test(String(o.id))) fail(400, `Office ${name} is not recognised`);
    const wifi = Array.isArray(o.wifi) ? o.wifi as Body[] : [];
    if (wifi.length > 10) fail(400, `Add up to 10 Wi-Fi networks for ${name}`);
    const networks = wifi.map((w) => {
      const ssid = String(w?.ssid ?? "").trim();
      if (!ssid || ssid.length > 32) fail(400, `A Wi-Fi network name for ${name} is missing or too long`);
      const bssids = [...new Set((Array.isArray(w.bssids) ? w.bssids : []).map((b) => String(b).trim().toLowerCase().replace(/-/g, ":")))];
      if (bssids.length > 16 || bssids.some((b) => !MAC.test(b))) fail(400, `Use access-point addresses like a4:2b:b0:11:22:33 for ${ssid}`);
      return { ssid, bssids };
    });
    return { id: o.id ? String(o.id) : null, name, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, radius, wifi: networks, publicIpRanges: cleanRanges(o.publicIpRanges), active: o.active !== false };
  });
}

// ATT: the company's attendance rules as HR edits them (migration 0861).
const RULES = `presence_auto_checkout "autoCheckOut",presence_break_max_minutes "breakMaxMinutes",break_allowed_minutes "breakAllowedMinutes",break_paid "breakPaid",
  checkout_grace_minutes "graceMinutes",presence_question "question",presence_threshold "threshold"`;
type Rules = { autoCheckOut: boolean; breakMaxMinutes: number; breakAllowedMinutes: number; breakPaid: boolean; graceMinutes: number; question: boolean; threshold: number };
/** HR's rules, bounded; anything not sent keeps its value. */
export function cleanRules(raw: unknown, was: Rules): Rules {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const flag = (k: keyof Rules) => typeof r[k] === "boolean" ? r[k] as boolean : was[k] as boolean;
  const num = (k: keyof Rules, lo: number, hi: number, words: string) => {
    if (r[k] === undefined) return was[k] as number;
    const n = Number(r[k]); if (!Number.isInteger(n) || n < lo || n > hi) fail(400, `${words} is ${lo} to ${hi}`); return n;
  };
  return { autoCheckOut: flag("autoCheckOut"), breakMaxMinutes: num("breakMaxMinutes", 10, 240, "The longest break Pulse records by itself (minutes)"),
    breakAllowedMinutes: num("breakAllowedMinutes", 0, 240, "Break time allowed a day (minutes)"), breakPaid: flag("breakPaid"),
    graceMinutes: num("graceMinutes", 0, 480, "The time after a shift before Pulse checks out (minutes)"), question: flag("question"),
    threshold: num("threshold", 30, 100, "How sure Pulse must be (out of 100)") };
}

/** Instants of a shift on a date on the organisation's clock; an overnight shift ends the next day. */
async function shiftInstants(c: PoolClient, date: string, start: string, end: string) {
  return (await c.query(`select (($1::date + $2::time) at time zone ${ORG_TZ}) s,
    (($1::date + $3::time + case when $3::time <= $2::time then interval '1 day' else interval '0' end) at time zone ${ORG_TZ}) e`, [date, start, end])).rows[0] as { s: Date; e: Date };
}

/** Consecutive working days, up to today, checked in on time (leave, holidays and days off neither break nor add). */
function onTimeStreak(x: Ctx, today: string, days: Map<string, number>, leave: Set<string>, includeToday: boolean) {
  let n = 0;
  for (let i = includeToday ? 0 : 1; i < 90; i++) {
    const d = addDay(today, -i);
    if (!working(x,d) || leave.has(d)) { if (!days.has(d)) continue; }
    const late = days.get(d);
    if (late === undefined || late > 0) break;
    n++;
  }
  return n;
}

export function registerCompanionRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  const body = { type: "object", maxProperties: 20 } as const;
  const me = (v: Viewer): string => { if (!v.person) fail(403, "The companion belongs to one person. Sign in with your own account."); return v.person as string; };

  // ------------------------------------------------------------------------------------------------- the day
  app.get("/api/v0/companion", req => tx(req, async (c, v) => {
    const who = me(v);
    if (v.nativeDevice) await c.query("select pulse.companion_presence_tick($1)",[v.nativeDevice]);
    // ATT: a Pulse page open on the office network is a signal too (only with the person's own consent; the address is
    // matched against the office's and never stored). `visible=0` (a hidden tab) says nothing.
    else if (v.person) { const ip = String(req.headers["x-pulse-client-ip"] ?? ""); await c.query("select pulse.presence_browser_seen($1::inet,$2)", [isIP(ip) ? ip : null, (req.query as { visible?: string }).visible !== "0"]); }
    const base = await context(c);
    const attendanceEnabled = await companionAttendanceEnabled(c);
    const person = (await c.query("select display_name name from pulse.person where id=$1 and status='active'", [who])).rows[0];
    if (!person) fail(403, "This account is not active in this company's Pulse");
    const entry = attendanceEnabled ? (await c.query(`select e.id,e.work_date::text "date",e.checked_in_at "in",e.checked_out_at "out",e.mode,e.late_minutes late,e.missed_out "missedOut",
      -- ATT: how the day was recorded (automatic check-in or check-out, and why), for the one-tap confirm and the words.
      e.client->>'via' "inVia",e.out_client->>'via' "outVia",e.out_client->>'reason' "outReason",
      coalesce((select round(sum(extract(epoch from b.ended_at-b.started_at))) from pulse.attendance_break b where b.entry_id=e.id and b.ended_at is not null),0)::int "closedBreakSeconds",
      (select b.started_at from pulse.attendance_break b where b.entry_id=e.id and b.ended_at is null) "breakStartedAt",
      coalesce((e.client->>'queued')::boolean,false) "syncedLate",
      -- POLISH-1: a forgotten check-out the person already sent a time for (the chip says it is waiting for approval).
      exists(select 1 from pulse.attendance_regularisation r where r.person_id=e.person_id and r.work_date=e.work_date and r.kind='missed_punch' and r.status='pending') "correctionPending"
      from pulse.attendance_effective e where e.person_id=$1 and (e.checked_out_at is null or e.work_date=$2)
      order by (e.checked_out_at is null) desc,e.checked_in_at desc limit 1`, [who, base.today])).rows[0] ?? null : null;
    // POLISH-2: a session Pulse closed for review because nobody checked out (the next morning, or at the next check-in):
    // the person tells the time they left (a correction HR or the pod head approves). Nothing changes until then.
    const unresolved = attendanceEnabled ? (await c.query(`select e.id "entryId",e.work_date::text "date",e.checked_in_at "in",p.proposed_end "proposedEnd",p.reason,
      exists(select 1 from pulse.attendance_regularisation r where r.person_id=e.person_id and r.work_date=e.work_date and r.kind='missed_punch' and r.status='pending') "correctionPending"
      from pulse.attendance_entry e join pulse.attendance_provisional_close p on p.entry_id=e.id
      where e.person_id=$1 and e.voided_at is null and e.checked_out_at is null and e.work_date>=$2::date-14
      and not exists(select 1 from pulse.attendance_correction_time t join pulse.attendance_regularisation r on r.id=t.regularisation_id where t.entry_id=e.id and r.status='approved')
      order by e.checked_in_at desc limit 1`, [who, base.today])).rows[0] ?? null : null;
    const planned = attendanceEnabled ? (await c.query(`select kind from pulse.attendance_regularisation where person_id=$1 and work_date=$2 and status='approved' and kind in ('wfh','on_duty') order by created_at desc limit 1`, [who, base.today])).rows[0] : null;
    // ATT: the one question Pulse may ask about a session (signals conflict), until it is answered.
    const question = attendanceEnabled && entry && !entry.out ? (await c.query(`select s.entry_id "entryId",s.ask_kind kind,coalesce(s.absent_since,s.last_confident_at) "leftAt",s.asked_at "askedAt",
      (select o.name from pulse.presence_office o join pulse.companion_presence d on d.office_id=o.id where d.person_id=s.person_id order by d.updated_at desc limit 1) office
      from pulse.attendance_presence_state s where s.person_id=$1 and s.entry_id=$2 and s.asked_at is not null and s.answer is null`, [who, entry.id])).rows[0] ?? null : null;
    const mode = entry?.mode ?? (planned ? (planned.kind === "wfh" ? "wfh" : "field") : "office");
    let x = await shiftContext(c, base, who, base.today, mode, !entry || !entry.out);
    x = await personalContext(c,x,who,addDay(x.today,-90),addDay(x.today,21));
    const leaves = (await c.query(`select from_date::text "from",to_date::text "to",half_day "half" from pulse.leave_request where person_id=$1 and status='approved' and to_date>=$2::date-90 and from_date<=$2::date+14`, [who, x.today])).rows as { from: string; to: string; half: string | null }[];
    const fullLeave = new Set<string>(); for (const l of leaves) if (!l.half) for (let d = l.from; d <= l.to; d = addDay(d, 1)) fullLeave.add(d);
    const workingDay = working(x,x.today);
    const state = entry && !entry.out ? (entry.breakStartedAt ? "break" : "in") : entry ? "done"
      : !workingDay && x.off.has(x.today) ? "holiday" : !workingDay ? "off" : fullLeave.has(x.today) ? "leave" : "out";
    const today = await shiftInstants(c, x.today, x.policy.shiftStart, x.policy.shiftEnd);
    // The next working days for reminders and "next shift"; the person's shift for today's mode stands in for later days.
    const upcoming: { date: string; start: string; startsAt: string }[] = [];
    for (let i = 0; i < 21 && upcoming.length < 7; i++) {
      const d = addDay(x.today, i);
      if (!working(x,d) || fullLeave.has(d)) continue;
      const at = await shiftInstants(c, d, x.policy.shiftStart, x.policy.shiftEnd);
      if (i === 0 && (state !== "out" || at.e.getTime() < Date.now())) continue;
      upcoming.push({ date: d, start: x.policy.shiftStart, startsAt: at.s.toISOString() });
    }
    const history = attendanceEnabled ? (await c.query(`select work_date::text d,min(late_minutes)::int late from pulse.attendance_effective where person_id=$1 and work_date>$2::date-90 and work_date<=$2::date group by 1`, [who, x.today])).rows as { d: string; late: number }[] : [];
    const total = attendanceEnabled ? Number((await c.query("select count(*)::int n from pulse.attendance_effective where person_id=$1", [who])).rows[0].n) : 0;
    const streak = attendanceEnabled ? { onTime: onTimeStreak(x, x.today, new Map(history.map((r) => [r.d, r.late])), fullLeave, !!entry && entry.date === x.today), firstCheckIn: total === 1 && entry?.date === x.today } : { onTime: 0, firstCheckIn: false };
    // Requests waiting for this person's decision: their team's, or everyone's for HR. Row security decides what is visible.
    const waiting = (await c.query(`select count(*)::int n from pulse.hr_flow f where f.status='pending' and f.person_id<>$1 and
      ($3::boolean or f.kind<>'correction') and
      ((f.stage='cofounder' and pulse.hr_is_cofounder()) or (f.stage='hr' and $2) or (f.stage='pod_head' and ($2 or pulse.hr_head(f.person_id)=$1)))`, [who,hr(v),attendanceEnabled])).rows[0].n as number;
    const policy = (await c.query(`select presence_auto_checkin auto,presence_sites sites,presence_dwell_minutes "dwellMinutes",presence_leave_minutes "leaveMinutes",presence_auto_checkout "autoCheckOut" from pulse.hr_policy`)).rows[0] ?? { auto: false, sites: true };
    const offices = (await c.query(`select id,name,lat,lng,radius_m radius,wifi,public_ip_ranges "publicIpRanges",audience is not null "test" from pulse.presence_office where active and (audience is null or $1=any(audience)) order by name`, [v.person])).rows;
    const sites = policy.sites ? (await c.query(`select l.id,coalesce(nullif(l.name,''),l.geo_key) "name",l.lat,l.lng,l.precision from pulse.project_location l
      where l.precision in ('exact','building') and l.lat is not null order by l.pinned_at desc nulls last,l.updated_at desc limit ${SITE_LIMIT}`)).rows.map((s) => ({ ...s, radius: SITE_RADIUS[s.precision] })) : [];
    const offset = (await c.query(`select round(extract(epoch from (now() at time zone ${ORG_TZ}) - (now() at time zone 'UTC'))/60)::int m`)).rows[0].m as number;
    // PRESENCE-ONBOARD: the first time someone opens Pulse counts as "signed in" on HR's Onboard team view.
    await c.query("select pulse.onboarding_seen()");
    // Arrived at an office and Pulse asked "Check in?": every surface offers the same one tap until they answer.
    const arrival = attendanceEnabled && state === "out" ? (await c.query(`select a.at,o.name office from pulse.attendance_event a left join pulse.presence_office o on o.id=a.office_id
      where a.person_id=$1 and a.work_date=$2 and a.kind='arrival_asked' and a.at>now()-interval '3 hours' order by a.at desc limit 1`, [who, x.today])).rows[0] ?? null : null;
    // "On time this week": this week's working days so far, each on time, late, missed or not a working day.
    const monday = addDay(x.today, -((new Date(`${x.today}T00:00:00Z`).getUTCDay() + 6) % 7)), lateness = new Map(history.map((r) => [r.d, r.late]));
    // POLISH-2 (QA-E2E P2-14): days before the person's first day (joined, else attendance tracked from) are not "missed".
    const first = attendanceEnabled ? (await c.query(`select greatest(coalesce((select joined_on from pulse.people_profile where person_id=$1),'-infinity'::date),
      coalesce((select tracking_from from pulse.hr_policy),'-infinity'::date))::text d`, [who])).rows[0]?.d as string | undefined : undefined;
    const before = (d: string) => !!first && /^\d{4}-/.test(first) && d < first;
    const weekDays = Array.from({ length: 7 }, (_, i) => addDay(monday, i)).filter((d) => d <= x.today || lateness.has(d)).map((d) => ({ date: d,
      state: lateness.has(d) ? (lateness.get(d)! > 0 ? "late" : "on_time") : !working(x, d) || fullLeave.has(d) || before(d) ? "off" : d === x.today ? "today" : "missed" }));
    const week = attendanceEnabled ? { onTime: weekDays.filter((d) => d.state === "on_time").length, late: weekDays.filter((d) => d.state === "late").length,
      missed: weekDays.filter((d) => d.state === "missed").length, days: weekDays } : null;
    const grace = x.policy.graceMinutes, [h, m] = x.policy.shiftStart.split(":").map(Number), byMin = h * 60 + m + grace;
    const next = state === "out" && today.e.getTime() > Date.now() ? { date: x.today, start: x.policy.shiftStart, startsAt: today.s.toISOString() } : upcoming.find((u) => u.date !== x.today) ?? null;
    return {
      attendanceEnabled,
      person: { id: who, name: person.name, firstName: String(person.name ?? "").split(" ")[0] },
      now: new Date().toISOString(), today: x.today, clock: x.clock, timezone: x.zone, utcOffsetMinutes: offset,
      shift: { start: x.policy.shiftStart, end: x.policy.shiftEnd, graceMinutes: grace, onTimeBy: `${String(Math.floor(byMin / 60) % 24).padStart(2, "0")}:${String(byMin % 60).padStart(2, "0")}`, workingDay, mode: attendanceEnabled ? mode : null },
      shiftStartsAt: today.s.toISOString(), shiftEndsAt: today.e.toISOString(),
      state, holiday: workingDay ? null : x.off.get(x.today) ?? null,
      entry: entry ? { ...entry, onBreak: !!entry.breakStartedAt } : null,
      nextShift: next, upcoming, streak, week, arrival, unresolved, question,
      waiting: Number(waiting) > 0 ? { count: Number(waiting), href: "/me/approvals" } : null,
      presence: { dwellMinutes: policy.dwellMinutes, leaveMinutes: policy.leaveMinutes, autoCheckIn: !!policy.auto || offices.some((o) => o.test), autoCheckOut: policy.autoCheckOut !== false, offices: offices.map((o) => ({ ...o, wifi: o.wifi ?? [] })), sites },
      links: { desk: "/me", corrections: "/me?tab=attendance" },
    };
  }));

  app.post<{ Body: Body }>("/api/v0/companion/presence", { schema: { body } }, req => tx(req, async (c,v) => ({
    ...(await updatePresence(c,v,req.body,String(req.headers['x-pulse-client-ip'] ?? ''))), attendanceEnabled: await companionAttendanceEnabled(c),
  })));
  app.get("/api/v0/companion/presence", req => tx(req, async (c,v) => {
    if (!v.nativeDevice || !v.person) fail(403, "Office presence requires an authorized device");
    const preference = (await c.query('select consent from pulse.companion_presence where device_id=$1 and person_id=$2',[v.nativeDevice,v.person])).rows[0];
    // A device that never chose follows the person's own agreement from onboarding; a device's own "off" wins.
    const person = (await c.query('select pulse.onboarding_presence_consent() c')).rows[0].c as { given: boolean; auto: boolean };
    const offices = (await c.query(`select id,name,lat,lng,radius_m radius,wifi from pulse.presence_office
      where active and (audience is null or $1=any(audience)) order by name`,[v.person])).rows;
    const dwell = (await c.query('select presence_dwell_minutes d from pulse.hr_policy')).rows[0]?.d ?? 3;
    return { enabled: preference ? preference.consent === true : person.given, auto: person.auto, dwellMinutes: dwell, offices, sites: [] };
  }));

  // ------------------------------------------------------------------------------------- HR: office presence
  app.get("/api/v0/hr/presence", req => tx(req, async (c, v) => {
    const policy = (await c.query(`select presence_auto_checkin auto,presence_sites sites,presence_dwell_minutes "dwellMinutes",presence_leave_minutes "leaveMinutes",${RULES} from pulse.hr_policy`)).rows[0] ?? { auto: false, sites: true };
    const offices = (await c.query(`select o.id,o.name,o.lat,o.lng,o.radius_m radius,o.wifi,o.public_ip_ranges "publicIpRanges",o.active,o.updated_at "updatedAt",
      (select array_agg(p.display_name order by p.display_name) from pulse.person p where p.id=any(o.audience)) "testFor" from pulse.presence_office o where o.active order by o.name`)).rows;
    const siteCount = (await c.query("select count(*)::int n from pulse.project_location where precision in ('exact','building') and lat is not null")).rows[0].n;
    // ATT: what the data already shows about the office: the owner-only test office (offered to HR as the company's),
    // never copied anywhere else. Values stay in the database.
    const suggestions = (await c.query(`select o.id,o.name,coalesce(jsonb_array_length(o.wifi),0)::int "wifiCount",cardinality(o.public_ip_ranges)::int "networkCount",
      (select count(distinct a.person_id)::int from pulse.attendance_event a where a.office_id=o.id) "peopleSeen" from pulse.presence_office o where o.active and o.audience is not null order by o.name`)).rows;
    return { attendanceEnabled: await companionAttendanceEnabled(c), offices, dwellMinutes: policy.dwellMinutes, leaveMinutes: policy.leaveMinutes, autoCheckIn: !!policy.auto, sites: !!policy.sites, siteCount, siteLimit: SITE_LIMIT,
      rules: { autoCheckOut: policy.autoCheckOut ?? true, breakMaxMinutes: policy.breakMaxMinutes ?? 90, breakAllowedMinutes: policy.breakAllowedMinutes ?? 60, breakPaid: !!policy.breakPaid,
        graceMinutes: policy.graceMinutes ?? 60, question: policy.question ?? true, threshold: policy.threshold ?? 60 }, suggestions, canEdit: hr(v) && !!v.person && !v.nativeDevice };
  }));
  app.post<{ Body: Body }>("/api/v0/hr/presence", { schema: { body } }, req => tx(req, async (c, v) => {
    if (!hr(v) || !v.person || v.nativeDevice) fail(403, "Office presence is set by HR and organisation admins");
    await c.query("select pulse.hr_defaults()");
    const b = req.body, offices = cleanOffices(b.offices ?? []);
    const before = (await c.query(`select id,name,lat,lng,radius_m radius,wifi,public_ip_ranges "publicIpRanges" from pulse.presence_office where active`)).rows as { id: string; name: string }[];
    const change = (id: string, field: string, from: string | null, to: string | null) => c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values ($1,'presence_office',$2,$3,$4,$5,$6)`, [v.org, id, field, from, to, v.person]);
    const kept: string[] = [];
    for (const o of offices) {
      if (o.id && before.some((x) => x.id === o.id)) {
        await c.query("update pulse.presence_office set name=$2,lat=$3,lng=$4,radius_m=$5,wifi=$6,active=$7,updated_at=now(),updated_by=$8,public_ip_ranges=$9::cidr[] where id=$1", [o.id, o.name, o.lat, o.lng, o.radius, JSON.stringify(o.wifi), o.active, v.person, o.publicIpRanges]);
        await change(o.id, "office", null, `${o.name} · ${o.radius} m · ${o.wifi.length} Wi-Fi · ${o.publicIpRanges.length} public networks`);
        kept.push(o.id);
      } else {
        const id = (await c.query("insert into pulse.presence_office(org_id,name,lat,lng,radius_m,wifi,active,updated_by,public_ip_ranges) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::cidr[]) returning id", [v.org, o.name, o.lat, o.lng, o.radius, JSON.stringify(o.wifi), o.active, v.person, o.publicIpRanges])).rows[0].id;
        await change(id, "office", null, `${o.name} · ${o.radius} m · ${o.wifi.length} Wi-Fi · ${o.publicIpRanges.length} public networks`);
        kept.push(id);
      }
    }
    for (const gone of before.filter((x) => !kept.includes(x.id))) {
      await c.query("update pulse.presence_office set active=false,updated_at=now(),updated_by=$2 where id=$1", [gone.id, v.person]);
      await change(gone.id, "office", gone.name, null);
    }
    // ATT: a test office (one person's) becomes the company's office for everyone, as HR confirms it is.
    if (b.openToEveryone !== undefined) {
      const id = String(b.openToEveryone);
      if (!UUID.test(id)) fail(400, "Office is not recognised");
      const opened = await c.query("update pulse.presence_office set audience=null,updated_at=now(),updated_by=$2 where id=$1 and active and audience is not null returning name", [id, v.person]);
      if (opened.rowCount) await change(id, "audience", "test", "everyone");
    }
    const prior = (await c.query(`select presence_auto_checkin auto,presence_sites sites,presence_dwell_minutes "dwellMinutes",presence_leave_minutes "leaveMinutes" from pulse.hr_policy`)).rows[0];
    const auto = typeof b.autoCheckIn === "boolean" ? b.autoCheckIn : !!prior.auto, sites = typeof b.sites === "boolean" ? b.sites : !!prior.sites;
    const dwell = b.dwellMinutes === undefined ? prior.dwellMinutes : Number(b.dwellMinutes), leave = b.leaveMinutes === undefined ? prior.leaveMinutes : Number(b.leaveMinutes);
    if (!Number.isInteger(dwell) || dwell < 1 || dwell > 30 || !Number.isInteger(leave) || leave < 1 || leave > 120) fail(400,"Dwell is 1–30 minutes; departure confirmation is 1–120 minutes");
    await c.query("update pulse.hr_policy set presence_auto_checkin=$1,presence_sites=$2,presence_dwell_minutes=$3,presence_leave_minutes=$4,updated_at=now()", [auto, sites, dwell, leave]);
    // ATT: break, check-out and question rules (HR → Settings → Attendance). Each change is recorded like the others.
    const was = (await c.query(`select ${RULES} from pulse.hr_policy`)).rows[0];
    const rules = cleanRules(b.rules, was);
    await c.query(`update pulse.hr_policy set presence_auto_checkout=$1,presence_break_max_minutes=$2,break_allowed_minutes=$3,break_paid=$4,checkout_grace_minutes=$5,presence_question=$6,presence_threshold=$7`,
      [rules.autoCheckOut, rules.breakMaxMinutes, rules.breakAllowedMinutes, rules.breakPaid, rules.graceMinutes, rules.question, rules.threshold]);
    for (const [field, value] of Object.entries(rules)) if (String(was[field]) !== String(value))
      await c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values($1,'hr_policy',$1,$2,$3,$4,$5)`, [v.org, `presence.${field}`, String(was[field]), String(value), v.person]);
    if (auto !== !!prior.auto) await c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values ($1,'hr_policy',$1,'presenceAutoCheckIn',$2,$3,$4)`, [v.org, String(!!prior.auto), String(auto), v.person]);
    if (sites !== !!prior.sites) await c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values ($1,'hr_policy',$1,'presenceSites',$2,$3,$4)`, [v.org, String(!!prior.sites), String(sites), v.person]);
    for (const [field,oldValue,newValue] of [['presenceDwellMinutes',prior.dwellMinutes,dwell],['presenceLeaveMinutes',prior.leaveMinutes,leave]] as const) {
      if(oldValue!==newValue)await c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values($1,'hr_policy',$1,$2,$3,$4,$5)`,[v.org,field,String(oldValue),String(newValue),v.person]);
    }
    return { ok: true, offices: kept.length, attendanceEnabled: await companionAttendanceEnabled(c) };
  }));

  // --------------------------------------------------------------------------------------- browser pairing
  // 1. The app asks for a code (no account yet). 2. The person approves it on the Pulse site where they are signed in.
  // 3. The app collects its device tokens once. Codes live ten minutes; secrets are stored only as hashes.
  // A company may also require an admin's approval (tenant setting companion.pairing_approval, migration 0174): then
  // the person's approval leaves the request awaiting_admin for 24 hours and the tokens come after both approvals.
  // Before pairing, the app names the company it joins: the name and the approval mode only, no people or counts.
  app.get("/api/v0/native/about", { schema: { response: { 200: ABOUT } } }, () => open(async c => {
    const r = (await c.query("select o.name,pulse.companion_pairing_approval() approval from pulse.org o where o.id=pulse.current_org()")).rows[0];
    return { product: "Pulse", company: { name: r.name }, pairing: { approval: r.approval } };
  }));
  app.post<{ Body: Body }>("/api/v0/native/pair/start", { schema: { body } }, async req => {
    const platform = String(req.body.platform ?? ""), name = text(req.body.name, 80) || "Pulse app";
    if (!PLATFORMS.includes(platform)) fail(400, "Choose the app's platform");
    const pollSecret = secret();
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = pairCode();
      try {
        const pairId = await open(async c => (await c.query("select pulse.native_pair_start($1,$2,$3,$4) id", [code, sessionHash(pollSecret), platform, name])).rows[0].id as string);
        return { pairId, pollSecret, code, expiresIn: 600, interval: 3 };
      } catch (e) { if ((e as { code?: string }).code !== "23505") throw e; }
    }
    return fail(503, "Pulse could not make a sign-in code. Try again.");
  });
  app.post<{ Body: Body }>("/api/v0/native/pair/poll", { schema: { body } }, async req => {
    const pairId = String(req.body.pairId ?? ""), pollSecret = String(req.body.pollSecret ?? "");
    if (!UUID.test(pairId) || !/^[A-Za-z0-9_-]{43}$/.test(pollSecret)) fail(400, "Unknown sign-in request");
    const accessToken = secret(), refreshToken = secret();
    const d = await open(async c => (await c.query("select pulse.native_pair_redeem($1,$2,$3,$4) d", [pairId, sessionHash(pollSecret), sessionHash(accessToken), sessionHash(refreshToken)])).rows[0].d as Body);
    if (d.status === "unknown") fail(404, "Unknown sign-in request");
    if (d.status !== "approved") return { status: d.status };
    return { status: "approved", accessToken, refreshToken, expiresIn: 900, deviceId: d.deviceId, person: { id: d.personId, name: d.name } };
  });
  app.get<{ Params: { code: string } }>("/api/v0/native/pair/:code", req => tx(req, async (c, v) => {
    if (v.nativeDevice) fail(403, "Approve new apps from the Pulse site");
    const code = normalCode(req.params.code) ?? fail(404, "That code is not valid. Check the code in the app.");
    const d = (await c.query("select pulse.native_pair_peek($1) d", [code])).rows[0].d;
    if (!d) fail(404, "That code has expired or was already used. Start again in the app.");
    return { code, ...d, browserPerson:{id:v.person,name:v.name} };
  }));
  app.post<{ Body: Body }>("/api/v0/native/pair/decide", { schema: { body } }, req => tx(req, async (c, v) => {
    if (v.nativeDevice) fail(403, "Approve new apps from the Pulse site");
    if (v.mustChange) fail(403, "Choose your own password before connecting an app");
    const code = normalCode(req.body.code) ?? fail(400, "That code is not valid");
    return (await c.query("select pulse.native_pair_decide($1,$2) d", [code, req.body.approve === true])).rows[0].d;
  }));
  // Admins of the organisation see and decide the requests waiting for them (row security keeps other companies out).
  const deviceAdmin = (v: Viewer) => { if (!admin(v) || !v.person || v.nativeDevice) fail(403, "New devices are approved by organisation admins"); };
  app.get("/api/v0/admin/devices/pairings", req => tx(req, async (c, v) => {
    deviceAdmin(v);
    return { pairings: (await c.query("select pulse.native_pair_awaiting() d")).rows[0].d };
  }));
  app.post<{ Params: { code: string }; Body: Body }>("/api/v0/admin/devices/pairings/:code/decide", { schema: { body } }, req => tx(req, async (c, v) => {
    deviceAdmin(v);
    if (typeof req.body.approve !== "boolean") fail(400, "Approve or deny the device");
    const code = normalCode(req.params.code) ?? fail(404, "No device is waiting for approval with this code");
    return (await c.query("select pulse.native_pair_admin_decide($1,$2) d", [code, req.body.approve])).rows[0].d;
  }));
  // The Pulse phone app is the web app in a shell: after the normal sign-in on the phone, the page approves the shell's
  // own pairing request (nobody types a code) and the device is bound to this web session (migration 0136).
  app.post<{ Body: Body }>("/api/v0/native/shell/enroll", { schema: { body } }, req => tx(req, async (c, v) => {
    if (v.nativeDevice) fail(403, "Register the phone app from its own signed-in Pulse");
    const token = req.headers["x-pulse-session"];
    if (v.via !== "password" || typeof token !== "string") fail(403, "Sign in to Pulse on this phone first");
    if (v.mustChange) fail(403, "Choose your own password before connecting an app");
    if (req.body.expectedPersonId !== undefined && req.body.expectedPersonId !== v.person) fail(403, "Your sign-in changed. Open Pulse again before registering this phone.");
    const code = normalCode(req.body.code) ?? fail(400, "That code is not valid");
    const replaces = req.body.replaces == null ? null : UUID.test(String(req.body.replaces)) ? String(req.body.replaces) : fail(400, "Unknown earlier device");
    return (await c.query("select pulse.native_shell_enroll($1,$2,$3) d", [code, sessionHash(token as string), replaces])).rows[0].d;
  }));
}
