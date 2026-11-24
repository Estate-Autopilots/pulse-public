// WL-FINANCE-CLEAN (Willow Lane's owner, 20 Nov 2026: "Yes, add archive"): archive a quotation (kept, and left out of every
// list, total, pipeline and AI read), optionally as superseded by the live quotation that replaces it; unarchive puts it
// back as it was. The database decides who and what (2495_quote_archive.sql: Billing's writers who see every deal; never
// an invoice, never a quotation that became one) and logs each step; these routes only carry the request.
import type { FastifyInstance } from "fastify";
import { UUID } from "./erp-model.js";
import { fail, type Tx } from "./routes.js";

type Body = { note?: unknown; supersededBy?: unknown };
const quote = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : fail(404, "Quotation not found"));
const note = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 500) : "");

export function registerErpArchiveRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Querystring: { limit?: string } }>("/api/v0/erp/documents/archived", (req) => tx(req, async (c) => {
    const limit = Math.min(Math.max(Number.parseInt(String(req.query?.limit ?? "200"), 10) || 200, 1), 1000);
    return { documents: (await c.query("select pulse.erp_archived_list($1) r", [limit])).rows[0].r };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/archive", (req) => tx(req, async (c) => {
    const b = req.body ?? {};
    const by = b.supersededBy === undefined || b.supersededBy === null || b.supersededBy === "" ? null
      : typeof b.supersededBy === "string" && UUID.test(b.supersededBy) ? b.supersededBy : fail(400, "Choose the live quotation that replaces it");
    return (await c.query("select pulse.erp_document_archive($1,$2,$3) r", [quote(req.params.id), note(b.note), by])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/unarchive", (req) => tx(req, async (c) =>
    (await c.query("select pulse.erp_document_unarchive($1,$2) r", [quote(req.params.id), note(req.body?.note) || null])).rows[0].r));
}
