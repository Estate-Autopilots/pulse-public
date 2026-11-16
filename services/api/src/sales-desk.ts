// KAZUK-REST (6 Nov 2026, migration 1711; Kazuk's backlog A19): a salesperson's desk on My sales.
//   GET /api/v0/sales-desk?person=   their leads (Pulse enquiries and Sales X-Ray leads) by stage, their calls of the last
//                                    14 days with outcomes, follow-ups due today, and quotations waiting for approval
// Another person's desk is for leadership and Finance (decided in the database, pulse.sales_desk).
import type { FastifyInstance } from "fastify";
import { fail, work, type Tx } from "./routes.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** "?person=" as the database takes it: null for the viewer's own desk. */
export function deskPerson(q: unknown): string | null {
  if (q === undefined || q === null || q === "") return null;
  return typeof q === "string" && UUID.test(q) ? q : fail(400, "Choose a person");
}

export function registerSalesDeskRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Querystring: { person?: string } }>("/api/v0/sales-desk", (req) => tx(req, async (c, v) => {
    work(v);
    if (!v.person || v.role === "accountant") fail(403, "A sales desk belongs to a staff person");
    return (await c.query("select pulse.sales_desk($1) d", [deskPerson(req.query.person)])).rows[0].d;
  }));
}
