// PULSE-ADMIN (owner, 27 Oct 2026): Pulse's back office for its platform admins (the owner), apart from each
// organisation's Settings: organisations (status, plan and limits, members, switches), people across organisations
// (sign-in help and a read-only, audited "view as"), usage and AI tokens, the platform audit log, system health and
// announcements. Every route asks the database first (pulse.platform_admin(): an individual admin of the install's own
// organisation named in pulse_priv.platform_admin) and every pulse.platform_* function checks again itself (1140).
// Requests are checked for access before their input, so everyone else gets the same 403 whatever they send.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from './routes.js';
import { platformConfig } from './platform-config.js';

type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = (x: unknown, what: string) => (typeof x === 'string' && UUID.test(x) ? x : fail(404, `${what} not found`));
const text = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const body = { type: 'object' } as const;
export const PLANS = ['trial', 'starter', 'growth', 'scale', 'internal', 'custom'] as const;
export const PERSON_ACTIONS = ['sign_out', 'unlock', 'reset', 'disable', 'enable'] as const;
const FLAG_KINDS = ['company', 'module', 'org-only'] as const;

/** Refuses anyone who is not a platform admin (403), before anything else about the request is read. */
async function platform(c: PoolClient, v: Viewer) {
  const ok = !!v.person && v.role === 'admin' && (await c.query<{ ok: boolean }>('select pulse.platform_admin() ok')).rows[0].ok;
  if (!ok) fail(403, 'Only Pulse’s platform admins use the admin console');
}

/** A limit field: empty clears it; otherwise a whole number in range. */
function limit(x: unknown, min: number, max: number, what: string): string | null {
  if (x === null || x === '' || x === undefined) return null;
  const n = typeof x === 'number' ? x : Number(String(x).replace(/[,_\s]/g, ''));
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${what}: a whole number from ${min.toLocaleString('en-IN')} to ${max.toLocaleString('en-IN')}`);
  return String(n);
}

/** What the organisation settings form may change, checked and shaped for pulse.platform_org_set. */
export function orgChange(b: Body): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ('status' in b) { if (!['active', 'suspended'].includes(String(b.status))) fail(400, 'Choose active or suspended'); out.status = b.status; }
  if ('plan' in b) { if (!(PLANS as readonly string[]).includes(String(b.plan))) fail(400, 'Choose a plan'); out.plan = b.plan; }
  if ('seatLimit' in b) out.seatLimit = limit(b.seatLimit, 1, 100_000, 'Seats');
  if ('aiTokensMonth' in b) out.aiTokensMonth = limit(b.aiTokensMonth, 1_000, 100_000_000_000, 'AI tokens a month');
  if ('trialEnds' in b) {
    const d = b.trialEnds === null || b.trialEnds === '' ? null : String(b.trialEnds);
    if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(d)) fail(400, 'Trial ends: a date like 2026-12-31');
    out.trialEnds = d;
  }
  if ('note' in b) out.note = text(b.note, 400) || null;
  if (!Object.keys(out).length) fail(400, 'Nothing to change');
  return out;
}

/** A new announcement, checked. */
export function announcement(b: Body) {
  const title = text(b.title, 120);
  if (title.length < 2) fail(400, 'Give the announcement a title');
  const tone = b.tone === undefined || b.tone === '' ? 'info' : String(b.tone);
  if (!['info', 'warning', 'success'].includes(tone)) fail(400, 'Choose info, warning or success');
  const audience = b.audience === undefined || b.audience === '' ? 'everyone' : String(b.audience);
  if (!['everyone', 'admins'].includes(audience)) fail(400, 'Choose everyone or admins');
  const link = text(b.link, 300);
  if (link && !/^(\/[^\s]*|https:\/\/[^\s]+)$/.test(link)) fail(400, 'A link starts with / (a Pulse page) or https://');
  const endsAt = text(b.endsAt, 40);
  if (endsAt && Number.isNaN(Date.parse(endsAt))) fail(400, 'Ends: a date and time');
  if (endsAt && Date.parse(endsAt) <= Date.now()) fail(400, 'Ends: a time in the future');
  return { title, body: text(b.body, 1000) || null, tone, audience, link: link || null, endsAt: endsAt ? new Date(endsAt).toISOString() : null };
}

export function registerPlatformAdminRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const one = async (c: PoolClient, sql: string, args: unknown[]) => (await c.query(sql, args)).rows[0].r;

  // Who runs this Pulse (product, company, support address, domain: all from the server's environment).
  app.get('/api/v0/platform/config', (req) => tx(req, async (c, v) => { await platform(c, v); return platformConfig(); }));

  app.get('/api/v0/platform/orgs', (req) => tx(req, async (c, v) => {
    await platform(c, v);
    return { orgs: await one(c, 'select pulse.platform_orgs() r', []) };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/platform/orgs/:id', (req) => tx(req, async (c, v) => {
    await platform(c, v);
    return one(c, 'select pulse.platform_org($1) r', [uuid(req.params.id, 'Organisation')]);
  }));
  // { status?, plan?, seatLimit?, aiTokensMonth?, trialEnds?, note?, reason }
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/platform/orgs/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    await platform(c, v);
    const org = uuid(req.params.id, 'Organisation'); const b = req.body ?? {};
    const { reason, ...rest } = b;
    return { changes: await one(c, 'select pulse.platform_org_set($1,$2,$3) r', [org, JSON.stringify(orgChange(rest)), text(reason, 400)]) };
  }));
  // { flag, kind: company | module | org-only, enabled, reason }
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/platform/orgs/:id/flags', { schema: { body } }, (req) => tx(req, async (c, v) => {
    await platform(c, v);
    const org = uuid(req.params.id, 'Organisation'); const b = req.body ?? {};
    if (!(FLAG_KINDS as readonly string[]).includes(String(b.kind))) fail(400, 'Unknown switch');
    if (typeof b.enabled !== 'boolean') fail(400, 'Say on or off');
    return one(c, 'select pulse.platform_flag_set($1,$2,$3,$4,$5) r', [org, text(b.flag, 30), b.enabled, b.kind, text(b.reason, 400)]);
  }));

  app.get<{ Querystring: { q?: string } }>('/api/v0/platform/people', (req) => tx(req, async (c, v) => {
    await platform(c, v);
    const q = text(req.query.q, 80);
    if (q.length < 2) return { people: [], more: false };
    return one(c, 'select pulse.platform_people($1) r', [q]);
  }));
  // Pulse accounts (one per human across organisations; AUTH-UNIFY owns their schema) with their memberships.
  app.get<{ Querystring: { q?: string } }>('/api/v0/platform/accounts', (req) => tx(req, async (c, v) => {
    await platform(c, v);
    const q = text(req.query.q, 80);
    return { accounts: q.length < 2 ? [] : await one(c, 'select pulse.platform_accounts($1) r', [q]) };
  }));
  app.get<{ Params: { id: string; person: string } }>('/api/v0/platform/orgs/:id/people/:person', (req) => tx(req, async (c, v) => {
    await platform(c, v);
    return one(c, 'select pulse.platform_person($1,$2,null) r', [uuid(req.params.id, 'Organisation'), uuid(req.params.person, 'Person')]);
  }));
  // View as (read-only): what this person's Pulse holds for them, with a reason, audited here and in their organisation.
  app.post<{ Params: { id: string; person: string }; Body: Body }>('/api/v0/platform/orgs/:id/people/:person/view-as', { schema: { body } }, (req) => tx(req, async (c, v) => {
    await platform(c, v);
    return one(c, 'select pulse.platform_person($1,$2,$3) r', [uuid(req.params.id, 'Organisation'), uuid(req.params.person, 'Person'), text(req.body?.reason, 400)]);
  }));
  // { action: sign_out | unlock | reset | disable | enable, reason }
  app.post<{ Params: { id: string; person: string }; Body: Body }>('/api/v0/platform/orgs/:id/people/:person/sign-in', { schema: { body } }, (req) => tx(req, async (c, v) => {
    await platform(c, v);
    const action = String(req.body?.action ?? '');
    if (!(PERSON_ACTIONS as readonly string[]).includes(action)) fail(400, 'Unknown action');
    return one(c, 'select pulse.platform_person_action($1,$2,$3,$4) r', [uuid(req.params.id, 'Organisation'), uuid(req.params.person, 'Person'), action, text(req.body?.reason, 400)]);
  }));

  app.get<{ Querystring: { days?: string } }>('/api/v0/platform/usage', (req) => tx(req, async (c, v) => {
    await platform(c, v);
    const days = Math.min(Math.max(Number.parseInt(String(req.query.days ?? '30'), 10) || 30, 1), 365);
    return one(c, 'select pulse.platform_usage($1) r', [days]);
  }));

  app.get<{ Querystring: { org?: string; action?: string; before?: string } }>('/api/v0/platform/audit', (req) => tx(req, async (c, v) => {
    await platform(c, v);
    const org = req.query.org && UUID.test(req.query.org) ? req.query.org : null;
    const action = req.query.action && /^[a-z_.]{2,40}$/.test(req.query.action) ? req.query.action : null;
    const before = req.query.before && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before).toISOString() : null;
    return { entries: await one(c, 'select pulse.platform_audit_list($1,$2,$3,200) r', [org, action, before]) };
  }));

  app.get('/api/v0/platform/health', (req) => tx(req, async (c, v) => {
    await platform(c, v);
    const db = await one(c, 'select pulse.platform_health() r', []);
    const memory = process.memoryUsage();
    return { ...db, api: { release: process.env.PULSE_RELEASE ?? 'dev', environment: process.env.PULSE_ENVIRONMENT ?? process.env.NODE_ENV ?? null,
      node: process.version, uptimeSeconds: Math.round(process.uptime()), rssBytes: memory.rss, heapBytes: memory.heapUsed,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() } };
  }));

  app.get('/api/v0/platform/announcements', (req) => tx(req, async (c, v) => {
    await platform(c, v);
    return { announcements: await one(c, 'select pulse.platform_announcements() r', []) };
  }));
  app.post<{ Body: Body }>('/api/v0/platform/announcements', { schema: { body } }, (req) => tx(req, async (c, v) => {
    await platform(c, v);
    return { id: await one(c, 'select pulse.platform_announce($1) r', [JSON.stringify(announcement(req.body ?? {}))]) };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/platform/announcements/:id/end', (req) => tx(req, async (c, v) => {
    await platform(c, v);
    await c.query('select pulse.platform_announce_end($1)', [uuid(req.params.id, 'Announcement')]);
    return { ok: true };
  }));

  // Every signed-in person: the platform's live announcements for them (the banner above every page).
  app.get('/api/v0/platform-notices', (req) => tx(req, async (c, v) => ({
    notices: v.person ? await one(c, 'select pulse.platform_notices() r', []) : [],
  })));
}
