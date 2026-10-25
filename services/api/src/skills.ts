// R48: structured skills and the internal CV (migration 0360). A person picks skills from the approved taxonomy or
// HR's local list, with a level on the scale, since/last used and links to work that is theirs; their manager, pod
// head or HR marks what they saw, separately; the person reviews the CV others may read. Every rule is in the database
// (who reads, who writes, who verifies, versions, access log); these routes validate shapes and pass refusals on in
// the database's own words. Taxonomy imports are the operator's (pulse_workers.skill_taxonomy, owner errand E16).
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { cvFileName, cvMarkdown, type CvBody } from "./skills-model.js";
import { fail, type Tx, type Viewer } from "./routes.js";
import { moduleOff, readModules } from "./modules.js";

type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (raw: unknown, what = "Record") => UUID.test(String(raw ?? "")) ? String(raw) : fail(404, `${what} not found`);
const str = (x: unknown, max: number) => typeof x === "string" ? x.trim().slice(0, max) : "";
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const month = (x: unknown) => x === null || x === undefined || x === "" ? "" : MONTH.test(String(x)) ? String(x) : fail(400, "Use a month like 2026-10");
const ids = (x: unknown, max: number) => Array.isArray(x) && x.length <= max && x.every((v) => UUID.test(String(v))) ? x.map(String) : fail(400, "Choose from the list");
const body = { type: "object", maxProperties: 20 } as const;
/** A whole number from JSON or a form field ("3"). */
const whole = (x: unknown) => typeof x === "number" || (typeof x === "string" && /^\d{1,3}$/.test(x)) ? Number(x) : NaN;

/** The database's refusals in its own words (the generic error handler would replace them). */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "42501") fail(403, err.message ?? "Not allowed");
    if (err.code === "22023" || err.code === "22P02" || err.code === "23514") fail(400, err.message ?? "Check the details");
    if (err.code === "P0002") fail(404, err.message ?? "Not found");
    if (err.code === "40001" || err.code === "23505") fail(409, err.message ?? "Changed meanwhile: look again");
    throw e;
  }
}
const notDevice = (v: Viewer) => { if (v.nativeDevice) fail(403, "Open Pulse to do this"); };
const signedIn = (v: Viewer) => { if (!v.person) fail(403, "Skills need your own sign-in"); };
/** The person's own profile and CV (the database checks again). */
const own = (v: Viewer, person: string) => { signedIn(v); if (person !== v.person) fail(403, "Only the person changes their own skills and CV"); return person; };
/** HR and admins look after the list and the scale (the database checks again). */
const curator = async (c: PoolClient, v: Viewer) => {
  signedIn(v);
  if (!(await c.query("select pulse.viewer_is('hr','admin') ok")).rows[0].ok) fail(403, "HR and admins look after the skills list");
};

export function registerSkillRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // ------------------------------------------------------------------------------------------------- the list
  /** Search the approved taxonomy and HR's local skills (with each source's licence and attribution). */
  app.get<{ Querystring: { q?: string } }>("/api/v0/skills/catalog", req => tx(req, async (c, v) => {
    signedIn(v);
    return (await run(() => c.query("select pulse.skill_catalog($1,20) c", [str(req.query.q, 80)]))).rows[0].c;
  }));
  /** HR and admins: imported versions with their provenance, the scale, and the local skills and names. */
  app.get("/api/v0/skills/setup", req => tx(req, async (c, v) => {
    await curator(c, v);
    const sources = (await c.query(`select family,version,language,file_name "fileName",file_sha256 "fileSha256",data_licence "dataLicence",software_licence "softwareLicence",
      attribution,adapted,source_url "sourceUrl",slice,approval_ref "approvalRef",counts,imported_at "importedAt",superseded_at "supersededAt"
      from pulse.skill_source order by family,language,imported_at desc`)).rows;
    const local = (await c.query(`select c.id,c.label,c.description,c.created_at "createdAt",p.display_name "createdBy" from pulse.skill_concept c
      left join pulse.person p on p.id=c.created_by where c.family='local' order by c.label limit 500`)).rows;
    const names = (await c.query(`select t.id,t.label,t.language,c.id "conceptId",c.label "skill",c.family,p.display_name "createdBy",t.created_at "createdAt"
      from pulse.skill_term t join pulse.skill_concept c on c.id=t.concept_id left join pulse.person p on p.id=t.created_by
      where t.kind='local' and t.withdrawn_at is null order by c.label,t.label limit 500`)).rows;
    const rubric = (await c.query("select pulse.skill_rubric_levels() r")).rows[0].r;
    return { sources, local, names, rubric };
  }));
  app.post<{ Body: Body }>("/api/v0/skills/local", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); await curator(c, v);
    const row = (await run(() => c.query("select pulse.skill_local_add($1,$2) id", [str(req.body.label, 80), str(req.body.description, 400) || null]))).rows[0];
    return { id: row.id };
  }));
  app.post<{ Body: Body }>("/api/v0/skills/names", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); await curator(c, v);
    const row = (await run(() => c.query("select pulse.skill_alias_add($1,$2,$3) id", [id(req.body.conceptId, "Skill"), str(req.body.label, 80), str(req.body.language, 3) || "en"]))).rows[0];
    return { id: row.id };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/skills/names/:id/withdraw", req => tx(req, async (c, v) => {
    notDevice(v); await curator(c, v);
    await run(() => c.query("select pulse.skill_alias_withdraw($1)", [id(req.params.id, "Name")]));
    return { ok: true };
  }));
  app.post<{ Body: Body }>("/api/v0/skills/scale", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); await curator(c, v);
    const levels = Array.isArray(req.body.levels) && req.body.levels.length <= 5 ? req.body.levels.map((l) => ({ label: str((l as Body)?.label, 40), description: str((l as Body)?.description, 400) }))
      : fail(400, "A scale has 3 to 5 levels");
    await run(() => c.query("select pulse.skill_rubric_set($1)", [JSON.stringify(levels)]));
    return { ok: true };
  }));

  // ------------------------------------------------------------------------------------------- a person's skills
  /** The profile: skills with their linked work and verification, experience, the scale and attribution. */
  app.get<{ Params: { id: string } }>("/api/v0/people/:id/skills", req => tx(req, async (c, v) => {
    signedIn(v);
    const p = (await run(() => c.query("select pulse.skill_profile($1) p", [id(req.params.id, "Person")]))).rows[0].p;
    // RELEASE-5: internal jobs (R49) has its own switch; the tab links to it and mentions it only when it is on.
    return { ...p, jobs: !moduleOff(await readModules(c, v.org), "jobs") };
  }));
  /** Work the signed-in person may link to a skill or an experience entry. */
  app.get<{ Querystring: { q?: string } }>("/api/v0/skills/my-work", req => tx(req, async (c, v) => {
    signedIn(v);
    return (await c.query("select pulse.skill_work_options($1) w", [str(req.query.q, 80) || null])).rows[0].w ?? { tasks: [], projects: [] };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/people/:id/skills", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); const person = own(v, id(req.params.id, "Person"));
    const b = req.body; const p: Body = { level: Number.isInteger(whole(b.level)) ? whole(b.level) : fail(400, "Choose a level from the scale"),
      since: month(b.since), lastUsed: month(b.lastUsed), note: str(b.note, 300) };
    if ("evidence" in b) {
      if (!Array.isArray(b.evidence) || b.evidence.length > 12) fail(400, "Link up to 12 pieces of work");
      p.evidence = (b.evidence as Body[]).map((e) => ({ kind: ["task", "project", "experience"].includes(String(e?.kind)) ? String(e.kind) : fail(400, "Link a task, an RE project or an experience entry"), id: id(e?.id, "Work") }));
    }
    const row = (await run(() => c.query("select pulse.skill_claim_save($1,$2,$3) id", [person, id(b.conceptId, "Skill"), JSON.stringify(p)]))).rows[0];
    return { id: row.id };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/skills/claims/:id/remove", req => tx(req, async (c, v) => {
    notDevice(v); signedIn(v);
    await run(() => c.query("select pulse.skill_claim_remove($1)", [id(req.params.id, "Skill")]));
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/skills/claims/:id/verify", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); signedIn(v);
    const version = whole(req.body.version), level = whole(req.body.level);
    if (!Number.isInteger(version) || !Number.isInteger(level)) fail(400, "Choose the level you saw");
    const row = (await run(() => c.query("select pulse.skill_verify($1,$2,$3,$4) id", [id(req.params.id, "Skill"), version, level, str(req.body.note, 300) || null]))).rows[0];
    return { id: row.id };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/skills/verifications/:id/withdraw", req => tx(req, async (c, v) => {
    notDevice(v); signedIn(v);
    await run(() => c.query("select pulse.skill_verify_withdraw($1)", [id(req.params.id, "Verification")]));
    return { ok: true };
  }));

  // ----------------------------------------------------------------------------------------------- experience
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/people/:id/experience", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); const person = own(v, id(req.params.id, "Person"));
    const b = req.body;
    const p = { title: str(b.title, 120), projectId: b.projectId ? id(b.projectId, "RE project") : "", started: month(b.started), ended: month(b.ended),
      responsibilities: str(b.responsibilities, 1500), outcomes: str(b.outcomes, 1500) };
    const row = (await run(() => c.query("select pulse.experience_save($1,$2,$3) id", [person, b.id ? id(b.id, "Entry") : null, JSON.stringify(p)]))).rows[0];
    return { id: row.id };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/skills/experience/:id/remove", req => tx(req, async (c, v) => {
    notDevice(v); signedIn(v);
    await run(() => c.query("select pulse.experience_remove($1)", [id(req.params.id, "Entry")]));
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/skills/experience/:id/confirm", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); signedIn(v);
    const version = whole(req.body.version);
    if (!Number.isInteger(version)) fail(400, "Look at the entry again");
    await run(() => c.query("select pulse.experience_confirm($1,$2,$3)", [id(req.params.id, "Entry"), version, str(req.body.note, 300) || null]));
    return { ok: true };
  }));

  // ---------------------------------------------------------------------------------------------------- the CV
  /** The person: the draft and their last reviewed version. Others: the reviewed version only (a logged read). */
  app.get<{ Params: { id: string } }>("/api/v0/people/:id/cv", req => tx(req, async (c, v) => {
    signedIn(v);
    const person = id(req.params.id, "Person");
    const read = (await run(() => c.query("select pulse.resume_read($1,'view') r", [person]))).rows[0].r;
    const draft = read.self ? (await run(() => c.query("select pulse.resume_draft($1) d", [person]))).rows[0].d : null;
    return { ...read, draft };
  }));
  /** The person previews a choice (what to include, headline, summary) without keeping it. */
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/people/:id/cv/preview", { schema: { body } }, req => tx(req, async (c, v) => {
    const person = own(v, id(req.params.id, "Person"));
    const b = req.body;
    const p = { headline: str(b.headline, 120), summary: str(b.summary, 1200), skills: ids(b.skills, 100), experience: ids(b.experience, 50) };
    return (await run(() => c.query("select pulse.resume_draft($1,$2) d", [person, JSON.stringify(p)]))).rows[0].d;
  }));
  /** The person keeps exactly the CV they read (its SHA-256) as the version others may read. */
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/people/:id/cv", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); const person = own(v, id(req.params.id, "Person"));
    const b = req.body;
    const p = { headline: str(b.headline, 120), summary: str(b.summary, 1200), skills: ids(b.skills, 100), experience: ids(b.experience, 50),
      sha256: /^[0-9a-f]{64}$/.test(String(b.sha256)) ? String(b.sha256) : fail(400, "Read the CV before keeping it") };
    return (await run(() => c.query("select pulse.resume_review($1,$2) r", [person, JSON.stringify(p)]))).rows[0].r;
  }));
  /** The reviewed CV as a Markdown file (logged as an export when someone else downloads it). */
  app.get<{ Params: { id: string } }>("/api/v0/people/:id/cv/export", async (req, reply) => {
    const out = await tx(req, async (c, v) => {
      signedIn(v);
      const read = (await run(() => c.query("select pulse.resume_read($1,'export') r", [id(req.params.id, "Person")]))).rows[0].r;
      if (!read.reviewed) fail(404, "No reviewed CV yet");
      const company = (await c.query("select name from pulse.org where id=pulse.current_org()")).rows[0]?.name ?? "the company";
      const r = read.reviewed as { version: number; reviewedAt: string | Date; body: CvBody };
      const at = r.reviewedAt instanceof Date ? r.reviewedAt.toISOString() : String(r.reviewedAt);
      return { text: cvMarkdown(r.body, { version: r.version, reviewedAt: at, company }), name: cvFileName(r.body.person.name, r.version) };
    });
    reply.header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
      .header("content-disposition", `attachment; filename="${out.name}"`);
    return reply.type("text/markdown; charset=utf-8").send(out.text);
  });
}
