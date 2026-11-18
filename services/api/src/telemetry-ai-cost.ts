// TOKENS-TELEMETRY (owner, 17 Nov 2026: "1 million tokens is not enough for anything ... each time it gets cheaper and
// cheaper"): what AI employees cost, per kind of work and per AI employee, and the rules that do work without a model.
//   GET  /api/v0/telemetry/ai-cost?days=30   leadership: pulse.ai_cost_report (model runs + rule/skill decisions per task
//        type and day, rupees where a price is set, each AI employee against its daily budget, the waste counters, rules)
//   POST /api/v0/telemetry/ai-rules          admins: turn a built-in rule off or on ({key, on, note}); audited
//   POST /api/v0/agent/decisions             an AI employee's runtime (its key): something done without a model call
// TOKENS-2 (2280): the read adds `router` (pulse.ai_router_report: runs per router class and week, on the strongest model,
// escalated, rupees per kind of work, the patterns); an admin approves a pattern with ai-rules {key, on: true}.
// The database decides (2270_ai_cost_down.sql); row security keeps every read inside the viewer's company.
import type { FastifyInstance } from "fastify";
import { agentTxFor } from "./agents.js";
import { admin, fail, leadership, type Open, type Tx } from "./routes.js";

type Body = Record<string, unknown>;
const KEY = /^[a-z][a-z0-9_:.@/-]{0,119}$/;
const body = { type: "object" } as const;

/** The decision the runtime sends, kept to the shapes ai_decision_note reads. */
export function decisionNote(b: Body) {
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.min(Math.round(x), 100000000) : undefined);
  const s = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");
  const taskType = s(b.taskType, 60), ruleKey = s(b.ruleKey, 120), route = s(b.route, 10) || "rule";
  if (!/^[a-z][a-z0-9_.-]{0,59}$/.test(taskType)) fail(400, "Name the kind of work (taskType)");
  if (!KEY.test(ruleKey)) fail(400, "Name the rule or skill (ruleKey)");
  if (!["rule", "skill", "skip", "cache"].includes(route)) fail(400, "route is rule, skill, skip or cache");
  return { taskType, route, ruleKey, tokens: n(b.tokens), savedEst: n(b.savedEst), outcome: ["done", "error", "skipped"].includes(s(b.outcome, 10)) ? s(b.outcome, 10) : "done",
    runId: s(b.runId, 40) || undefined, subjectId: s(b.subjectId, 40) || undefined, dedupe: s(b.dedupe, 200) || undefined };
}

/** TOKENS-2 (2280): look for work done the same way again and again (candidates for an admin's review), at most every
 *  6 hours per company and per API process; never fails the request it rides on. */
const scanned = new Map<string, number>();
export async function patternScan(c: { query: (q: string, a?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) {
  const org = String((await c.query("select pulse.current_org() o")).rows[0]?.o ?? "");
  if (!org || Date.now() - (scanned.get(org) ?? 0) < 6 * 3600 * 1000) return null;
  scanned.set(org, Date.now());
  await c.query("savepoint pattern_scan");
  try { const r = (await c.query("select pulse.ai_pattern_scan(14) r")).rows[0]?.r; await c.query("release savepoint pattern_scan"); return r; }
  catch { await c.query("rollback to savepoint pattern_scan"); return null; }
}

export function registerTelemetryAiCostRoutes(app: FastifyInstance, { open, tx }: { open: Open; tx: Tx }) {
  const agentTx = agentTxFor(open);
  app.get("/api/v0/telemetry/ai-cost", (request) => tx(request, async (c, v) => {
    if (!leadership(v)) fail(403, "Leadership access required");
    const d = Number((request.query as Record<string, string | undefined>).days ?? 30);
    const days = Number.isInteger(d) && d >= 1 && d <= 120 ? d : 30;
    const report = (await c.query("select pulse.ai_cost_report($1) r", [days])).rows[0].r;
    // TOKENS-2 (2280): the model router (runs per class and week, cost per kind of work) and the patterns waiting for review.
    await patternScan(c);
    return { ...report, router: (await c.query("select pulse.ai_router_report($1) r", [days])).rows[0].r, canReview: admin(v) };
  }));
  app.post<{ Body: Body }>("/api/v0/telemetry/ai-rules", { schema: { body } }, (request) => tx(request, async (c, v) => {
    if (!admin(v)) fail(403, "Only an admin can turn an AI rule on or off");
    const key = typeof request.body.key === "string" ? request.body.key.trim() : "";
    if (!KEY.test(key)) fail(400, "Choose a rule");
    if (typeof request.body.on !== "boolean") fail(400, "Say on: true or false");
    const note = typeof request.body.note === "string" ? request.body.note.trim().slice(0, 300) : null;
    return (await c.query("select pulse.ai_heuristic_set($1,$2,$3) r", [key, request.body.on, note])).rows[0].r;
  }));
  app.post<{ Body: Body }>("/api/v0/agent/decisions", { schema: { body } }, (request) => agentTx(request, async (c) =>
    (await c.query("select pulse.ai_decision_note($1) r", [JSON.stringify(decisionNote(request.body))])).rows[0].r));
}
