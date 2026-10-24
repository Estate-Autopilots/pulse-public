// PEOPLE-CONTACTS part 2 (owner, 11 Oct 2026): "My info" on a person's profile, for the person themself and HR.
// Personal details and documents come from the onboarding record (pulse.onboarding_state), bank details from
// pulse.bank_state (the person and HR only), and requests for what HR approves (a new name, a different date of birth)
// from pulse.profile_change. Every rule is in the database (migration 0211); these routes validate, seal and shape.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { bankContext, loadKeyring, open, requireKeyring } from "./document-keys.js";
import { lookupIfsc } from "./ifsc.js";
import { fail, type Tx, type Viewer } from "./routes.js";

type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (raw: unknown, what = "Record") => UUID.test(String(raw ?? "")) ? String(raw) : fail(404, `${what} not found`);
/** The database's refusals in its own words (the generic error handler would replace them). */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "42501") fail(403, err.message ?? "Not allowed");
    if (err.code === "22023" || err.code === "22P02" || err.code === "23514") fail(400, err.message ?? "Check the details");
    if (err.code === "P0002") fail(404, err.message ?? "Not found");
    throw e;
  }
}
const notDevice = (v: Viewer) => { if (v.nativeDevice) fail(403, "Open Pulse to do this"); };

export function registerPeopleInfoRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const body = { type: "object", maxProperties: 20 } as const;
  const staffOnly = async (c: PoolClient, person: string) => {
    if (!(await c.query("select 1 from pulse.person where id=$1 and side='staff'", [person])).rows[0]) fail(404, "Person not found");
  };

  /** Everything "My info" shows, for the person or HR (the database refuses everyone else and logs HR's reads). */
  app.get<{ Params: { id: string } }>("/api/v0/people/:id/info", req => tx(req, async (c, v) => {
    const person = id(req.params.id, "Person"); await staffOnly(c, person);
    if (!v.person) fail(403, "My info needs your own sign-in");
    // pulse.onboarding_state refuses anyone but the person, HR, leadership and admins (and logs HR's reads).
    const state = (await run(() => c.query("select pulse.onboarding_state($1) s", [person]))).rows[0].s;
    const can = (await c.query(`select pulse.bank_can_see($1) bank,pulse.viewer_is('admin','hr') decide`, [person])).rows[0];
    const profile = (await c.query(`select pp.about,pp.pronouns,pp.languages,pp.phone "workPhone",pp.email "workEmail",pp.skills from pulse.people_profile pp where pp.person_id=$1`, [person])).rows[0] ?? {};
    const bank = can.bank ? (await run(() => c.query("select pulse.bank_state($1) b", [person]))).rows[0].b : null;
    const changes = (await c.query(`select x.id,x.field,x.old_value "from",x.new_value "to",x.note,x.status,x.requested_at "requestedAt",x.decided_at "decidedAt",
      x.decision_note "decisionNote",d.display_name "decidedBy" from pulse.profile_change x left join pulse.person d on d.id=x.decided_by
      where x.person_id=$1 and (x.status='pending' or x.decided_at>now()-interval '30 days') order by x.requested_at desc limit 10`, [person])).rows;
    return { ...state, profile, bankDetails: bank, changes, self: person === v.person, filesReady: (await loadKeyring()).ok,
      can: { edit: person === v.person || ["admin", "hr"].includes(v.role), bank: !!can.bank, decide: !!can.decide && person !== v.person, request: person === v.person } };
  }));

  /** About, pronouns, languages: the person (or HR); each change is in the record's history. */
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/people/:id/info", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); const person = id(req.params.id, "Person");
    if (!v.person || (person !== v.person && !["admin", "hr"].includes(v.role))) fail(403, "Your own profile, or HR");
    const data: Body = {};
    if ("about" in req.body) data.about = String(req.body.about ?? "").replace(/[ \t]+/g, " ").trim().slice(0, 400);
    if ("pronouns" in req.body) data.pronouns = String(req.body.pronouns ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
    if ("languages" in req.body) data.languages = (Array.isArray(req.body.languages) ? req.body.languages : String(req.body.languages ?? "").split(","))
      .map((x) => String(x).replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8);
    if (!Object.keys(data).length) fail(400, "Nothing to save");
    await run(() => c.query("select pulse.profile_info_save($1,$2)", [person, data]));
    return { ok: true };
  }));

  // ------------------------------------------------------------------------------------------------- bank details
  /** The bank and branch an IFSC names (public reference data). */
  app.get<{ Params: { code: string } }>("/api/v0/ifsc/:code", req => tx(req, async () => lookupIfsc(String(req.params.code).slice(0, 20))));

  /** The full account number and UPI ID, opened here for the person or for HR paying salaries. Each one is logged. */
  app.post<{ Params: { id: string } }>("/api/v0/people/:id/bank/reveal", req => tx(req, async (c, v) => {
    notDevice(v); const person = id(req.params.id, "Person");
    if (!(await c.query("select pulse.bank_can_see($1) ok", [person])).rows[0].ok) fail(403, "Bank details are for the person and HR");
    const row = (await run(() => c.query("select key_id,data_key,sealed from pulse.bank_sealed($1)", [person]))).rows[0];
    if (!row) fail(404, "No bank details are on file");
    const ring = await requireKeyring("open");
    const account = JSON.parse(open(ring, { keyId: row.key_id, dataKey: row.data_key, data: row.sealed }, bankContext(v.org, person)).toString("utf8"));
    return { holder: account.holder ?? null, bank: account.bank ?? null, branch: account.branch ?? null, ifsc: account.ifsc ?? null, account: account.account ?? null, upi: account.upi ?? null };
  }));
  /** HR checks a change the person made (never their own). */
  app.post<{ Params: { id: string } }>("/api/v0/people/:id/bank/confirm", req => tx(req, async (c, v) => {
    notDevice(v); const person = id(req.params.id, "Person");
    return (await run(() => c.query("select pulse.bank_confirm($1) b", [person]))).rows[0].b;
  }));

  // ------------------------------------------------------------------------------- what HR approves: name, birth date
  app.post<{ Body: Body }>("/api/v0/me/changes", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v);
    if (!v.person) fail(403, "Sign in with your own account");
    const field = String(req.body.field ?? "");
    if (!["name", "dob"].includes(field)) fail(400, "Ask to change your name or your date of birth");
    const value = String(req.body.value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (field === "dob" && !(/^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value)) fail(400, "Check the date of birth");
    const row = (await run(() => c.query("select pulse.profile_change_request($1,$2,$3) id", [field, value, String(req.body.note ?? "").slice(0, 300)]))).rows[0];
    return { id: row.id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/profile-changes/:id", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v);
    if (!v.person || !["admin", "hr"].includes(v.role)) fail(403, "HR approves changes to a record");
    if (typeof req.body.approve !== "boolean") fail(400, "Approve or decline");
    await run(() => c.query("select pulse.profile_change_decide($1,$2,$3)", [id(req.params.id, "Request"), req.body.approve, String(req.body.note ?? "").slice(0, 300)]));
    return { ok: true };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/profile-changes/:id/withdraw", req => tx(req, async (c, v) => {
    notDevice(v);
    await run(() => c.query("select pulse.profile_change_withdraw($1)", [id(req.params.id, "Request")]));
    return { ok: true };
  }));
}
