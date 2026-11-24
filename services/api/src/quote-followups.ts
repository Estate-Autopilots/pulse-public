// EST-1238: a sent quotation's follow-up, for its salesperson (or anyone who reads ERP): when it is next due, its task,
// and the customer's answer. The database decides who may see or answer it (0520_quote_followups.sql); the minute tick
// in the notification worker makes the tasks and notices.
import type { FastifyInstance } from "fastify";
import { UUID } from "./erp-model.js";
import { fail, type Tx } from "./routes.js";

type Answer = { action?: unknown; outcome?: unknown; note?: unknown };
const ACTIONS = ["replied", "later", "close"];
const OUTCOMES = ["converted", "not_interested", "lost", "other"];

export function registerQuoteFollowupRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const quote = (v: string) => (UUID.test(v) ? v : fail(404, "No follow-up for this quotation"));
  // FIX-BILLING (BC-024, 19 Nov 2026): most quotations have no follow-up (a draft, one never marked sent, or not the
  // viewer's), so "none" is an empty answer (JSON null; the panel shows nothing), not a 404 counted as a failed call.
  app.get<{ Params: { id: string } }>("/api/v0/quotes/:id/follow-up", (req) => tx(req, async (c) =>
    (await c.query("select pulse.erp_followup_view($1) v", [quote(req.params.id)])).rows[0].v ?? null));
  // QUOTE-FIXES (2500): Home's quote cards: this person's next follow-ups and their quotations not sent yet.
  app.get("/api/v0/quotes/follow-ups", (req) => tx(req, async (c) =>
    (await c.query("select pulse.erp_quote_home() v")).rows[0]?.v ?? { followUps: [], notSent: 0 }));
  app.post<{ Params: { id: string }; Body: Answer }>("/api/v0/quotes/:id/follow-up", (req) => tx(req, async (c) => {
    const b = req.body ?? {};
    const action = ACTIONS.includes(String(b.action)) ? String(b.action) : fail(400, "Choose replied, call later or close");
    const outcome = action !== "close" ? null : OUTCOMES.includes(String(b.outcome)) ? String(b.outcome) : fail(400, "Choose how it ended");
    const note = typeof b.note === "string" ? b.note.trim().slice(0, 500) || null : null;
    return (await c.query("select pulse.erp_followup_answer($1,$2,$3,$4) v", [quote(req.params.id), action, outcome, note])).rows[0].v;
  }));
}
