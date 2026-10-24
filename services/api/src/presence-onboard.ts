// PRESENCE-ONBOARD (owner, 10 Oct 2026): the person's day timeline with "That's not right", HR's check-in settings
// (arrival: ask or automatic; reminders; payroll cut-off), the employee's first-run onboarding (details, bank,
// documents, app, notifications, office-arrival consent, staff notice), government IDs handled as the Aadhaar Act and
// the DPDP Act require (see migration 0147 and onboarding-model.ts), agents' proposals and HR's "Onboard team" view.
// Authorization is decided by the database functions in the same transaction; these routes validate and shape.
import { ORG_TZ } from "./org-time.js";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { checkBank, cleanDetails, maskAadhaar, maskPan } from "./onboarding-model.js";
import { bankContext, documentContext, DocumentKeyError, loadKeyring, open, requireKeyring, seal } from "./document-keys.js";
import { attendanceEnabled } from "./attendance-policy.js";
import { fail, hr, type Tx, type Viewer } from "./routes.js";
import { sendFile } from "./tasks.js";

type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (raw: unknown, what = "Record") => UUID.test(String(raw ?? "")) ? String(raw) : fail(400, `${what} is not recognised`);
const day = (raw: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(raw ?? "")) ? String(raw) : null;

/** The database speaks in SQLSTATEs; people get the sentence the function raised. */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "42501") fail(403, err.message ?? "Not allowed");
    if (err.code === "22023" || err.code === "22P02" || err.code === "23514") fail(400, err.message ?? "Check the details");
    if (err.code === "23505") fail(409, "That was already saved");
    throw e;
  }
}

export function registerPresenceOnboardRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const body = { type: "object", maxProperties: 30 } as const;
  const me = (v: Viewer) => v.person ?? fail(403, "This is for one person. Sign in with your own account.");
  const notDevice = (v: Viewer) => { if (v.nativeDevice) fail(403, "Open Pulse to do this"); };

  // ------------------------------------------------------------------------------------------- the day timeline
  /** One day as the person lived it: check-ins and breaks with how they were recorded, what Pulse noticed or reminded,
   *  and the corrections asked for. HR may read anyone's (?person=). Never a location: an office name and a signal kind. */
  app.get<{ Querystring: { date?: string; person?: string } }>("/api/v0/attendance/day", req => tx(req, async (c, v) => {
    const who = req.query.person ? id(req.query.person, "Person") : me(v);
    if (who !== v.person && !hr(v)) fail(403, "Your own day, or HR");
    const today = (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d as string;
    const date = day(req.query.date) ?? today;
    if (!(await attendanceEnabled(c))) return { attendanceEnabled: false, date, today, sessions: [], events: [], corrections: [] };
    const sessions = (await c.query(`select e.id,e.checked_in_at "in",e.checked_out_at "out",e.mode,e.late_minutes late,e.source,
      e.client->>'via' "inVia",e.client->>'trigger' "inTrigger",coalesce((e.client->>'queued')::boolean,false) "inQueued",
      e.out_client->>'via' "outVia",e.out_client->>'trigger' "outTrigger",coalesce((e.out_client->>'queued')::boolean,false) "outQueued",
      (select o.name from pulse.presence_office o where o.id::text=e.client->'place'->>'id') office,
      coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'start',b.started_at,'end',b.ended_at) order by b.started_at) from pulse.attendance_break b where b.entry_id=e.id),'[]') breaks
      from pulse.attendance_effective e where e.person_id=$1 and e.work_date=$2::date and e.voided_at is null order by e.checked_in_at`, [who, date])).rows;
    const events = (await c.query(`select a.id,a.at,a.kind,a.detail,a.signals,o.name office,a.device_kind "device",a.entry_id "entryId",
      a.regularisation_id "correctionId",a.disputed_at "disputedAt",a.dispute_id "disputeId"
      from pulse.attendance_event a left join pulse.presence_office o on o.id=a.office_id where a.person_id=$1 and a.work_date=$2::date order by a.at`, [who, date])).rows;
    const corrections = (await c.query(`select r.id,r.kind,to_char(r.in_time,'HH24:MI') "inTime",to_char(r.out_time,'HH24:MI') "outTime",r.reason,r.status,r.created_at "createdAt"
      from pulse.attendance_regularisation r where r.person_id=$1 and r.work_date=$2::date order by r.created_at`, [who, date])).rows;
    return { attendanceEnabled: true, date, today, self: who === v.person, sessions, events, corrections };
  }));
  /** "That's not right": the correction itself goes through POST /hr/regularisations; this links it to the event. */
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/attendance/events/:id/dispute", { schema: { body } }, req => tx(req, async (c, v) => {
    me(v);
    await run(() => c.query("select pulse.attendance_event_dispute($1,$2)", [id(req.params.id, "Event"), id(req.body.correctionId, "Correction")]));
    return { ok: true };
  }));

  // ------------------------------------------------------------------------------------ HR: check-in settings
  const settings = async (c: PoolClient) => {
    const p = (await c.query(`select presence_auto_checkin auto,presence_ask ask,presence_dwell_minutes "dwellMinutes",presence_leave_minutes "leaveMinutes",
      payroll_cutoff_day "cutoffDay",onboarding_reminders "onboardingReminders",to_char(shift_start,'HH24:MI') "shiftStart",to_char(shift_end,'HH24:MI') "shiftEnd" from pulse.hr_policy`)).rows[0] ?? {};
    const r = (await c.query(`select enabled,approval_ref "approvedBy",start_offset_minutes "startOffset",long_break_minutes "longBreak" from pulse.notification_reminder_policy`)).rows[0];
    const offices = (await c.query("select count(*)::int n,count(*) filter (where cardinality(public_ip_ranges)>0 or jsonb_array_length(wifi)>0)::int networks from pulse.presence_office where active and audience is null")).rows[0];
    return { arrival: p.auto ? "auto" : p.ask === false ? "off" : "ask", dwellMinutes: p.dwellMinutes ?? 3, leaveMinutes: p.leaveMinutes ?? 15,
      cutoffDay: p.cutoffDay ?? null, onboardingReminders: p.onboardingReminders === true, shift: { start: p.shiftStart ?? "10:00", end: p.shiftEnd ?? "19:00" },
      reminders: { enabled: r?.enabled === true, approvedBy: r?.approvedBy ?? null, startOffset: r?.startOffset ?? 0, longBreak: r?.longBreak ?? 60 },
      offices: { count: offices.n, withNetworks: offices.networks }, attendanceEnabled: await attendanceEnabled(c) };
  };
  app.get("/api/v0/hr/checkin-settings", req => tx(req, async (c, v) => { if (!hr(v)) fail(403, "For HR and organisation admins"); return { ...(await settings(c)), canEdit: !!v.person && ["admin", "hr"].includes(v.role) }; }));
  app.post<{ Body: Body }>("/api/v0/hr/checkin-settings", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v);
    if (!v.person || !["admin", "hr"].includes(v.role)) fail(403, "HR or an organisation admin decides check-in settings");
    await c.query("select pulse.hr_defaults()");
    const b = req.body, before = await settings(c);
    const log = (field: string, from: unknown, to: unknown) => String(from) === String(to) ? null : c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values($1,'hr_policy',$1,$2,$3,$4,$5)`, [v.org, field, String(from), String(to), v.person]);
    if (b.arrival !== undefined) {
      if (!["off", "ask", "auto"].includes(String(b.arrival))) fail(400, "Choose ask, automatic or off");
      await c.query("update pulse.hr_policy set presence_ask=$1,presence_auto_checkin=$2,updated_at=now()", [b.arrival !== "off", b.arrival === "auto"]);
      await log("presenceArrival", before.arrival, b.arrival);
    }
    if (b.cutoffDay !== undefined) {
      const n = b.cutoffDay === null || b.cutoffDay === "" ? null : Number(b.cutoffDay);
      if (n !== null && (!Number.isInteger(n) || n < 1 || n > 28)) fail(400, "The payroll cut-off is a day from 1 to 28");
      await c.query("update pulse.hr_policy set payroll_cutoff_day=$1,updated_at=now()", [n]);
      await log("payrollCutoffDay", before.cutoffDay, n);
    }
    if (typeof b.onboardingReminders === "boolean") {
      await c.query("update pulse.hr_policy set onboarding_reminders=$1,updated_at=now()", [b.onboardingReminders]);
      await log("onboardingReminders", before.onboardingReminders, b.onboardingReminders);
    }
    if (b.reminders && typeof b.reminders === "object") {
      const r = b.reminders as Body, start = Number(r.startOffset ?? before.reminders.startOffset), long = Number(r.longBreak ?? before.reminders.longBreak);
      if (![0, 5, 10, 15].includes(start)) fail(400, "The first reminder is at the start or 5, 10 or 15 minutes later");
      if (!Number.isInteger(long) || long < 15 || long > 240) fail(400, "A long break is 15 to 240 minutes");
      await run(() => c.query("select pulse.attendance_reminders_set($1,$2,$3)", [r.enabled === true, start, long]));
    }
    return settings(c);
  }));

  // ---------------------------------------------------------------------------------------------- onboarding
  // filesReady: whether this server holds the document keyring (no keyring, no ID files or bank details).
  const state = async (c: PoolClient, who: string) => ({ ...(await run(() => c.query("select pulse.onboarding_state($1) s", [who]))).rows[0].s, filesReady: (await loadKeyring()).ok });
  app.get("/api/v0/onboarding", req => tx(req, async (c, v) => ({ ...(await state(c, me(v))), attendanceEnabled: await attendanceEnabled(c) })));
  app.get<{ Params: { person: string } }>("/api/v0/onboarding/:person", req => tx(req, async (c) => state(c, id(req.params.person, "Person"))));
  app.post<{ Params: { person: string }; Body: Body }>("/api/v0/onboarding/:person/details", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v);
    const today = (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d;
    const clean = cleanDetails(req.body, today);
    if (!clean.ok) fail(400, clean.error);
    return (await run(() => c.query("select pulse.onboarding_save($1,'details',$2) r", [id(req.params.person, "Person"), clean.ok ? clean.data : {}]))).rows[0].r;
  }));
  app.post<{ Params: { person: string }; Body: Body }>("/api/v0/onboarding/:person/bank", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v);
    const bank = checkBank(req.body);
    if (!bank.ok) fail(400, bank.error);
    // The account is sealed here; the database keeps only the sealed bytes and the masked line the answer carries.
    const person = id(req.params.person, "Person"), ring = await requireKeyring("bank");
    const sealed = bank.ok ? seal(ring, Buffer.from(JSON.stringify(bank.account)), bankContext(v.org, person)) : null;
    // PEOPLE-CONTACTS: pulse.bank_save decides who may (the person or HR) and keeps the summary without the number.
    const r = (await run(() => c.query("select pulse.onboarding_save($1,'bank',$2) r", [person, bank.ok && sealed ? { masked: bank.masked, summary: bank.summary, keyId: sealed.keyId, dataKey: sealed.dataKey.toString("base64"), sealed: sealed.data.toString("base64") } : {}]))).rows[0].r;
    return { ...r, masked: bank.ok ? bank.masked : null, summary: bank.ok ? bank.summary : null };
  }));
  app.post<{ Params: { person: string }; Body: Body }>("/api/v0/onboarding/:person/step", { schema: { body } }, req => tx(req, async (c) =>
    (await run(() => c.query("select pulse.onboarding_save($1,'step',$2) r", [id(req.params.person, "Person"), { step: String(req.body.step ?? ""), state: String(req.body.state ?? "done") }]))).rows[0].r));
  app.post<{ Body: Body }>("/api/v0/onboarding/consent", { schema: { body } }, req => tx(req, async (c, v) => {
    if (typeof req.body.given !== "boolean") fail(400, "Agree or not");
    return (await run(() => c.query("select pulse.onboarding_save($1,'consent',$2) r", [me(v), { given: req.body.given, auto: req.body.auto === true, version: "arrival-v1" }]))).rows[0].r;
  }));
  app.post<{ Body: Body }>("/api/v0/onboarding/notice", { schema: { body } }, req => tx(req, async (c, v) =>
    (await run(() => c.query("select pulse.onboarding_save($1,'notice',$2) r", [me(v), { noticeId: id(req.body.noticeId, "Notice") }]))).rows[0].r));

  // Government IDs: the number is checked and masked here; only the masked form reaches the database.
  app.post<{ Params: { person: string }; Body: Body }>("/api/v0/onboarding/:person/documents", { schema: { body }, bodyLimit: 7200000 }, req => tx(req, async (c, v) => {
    notDevice(v);
    const kind = String(req.body.kind ?? "");
    await c.query("select pulse.onboarding_defaults()");
    const kindRow = (await c.query("select id_number from pulse.onboarding_document_kind where kind=$1 and active", [kind])).rows[0];
    if (!kindRow) fail(400, "HR has not asked for that document");
    let masked: string | null = null;
    if (req.body.number !== undefined && String(req.body.number).trim()) {
      const m = kindRow.id_number === "aadhaar" ? maskAadhaar(req.body.number) : kindRow.id_number === "pan" ? maskPan(req.body.number) : { ok: false as const, error: "This document has no number to keep" };
      if (!m.ok) fail(400, m.error);
      masked = m.ok ? m.masked : null;
    }
    const raw = req.body.bytes === undefined ? null : String(req.body.bytes);
    if (raw !== null && (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length > 7000000)) fail(400, "Choose a PDF or photo up to 5 MB");
    const bytes = raw === null ? null : Buffer.from(raw, "base64");
    const mime = String(req.body.mime ?? "");
    if (bytes && !["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(mime)) fail(400, "Choose a PDF, JPEG, PNG or WebP file");
    if (bytes && !sniff(bytes, mime)) fail(400, "That file is not the PDF or photo it says it is");
    const name = String(req.body.name ?? kind).replace(/[\x00-\x1f/\\]/g, "_").slice(0, 120);
    // Sealed here before anything reaches the database. No keyring, no upload: there is no fallback key.
    const person = id(req.params.person, "Person");
    const sealed = bytes ? seal(await requireKeyring("upload"), bytes, documentContext(v.org, person, kind)) : null;
    const row = (await run(() => c.query("select pulse.identity_document_add($1,$2,$3,$4,$5,$6,$7,$8,$9) id",
      [person, kind, masked, bytes ? mime : null, bytes ? name : null, bytes?.length ?? null, sealed?.keyId ?? null, sealed?.dataKey ?? null, sealed?.data ?? null]))).rows[0];
    return { id: row.id, masked };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/onboarding/documents/:id/file", async (req, reply) => {
    // The database decides and logs the access; the file is opened here in the same transaction, so a file that
    // cannot be opened leaves no "opened" entry behind.
    const file = await tx(req, async (c, v) => {
      notDevice(v);
      const row = (await run(() => c.query("select * from pulse.identity_document_read($1)", [id(req.params.id, "Document")]))).rows[0];
      if (!row) return null;
      const ring = await requireKeyring("open");
      if (!row.key_id) throw new DocumentKeyError("This file is waiting to be re-encrypted. HR: ask the Pulse administrator to run the document re-encryption.", "legacy");
      return { name: row.name as string, mime: row.mime as string, bytes: open(ring, { keyId: row.key_id, dataKey: row.data_key, data: row.sealed }, documentContext(v.org, row.person_id, row.kind)) };
    });
    if (!file) return fail(404, "Document unavailable");
    return sendFile(reply, file, true);
  });
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/onboarding/documents/:id/check", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v);
    await run(() => c.query("select pulse.identity_document_check($1,$2,$3)", [id(req.params.id, "Document"), req.body.ok === true, String(req.body.note ?? "")]));
    return { ok: true };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/onboarding/documents/:id/remove", req => tx(req, async (c, v) => {
    notDevice(v);
    await run(() => c.query("select pulse.identity_document_remove($1)", [id(req.params.id, "Document")]));
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/onboarding/proposals/:id", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v);
    if (typeof req.body.accept !== "boolean") fail(400, "Accept or reject");
    return (await run(() => c.query("select pulse.profile_proposal_decide($1,$2) r", [id(req.params.id, "Proposal"), req.body.accept]))).rows[0].r;
  }));

  // ----------------------------------------------------------------------------------------- HR: Onboard team
  app.get("/api/v0/hr/onboard", req => tx(req, async (c, v) => {
    if (!hr(v)) fail(403, "For HR and leadership");
    const people = (await run(() => c.query("select pulse.onboarding_roster() r"))).rows[0].r;
    const kinds = (await c.query("select kind,label,required,id_number \"idNumber\",sort,active from pulse.onboarding_document_kind order by sort,kind")).rows;
    return { people, kinds, settings: await settings(c), sendEnabled: process.env.PULSE_GMAIL_SEND_ENABLED === "1", canEdit: !!v.person && ["admin", "hr"].includes(v.role), filesReady: (await loadKeyring()).ok };
  }));
  app.post<{ Body: Body }>("/api/v0/hr/onboard/nudge", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v);
    if (!v.person || !["admin", "hr"].includes(v.role)) fail(403, "HR nudges");
    const kind = String(req.body.kind ?? "");
    if (!["checkin", "profile", "bank"].includes(kind)) fail(400, "Nudge to check in, to finish the profile or to add bank details");
    const ids = Array.isArray(req.body.personIds) ? (req.body.personIds as unknown[]).slice(0, 200).map(x => id(x, "Person")) : fail(400, "Choose people");
    let sent = 0;
    for (const who of ids) if ((await run(() => c.query("select pulse.onboarding_nudge($1,$2) id", [who, kind]))).rows[0].id) sent++;
    return { sent, skipped: ids.length - sent };
  }));
  app.post<{ Body: Body }>("/api/v0/hr/onboard/kinds", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v);
    if (!v.person || !["admin", "hr"].includes(v.role)) fail(403, "HR chooses which documents to ask for");
    await c.query("select pulse.onboarding_defaults()");
    const rows = Array.isArray(req.body.kinds) ? req.body.kinds as Body[] : fail(400, "Send the list");
    if (rows.length > 12) fail(400, "Ask for up to 12 documents");
    for (const [i, k] of rows.entries()) {
      const kind = String(k.kind ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+/, "").slice(0, 32) || `doc_${i + 1}`;
      const label = String(k.label ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (label.length < 2) fail(400, "Each document needs a name");
      await run(() => c.query(`insert into pulse.onboarding_document_kind(org_id,kind,label,required,sort,active) values($1,$2,$3,$4,$5,$6)
        on conflict(org_id,kind) do update set label=excluded.label,required=excluded.required,sort=excluded.sort,active=excluded.active`,
        [v.org, /^[a-z]/.test(kind) ? kind : `d_${kind}`, label, k.required !== false, (i + 1) * 10, k.active !== false]));
    }
    return { kinds: (await c.query("select kind,label,required,id_number \"idNumber\",sort,active from pulse.onboarding_document_kind order by sort,kind")).rows };
  }));
}

/** The first bytes must agree with the declared type: a renamed executable is not a "PDF". */
export function sniff(b: Buffer, mime: string) {
  if (mime === "application/pdf") return b.subarray(0, 5).toString("latin1") === "%PDF-";
  if (mime === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === "image/png") return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === "image/webp") return b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}
