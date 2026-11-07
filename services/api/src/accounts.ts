// ORG (owner, 22 Oct 2026): one Pulse account per human across the organisations on this Pulse, the org switcher,
// invitations into an organisation (staff, freelancers, clients), "Start your own Pulse" and the portable profile.
// Every request still runs inside exactly one organisation: switching mints an ordinary session in the other
// organisation for the person the account is there (0920, pulse.account_switch), and the API's front door picks the
// organisation from that session (app.ts). Nothing here sends e-mail: invitation links are shown once to the inviter.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { authIp } from './account-security.js';
import { deviceLabel, passwordError } from './auth-policy.js';
import { fail, sessionHash, type Open, type Tx } from './routes.js';
import { requestCompany } from './tenant-context.js';
import { linkOrigin } from './connect.js';
import { PACK, PACKS, packPayload } from './flow/packs.js';
import { pulseMail } from './auth-mail.js';
import { SEAT, inviteMail, onboardingPlan, type SeatKey } from './self-serve-model.js';
import { planFrom } from './self-serve-space.js';

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
export function answer(r: Record<string, unknown>, token: string): SwitchAnswer {
  return { org: String(r.org), name: String(r.name), handle: (r.handle as string) ?? null, kind: String(r.kind ?? 'staff'), token,
    hostOwn: requestCompany()?.hostOrg === r.org, home: r.kind === 'client' ? '/tasks' : '/' };
}

/** PROFILE-UNIFY: the resume link's hash (the token itself is shown once and never kept). */
const resumeHash = (token: string) => createHash('sha256').update(token).digest('hex');
const list = (x: unknown, n: number, max: number) => Array.isArray(x) ? x.slice(0, n).map((s) => text(s, max)) : [];
const objs = (x: unknown, n: number) => Array.isArray(x) ? (x as unknown[]).slice(0, n).filter((o): o is Body => !!o && typeof o === 'object' && !Array.isArray(o)) : [];

/** The account profile fields a save sends (only those present; the database keeps the others). */
export function profileFields(b: Body): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, max] of [['name', 120], ['headline', 120], ['about', 2000], ['pronouns', 30], ['location', 120], ['contactEmail', 254], ['contactPhone', 24]] as const)
    if (k in b) out[k] = text(b[k], max);
  if ('skills' in b) out.skills = list(b.skills, 40, 60);
  if ('languages' in b) out.languages = list(b.languages, 8, 40);
  if ('skillLevels' in b && b.skillLevels && typeof b.skillLevels === 'object' && !Array.isArray(b.skillLevels))
    out.skillLevels = Object.fromEntries(Object.entries(b.skillLevels as Body).slice(0, 40).filter(([, v]) => typeof v === 'number' && v >= 1 && v <= 4).map(([k, v]) => [text(k, 60), v]));
  if ('links' in b) out.links = objs(b.links, 8).map((l) => ({ label: text(l.label, 60), url: text(l.url, 300) }));
  if ('education' in b) out.education = objs(b.education, 12).map((e) => ({ school: text(e.school, 120), degree: text(e.degree, 120), from: text(e.from, 10), to: text(e.to, 10) }));
  if ('certifications' in b) out.certifications = objs(b.certifications, 20).map((e) => ({ name: text(e.name, 120), issuer: text(e.issuer, 120), on: text(e.on, 10), url: text(e.url, 300) }));
  return out;
}

/** ACCOUNT-SEATS (1463): an invitation that linked the company's earlier, inactive record of me: no session there until
 *  its HR makes the record active again. */
const waiting = (r: Record<string, unknown>) => ({ waiting: true, org: String(r.org), name: String(r.name),
  message: `You are linked to your earlier record at ${String(r.name)}. Its HR decides when your place opens again; it then appears in your organisations.` });

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
  // Switch organisation: the same human there, no sign-in again. AUTH-UNIFY (1291): a signed-in session moves itself to
  // the other organisation (the same token, so the browser keeps its cookie; membership checked, audited in both); only an
  // Access identity, which has no session to move, gets a new one there.
  app.post<{ Body: Body }>('/api/v0/account/switch', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Switch organisations from your browser account');
    const org = id(req.body.org, 'Choose an organisation');
    const current = req.headers['x-pulse-session'];
    if (v.via === 'password' && typeof current === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(current)) {
      const r = await plain(async () => (await c.query('select pulse.account_move($1,$2) r', [org, sessionHash(current)])).rows[0].r);
      return answer(r, current);
    }
    const token = secret();
    const r = await plain(async () => (await c.query('select pulse.account_switch($1,$2,$3) r', [org, sessionHash(token), device(req)])).rows[0].r);
    return answer(r, token);
  }));
  // PERSONAL-WORKSPACE (1640): my own private workspace, made the first time it is opened from the switcher (the
  // platform's tools/admin/personal-workspaces.py makes it for every account that has none). Nobody is told.
  app.post('/api/v0/account/personal-workspace', (req) => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Open your workspace from your browser account');
    return { org: (await c.query('select pulse.personal_workspace_mine() o')).rows[0].o };
  }));
  // AUTH-UNIFY: one password for all my workspaces (one current password proves it is me; every credential then matches).
  app.post<{ Body: Body }>('/api/v0/account/unify', { schema: { body } }, async (req) => {
    if (!await allow(req, 'account-unify', 10)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    return tx(req, async (c, v) => {
      if (!v.person || v.nativeDevice) fail(403, 'Set your password from your browser account');
      const next = text(req.body.next, 200); const problem = passwordError(next); if (problem) fail(400, problem);
      const r = await plain(async () => (await c.query('select pulse.account_password_unify($1,$2) r', [text(req.body.current, 200), next])).rows[0].r);
      if (r?.error) fail(400, String(r.error));
      return r;
    });
  });
  // The industry packs to start from (FLOW-E), for anyone signed in (a client of another organisation too).
  app.get('/api/v0/account/packs', (req) => tx(req, async () => ({ packs: PACKS.map((p) => ({ key: p.key, name: p.name, summary: p.summary, examples: p.examples, icon: p.icon, words: p.words })) })));
  // Start your own Pulse: a new organisation owned by this account, with an industry pack, and a session in it.
  // ONBOARD-SELF (1462): with templates it is "Start your company on Pulse": the company set up from the wizard's answers
  // (self-serve-model.ts), its starter projects, the founder as admin and leadership; then the invitations step. Either
  // way the account's e-mail must be proven (a code, an invitation mailed to it, or the Access identity carrying it).
  app.post<{ Body: Body }>('/api/v0/account/start', { schema: { body } }, async (req) => {
    if (!await allow(req, 'account-start', 10)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    return tx(req, async (c, v) => {
      if (!v.person || v.nativeDevice) fail(403, 'Start an organisation from your browser account');
      if (v.via === 'access' && v.email) await c.query('select pulse.account_email_proven($1)', [v.email]);
      // SELF-SERVE (owner, 4 Nov 2026): Start another space, set up for its kind (one person holds several).
      if (req.body.setup !== undefined) {
        const plan = planFrom(req.body.setup, v.name ?? '');
        const token = secret();
        const r = await plain(async () => (await c.query('select pulse.account_setup_start($1,$2,$3) r', [JSON.stringify(plan), sessionHash(token), device(req)])).rows[0].r);
        if (!r) fail(403, 'Pulse could not open your new space');
        return { ...answer(r, token), code: r.code, home: String(r.home ?? '/') };
      }
      if (Array.isArray(req.body.templates)) {
        const plan = onboardingPlan(req.body); if ('error' in plan) fail(400, plan.error);
        const token = secret();
        const r = await plain(async () => (await c.query('select pulse.account_onboard($1,$2,$3) r', [JSON.stringify(plan), sessionHash(token), device(req)])).rows[0].r);
        if (!r) fail(403, 'Pulse could not open your new company');
        return { ...answer(r, token), code: r.code, home: '/start/team' };
      }
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
  // ONBOARD-SELF (1462): rows [{ email, seat }] invite by e-mail, per seat: one private link each, mailed with what the
  // seat will and won't see (the link is shown here only when it could not be mailed).
  app.post<{ Body: Body }>('/api/v0/account/invites', { schema: { body } }, async (req) => {
    if (Array.isArray(req.body.rows)) return inviteByEmail(req);
    return tx(req, async (c) => {
    const toHandle = text(req.body.toHandle, 40).trim();
    const token = toHandle ? null : secret();
    const r = await plain(async () => (await c.query('select pulse.org_invite_create($1) r', [JSON.stringify({ kind: text(req.body.kind, 20), title: text(req.body.title, 80), toHandle, hash: token ? sessionHash(token) : null })])).rows[0].r);
    if (!token) return { ...r, link: null };
    // SIM-CLIENTS (R142): on the address the inviter is on, like a client link (connect.ts), not always the install's.
    const url = new URL('/join', linkOrigin(req)); url.hash = token;
    return { ...r, link: url.href, warning: 'Shown once. Send it privately to the person you are inviting; anyone with the link can join.' };
  }); });
  const inviteByEmail = async (req: FastifyRequest<{ Body: Body }>) => {
    const seen = new Set<string>(); const tokens = new Map<string, string>();
    const rows = (req.body.rows as Body[]).slice(0, 51).flatMap((x) => {
      const email = text(x?.email, 254).trim().toLowerCase(); const seat = text(x?.seat, 20) || 'staff';
      if (seen.has(email)) return []; seen.add(email);
      const token = secret(); tokens.set(email, token);
      return [{ email, seat, hash: sessionHash(token), title: SEAT.get(seat as SeatKey)?.label ?? '' }];
    });
    const made = await tx(req, async (c, v) => ({
      rows: await plain(async () => (await c.query('select pulse.onboard_invites($1) r', [JSON.stringify({ rows })])).rows[0].r) as { id?: string; email: string; seat: SeatKey; status: string; hasAccount?: boolean }[],
      org: String((await c.query('select name from pulse.org where id = pulse.current_org()')).rows[0]?.name ?? 'Pulse'), by: v.name }));
    const mailed: string[] = [];
    const out = [];
    for (const r of made.rows) {
      if (r.status !== 'created' || !r.id) { out.push({ email: r.email, seat: r.seat, status: r.status, mailed: false, link: null }); continue; }
      const url = new URL('/join', linkOrigin(req)); url.hash = tokens.get(r.email)!;
      const mail = inviteMail({ org: made.org, by: made.by, seat: r.seat, link: url.href, hasAccount: r.hasAccount === true });
      const ok = await pulseMail(r.email, mail.title, mail.body).catch(() => false);
      if (ok) mailed.push(r.id);
      out.push({ email: r.email, seat: r.seat, status: r.status, hasAccount: r.hasAccount === true, mailed: ok, link: ok ? null : url.href });
    }
    if (mailed.length) await tx(req, async (c) => c.query('select pulse.onboard_invite_mailed($1::uuid[])', [mailed]));
    return { rows: out, ...(out.some((r) => r.link) ? { warning: 'Some invitations could not be e-mailed. Send each link privately; it is shown only now.' } : {}) };
  };
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
    if (r.waiting) return waiting(r);
    return answer(r, token);
  }));

  // ACCOUNT-SEATS (1463): leave a company from my account. The seat ends (the company keeps its records, as with any
  // leaver); the account and its other companies stay. Leaving the company I am in opens another of mine, if any.
  app.post<{ Body: Body }>('/api/v0/account/leave', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Leave a company from your browser account');
    const org = id(req.body.org, 'Choose a company'); const token = secret();
    const r = await plain(async () => (await c.query('select pulse.account_leave($1,$2,$3) r', [org, sessionHash(token), device(req)])).rows[0].r);
    if (r.moved) return { ...answer(r.moved, token), left: org, leftName: r.name };
    return { left: org, leftName: r.name, signedOut: org === v.org };
  }));

  // Signed out: what an invitation link is for, then joining with a new Pulse account.
  app.post<{ Body: Body }>('/api/v0/auth/join-peek', { schema: { body } }, async (req) => {
    if (!await allow(req, 'join-peek', 300)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const link = text(req.body.token, 64); if (!TOKEN.test(link)) fail(404, 'This invitation is no longer open');
    const r = await open(async (c) => (await c.query('select pulse.org_invite_peek($1) r', [sessionHash(link)])).rows[0].r);
    return r ?? fail(404, 'This invitation is no longer open. Ask for a new link.');
  });
  app.post<{ Body: Body }>('/api/v0/auth/join', { schema: { body } }, async (req) => {
    if (!await allow(req, 'join', 100)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const link = text(req.body.token, 64); if (!TOKEN.test(link)) fail(404, 'This invitation is no longer open');
    const password = text(req.body.password, 200); const problem = passwordError(password); if (problem) fail(400, problem);
    const token = secret();
    const r = await open(async (c) => plain(async () => (await c.query('select pulse.account_join($1,$2,$3,$4) r', [sessionHash(link),
      JSON.stringify({ name: text(req.body.name, 120), handle: text(req.body.handle, 40), email: text(req.body.email, 254), password }), sessionHash(token), device(req)])).rows[0].r));
    if (!r) fail(403, 'Your place in that organisation is not active');
    if (r.waiting) return waiting(r);
    return { ...answer(r, token), maxAge: 2592000 };
  });
  // Signed out: sign in with the Pulse account (handle or e-mail) at the shared address, into the last organisation;
  // SIGNIN-OFFICE: at an organisation's own address, into that organisation when the account belongs to it.
  app.post<{ Body: Body }>('/api/v0/auth/account-sign-in', { schema: { body } }, async (req) => {
    const login = text(req.body.login ?? req.body.username, 254).trim().toLowerCase();
    // SIGNIN-OFFICE: per address an office's worth (the sign-in form tries this first for every person); 20 per login.
    if (!await allow(req, 'account-login', 300) || !await allow(req, 'account-login:' + login, 20)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const token = secret(), challenge = secret();
    // LOGIN-OTP (owner, 6 Nov 2026): an authenticator on a seat no longer sends people to their organisation's own address:
    // the right password opens a 5-minute challenge, finished with the authenticator code on auth/two-step.
    const r = await open(async (c) => (await c.query('select pulse.account_sign_in($1,$2,$3,$4,$5) r', [login, text(req.body.password, 200), sessionHash(token), device(req), sessionHash(challenge)])).rows[0].r);
    if (r?.twoStep && r?.challenge === true) return { twoStep: true, challenge };
    if (!r || r.failed) fail(401, r?.noOrg ? 'Your account has no active organisation yet. Open your invitation link again.'
      : r?.twoStep ? 'Your account uses two-step verification: sign in with your username at your organisation\'s own Pulse address.'
      : r?.ambiguous ? 'That sign-in matches more than one person. Use your username at your organisation\'s own Pulse address.'
      : 'Sign-in details are unavailable or temporarily locked. Wait 15 minutes or use your organisation\'s sign-in.');
    // AUTH-UNIFY: unify asks once for one password for all workspaces; mustChange opens the issued-password change first.
    return { ...answer(r, token), maxAge: 2592000, unify: r.unify === true, mustChange: r.mustChange === true };
  });

  // The portable profile: what travels with me, and what each organisation may see.
  app.get('/api/v0/account/profile', (req) => tx(req, async (c) => (await c.query('select pulse.account_profile_get() p')).rows[0].p));
  // PROFILE-UNIFY (1683): the account's own details, kept once and shown in every company. A save changes only the
  // fields it sends; the database then writes them into every seat (photo, pronouns, about, languages, skills, name).
  app.post<{ Body: Body }>('/api/v0/account/profile', { schema: { body } }, (req) => tx(req, async (c) => plain(async () => (await c.query('select pulse.account_profile_save($1) p', [JSON.stringify(profileFields(req.body))])).rows[0].p)));
  app.post<{ Body: Body }>('/api/v0/account/share', { schema: { body } }, (req) => tx(req, async (c) => plain(async () => {
    const flags: Record<string, unknown> = { org: req.body.org ? id(req.body.org) : null };
    for (const k of ['profile', 'skills', 'badges', 'highlights', 'contact', 'career']) if (typeof req.body[k] === 'boolean') flags[k] = req.body[k];
    return (await c.query('select pulse.account_share_save($1) p', [JSON.stringify(flags)])).rows[0].p;
  })));
  // My career: every company, current and former (only the person reads it), and moves waiting for them.
  app.get('/api/v0/account/career', (req) => tx(req, async (c, v) => { if (!v.person) fail(403, 'A Pulse account belongs to a person'); return plain(async () => (await c.query('select pulse.account_career() r')).rows[0].r); }));
  // The resume: its sections and its public link (off by default; the link is shown once, Pulse keeps its hash).
  app.get('/api/v0/account/resume', (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'A Pulse account belongs to a person');
    return plain(async () => ({ resume: (await c.query('select pulse.account_resume_get() r')).rows[0].r, profile: (await c.query('select pulse.account_profile_get() p')).rows[0].p,
      career: (await c.query('select pulse.account_career() r')).rows[0].r?.career ?? [] }));
  }));
  app.post<{ Body: Body }>('/api/v0/account/resume', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'A Pulse account belongs to a person');
    const share = ['on', 'off', 'new'].includes(String(req.body.share)) ? String(req.body.share) : null;
    const token = share === 'new' ? secret() : null;
    const r = await plain(async () => (await c.query('select pulse.account_resume_save($1,$2) r', [JSON.stringify({ sections: Array.isArray(req.body.sections) ? req.body.sections.slice(0, 12).map((s) => text(s, 20)) : undefined, share }), token ? resumeHash(token) : null])).rows[0].r);
    return token ? { ...r, link: new URL(`/accept/cv/${token}`, linkOrigin(req)).href, warning: 'Shown once. Anyone with the link sees the sections you chose; turn it off here at any time.' } : r;
  }));
  // Signed out: a person's resume through their own link (only the sections they chose).
  app.get<{ Params: { token: string } }>('/api/v0/share/resume/:token', async (req) => {
    const h = /^[A-Za-z0-9_-]{43}$/.test(req.params.token) ? resumeHash(req.params.token) : fail(404, 'This link is not valid');
    const r = await open(async (c) => (await c.query('select pulse.resume_public($1) r', [h])).rows[0].r);
    return r ?? fail(404, 'This link is not valid or has been turned off');
  });
  // Moving company: the companies I may invite this person into (my other companies where I am an admin, HR or
  // leadership), and the invitation itself, as a move (their seat here ends when they accept) or as a second seat.
  app.get<{ Params: { person: string } }>('/api/v0/account/invite-targets/:person', (req) => tx(req, async (c) => (await c.query('select pulse.account_invite_targets($1) r', [id(req.params.person)])).rows[0].r ?? { targets: [], hasAccount: false }));
  app.post<{ Body: Body }>('/api/v0/account/invite-elsewhere', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!['admin', 'hr', 'leadership'].includes(String(v.role))) fail(403, 'Admins, HR and leadership invite people into their other companies');
    return plain(async () => (await c.query('select pulse.account_invite_elsewhere($1,$2,$3,$4) r',
      [id(req.body.person, 'Choose a person'), id(req.body.org, 'Choose a company'), text(req.body.title, 80), req.body.move === true])).rows[0].r);
  }));
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
