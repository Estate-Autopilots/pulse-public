// R50: the disabled coach seam (migration 0380, contract coach.v1 in coach-contract.ts). Everyone signed in reads
// whether the coach is on and the published contract; admins set the company's configuration; HR and admins ask about
// one current staff member for one internal job, read what was sent and answered, and accept or reject each cited
// suggestion. It answers only when the server sets PULSE_COACH=1 and an admin turned it on; the only provider is
// Pulse's deterministic stub. The packet is built by the database, never taken from the caller; the provider is asked
// outside any transaction. Owner errands E08/E16 keep a real coach closed (docs/ops/COACH.md).
import type { FastifyInstance } from "fastify";
import { fail, type Tx } from "./routes.js";
import { notDevice, reviewer, run, signedIn } from "./ats.js";
import { ACTIVATION_GATES, COACH_CONTRACT, KINDS, PROVIDERS, REQUEST_FIELDS, askCoach, checkEvidence, coachServerOn, evidenceSchema, suggestionsSchema,
  type Outcome } from "./coach-contract.js";

type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (raw: unknown, what = "Record") => UUID.test(String(raw ?? "")) ? String(raw) : fail(404, `${what} not found`);
const str = (x: unknown, max: number) => typeof x === "string" ? x.trim().slice(0, max) : "";
const body = { type: "object", maxProperties: 20 } as const;
const num = (x: unknown, what: string) => typeof x === "number" ? x : typeof x === "string" && /^\d{1,5}$/.test(x) ? Number(x) : fail(400, `Give a number for "${what}"`);

export function registerCoachRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  /** Whether the coach answers here, and why not: the server switch, the company's configuration, the open gates. */
  app.get("/api/v0/coach/status", req => tx(req, async (c, v) => {
    signedIn(v);
    const s = (await run(() => c.query("select pulse.coach_status() s"))).rows[0].s;
    const server = coachServerOn(), tenant = s.tenant.state === "enabled";
    const why = [...(server ? [] : ["The coach is off on this server (PULSE_COACH)"]), ...(tenant ? [] : ["The coach is off for this company"])];
    return { ...s, server, state: server && tenant ? "enabled" : "disabled", why, providers: Object.keys(PROVIDERS), gates: ACTIVATION_GATES, automated: true };
  }));
  /** The published contract: what a coach may receive and answer, and what a reviewer sends. */
  app.get("/api/v0/coach/contract", req => tx(req, async (_c, v) => {
    signedIn(v);
    return { contract: COACH_CONTRACT, request: { fields: REQUEST_FIELDS, purpose: "internal_job_fit" }, evidence: evidenceSchema, suggestions: suggestionsSchema,
      kinds: KINDS, never: ["names, person or job ids, e-mail addresses", "job titles, purposes and notes", "who verified a skill",
        "attendance, presence, leave", "pay, payslips, compensation", "chats and WhatsApp history", "app activity, credit, notifications",
        "contact details and private profile fields", "document or file contents"] };
  }));
  app.post<{ Body: Body }>("/api/v0/coach/config", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); signedIn(v);
    if (!(await c.query("select pulse.viewer_is('admin') ok")).rows[0].ok) fail(403, "Admins configure the coach");
    const b = req.body;
    const p = { state: str(b.state, 10), provider: str(b.provider, 20) || "stub", timeoutMs: num(b.timeoutMs, "timeoutMs"), maxSuggestions: num(b.maxSuggestions, "maxSuggestions") };
    return { version: (await run(() => c.query("select pulse.coach_configure($1,$2) v", [JSON.stringify(p), str(b.reason, 300)]))).rows[0].v };
  }));

  /** Exactly what a coach would receive about this person for this job (also while the coach is off); nothing is kept. */
  app.get<{ Querystring: { jobId?: string; personId?: string } }>("/api/v0/coach/preview", req => tx(req, async (c, v) => {
    await reviewer(c, v);
    const evidence = (await run(() => c.query("select pulse.coach_evidence($1,$2) e", [id(req.query.jobId, "Job"), id(req.query.personId, "Person")]))).rows[0].e;
    return { evidence, valid: checkEvidence(evidence).ok };
  }));
  /** Ask the company's coach. Only the job and the person are taken from the caller; any other field is refused. */
  app.post<{ Body: Body }>("/api/v0/coach/requests", { schema: { body } }, async req => {
    const opened = await tx(req, async (c, v) => {
      notDevice(v); await reviewer(c, v);
      const extra = Object.keys(req.body).filter((k) => !(REQUEST_FIELDS as readonly string[]).includes(k));
      if (extra.length) fail(400, `Not part of the coach contract: ${extra.slice(0, 5).join(", ")}`);
      if (req.body.purpose !== undefined && req.body.purpose !== "internal_job_fit") fail(400, "The coach answers about internal jobs only");
      if (!coachServerOn()) fail(409, "The coach is off on this server");
      return (await run(() => c.query("select pulse.coach_request_open($1,$2) r", [id(req.body.jobId, "Job"), id(req.body.personId, "Person")]))).rows[0].r as
        { id: string; evidence: unknown; provider: string; timeoutMs: number; maxSuggestions: number };
    });
    const checked = checkEvidence(opened.evidence), provider = PROVIDERS[opened.provider];
    const outcome: Outcome = !checked.ok ? { status: "failed", failure: checked.failure, version: provider?.version ?? "none", latencyMs: 0 }
      : !provider ? { status: "failed", failure: "error", version: "none", latencyMs: 0 }
      : await askCoach(provider, checked.packet, { timeoutMs: opened.timeoutMs, max: opened.maxSuggestions });
    const finish = (o: Outcome, failure?: string) => tx(req, async c => {
      await run(() => c.query("select pulse.coach_request_finish($1,$2,$3,$4,$5,$6)", [opened.id, o.status, o.version, o.latencyMs,
        failure ?? (o.status === "failed" ? o.failure : null), o.status === "answered" ? JSON.stringify(o.suggestions) : null]));
    });
    // The database checks the answer again; if it refuses, the request ends as failed (the answer is not kept).
    try { await finish(outcome); }
    catch (e) { if (outcome.status !== "answered") throw e; await finish({ status: "failed", failure: "error", version: outcome.version, latencyMs: outcome.latencyMs }, "refused"); }
    return tx(req, async c => (await run(() => c.query("select pulse.coach_request_read($1) r", [opened.id]))).rows[0].r);
  });
  app.get<{ Querystring: { jobId?: string } }>("/api/v0/coach/requests", req => tx(req, async (c, v) => {
    await reviewer(c, v);
    const job = req.query.jobId ? id(req.query.jobId, "Job") : null;
    return { requests: (await run(() => c.query("select pulse.coach_requests($1) r", [job]))).rows[0].r };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/coach/requests/:id", req => tx(req, async (c, v) => {
    await reviewer(c, v);
    return (await run(() => c.query("select pulse.coach_request_read($1) r", [id(req.params.id, "Request")]))).rows[0].r;
  }));
  /** A reviewer's decision on one suggestion, with a reason. Accepting does nothing else. */
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/coach/suggestions/:id/decide", { schema: { body } }, req => tx(req, async (c, v) => {
    notDevice(v); await reviewer(c, v);
    const decision = req.body.decision === "accept" ? "accepted" : req.body.decision === "reject" ? "rejected" : fail(400, "Accept or reject");
    await run(() => c.query("select pulse.coach_decide($1,$2,$3)", [id(req.params.id, "Suggestion"), decision, str(req.body.note, 300)]));
    return { ok: true };
  }));
}
