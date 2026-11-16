// KAZUK-GAPS (6 Nov 2026, migration 1853): what was promised to Kazuk and still missing.
//   GET  /api/v0/sales-pipeline?person=        A19: a salesperson's quotations by stage, follow-ups due, won and lost this
//                                              month, and the value still waiting for an answer (pulse.sales_pipeline)
//   GET  /api/v0/drafts                        A12: the viewer's unfinished forms and Billing drafts, newest first
//   GET  /api/v0/drafts/:key                   one unfinished form (null when there is none)
//   POST /api/v0/drafts/:key {title,href,data} keep an unfinished form on the server (any device can resume it)
//   POST /api/v0/drafts/:key/clear             forget it (the form was saved or the person discarded it)
// The CEO screen's money at risk and client-service alerts are read in project-health.ts (pulse.money_at_risk,
// pulse.cs_alerts_today). Pure helpers below are unit-tested (test/kazuk-gaps.test.mjs).
import type { FastifyInstance } from "fastify";
import { fail, work, type Tx, type Viewer } from "./routes.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[a-z][a-z0-9-]{1,80}$/;
const HREF = /^\/[A-Za-z0-9/_?=&%.:-]{0,300}$/;
const MAX_BYTES = 60000;

/** A draft's key, title, link and body, checked before the database checks them again. */
export function draftInput(key: string, body: unknown): { key: string; title: string; href: string; data: Record<string, unknown> } {
  if (!KEY.test(key)) fail(400, "Choose a valid draft");
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const title = typeof b.title === "string" ? b.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160) : "";
  if (!title) fail(400, "Give the draft a name");
  const href = typeof b.href === "string" ? b.href : "";
  if (!HREF.test(href) || href.startsWith("//")) fail(400, "Give the draft a page in Pulse");
  const data = b.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) fail(400, "Nothing to keep");
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_BYTES) fail(413, "This draft is too large to keep");
  return { key, title, href, data: data as Record<string, unknown> };
}

type Money = { count: number; amount: number; items: { id: string; number: string | null; buyer: string | null; amount: number; age: number; why?: string; projectId?: string | null }[] };
export type MoneyAtRisk = { today: string; stallDays: number; atLeast: number; overdue: Money; unbilled: Money; stalled: Money };

/** The CEO screen's question box sends the screen's own numbers with the question, so the AI employee answers from
 *  what the person is looking at and is told it may only read. Pure; at most `max` characters. */
export function screenFacts(x: { projects: number; late: number; waiting: number; blocked: number; money: MoneyAtRisk | null; alerts: number; cs: number; rupees: (paise: number) => string }, max = 900): string {
  const parts = [`${x.projects} active projects`, `${x.late} tasks late`, `${x.waiting} waiting on the client`, `${x.blocked} blocked`];
  if (x.money) {
    const m = x.money;
    parts.push(`overdue invoices ${m.overdue.count} (${x.rupees(m.overdue.amount)})`, `not billed yet ${m.unbilled.count} (${x.rupees(m.unbilled.amount)})`,
      `quotations of ${x.rupees(m.atLeast)} or more with no answer for ${m.stallDays}+ days ${m.stalled.count} (${x.rupees(m.stalled.amount)})`);
  }
  parts.push(`${x.alerts} same-day alerts`, `${x.cs} client issues raised today`);
  const s = `On this screen: ${parts.join("; ")}.`;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const person = (v: Viewer) => { work(v); if (!v.person || v.role === "accountant") fail(403, "Drafts and sales belong to a staff person"); return v.person; };

export function registerKazukGapRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Querystring: { person?: string } }>("/api/v0/sales-pipeline", (req) => tx(req, async (c, v) => {
    person(v);
    const who = req.query.person ? (UUID.test(req.query.person) ? req.query.person : fail(400, "Choose a person")) : null;
    return (await c.query("select pulse.sales_pipeline($1) s", [who])).rows[0].s;
  }));
  app.get("/api/v0/drafts", (req) => tx(req, async (c, v) => {
    const me = person(v);
    const items = (await c.query(`select key,title,href,updated_at "updatedAt" from pulse.form_draft where person_id=$1 and updated_at>now()-interval '30 days'
      order by updated_at desc limit 8`, [me])).rows;
    // Billing drafts the person started or last touched (only for those who may open Billing, where a draft opens).
    const reader = (await c.query("select pulse.erp_can(false) ok")).rows[0].ok as boolean;
    const billing = reader ? (await c.query(`select d.id,d.doc_type "docType",d.number,coalesce(nullif(btrim(d.buyer->>'name'),''),cl.display_name) buyer,d.total,d.updated_at "updatedAt"
      from pulse.erp_document d left join pulse.client cl on cl.org_id=d.org_id and cl.id=d.client_id
      where d.status='draft' and $1 in (d.created_by,d.updated_by,d.salesperson_id) and d.updated_at>now()-interval '30 days' order by d.updated_at desc limit 5`, [me])).rows : [];
    return { items, billing };
  }));
  app.get<{ Params: { key: string } }>("/api/v0/drafts/:key", (req) => tx(req, async (c, v) => {
    const me = person(v);
    if (!KEY.test(req.params.key)) fail(400, "Choose a valid draft");
    return { draft: (await c.query(`select key,title,href,data,updated_at "updatedAt" from pulse.form_draft where person_id=$1 and key=$2`, [me, req.params.key])).rows[0] ?? null };
  }));
  app.post<{ Params: { key: string }; Body: unknown }>("/api/v0/drafts/:key", (req) => tx(req, async (c, v) => {
    const me = person(v);
    const d = draftInput(req.params.key, req.body);
    const r = (await c.query(`insert into pulse.form_draft(org_id,person_id,key,title,href,data) values(pulse.current_org(),$1,$2,$3,$4,$5)
      on conflict(org_id,person_id,key) do update set title=excluded.title,href=excluded.href,data=excluded.data,updated_at=now()
      returning updated_at "updatedAt"`, [me, d.key, d.title, d.href, JSON.stringify(d.data)])).rows[0];
    return { ok: true, updatedAt: r.updatedAt };
  }));
  app.post<{ Params: { key: string } }>("/api/v0/drafts/:key/clear", (req) => tx(req, async (c, v) => {
    const me = person(v);
    if (!KEY.test(req.params.key)) fail(400, "Choose a valid draft");
    await c.query("delete from pulse.form_draft where person_id=$1 and key=$2", [me, req.params.key]);
    return { ok: true };
  }));
}
