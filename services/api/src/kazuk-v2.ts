// KAZUK-V2 (9 Nov 2026; Kazuk's sales flow version 2, KAZUK-SALES-FLOW-2026-11-06 G12–G14).
//   GET /api/v0/sales-deals?period=&person=&all=1   G12 (R31): negotiation numbers from the filed versions, read only:
//                                                   V1 against the latest price, the discount, versions per deal, days
//                                                   to yes and to paid, the services cut most, deals lost by reason.
//                                                   A salesperson gets their own; all=1 is everyone's for the Sales Head,
//                                                   leadership and Finance (pulse.sales_deals and pulse.sales_sees_team,
//                                                   migration 1930, decide; a salesperson asking for all gets their own).
//   GET  /api/v0/sales-workspace?person=            G13: the one home's deals with their incentive (Not due, Pending,
//                                                   Released), how many projects they sold, whether approval is on
//   GET  /api/v0/sales-neeti?person=&period=        G13 (R45): Neeti / Sales X-Ray numbers, null = "Not recorded", last sync
//   GET  /api/v0/sales-projects?person=&project=    G13 (R42): projects their deals started or joined, read only
//   POST /api/v0/sales-incentive/:id {released,note} G13 (R44): the Sales Head, leadership or Finance releases a paid
//                                                   deal's incentive, or takes it back (pulse.sales_incentive_set, 1931)
// G14, the Sales Agent (1932). Every decision is a typed rule in the database; the agent drafts and never sends.
//   GET  /api/v0/sales-agent/nudges?person=          the reminders with their drafted messages (no reply, overdue, renewal)
//   GET  /api/v0/sales-agent/advice?discount=&amount=&package=   what to offer before a discount; it never blocks
//   POST /api/v0/sales-agent {salesperson}           an admin, leadership or the Sales Head makes a salesperson's agent
//   POST /api/v0/sales-agent/settings {salesperson,noReplyDays,renewalDays}
//   The agent's own tools (its co-worker key; always its own salesperson's records, read only unless it drafts):
//   GET  /api/v0/agent/sales/nudges | how-did-i-do?period= | projects?project= | advice?… | proof?city=&package=
//        | call-prep?lead=;  POST /api/v0/agent/sales/change-order {project,note} (a new draft quotation on the project)
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, work, type Open, type Tx, type Viewer } from "./routes.js";
import { agentTxFor } from "./agents.js";
import { orgZone, zoneDay } from "./org-time.js";
import { periodRange } from "./finance-truth-model.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** "?person=" as the database takes it: null for the viewer's own. */
export function dealsPerson(q: unknown): string | null {
  if (q === undefined || q === null || q === "") return null;
  return typeof q === "string" && UUID.test(q) ? q : fail(400, "Choose a person");
}

export function registerKazukV2Routes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  const agentTx = agentTxFor(open);
  app.get<{ Querystring: { period?: string; from?: string; to?: string; person?: string; all?: string } }>("/api/v0/sales-deals", (req) => tx(req, async (c, v) => {
    work(v);
    if (!v.person || v.role === "accountant") fail(403, "Deals belong to a staff person");
    const today = zoneDay(await orgZone(c)), p = periodRange(req.query.period ?? "month", today, req.query.from, req.query.to);
    const data = (await c.query("select pulse.sales_deals($1,$2,$3,$4) d", [dealsPerson(req.query.person), `${p.from}-01`, `${p.to}-01`, req.query.all === "1"])).rows[0].d as Record<string, unknown>;
    return { period: p.period, ...data };
  }));
  app.get<{ Querystring: { person?: string } }>("/api/v0/sales-workspace", (req) => tx(req, async (c, v) => {
    staff(v);
    return (await c.query("select pulse.sales_workspace($1) h", [dealsPerson(req.query.person)])).rows[0].h;
  }));
  app.get<{ Querystring: { person?: string; period?: string; from?: string; to?: string } }>("/api/v0/sales-neeti", (req) => tx(req, async (c, v) => {
    staff(v);
    const today = zoneDay(await orgZone(c)), p = periodRange(req.query.period ?? "month", today, req.query.from, req.query.to);
    return { period: p.period, ...(await c.query("select pulse.sales_neeti($1,$2,$3) n", [dealsPerson(req.query.person), `${p.from}-01`, `${p.to}-01`])).rows[0].n };
  }));
  app.get<{ Querystring: { person?: string; project?: string } }>("/api/v0/sales-projects", (req) => tx(req, async (c, v) => {
    staff(v);
    return (await c.query("select pulse.sales_sold_projects($1,$2) p", [dealsPerson(req.query.person), dealsPerson(req.query.project)])).rows[0].p;
  }));
  app.post<{ Params: { id: string }; Body: { released?: unknown; note?: unknown } }>("/api/v0/sales-incentive/:id", (req) => tx(req, async (c, v) => {
    staff(v);
    const b = req.body ?? {};
    const released = typeof b.released === "boolean" ? b.released : null;
    const note = typeof b.note === "string" ? b.note.slice(0, 300) : null;
    // Who may (the Sales Head, leadership, Finance) is answered first; pulse.sales_incentive_set checks it again.
    if (!(await c.query("select pulse.viewer_is('sales_head','leadership','admin','finance') ok")).rows[0].ok) fail(403, "Only the Sales Head, leadership or Finance release an incentive");
    if (!UUID.test(req.params.id)) fail(404, "Deal not found");
    if (released === null) fail(400, "Say whether the incentive is released");
    return { incentive: (await c.query("select pulse.sales_incentive_set($1,$2,$3) s", [req.params.id, released, note])).rows[0].s as string };
  }));

  // ---------------------------------------------------------------------------------------------- G14 the Sales Agent
  app.get<{ Querystring: { person?: string } }>("/api/v0/sales-agent/nudges", (req) => tx(req, async (c, v) => {
    staff(v);
    return (await c.query("select pulse.sales_agent_nudges($1,null) n", [dealsPerson(req.query.person)])).rows[0].n;
  }));
  app.get<{ Querystring: AdviceQ }>("/api/v0/sales-agent/advice", (req) => tx(req, async (c, v) => {
    staff(v);
    return advice(c, req.query);
  }));
  app.post<{ Body: { salesperson?: unknown } }>("/api/v0/sales-agent", (req) => tx(req, async (c, v) => {
    staff(v);
    if (!(await c.query("select pulse.viewer_is('admin','leadership','sales_head') ok")).rows[0].ok) fail(403, "An admin, leadership or the Sales Head makes a Sales Agent");
    const sp = dealsPerson(req.body?.salesperson) ?? fail(400, "Choose the salesperson");
    return { agentId: (await c.query("select pulse.sales_agent_create($1) a", [sp])).rows[0].a as string };
  }));
  app.post<{ Body: { salesperson?: unknown; noReplyDays?: unknown; renewalDays?: unknown } }>("/api/v0/sales-agent/settings", (req) => tx(req, async (c, v) => {
    staff(v);
    const b = req.body ?? {};
    const days = (x: unknown, lo: number, hi: number) => (x === undefined || x === null ? null : Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi ? x as number : fail(400, `Give a number of days from ${lo} to ${hi}`));
    return (await c.query("select pulse.sales_agent_settings($1,$2,$3) s", [dealsPerson(b.salesperson) ?? v.person, days(b.noReplyDays, 1, 30), days(b.renewalDays, 7, 120)])).rows[0].s;
  }));
  app.get("/api/v0/agent/sales/nudges", (req) => agentTx(req, async (c) => (await c.query("select pulse.sales_agent_nudges(null,null) n")).rows[0].n));
  app.get<{ Querystring: { period?: string } }>("/api/v0/agent/sales/how-did-i-do", (req) => agentTx(req, async (c) => {
    const today = zoneDay(await orgZone(c)), p = periodRange(req.query.period ?? "month", today);
    return (await c.query("select pulse.sales_how_did_i_do(null,$1,$2) h", [`${p.from}-01`, `${p.to}-01`])).rows[0].h;
  }));
  app.get<{ Querystring: { project?: string } }>("/api/v0/agent/sales/projects", (req) => agentTx(req, async (c) =>
    (await c.query("select pulse.sales_sold_projects(null,$1) p", [dealsPerson(req.query.project)])).rows[0].p));
  app.get<{ Querystring: AdviceQ }>("/api/v0/agent/sales/advice", (req) => agentTx(req, async (c) => advice(c, req.query)));
  app.get<{ Querystring: { city?: string; package?: string } }>("/api/v0/agent/sales/proof", (req) => agentTx(req, async (c) =>
    (await c.query("select pulse.sales_proof($1,$2) p", [words(req.query.city), words(req.query.package)])).rows[0].p));
  app.get<{ Querystring: { lead?: string } }>("/api/v0/agent/sales/call-prep", (req) => agentTx(req, async (c) =>
    (await c.query("select pulse.sales_call_prep($1) p", [dealsPerson(req.query.lead) ?? fail(400, "Choose a lead")])).rows[0].p));
  app.post<{ Body: { project?: unknown; note?: unknown } }>("/api/v0/agent/sales/change-order", (req) => agentTx(req, async (c) => {
    const project = dealsPerson(req.body?.project) ?? fail(400, "Choose the project");
    return { quotationId: (await c.query("select pulse.sales_change_order($1,$2) id", [project, typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : null])).rows[0].id as string };
  }));
}

type AdviceQ = { discount?: string; amount?: string; package?: string };
/** The discount advice's inputs, checked: a percent from 0 to 100, the amount it takes off in paise, the package on it. */
export function adviceInput(q: AdviceQ): [number, number | null, string | null] {
  const pct = Number(q.discount);
  if (q.discount === undefined || q.discount === "" || !Number.isFinite(pct) || pct < 0 || pct > 100) fail(400, "Give the discount as 0 to 100 percent");
  const amount = q.amount === undefined || q.amount === "" ? null : Number(q.amount);
  if (amount !== null && (!Number.isInteger(amount) || amount < 0)) fail(400, "Give the amount in paise");
  return [Math.round(pct * 100) / 100, amount, dealsPerson(q.package)];
}
async function advice(c: PoolClient, q: AdviceQ) {
  return (await c.query("select pulse.sales_discount_advice($1,$2,$3) a", adviceInput(q))).rows[0].a;
}
/** A short search word (a city or a package name), or null. */
const words = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 60) : null);

/** A staff person's own sales (HR-only accounts and accountants are refused). */
function staff(v: Viewer) {
  work(v);
  if (!v.person || v.role === "accountant") fail(403, "This belongs to a staff person");
}
