// R49: explainable internal job matching (migration 0370) on R48's skills. HR and admins describe a job's required
// and preferred skills; Pulse reads each active staff member's skills, verifications and approved work and says, per
// requirement, matched, unknown or missing, with every contribution and the published weights; a reviewer picks
// people (only after HR accepts the weights) or asks someone to check what Pulse read. Every rule is in the database;
// these routes validate shapes and pass refusals on in the database's own words. No external applicants (E16).
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, type Tx, type Viewer } from "./routes.js";

type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (raw: unknown, what = "Record") => UUID.test(String(raw ?? "")) ? String(raw) : fail(404, `${what} not found`);
const str = (x: unknown, max: number) => typeof x === "string" ? x.trim().slice(0, max) : "";
const body = { type: "object", maxProperties: 20 } as const;
/** A whole number from JSON or a form field ("3"); empty stays empty. */
const whole = (x: unknown) => x === null || x === undefined || x === "" ? "" : typeof x === "number" || (typeof x === "string" && /^\d{1,3}$/.test(x)) ? Number(x) : fail(400, "Use a whole number");
const WEIGHTS = ["required", "preferred", "verified", "approvedWork", "self", "close", "notRecent"] as const;

/** The database's refusals in its own words (the generic error handler would replace them). */
export async function run<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "42501") fail(403, err.message ?? "Not allowed");
    if (err.code === "22023" || err.code === "22P02" || err.code === "23514") fail(400, err.message ?? "Check the details");
    if (err.code === "P0002") fail(404, err.message ?? "Not found");
    if (err.code === "40001" || err.code === "23505" || err.code === "55000") fail(409, err.message ?? "Changed meanwhile: look again");
    throw e;
  }
}
export const notDevice = (v: Viewer) => { if (v.nativeDevice) fail(403, "Open Pulse to do this"); };
export const signedIn = (v: Viewer) => { if (!v.person) fail(403, "Internal jobs need your own sign-in"); };
/** HR and admins review matches (the database checks again). */
export const reviewer = async (c: PoolClient, v: Viewer) => {
  signedIn(v);
  if (!(await c.query("select pulse.viewer_is('hr','admin') ok")).rows[0].ok) fail(403, "Internal jobs are for HR and admins");
};

export function registerAtsRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // ---------------------------------------------------------------------------------------------- the method
  /** Published to everyone signed in: the weights in force, earlier versions and HR's acceptances. */
  app.get("/api/v0/ats/method", req => tx(req, async (c, v) => {
    signedIn(v);
    return (await run(() => c.query("select pulse.ats_method() m"))).rows[0].m;
  }));
  app.post<{ Body: Body }>("/api/v0/ats/weights", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); await reviewer(c, v);
    const w = (req.body.weights ?? {}) as Body;
    const weights = Object.fromEntries(WEIGHTS.map((k) => [k, typeof w[k] === "number" ? w[k] : typeof w[k] === "string" && /^\d{1,2}(\.\d{1,2})?$/.test(w[k] as string) ? Number(w[k]) : fail(400, `Give a number for "${k}"`)]));
    const row = (await run(() => c.query("select pulse.ats_weights_set($1,$2) v", [JSON.stringify(weights), str(req.body.reason, 300)]))).rows[0];
    return { version: row.v };
  }));
  app.post<{ Body: Body }>("/api/v0/ats/accept", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); signedIn(v);
    if (!(await c.query("select pulse.viewer_is('hr') ok")).rows[0].ok) fail(403, "HR accepts the matching method");
    const version = whole(req.body.version);
    if (version === "") fail(400, "Look at the weights again");
    const row = (await run(() => c.query("select pulse.ats_accept($1,$2) id", [version, str(req.body.note, 600)]))).rows[0];
    return { id: row.id };
  }));

  // ------------------------------------------------------------------------------------------------------ jobs
  app.get("/api/v0/ats/jobs", req => tx(req, async (c, v) => {
    await reviewer(c, v);
    return { jobs: (await run(() => c.query("select pulse.ats_jobs() j"))).rows[0].j };
  }));
  app.post<{ Body: Body }>("/api/v0/ats/jobs", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); await reviewer(c, v);
    const b = req.body;
    const p = { title: str(b.title, 120), purpose: str(b.purpose, 1500), status: str(b.status, 10) || "draft" };
    const row = (await run(() => c.query("select pulse.ats_job_save($1,$2) id", [b.id ? id(b.id, "Job") : null, JSON.stringify(p)]))).rows[0];
    return { id: row.id };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/ats/jobs/:id", req => tx(req, async (c, v) => {
    await reviewer(c, v);
    const job = (await run(() => c.query("select pulse.ats_job_read($1) j", [id(req.params.id, "Job")]))).rows[0].j;
    return { ...job, scale: (await c.query("select pulse.skill_rubric_levels() r")).rows[0].r };
  }));
  /** Every active staff member, ranked, with each requirement's outcome and contributions. */
  app.get<{ Params: { id: string } }>("/api/v0/ats/jobs/:id/candidates", req => tx(req, async (c, v) => {
    await reviewer(c, v);
    return (await run(() => c.query("select pulse.ats_candidates($1) c", [id(req.params.id, "Job")]))).rows[0].c;
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/ats/jobs/:id/requirements", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); await reviewer(c, v);
    const b = req.body;
    const also = b.also === undefined || b.also === null || b.also === "" ? [] : Array.isArray(b.also) && b.also.length <= 10 ? b.also.map((x) => id(x, "Skill")) : fail(400, "Up to 10 skills the job accepts as the same");
    const p = { conceptId: id(b.conceptId, "Skill"), importance: str(b.importance, 10), minLevel: whole(b.minLevel), recentMonths: whole(b.recentMonths), also, note: str(b.note, 300) };
    const row = (await run(() => c.query("select pulse.ats_requirement_save($1,$2,$3) id", [id(req.params.id, "Job"), b.id ? id(b.id, "Requirement") : null, JSON.stringify(p)]))).rows[0];
    return { id: row.id };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/ats/requirements/:id/remove", req => tx(req, async (c, v) => {
    notDevice(v); await reviewer(c, v);
    await run(() => c.query("select pulse.ats_requirement_remove($1)", [id(req.params.id, "Requirement")]));
    return { ok: true };
  }));

  // ---------------------------------------------------------------------------------------- picks and checks
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/ats/jobs/:id/picks", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); await reviewer(c, v);
    const row = (await run(() => c.query("select pulse.ats_pick_add($1,$2,$3) id", [id(req.params.id, "Job"), id(req.body.personId, "Person"), str(req.body.note, 300)]))).rows[0];
    return { id: row.id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/ats/picks/:id/withdraw", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); await reviewer(c, v);
    await run(() => c.query("select pulse.ats_pick_withdraw($1,$2)", [id(req.params.id, "Pick"), str(req.body?.note, 300) || null]));
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/ats/jobs/:id/checks", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); await reviewer(c, v);
    const row = (await run(() => c.query("select pulse.ats_check_ask($1,$2,$3,$4) id", [id(req.params.id, "Job"), id(req.body.personId, "Person"),
      id(req.body.requirementId, "Requirement"), str(req.body.question, 500)]))).rows[0];
    return { id: row.id };
  }));
  /** The signed-in person's checks: the question and what Pulse read about them for that one skill. */
  app.get("/api/v0/ats/my-checks", req => tx(req, async (c, v) => {
    signedIn(v);
    const checks = (await run(() => c.query("select pulse.ats_my_checks() c"))).rows[0].c;
    return { checks, scale: (await c.query("select pulse.skill_rubric_levels() r")).rows[0].r, weights: (await c.query("select pulse.ats_method() m")).rows[0].m.current.weights };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/ats/checks/:id/answer", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); signedIn(v);
    await run(() => c.query("select pulse.ats_check_answer($1,$2)", [id(req.params.id, "Check"), str(req.body.answer, 500)]));
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/ats/checks/:id/close", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); await reviewer(c, v);
    await run(() => c.query("select pulse.ats_check_close($1,$2)", [id(req.params.id, "Check"), str(req.body?.note, 300) || null]));
    return { ok: true };
  }));
}
