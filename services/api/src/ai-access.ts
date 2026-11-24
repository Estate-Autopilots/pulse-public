// AI-ACCESS (owner, 23 Nov 2026: "Everyone who connects their Claude gets exactly what they are permitted to do. From one
// account I should manage all of that."): Settings → AI access, the one console. Everyone sees their own connected AI
// apps (every company); an admin also sees, for EACH company their account administers (wherever they opened Settings,
// including their own personal space), every connection that can act there, what it did, the company's AI rules (whole
// company, per role, per person) and the requests waiting for a yes. Every rule and scope is checked by the database
// (migration 2536: ai_access_console, ai_access_policy_set, ai_access_decide, ai_access_revoke, ai_access_log); this file
// only shapes requests. Revoke marks a connection revoked; nothing is deleted.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from './routes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GROUPS = ['read', 'work', 'messages', 'money', 'delete'] as const;
type Body = Record<string, unknown>;
const id = (x: unknown, what: string) => typeof x === 'string' && UUID.test(x) ? x : fail(400, `Choose ${what}`);
const person = (v: Viewer) => { if (!v.person || v.nativeDevice || (v.side && v.side !== 'staff')) fail(403, 'Open AI access in the browser with your staff account'); };
/** The database's own refusals keep their words (42501: not yours; 22023: a bad choice). */
async function db<T>(c: PoolClient, sql: string, args: unknown[]): Promise<T> {
  try { return (await c.query(sql, args)).rows[0]?.v as T; }
  catch (e) {
    const code = (e as { code?: string }).code, message = String((e as Error).message ?? '');
    if (code === '42501') fail(403, message); if (code === '22023') fail(400, message);
    throw e;
  }
}

export function registerAiAccessRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/ai-access', (req) => tx(req, async (c, v) => {
    person(v);
    return { ...await db<Record<string, unknown>>(c, 'select pulse.ai_access_console() v', []), groups: GROUPS };
  }));
  // A rule for the whole company (no roleKey or personId), a role, or one person; clear: true removes that rule.
  app.post<{ Body: Body }>('/api/v0/ai-access/policy', { schema: { body: { type: 'object', maxProperties: 7 } } }, (req) => tx(req, async (c, v) => {
    person(v);
    const b = req.body ?? {};
    if (Object.keys(b).some((k) => !['orgId', 'roleKey', 'personId', 'groups', 'approverId', 'clear'].includes(k))) fail(400, 'Unknown field');
    const org = id(b.orgId, 'a company');
    const role = b.roleKey === undefined || b.roleKey === null ? null : typeof b.roleKey === 'string' && /^[a-z_]{2,40}$/.test(b.roleKey) ? b.roleKey : fail(400, 'Choose a role');
    const who = b.personId === undefined || b.personId === null ? null : id(b.personId, 'a person');
    const approver = b.approverId === undefined || b.approverId === null ? null : id(b.approverId, 'who says yes');
    const clear = b.clear === true;
    const groups = clear ? null : b.groups && typeof b.groups === 'object' && !Array.isArray(b.groups) ? b.groups : fail(400, 'Choose what the AI may do');
    if (groups) for (const [k, x] of Object.entries(groups)) if (!(GROUPS as readonly string[]).includes(k) || !['on', 'ask', 'off'].includes(String(x))) fail(400, 'Each part is on, ask or off');
    const rule = await db<unknown>(c, 'select pulse.ai_access_policy_set($1,$2,$3,$4::jsonb,$5,$6) v', [org, role, who, groups ? JSON.stringify(groups) : null, approver, clear]);
    return { ok: true, rule };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/ai-access/requests/:id', { schema: { body: { type: 'object', maxProperties: 3 } } }, (req) => tx(req, async (c, v) => {
    person(v);
    const b = req.body ?? {};
    if (typeof b.approve !== 'boolean') fail(400, 'Say yes or no');
    const note = typeof b.note === 'string' ? b.note.slice(0, 500) : null;
    return db<unknown>(c, 'select pulse.ai_access_decide($1,$2,$3,$4) v', [id(b.orgId, 'a company'), id(req.params.id, 'a request'), b.approve, note]);
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/ai-access/connections/:id/revoke', { schema: { body: { type: 'object', maxProperties: 1 } } }, (req) => tx(req, async (c, v) => {
    person(v);
    if (!await db<boolean>(c, 'select pulse.ai_access_revoke($1,$2) v', [id(req.body?.orgId, 'a company'), id(req.params.id, 'a connection')])) fail(404, 'That connection has already ended');
    return { ok: true };
  }));
  app.get<{ Params: { id: string }; Querystring: { orgId?: string } }>('/api/v0/ai-access/connections/:id/log', (req) => tx(req, async (c, v) => {
    person(v);
    return db<unknown>(c, 'select pulse.ai_access_log($1,$2) v', [id(req.query.orgId, 'a company'), id(req.params.id, 'a connection')]);
  }));
}
