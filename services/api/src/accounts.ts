// ORG (owner, 22 Oct 2026): one Pulse account per human across the organisations on this Pulse, the org switcher,
// invitations into an organisation (staff, freelancers, clients), "Start your own Pulse" and the portable profile.
// Every request still runs inside exactly one organisation: switching mints an ordinary session in the other
// organisation for the person the account is there (0920, pulse.account_switch), and the API's front door picks the
// organisation from that session (app.ts). Nothing here sends e-mail: invitation links are shown once to the inviter.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { authIp } from './account-security.js';
import { deviceLabel, passwordError } from './auth-policy.js';
import { fail, sessionHash, type Open, type Tx } from './routes.js';
import { requestCompany } from './tenant-context.js';
import { linkOrigin } from './connect.js';
import { PACK, PACKS, packPayload } from './flow/packs.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 20 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const text = (x: unknown, max = 200) => String(x ?? '').slice(0, max);
const secret = () => randomBytes(32).toString('base64url');
const device = (req: FastifyRequest) => deviceLabel(String(req.headers['x-pulse-device-agent'] ?? req.headers['user-agent'] ?? ''));
const id = (x: unknown, what = 'Choose a valid record') => UUID.test(String(x)) ? String(x) : fail(400, what);

/** Plain sentences for the database's refusals (they arrive as Postgres errors with our own message). */
async function plain<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e) {
    const err = e as { code?: string; message?: string; statusCode?: number };
    if (err.statusCode) throw e;
    const status = ({ '42501': 403, '22023': 400, '23505': 409, P0002: 404, '28000': 401, '54000': 429 } as Record<string, number>)[err.code ?? ''];
    if (status) fail(status, String(err.message ?? 'Not possible'));
    throw e;
  }
}

/** A switch / join / start answer: the new session's token (the web turns it into the cookie), and whether the
 *  organisation is the one this address belongs to (an Access identity there needs no session of its own). */
export type SwitchAnswer = { org: string; name: string; handle: string | null; kind: string; token: string; hostOwn: boolean; home: string };
function answer(r: Record<string, unknown>, token: string): SwitchAnswer {
  return { org: String(r.org), name: String(r.name), handle: (r.handle as string) ?? null, kind: String(r.kind ?? 'staff'), token,
    hostOwn: requestCompany()?.hostOrg === r.org, home: r.kind === 'client' ? '/tasks' : '/' };
}

export function registerAccountRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  const allow = (req: FastifyRequest, key: string, limit: number) => open(async (c) => (await c.query('select pulse.auth_allow($1,$2) ok', [sessionHash(key + ':' + authIp(req)), limit])).rows[0].ok as boolean);
  const me = (c: PoolClient) => c.query('select pulse.account_me() a').then((r) => r.rows[0].a);

  // The signed-in person's account (null until claimed), organisations and invitations waiting for them.
  app.get('/api/v0/account', (req) => tx(req, async (c, v) => { if (!v.person) fail(403, 'A Pulse account belongs to a person'); return me(c); }));
  // Claim or change the handle; optionally set the account's own password (to sign in at the shared address).
  app.post<{ Body: Body }>('/api/v0/account/claim', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'A Pulse account belongs to a person');
    const password = text(req.body.password, 200);
    if (password) { const problem = passwordError(password); if (problem) fail(400, problem); }
    return plain(async () => (await c.query('select pulse.account_claim($1,$2) a', [text(req.body.handle, 40), password || null])).rows[0].a);
  }));
  // Link this person to an account you already have (its handle and password prove it is yours).
  app.post<{ Body: Body }>('/api/v0/account/link', { schema: { body } }, async (req) => {
    if (!await allow(req, 'account-link', 10)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    return tx(req, async (c) => plain(async () => (await c.query('select pulse.account_link($1,$2) a', [text(req.body.login, 254), text(req.body.password, 200)])).rows[0].a));
  });
  // Switch organisation: a session there for the same human, no sign-in again.
  app.post<{ Body: Body }>('/api/v0/account/switch', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Switch organisations from your browser account');
    const token = secret();
    const r = await plain(async () => (await c.query('select pulse.account_switch($1,$2,$3) r', [id(req.body.org, 'Choose an organisation'), sessionHash(token), device(req)])).rows[0].r);
    return answer(r, token);
  }));
  // The industry packs to start from (FLOW-E), for anyone signed in (a client of another organisation too).
  app.get('/api/v0/account/packs', (req) => tx(req, async () => ({ packs: PACKS.map((p) => ({ key: p.key, name: p.name, summary: p.summary, examples: p.examples, icon: p.icon, words: p.words })) })));
  // Start your own Pulse: a new organisation owned by this account, with an industry pack, and a session in it.
  app.post<{ Body: Body }>('/api/v0/account/start', { schema: { body } }, async (req) => {
    if (!await allow(req, 'account-start', 10)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    return tx(req, async (c, v) => {
      if (!v.person || v.nativeDevice) fail(403, 'Start an organisation from your browser account');
      const key = text(req.body.pack, 40);
      const pack = key ? PACK.get(key) ?? fail(400, 'Choose an industry pack') : null;
      const token = secret();
      const r = await plain(async () => (await c.query('select pulse.account_start_org($1,$2,$3) r', [JSON.stringify({ name: text(req.body.name, 80), handle: text(req.body.handle, 40), pack: pack ? packPayload(pack) : null }), sessionHash(token), device(req)])).rows[0].r);
      return { ...answer(r, token), code: r.code };
    });
  });

  // Invitations into this organisation (admins, HR, leadership): to a handle (it waits in their switcher), or a
  // private link shown once (nothing is e-mailed).
  app.get('/api/v0/account/invites', (req) => tx(req, async (c) => ({ invites: (await c.query('select pulse.org_invite_list() l')).rows[0].l })));
  app.post<{ Body: Body }>('/api/v0/account/invites', { schema: { body } }, (req) => tx(req, async (c) => {
    const toHandle = text(req.body.toHandle, 40).trim();
    const token = toHandle ? null : secret();
    const r = await plain(async () => (await c.query('select pulse.org_invite_create($1) r', [JSON.stringify({ kind: text(req.body.kind, 20), title: text(req.body.title, 80), toHandle, hash: token ? sessionHash(token) : null })])).rows[0].r);
    if (!token) return { ...r, link: null };
    // SIM-CLIENTS (R142): on the address the inviter is on, like a client link (connect.ts), not always the install's.
    const url = new URL('/join', linkOrigin(req)); url.hash = token;
    return { ...r, link: url.href, warning: 'Shown once. Send it privately to the person you are inviting; anyone with the link can join.' };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/account/invites/:id/revoke', (req) => tx(req, async (c) => {
    await plain(() => c.query('select pulse.org_invite_revoke($1)', [id(req.params.id)])); return { invites: (await c.query('select pulse.org_invite_list() l')).rows[0].l };
  }));
  // Accept an invitation to my handle (by id) or a private link (token) while signed in.
  app.post<{ Body: Body }>('/api/v0/account/accept', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Accept from your browser account');
    const link = text(req.body.token, 64);
    if (!req.body.id && !TOKEN.test(link)) fail(400, 'This invitation link is unavailable');
    const token = secret();
    const r = await plain(async () => (await c.query('select pulse.org_invite_accept($1,$2,$3,$4) r', [req.body.id ? id(req.body.id) : null, req.body.id ? null : sessionHash(link), sessionHash(token), device(req)])).rows[0].r);
    if (!r) fail(403, 'Your place in that organisation is not active');
    return answer(r, token);
  }));

  // Signed out: what an invitation link is for, then joining with a new Pulse account.
  app.post<{ Body: Body }>('/api/v0/auth/join-peek', { schema: { body } }, async (req) => {
    if (!await allow(req, 'join-peek', 30)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const link = text(req.body.token, 64); if (!TOKEN.test(link)) fail(404, 'This invitation is no longer open');
    const r = await open(async (c) => (await c.query('select pulse.org_invite_peek($1) r', [sessionHash(link)])).rows[0].r);
    return r ?? fail(404, 'This invitation is no longer open. Ask for a new link.');
  });
  app.post<{ Body: Body }>('/api/v0/auth/join', { schema: { body } }, async (req) => {
    if (!await allow(req, 'join', 10)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const link = text(req.body.token, 64); if (!TOKEN.test(link)) fail(404, 'This invitation is no longer open');
    const password = text(req.body.password, 200); const problem = passwordError(password); if (problem) fail(400, problem);
    const token = secret();
    const r = await open(async (c) => plain(async () => (await c.query('select pulse.account_join($1,$2,$3,$4) r', [sessionHash(link),
      JSON.stringify({ name: text(req.body.name, 120), handle: text(req.body.handle, 40), email: text(req.body.email, 254), password }), sessionHash(token), device(req)])).rows[0].r));
    if (!r) fail(403, 'Your place in that organisation is not active');
    return { ...answer(r, token), maxAge: 2592000 };
  });
  // Signed out: sign in with the Pulse account (handle or e-mail) at the shared address, into the last organisation.
  app.post<{ Body: Body }>('/api/v0/auth/account-sign-in', { schema: { body } }, async (req) => {
    const login = text(req.body.login ?? req.body.username, 254).trim().toLowerCase();
    if (!await allow(req, 'account-login', 30) || !await allow(req, 'account-login:' + login, 20)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const token = secret();
    const r = await open(async (c) => (await c.query('select pulse.account_sign_in($1,$2,$3,$4) r', [login, text(req.body.password, 200), sessionHash(token), device(req)])).rows[0].r);
    if (!r || r.failed) fail(401, r?.noOrg ? 'Your account has no active organisation yet. Open your invitation link again.' : 'Sign-in details are unavailable or temporarily locked. Wait 15 minutes or use your organisation\'s sign-in.');
    return { ...answer(r, token), maxAge: 2592000 };
  });

  // The portable profile: what travels with me, and what each organisation may see.
  app.get('/api/v0/account/profile', (req) => tx(req, async (c) => (await c.query('select pulse.account_profile_get() p')).rows[0].p));
  app.post<{ Body: Body }>('/api/v0/account/profile', { schema: { body } }, (req) => tx(req, async (c) => plain(async () => (await c.query('select pulse.account_profile_save($1) p', [JSON.stringify({
    headline: text(req.body.headline, 120), about: text(req.body.about, 2000),
    skills: Array.isArray(req.body.skills) ? req.body.skills.slice(0, 40).map((s) => text(s, 60)) : [],
    links: Array.isArray(req.body.links) ? (req.body.links as Body[]).slice(0, 8).map((l) => ({ label: text(l?.label, 60), url: text(l?.url, 300) })) : [] })])).rows[0].p)));
  app.post<{ Body: Body }>('/api/v0/account/share', { schema: { body } }, (req) => tx(req, async (c) => plain(async () => (await c.query('select pulse.account_share_save($1) p', [JSON.stringify({
    org: req.body.org ? id(req.body.org) : null, profile: req.body.profile !== false, skills: req.body.skills !== false, badges: req.body.badges !== false, highlights: req.body.highlights !== false })])).rows[0].p)));
  app.get('/api/v0/account/highlight-choices', (req) => tx(req, async (c) => ({ tasks: (await c.query('select pulse.account_highlight_choices() t')).rows[0].t })));
  app.post<{ Body: Body }>('/api/v0/account/highlights', { schema: { body } }, (req) => tx(req, async (c) => {
    const title = text(req.body.title, 160).trim();
    if (!req.body.taskId && title.length < 2) fail(400, 'Write what you did, or choose a finished task');
    return plain(async () => (await c.query('select pulse.account_highlight_add($1) p', [JSON.stringify({ taskId: req.body.taskId ? id(req.body.taskId) : null, title, detail: text(req.body.detail, 500), on: /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.on ?? '')) ? req.body.on : null })])).rows[0].p);
  }));
  app.post<{ Params: { id: string } }>('/api/v0/account/highlights/:id/remove', (req) => tx(req, async (c) => (await c.query("select pulse.account_item_set('highlight-remove',$1,null) p", [id(req.params.id)])).rows[0].p));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/account/badges/:id', { schema: { body } }, (req) => tx(req, async (c) => (await c.query("select pulse.account_item_set('badge-carry',$1,$2) p", [id(req.params.id), req.body.carried !== false])).rows[0].p));
  // A person's carried profile as this organisation may see it; and a badge from this organisation.
  app.get<{ Params: { id: string } }>('/api/v0/people/:id/carried', (req) => tx(req, async (c) => ({ card: (await c.query('select pulse.account_card($1) c', [id(req.params.id)])).rows[0].c })));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/people/:id/badges', { schema: { body } }, (req) => tx(req, async (c) => {
    const title = text(req.body.title, 80).trim(); if (title.length < 2) fail(400, 'Name the badge');
    return plain(async () => (await c.query('select pulse.org_badge_give($1,$2,$3) r', [id(req.params.id), title, text(req.body.note, 300)])).rows[0].r);
  }));
}
