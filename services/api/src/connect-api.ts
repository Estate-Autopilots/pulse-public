// PULSE-ID: the data API apps call with a Pulse access token (docs/architecture/PULSE_IDENTITY_AND_DATA_API.md §7-8),
// at discovery's pulse_org_api_base = {issuer}/api/v1/connect. AC's contract (members, webhooks, the link, work
// signals) exactly, plus the Pulse extensions (clients and contacts, leads and calls written in, money per client).
//  * One bearer token and nothing else; pulse.oidc_principal decides who it is, in which organisation, with which
//    scopes, and sets the organisation (and, for a personal connection, the member) for row security. {org_id} must be
//    the connection's own organisation. On a company's own address only that company's connections answer.
//  * Writes by an org link (leads, calls) run as the admin who allowed it: client rows are an admin's under row security.
//  * 120 calls a minute per connection; every call is logged (operation, status, time; never content).
//  * Webhooks: a minute tick turns what changed into signed deliveries (X-Pulse-Signature: t=…,v1=HMAC-SHA256(secret,
//    "t.body")), retried for 24 hours; secrets are sealed with the document keyring.
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { loadKeyring, open as unseal, seal, type Sealed } from './document-keys.js';
import { OutboundError, safeOutbound } from './safe-outbound.js';
import { sessionHash, type Open, type Viewer } from './routes.js';
import { hostCompany } from './tenant-context.js';
import { budget, limitHeaders, type Budget } from './v1-limits.js';
import { oidcIssuer, oidcOn } from './oidc.js';
import { pictureSignatureOk, pictureUrl, signingKeys } from './oidc-keys.js';
import { applyPushedLead, savePushedCall } from './sales-xray-sync.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUB = /^[0-9a-f]{32}$/;
type Principal = { grant: string; app: string; appName: string; clientId: string; kind: 'personal' | 'org'; org: string; person: string | null; member: string | null; scopes: string[] };
class Refusal extends Error { constructor(readonly status: number, readonly error: string, readonly description?: string, readonly scope?: string) { super(error); } }
const refuse = (status: number, error: string, description?: string, scope?: string): never => { throw new Refusal(status, error, description, scope); };
const one = async <T>(c: PoolClient, sql: string, args: unknown[]): Promise<T> => (await c.query(sql, args)).rows[0]?.r as T;
type Box = { k: string; w: string; d: string };
const box = (s: Sealed): Box => ({ k: s.keyId, w: s.dataKey.toString('base64'), d: s.data.toString('base64') });
const unbox = (b: Box): Sealed => ({ keyId: b.k, dataKey: Buffer.from(b.w, 'base64'), data: Buffer.from(b.d, 'base64') });
const hookContext = (org: string, grant: string) => `${org}/${grant}/connect-webhook`;

/** An opaque cursor: the last id of the page (lists are in id order). */
export const cursorOut = (id: string) => Buffer.from(JSON.stringify({ a: id })).toString('base64url');
export function cursorIn(raw: unknown): string | null {
  if (raw === undefined || raw === '') return null;
  try { const a = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')).a; if (typeof a === 'string' && UUID.test(a)) return a; } catch { /* below */ }
  return refuse(400, 'invalid_request', 'cursor is not one Pulse gave');
}
const limitOf = (raw: unknown) => { if (raw === undefined || raw === '') return 50; const n = Number(raw); return Number.isInteger(n) && n >= 1 && n <= 100 ? n : refuse(400, 'invalid_request', 'limit is 1 to 100'); };
const sinceOf = (raw: unknown) => { if (raw === undefined || raw === '') return null; const t = Date.parse(String(raw)); return Number.isFinite(t) ? new Date(t).toISOString() : refuse(400, 'invalid_request', 'updated_since is an ISO 8601 time'); };
/** A page of n+1 rows: the first n and the cursor after them. */
export function paged<T extends Record<string, unknown>>(rows: T[], limit: number, idKey: string) {
  const more = rows.length > limit, items = rows.slice(0, limit);
  return { items, next_cursor: more && items.length ? cursorOut(String(items[items.length - 1][idKey])) : null };
}

/** The signature an app checks (AC contract §3): HMAC-SHA256 over "<t>.<raw body>" with the endpoint's secret. */
export const webhookSignature = (secret: string, t: number, body: string) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
/** A webhook address an app may register: https on the standard port, a host name, no credentials or fragment. */
export function hookUrlOk(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 500) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (!u.port || u.port === '443') && !u.username && !u.password && !u.hash && /[a-z]/i.test(u.hostname)
      && !/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(u.hostname);
  } catch { return false; }
}

/** A member as AC's contract shapes it (the photo becomes its signed address). */
type MemberRow = { member: string; sub: string; name: string; email?: string; email_verified: boolean; title?: string; team?: string; photo?: { member: string; version: number };
  role: string; status: string; handle?: string; updated_at: string };

export function registerConnectApi(app: FastifyInstance, { open, pool }: { open: Open; pool: Pool }) {
  const budgets = new Map<string, Budget>();
  const spend = (grant: string) => { let b = budgets.get(grant); if (!b) { if (budgets.size > 4096) budgets.clear(); b = budget(120); budgets.set(grant, b); } return b; };
  const logs = new WeakMap<FastifyRequest, { org: string; grant: string; op: string }>();

  /** The bearer, for one scope, on one transaction; the answer, or a refusal in OAuth's words. */
  async function bearer<T>(req: FastifyRequest, reply: FastifyReply, op: string, scope: string, write: boolean, run: (c: PoolClient, p: Principal) => Promise<T>): Promise<T | FastifyReply> {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    try {
      if (!oidcOn()) refuse(404, 'not_found');
      const m = /^Bearer (pxa_[A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? ''));
      const beside = Object.keys(req.headers).some((h) => ['cookie', 'x-pulse-session', 'x-pulse-client-session', 'x-pulse-agent-key'].includes(h) || h.startsWith('cf-access-'));
      if (!m || beside) refuse(401, 'invalid_token', 'Send one Pulse access token as Authorization: Bearer, and nothing else');
      return await open(async (c) => {
        const p = await one<(Principal & { error?: string }) | null>(c, 'select pulse.oidc_principal($1,$2,$3) r', [sessionHash(m![1]), scope, write]);
        if (!p) refuse(401, 'invalid_token', 'This token is unknown, expired or its connection ended');
        if (p!.error === 'insufficient_scope') refuse(403, 'insufficient_scope', `This connection does not hold ${scope}`, scope);
        if (p!.error === 'no_admin') refuse(409, 'no_admin', 'Nobody can stand behind this write: the admin who linked the organisation is no longer an admin. An admin should link it again.');
        // A company's own address answers for that company only (a session never travels between companies either).
        const host = hostCompany();
        if (host && host.org !== p!.org) refuse(401, 'invalid_token', 'This token belongs to another organisation');
        const params = (req.params ?? {}) as { org_id?: string };
        if (params.org_id !== undefined && params.org_id !== p!.org) refuse(404, 'not_found', 'No such organisation for this connection');
        const b = spend(p!.grant), limited = b(); limitHeaders(reply, b.state());
        if (limited) { reply.header('retry-after', String(b.state().reset)); refuse(429, 'rate_limited', 'At most 120 calls a minute per connection'); }
        logs.set(req, { org: p!.org, grant: p!.grant, op });
        const answer = await run(c, p!);
        // Logged on the call's own transaction when it succeeds; a refusal after this point is logged on its own.
        await c.query('select pulse.connect_log($1,$2,$3,null)', [p!.grant, op, reply.statusCode]);
        logs.delete(req);
        return answer;
      });
    } catch (e) {
      if (e instanceof Refusal) {
        if (e.status === 401 || e.status === 403) reply.header('www-authenticate', `Bearer error="${e.error}"${e.scope ? `, scope="${e.scope}"` : ''}`);
        return reply.code(e.status).send({ error: e.error, ...(e.description ? { error_description: e.description } : {}) });
      }
      const pg = (e as { code?: string; message?: string }).code;
      if (pg === '22023' || pg === '22P02' || pg === '22007' || pg === '22008') return reply.code(400).send({ error: 'invalid_request', error_description: /\s/.test((e as Error).message) ? (e as Error).message : 'Please check the request' });
      if (pg === '42501') return reply.code(403).send({ error: 'insufficient_scope', error_description: (e as Error).message });
      if (pg === '54000') return reply.code(409).send({ error: 'limit_reached', error_description: (e as Error).message });
      throw e;
    }
  }
  app.addHook('onResponse', async (req, reply) => {
    const l = logs.get(req);
    if (!l || reply.statusCode < 400) return;
    const ms = Math.round(reply.elapsedTime);
    const c = await pool.connect().catch(() => null);
    if (!c) return;
    try {
      await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [l.org]);
      await c.query('select pulse.connect_log($1,$2,$3,$4)', [l.grant, l.op, reply.statusCode, ms]); await c.query('commit');
    } catch { await c.query('rollback').catch(() => {}); app.log.warn({ op: l.op }, 'Connect call log failed'); } finally { c.release(); }
  });
  const picture = async (clientId: string, org: string, photo?: { member: string; version: number }) => {
    const keys = await signingKeys(), issuer = oidcIssuer();
    return photo && keys.ok && issuer ? pictureUrl(issuer, keys.keys[0], clientId, org, photo.member, photo.version) : undefined;
  };
  const memberOut = async (p: Principal, m: MemberRow) => {
    const { member: _member, photo, ...rest } = m;
    const pic = await picture(p.clientId, p.org, photo);
    return { ...rest, ...(pic ? { picture: pic } : {}) };
  };
  const PARAMS = { type: 'object', properties: { org_id: { type: 'string', pattern: UUID.source } } } as const;
  const withId = (key: string, pattern: string) => ({ type: 'object', properties: { org_id: { type: 'string', pattern: UUID.source }, [key]: { type: 'string', pattern } } });

  // ----- AC contract §2: members, webhooks, the link -----------------------------------------------------------------
  app.get<{ Params: { org_id: string }; Querystring: Record<string, string> }>('/api/v1/connect/orgs/:org_id/members', { schema: { params: PARAMS } }, (req, reply) =>
    bearer(req, reply, 'members.list', 'pulse.org.read', false, async (c, p) => {
      const limit = limitOf(req.query.limit);
      const r = await one<{ members: MemberRow[] }>(c, 'select pulse.connect_members($1) r', [JSON.stringify({ limit, after: cursorIn(req.query.cursor), updatedSince: sinceOf(req.query.updated_since) })]);
      const { items, next_cursor } = paged(r.members, limit, 'member');
      return { members: await Promise.all(items.map((m) => memberOut(p, m))), next_cursor };
    }));
  app.get<{ Params: { org_id: string; sub: string } }>('/api/v1/connect/orgs/:org_id/members/:sub', { schema: { params: withId('sub', SUB.source) } }, (req, reply) =>
    bearer(req, reply, 'members.get', 'pulse.org.read', false, async (c, p) => {
      const r = await one<{ members: MemberRow[] } | null>(c, 'select pulse.connect_members($1) r', [JSON.stringify({ sub: req.params.sub, limit: 1 })]);
      return r?.members[0] ? memberOut(p, r.members[0]) : refuse(404, 'not_found', 'No such member in this organisation');
    }));
  app.get<{ Params: { org_id: string } }>('/api/v1/connect/orgs/:org_id/webhooks', { schema: { params: PARAMS } }, (req, reply) =>
    bearer(req, reply, 'webhooks.list', 'pulse.org.webhooks', false, async (c) => one(c, "select pulse.connect_hooks('list','{}') r", [])));
  app.post<{ Params: { org_id: string }; Body: { url?: unknown; events?: unknown } }>('/api/v1/connect/orgs/:org_id/webhooks', {
    schema: { params: PARAMS, body: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', maxLength: 500 }, events: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } } } } },
  }, (req, reply) => bearer(req, reply, 'webhooks.add', 'pulse.org.webhooks', false, async (c, p) => {
    if (!hookUrlOk(req.body.url)) refuse(400, 'invalid_request', 'The webhook address must be a public https address on the standard port');
    const ring = await loadKeyring();
    if (!ring.ok) refuse(503, 'temporarily_unavailable', 'Webhook secrets can’t be stored on this Pulse server yet');
    const secret = 'pwhs_' + randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 11);
    const sealed = box(seal((ring as { ring: Parameters<typeof seal>[0] }).ring, Buffer.from(secret), hookContext(p.org, p.grant)));
    const r = await one<{ id: string; events: string[] }>(c, "select pulse.connect_hooks('add',$1) r", [JSON.stringify({ url: req.body.url, events: req.body.events ?? [], secret: sealed })]);
    reply.code(201);
    return { id: r.id, secret, events: r.events };
  }));
  app.delete<{ Params: { org_id: string; id: string } }>('/api/v1/connect/orgs/:org_id/webhooks/:id', { schema: { params: withId('id', UUID.source) } }, (req, reply) =>
    bearer(req, reply, 'webhooks.remove', 'pulse.org.webhooks', false, async (c) => {
      const r = await one<{ id: string } | null>(c, "select pulse.connect_hooks('remove',$1) r", [JSON.stringify({ id: req.params.id })]);
      if (!r) refuse(404, 'not_found', 'No such webhook endpoint');
      reply.code(204); return null;
    }));
  app.delete<{ Params: { org_id: string } }>('/api/v1/connect/orgs/:org_id/link', { schema: { params: PARAMS } }, (req, reply) =>
    bearer(req, reply, 'link.end', 'openid', false, async (c) => { await one(c, 'select pulse.connect_link_end() r', []); reply.code(204); return null; }));

  // ----- AC contract §4: work signals ---------------------------------------------------------------------------------
  app.post<{ Params: { org_id: string }; Body: { items: unknown[] } }>('/api/v1/connect/orgs/:org_id/signals', {
    bodyLimit: 262144, schema: { params: PARAMS, body: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', minItems: 1, maxItems: 500 } } } },
  }, (req, reply) => bearer(req, reply, 'signals.add', 'pulse.signals.write', false, async (c) => one(c, 'select pulse.connect_signals($1) r', [JSON.stringify({ items: req.body.items })])));

  // ----- Pulse extensions: clients, money, leads and calls written in ---------------------------------------------------
  type ClientRow = Record<string, unknown> & { id: string; owner?: { sub: string; name: string } };
  const clientsOf = async (c: PoolClient, q: Record<string, string>) => {
    const limit = limitOf(q.limit);
    const r = await one<{ clients: ClientRow[] }>(c, 'select pulse.connect_clients($1) r', [JSON.stringify({ limit, after: cursorIn(q.cursor), updatedSince: sinceOf(q.updated_since), q: (q.q ?? '').slice(0, 80) })]);
    const { items, next_cursor } = paged(r.clients, limit, 'id');
    return { clients: items, next_cursor };
  };
  app.get<{ Params: { org_id: string }; Querystring: Record<string, string> }>('/api/v1/connect/orgs/:org_id/clients', { schema: { params: PARAMS } }, (req, reply) =>
    bearer(req, reply, 'clients.list', 'pulse.clients.read', false, async (c, p) => p.kind === 'org' ? clientsOf(c, req.query) : refuse(403, 'insufficient_scope', 'A personal connection reads its clients at /me/clients')));
  app.get<{ Querystring: Record<string, string> }>('/api/v1/connect/me/clients', (req, reply) =>
    bearer(req, reply, 'clients.mine', 'pulse.clients.read', false, async (c, p) => p.kind === 'personal' ? clientsOf(c, req.query) : refuse(403, 'insufficient_scope', 'An organisation link reads clients at /orgs/{org_id}/clients')));
  app.get<{ Params: { org_id: string; id: string } }>('/api/v1/connect/orgs/:org_id/clients/:id', { schema: { params: withId('id', UUID.source) } }, (req, reply) =>
    bearer(req, reply, 'clients.get', 'pulse.clients.read', false, async (c) => {
      const r = await one<{ clients: ClientRow[] }>(c, 'select pulse.connect_clients($1) r', [JSON.stringify({ id: req.params.id, limit: 1 })]);
      return r.clients[0] ?? refuse(404, 'not_found', 'No such client');
    }));
  app.get<{ Params: { org_id: string }; Querystring: Record<string, string> }>('/api/v1/connect/orgs/:org_id/money/clients', { schema: { params: PARAMS } }, (req, reply) =>
    bearer(req, reply, 'money.clients', 'pulse.money.read', false, async (c) => {
      const limit = limitOf(req.query.limit);
      const r = await one<{ clients: (Record<string, unknown> & { client_id: string })[] }>(c, 'select pulse.connect_money_clients($1) r', [JSON.stringify({ limit, after: cursorIn(req.query.cursor) })]);
      const { items, next_cursor } = paged(r.clients, limit, 'client_id');
      return { clients: items, next_cursor };
    }));

  const text = (x: unknown, max: number) => typeof x === 'string' && x.trim() ? x.replace(/\s+/g, ' ').trim().slice(0, max) : null;
  const list = (x: unknown) => (Array.isArray(x) ? x : typeof x === 'string' ? [x] : []).map((s) => text(s, 300)).filter((s): s is string => !!s).slice(0, 50);
  const viewerOf = (p: Principal, c: PoolClient) => c.query("select current_setting('pulse.viewer_id',true) v").then((r) => ({ email: '', org: p.org, person: r.rows[0].v || null,
    role: 'admin', name: p.appName, pod: null, via: 'access', username: null, mustChange: false }) as Viewer);
  const personOf = async (c: PoolClient, p: Principal, who: unknown) => {
    const sub = (who as { sub?: unknown } | null)?.sub;
    return typeof sub === 'string' && SUB.test(sub) ? (await c.query('select pulse.oidc_sub_person($1,$2) p', [p.app, sub]).then((r) => r.rows[0].p as string | null).catch(() => null)) : null;
  };
  const LEAD = { type: 'object', additionalProperties: false, required: ['name', 'stage', 'revision'], properties: {
    name: { type: 'string', maxLength: 200 }, company: { type: ['string', 'null'], maxLength: 200 }, phone: { type: ['string', 'null'], maxLength: 40 },
    email: { type: ['string', 'null'], maxLength: 320 }, city: { type: ['string', 'null'], maxLength: 120 }, interest: { type: ['string', 'null'], maxLength: 200 },
    stage: { type: 'string', minLength: 1, maxLength: 40 }, stage_label: { type: ['string', 'null'], maxLength: 80 },
    owner: { type: ['object', 'null'], additionalProperties: false, properties: { sub: { type: 'string', maxLength: 64 }, name: { type: 'string', maxLength: 200 } } },
    source: { type: ['string', 'null'], maxLength: 200 }, created_at: { type: ['string', 'null'], maxLength: 40 }, revision: { type: 'integer', minimum: 0 } } } as const;
  app.put<{ Params: { org_id: string; lead_id: string }; Body: Record<string, unknown> }>('/api/v1/connect/orgs/:org_id/leads/:lead_id', { schema: { params: withId('lead_id', UUID.source), body: LEAD } }, (req, reply) =>
    bearer(req, reply, 'leads.put', 'pulse.leads.write', true, async (c, p) => {
      const b = req.body, v = await viewerOf(p, c);
      const owner = (b.owner ?? null) as { sub?: string; name?: string } | null, ownerPerson = await personOf(c, p, owner);
      const ownerName = ownerPerson ? (await c.query('select display_name from pulse.person where id=$1', [ownerPerson])).rows[0]?.display_name : text(owner?.name, 200);
      const r = await applyPushedLead(c, v, { lead_id: req.params.lead_id, revision: Number(b.revision), name: text(b.name, 200), company: text(b.company, 200), city: text(b.city, 120),
        interest: text(b.interest, 200), stage: text(b.stage, 40), stage_label: text(b.stage_label, 80), owner_name: ownerName ?? null, source_label: text(b.source, 200) ?? p.appName,
        created_at: text(b.created_at, 40) }, { phone: text(b.phone, 40), email: text(b.email, 320) });
      return { lead_id: req.params.lead_id, revision: r.revision, changed: r.changed, client: r.client, conflicts: r.conflicts };
    }));
  const CALL = { type: 'object', additionalProperties: false, required: ['status'], properties: {
    title: { type: ['string', 'null'], maxLength: 200 }, at: { type: ['string', 'null'], maxLength: 40 }, duration_seconds: { type: ['integer', 'null'], minimum: 0, maximum: 86400 },
    status: { enum: ['analysing', 'ready', 'failed'] }, lead_id: { type: ['string', 'null'], pattern: UUID.source },
    member: { type: ['object', 'null'], additionalProperties: false, properties: { sub: { type: 'string', maxLength: 64 } } },
    client_id: { type: ['string', 'null'], pattern: UUID.source }, report_url: { type: ['string', 'null'], maxLength: 400 },
    summary: { type: ['object', 'null'], additionalProperties: false, properties: { text: { type: 'string', maxLength: 8000 }, wants: {}, objections: {}, promises: {}, score: {} } } } } as const;
  app.put<{ Params: { org_id: string; call_id: string }; Body: Record<string, unknown> }>('/api/v1/connect/orgs/:org_id/calls/:call_id', { schema: { params: withId('call_id', UUID.source), body: CALL } }, (req, reply) =>
    bearer(req, reply, 'calls.put', 'pulse.calls.write', true, async (c, p) => {
      const b = req.body, v = await viewerOf(p, c), s = b.summary as Record<string, unknown> | null | undefined;
      const at = typeof b.at === 'string' && Number.isFinite(Date.parse(b.at)) ? new Date(b.at).toISOString() : null;
      const report = typeof b.report_url === 'string' && /^https:\/\//.test(b.report_url) ? b.report_url : null;
      const r = await savePushedCall(c, v, req.params.call_id, { title: text(b.title, 200), at, durationSeconds: typeof b.duration_seconds === 'number' ? b.duration_seconds : null,
        status: b.status as 'analysing' | 'ready' | 'failed', leadId: (b.lead_id as string | null) ?? null, personId: await personOf(c, p, b.member), clientId: (b.client_id as string | null) ?? null,
        summary: s ? { summary: text(s.text, 8000) ?? '', items: list(s.wants), objections: list(s.objections), promises: list(s.promises),
          score: typeof s.score === 'number' || typeof s.score === 'string' ? s.score : null, url: report ?? undefined, source: 'sales-xray' } : null, reportUrl: report });
      const memberSub = r.personId ? (await c.query('select pulse.oidc_sub($1,$2) s', [p.app, r.personId]).then((x) => x.rows[0].s as string).catch(() => null)) : null;
      return { call_id: req.params.call_id, client_id: r.clientId, member_sub: memberSub, status: r.status };
    }));

  // ----- photos: no token; the signed address and a live connection decide ------------------------------------------
  app.get<{ Params: { member: string }; Querystring: Record<string, string> }>('/api/v1/connect/photos/:member', async (req, reply) => {
    reply.header('referrer-policy', 'no-referrer');
    if (!oidcOn()) return reply.callNotFound();
    const { o = '', v = '', a = '', s = '' } = req.query, member = req.params.member;
    const keys = await signingKeys();
    if (!keys.ok || !UUID.test(member) || !UUID.test(o) || !/^\d{1,16}$/.test(v) || !/^papp_[a-z0-9]{20}$/.test(a) || !pictureSignatureOk(keys.keys, a, o, member, v, s)) {
      return reply.code(404).header('cache-control', 'no-store').send({ error: 'not_found' });
    }
    const row = await open(async (c) => (await c.query('select bytes, mime, version from pulse.connect_photo($1,$2,$3)', [a, o, member])).rows[0]);
    if (!row?.bytes || !/^image\/(png|jpeg|webp)$/.test(row.mime)) return reply.code(404).header('cache-control', 'no-store').send({ error: 'not_found' });
    // (Every /api/ answer leaves as private, no-store: apps copy the bytes once, as the contract asks.)
    return reply.type(row.mime).header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox").send(row.bytes);
  });

  // ----- webhook delivery: every minute, for the organisations with endpoints -----------------------------------------
  let busy = false;
  const deliverAll = async () => {
    if (busy || !oidcOn()) return;
    busy = true;
    try {
      const sweep = await pool.connect();
      let orgs: string[] = [];
      try {
        await sweep.query('begin'); await sweep.query('select pulse.oidc_sweep()');
        orgs = (await sweep.query('select pulse.connect_hook_orgs() org')).rows.map((r) => r.org as string); await sweep.query('commit');
      } catch { await sweep.query('rollback').catch(() => {}); } finally { sweep.release(); }
      for (const org of orgs) await deliverOrg(org).catch((e) => app.log.warn({ org, reason: (e as Error).message?.slice(0, 120) }, 'Webhook delivery failed'));
    } finally { busy = false; }
  };
  type Due = { id: string; hook: string; url: string; secret: Box; type: string; body: Record<string, unknown> };
  async function deliverOrg(org: string) {
    const ring = await loadKeyring();
    const withOrg = async <T>(run: (c: PoolClient) => Promise<T>) => {
      const c = await pool.connect();
      try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [org]); const r = await run(c); await c.query('commit'); return r; }
      catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
    };
    const due = await withOrg((c) => one<Due[]>(c, 'select pulse.connect_due(50) r', []));
    if (!due.length) return;
    const grants = new Map<string, string>();
    const results: { id: string; status: number; error?: string }[] = [];
    for (const e of due) {
      try {
        if (!ring.ok) throw new Error('keyring');
        const grant: string = grants.get(e.hook) ?? await withOrg((c) => c.query('select grant_id from pulse.connect_hook where id=$1', [e.hook]).then((r) => String(r.rows[0]?.grant_id ?? '')));
        grants.set(e.hook, grant);
        const secret = unseal(ring.ring, unbox(e.secret), hookContext(org, grant)).toString();
        const body = JSON.stringify(e.body), t = Math.floor(Date.now() / 1000);
        const r = await safeOutbound(e.url, body, { 'X-Pulse-Event-Id': e.id, 'X-Pulse-Event': e.type, 'X-Pulse-Signature': webhookSignature(secret, t, body), 'User-Agent': 'Pulse-Webhooks/1' }, 3000);
        results.push({ id: e.id, status: r.status });
      } catch (err) {
        results.push({ id: e.id, status: 0, error: err instanceof OutboundError ? `Could not deliver (${err.kind})` : 'Could not deliver' });
      }
    }
    await withOrg((c) => c.query('select pulse.connect_delivered($1)', [JSON.stringify(results)]));
  }
  const loopOn = process.env.PULSE_CONNECT_WEBHOOKS !== '0';
  const tick = loopOn ? setInterval(() => void deliverAll().catch(() => {}), 60_000) : null;
  tick?.unref();
  app.addHook('onClose', async () => { if (tick) clearInterval(tick); });
  return { deliverAll };
}
