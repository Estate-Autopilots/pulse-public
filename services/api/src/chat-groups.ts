// CHAT-GROUPS (owner report EA #4, 28 Oct 2026; built 22 Nov 2026): team chat groups by category, who may make them, who
// adds people and who posts inside a group, admin roles, requests for a group, the company's categories and a project's
// group. The database decides every rule (migration 2530); these routes pass the person's request through.
//   POST /api/v0/chats/groups/:id/settings     {category?, icon?, colour?, adders?, posting?} a group's settings
//   POST /api/v0/chats/groups/:id/admins       {personId, admin} make a member an admin, or take it back
//   GET  /api/v0/chats/group-requests          my requests (30 days) and the ones waiting on me
//   POST /api/v0/chats/group-requests          {name, description?, memberIds?, category?, icon?, colour?, note?} ask for a group
//   POST /api/v0/chats/group-requests/:id      {approve: true|false, note?} or {withdraw: true}
//   GET  /api/v0/chats/group-policy            the company's "who may make groups" and categories (Settings → Chats)
//   POST /api/v0/chats/group-policy            {creators: leaders|managers|everyone} (admins and leadership)
//   POST /api/v0/chats/categories              {id?, name?, icon?, colour?, archived?} the company's own categories
//   GET  /api/v0/chats/bugs-group              Bugs and support for Report a bug (null for client seats)
//   POST /api/v0/projects/:id/group            a project's group: the linked team chat, else a new one (never a second)
// New groups (POST /api/v0/chats/groups) and the list's group facts live in chats.ts beside the routes they extend.
import type { FastifyInstance } from 'fastify';
import { fail, work, type Tx, type Viewer } from './routes.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 20 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (raw: unknown, what = 'conversation') => (UUID.test(String(raw)) ? String(raw) : fail(400, `Choose a valid ${what}`));
const member = (v: Viewer) => { if (!v.person) fail(403, 'Chats requires your individual employee account'); };
const SETTINGS = ['category', 'icon', 'colour', 'adders', 'posting'] as const;

/** A group's settings and a new group's fields from a request body: only the known keys, as text. */
export function groupFields(b: Body): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of SETTINGS) if (k in b) out[k] = b[k] === null ? null : String(b[k]).slice(0, 40);
  return out;
}
/** People's ids from a request body (up to 256, each a uuid). */
export function personIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 256) fail(400, 'Choose up to 256 people');
  return [...new Set((raw as unknown[]).map((x) => id(x, 'person')))];
}
/** The body of a new group or a request for one (chat_group_new / chat_group_request_file). */
export function newGroupBody(b: Body): Record<string, unknown> {
  return { name: String(b.name ?? ''), description: String(b.description ?? '').slice(0, 300), members: personIds(b.memberIds), ...groupFields(b),
    ...(typeof b.note === 'string' ? { note: b.note.slice(0, 300) } : {}) };
}

export function registerChatGroupRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/chats/groups/:id/settings', { schema: { body } }, req => tx(req, async (c, v) => {
    member(v);
    return (await c.query('select pulse.chat_group_meta_set($1,$2) r', [id(req.params.id), JSON.stringify(groupFields(req.body ?? {}))])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/chats/groups/:id/admins', { schema: { body } }, req => tx(req, async (c, v) => {
    member(v);
    await c.query('select pulse.chat_group_admin_set($1,$2,$3)', [id(req.params.id), id(req.body?.personId, 'person'), req.body?.admin === true]);
    return { ok: true };
  }));
  app.get('/api/v0/chats/group-requests', req => tx(req, async (c, v) => {
    member(v);
    return { requests: (await c.query('select pulse.chat_group_requests() r')).rows[0].r };
  }));
  app.post<{ Body: Body }>('/api/v0/chats/group-requests', { schema: { body } }, req => tx(req, async (c, v) => {
    member(v);
    return (await c.query('select pulse.chat_group_request_file($1) r', [JSON.stringify(newGroupBody(req.body ?? {}))])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/chats/group-requests/:id', { schema: { body } }, req => tx(req, async (c, v) => {
    member(v); const rid = id(req.params.id, 'request'); const b = req.body ?? {};
    if (b.withdraw === true) return (await c.query('select pulse.chat_group_request_withdraw($1) r', [rid])).rows[0].r;
    if (typeof b.approve !== 'boolean') fail(400, 'Approve or decline');
    return (await c.query('select pulse.chat_group_request_decide($1,$2,$3) r', [rid, b.approve, typeof b.note === 'string' ? b.note.slice(0, 300) : null])).rows[0].r;
  }));
  app.get('/api/v0/chats/group-policy', req => tx(req, async (c, v) => {
    member(v);
    const r = (await c.query(`select pulse.chat_group_creators() creators, pulse.chat_categories() categories, pulse.chat_group_may_create() "canCreate",
        (select pulse.chat_viewer_leads()) "canChange", gp.changed_at "changedAt", p.display_name "changedBy",
        (select count(*)::int from pulse.chat_group_request r where r.status = 'pending') pending
      from (select 1) x left join pulse.chat_group_policy gp on true left join pulse.person p on p.id = gp.changed_by`)).rows[0];
    return r;
  }));
  app.post<{ Body: Body }>('/api/v0/chats/group-policy', { schema: { body } }, req => tx(req, async (c, v) => {
    member(v);
    await c.query('select pulse.chat_group_policy_set($1)', [String(req.body?.creators ?? '')]);
    return (await c.query('select pulse.chat_group_creators() creators, pulse.chat_group_may_create() "canCreate"')).rows[0];
  }));
  app.post<{ Body: Body }>('/api/v0/chats/categories', { schema: { body } }, req => tx(req, async (c, v) => {
    member(v); const b = req.body ?? {}; const p: Record<string, unknown> = {};
    for (const k of ['id', 'name', 'icon', 'colour'] as const) if (typeof b[k] === 'string') p[k] = (b[k] as string).slice(0, 60);
    if (typeof b.archived === 'boolean') p.archived = b.archived;
    const made = (await c.query('select pulse.chat_category_set($1) r', [JSON.stringify(p)])).rows[0].r;
    return { category: made, categories: (await c.query('select pulse.chat_categories() r')).rows[0].r };
  }));
  // Report a bug asks whether this person may post into Bugs and support (staff of this company; made the first time).
  app.get('/api/v0/chats/bugs-group', req => tx(req, async (c, v) => {
    if (!v.person || v.side === 'client') return { group: null };
    const gid = (await c.query('select pulse.chat_bugs_group_ensure() g')).rows[0]?.g ?? null;
    return { group: gid ? { id: gid, name: 'Bugs and support' } : null };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/projects/:id/group', req => tx(req, async (c, v) => {
    member(v); work(v);   // as every project route: an HR-only account has no Work area
    return (await c.query('select pulse.chat_project_group($1) r', [id(req.params.id, 'project')])).rows[0].r;
  }));
}
