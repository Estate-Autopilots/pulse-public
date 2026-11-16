// EST-1542 (owner decision 19 Oct): the private screen where leadership and HR decide who each WhatsApp sender name is
// before group history is imported. Reads and writes go through pulse.chat_names_* (0640), which check the role; names
// sit in pulse_priv and never reach chats, boards or exports. "Most important" are the names seen in 5 or more groups.
// Always on (not the chat_import module), so the matching can finish before imports are switched on.
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FastifyInstance } from "fastify";
import { fail, type Tx } from "./routes.js";

type Body = Record<string, unknown>;
export const CHAT_NAMES_SOURCE = "wp-group-data";
export const IMPORTANT_GROUPS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** EST-1542 B (Pulse CEO, EST-1520 27e32ea8): a load is exactly a list and each entry exactly a name with its message
 *  and group counts. Checked here strictly (Fastify's own body schema would drop extra fields, not refuse them) and again
 *  in chat_names_load (0680), which also refuses a name that is a phone number. */
export const LOAD_SCHEMA = {
  type: "object", additionalProperties: false, required: ["source", "names"],
  properties: {
    source: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,59}$" },
    names: { type: "array", maxItems: 2000, items: { type: "object", additionalProperties: false, required: ["label"], properties: {
      label: { type: "string", minLength: 1, maxLength: 80 },
      messages: { type: "integer", minimum: 0, maximum: 999999999 },
      groups: { type: "integer", minimum: 0, maximum: 999999999 } } } },
  },
} as const;
export const validLoad = new Ajv2020({ allErrors: true, strict: false }).compile(LOAD_SCHEMA);
const source = (x: unknown) => { const s = String(x ?? CHAT_NAMES_SOURCE); return /^[a-z0-9][a-z0-9_-]{0,59}$/.test(s) ? s : fail(400, "Choose a list"); };

type Row = { id: string; label: string; messages: number; groups: number; decision: string | null };
/** Progress: every name, and the most important ones (in IMPORTANT_GROUPS groups or more). */
export function progress(rows: Row[]) {
  const important = rows.filter((r) => r.groups >= IMPORTANT_GROUPS);
  return { total: rows.length, done: rows.filter((r) => r.decision).length, important: important.length, importantDone: important.filter((r) => r.decision).length,
    messages: rows.reduce((n, r) => n + r.messages, 0), messagesDone: rows.filter((r) => r.decision).reduce((n, r) => n + r.messages, 0) };
}

export function registerChatNames(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Querystring: { source?: string } }>("/api/v0/chat-names", (req) => tx(req, async (c, v) => {
    const s = source(req.query.source);
    const rows = (await c.query("select pulse.chat_names_read($1) r", [s])).rows[0].r as Row[];
    const people = (await c.query("select id,display_name name from pulse.person where side='staff' and status='active' order by 2")).rows;
    // EST-1542 B (0680): leadership, HR and admins load names from their own exports on the screen.
    const canLoad = (await c.query("select pulse.chat_names_can_load() ok")).rows[0].ok === true;
    return { source: s, importantGroups: IMPORTANT_GROUPS, rows, people, progress: progress(rows), viewer: v.person, canLoad };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/chat-names/:id", { schema: { body: { type: "object" } } }, (req) => tx(req, async (c) => {
    if (!UUID.test(req.params.id)) fail(404, "Name not found");
    const d = req.body.decision === null ? null : String(req.body.decision ?? "");
    const person = req.body.personId ? String(req.body.personId) : null;
    if (person && !UUID.test(person)) fail(400, "Choose which colleague");
    await c.query("select pulse.chat_name_decide($1,$2,$3)", [req.params.id, d, person]);
    return { ok: true };
  }));
  app.post<{ Body: Body }>("/api/v0/chat-names/load", { schema: { body: { type: "object" } }, bodyLimit: 1_000_000 }, (req) => tx(req, async (c) => {
    // Who may load is answered first (a member gets 403, whatever they send); then the shape (400).
    if ((await c.query("select pulse.chat_names_can_load() ok")).rows[0].ok !== true) fail(403, "Leadership, HR or an admin loads the WhatsApp names");
    if (!validLoad(req.body)) fail(400, "Send only each name with its message and group counts");
    if ((req.body.names as { label: string }[]).some((n) => (n.label.match(/\p{Nd}/gu) ?? []).length >= 7)) fail(400, "Phone numbers are never loaded");
    return (await c.query("select pulse.chat_names_load($1,$2::jsonb) r", [source(req.body.source), JSON.stringify(req.body.names)])).rows[0].r;
  }));
}
