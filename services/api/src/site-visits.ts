// EST-2284: staff access to persisted visits; validate only after sign-in and the HR guard.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { UUID } from "./erp-model.js";
import { fail, work, type Tx } from "./routes.js";

const id = (value: string) => UUID.test(value) ? value : fail(404, "Site visit or customer unavailable");
function body(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail(400, "Check the site-visit fields");
  return value as Record<string, unknown>;
}
function notes(value: unknown, max: number): string {
  if (typeof value !== "string" || [...value].length > max) fail(400, "Check the site-visit notes length");
  return value as string;
}
async function read(c: PoolClient, visitId: string) {
  const visit = (await c.query("select * from pulse.site_visit where id=$1", [visitId])).rows[0];
  if (!visit) fail(404, "Site visit or customer unavailable");
  const fieldNotes = (await c.query("select field_key,notes from pulse.site_visit_field_note where visit_id=$1 order by field_key", [visitId])).rows;
  const history = (await c.query("select * from pulse.site_visit_history where visit_id=$1 order by at desc,id desc", [visitId])).rows;
  return { visit, fieldNotes, history };
}
export function registerSiteVisits(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Params: { id: string } }>("/api/v0/customers/:id/site-visits", req => tx(req, async (c, v) => {
    work(v);
    const customer = (await c.query("select pulse.site_visit_prefill($1) v", [id(req.params.id)])).rows[0].v;
    if (!customer) fail(404, "Site visit or customer unavailable");
    const visits = (await c.query("select * from pulse.site_visit where customer_id=$1 order by created_at desc,id desc", [req.params.id])).rows;
    return { customer, visits };
  }));
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v0/customers/:id/site-visits", req => tx(req, async (c, v) => {
    work(v);
    const customerId = id(req.params.id), b = body(req.body, ["typeKey", "assignedPersonId", "notes"]);
    if (typeof b.typeKey !== "string" || !/^[a-z0-9_]{1,40}$/.test(b.typeKey)) fail(400, "Choose a visit type");
    if (b.assignedPersonId !== undefined && (typeof b.assignedPersonId !== "string" || !UUID.test(b.assignedPersonId))) fail(400, "Choose a visit assignee");
    const visitId = (await c.query("select pulse.site_visit_create($1,$2,$3,$4) id", [customerId, b.typeKey, b.assignedPersonId ?? null, notes(b.notes === undefined ? "" : b.notes, 4000)])).rows[0].id;
    return read(c, visitId);
  }));
  app.get<{ Params: { id: string } }>("/api/v0/site-visits/:id", req => tx(req, async (c, v) => {
    work(v); return read(c, id(req.params.id));
  }));
  app.put<{ Params: { id: string }; Body: unknown }>("/api/v0/site-visits/:id/notes", req => tx(req, async (c, v) => {
    work(v);
    const visitId = id(req.params.id), b = body(req.body, ["notes"]);
    await c.query("select pulse.site_visit_notes_save($1,$2)", [visitId, notes(b.notes, 4000)]);
    return read(c, visitId);
  }));
  app.put<{ Params: { id: string; key: string }; Body: unknown }>("/api/v0/site-visits/:id/fields/:key/notes", req => tx(req, async (c, v) => {
    work(v);
    const visitId = id(req.params.id), b = body(req.body, ["notes"]);
    if (!/^[a-z0-9_]{1,40}$/.test(req.params.key)) fail(400, "Choose a starting visit field");
    await c.query("select pulse.site_visit_field_note_save($1,$2,$3)", [visitId, req.params.key, notes(b.notes, 2000)]);
    return read(c, visitId);
  }));
}
