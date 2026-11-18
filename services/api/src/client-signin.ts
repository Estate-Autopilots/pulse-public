// PORTAL-2 (owner, 25 Oct 2026): sign-in without friction for Pulse accounts that are not staff (clients, freelancers),
// db/migrations/1066_client_portal_2.sql. Signed out:
//   POST /api/v0/auth/account-forgot         {login}            e-mail a reset link (60 min, one use)
//   POST /api/v0/auth/account-link           {login}            e-mail a one-time sign-in link (15 min, one use)
//   POST /api/v0/auth/account-reset          {token, password}  choose a new password and sign in
//   POST /api/v0/auth/account-link-sign-in   {token}            sign in with the link (the person presses Sign in)
//   POST /api/v0/auth/account-confirm        {token}            confirm a new address
// Signed in (a client's seat):
//   POST /api/v0/client-portal/email         {email}            send a confirmation link to a new address
// Requests answer the same whether or not an account matches, after the same short wait; limits per IP, per address
// and per account (the database: three links an hour). Tokens travel in the link's fragment, so they never reach a log.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authIp } from './account-security.js';
import { deviceLabel, passwordError } from './auth-policy.js';
import { accountMail, clientMail, clientMailAvailable } from './client-mail.js';
import { linkOrigin } from './connect.js';
import { fail, sessionHash, type Open, type Tx } from './routes.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 10 } as const;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const text = (x: unknown, max = 254) => String(x ?? '').slice(0, max);
const secret = () => randomBytes(32).toString('base64url');
const device = (req: FastifyRequest) => deviceLabel(String(req.headers['x-pulse-device-agent'] ?? req.headers['user-agent'] ?? ''));
export const NEUTRAL = 'If a Pulse account matches, an e-mail is on its way to its address. It can take a minute; check spam too.';
const PAGE = { reset: '/login/account-reset', signin: '/login/account-link', confirm: '/login/account-confirm' } as const;
const UNAVAILABLE = 'E-mail is not switched on here. Ask your contact at the company for help signing in.';

export function accountLink(req: FastifyRequest, kind: keyof typeof PAGE, token: string) {
  const url = new URL(PAGE[kind], linkOrigin(req)); url.hash = token; return url.href;
}

export function registerClientSignIn(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  const allow = (req: FastifyRequest, key: string, limit: number) =>
    open(async (c) => (await c.query('select pulse.auth_allow($1,$2) ok', [sessionHash(key + ':' + authIp(req)), limit])).rows[0].ok as boolean);
  const allowKey = (key: string, limit: number) => open(async (c) => (await c.query('select pulse.auth_allow($1,$2) ok', [sessionHash(key), limit])).rows[0].ok as boolean);

  for (const kind of ['reset', 'signin'] as const) {
    app.post<{ Body: Body }>(kind === 'reset' ? '/api/v0/auth/account-forgot' : '/api/v0/auth/account-link', { schema: { body } }, async (req, reply) => {
      const started = Date.now();
      const login = text(req.body.login ?? req.body.username).trim().toLowerCase();
      if (!clientMailAvailable()) return reply.code(503).send({ code: 'MAIL_UNAVAILABLE', error: UNAVAILABLE });
      const ip = await allow(req, 'account-mail', 10);
      const key = login ? await allowKey('account-mail-input:' + login, 5) : false;
      const token = secret();
      const r = ip && key ? await open(async (c) => (await c.query('select pulse.acct_link_issue($1,$2,$3) r', [login, kind, sessionHash(token)])).rows[0].r) : null;
      // Delivery does not change the answer or its timing.
      if (r) setImmediate(() => { const m = accountMail(kind, r, accountLink(req, kind, token));
        void clientMail({ to: r.to, subject: m.subject, body: m.body, company: r.org, replyTo: r.replyTo }).catch(() => {}); });
      await new Promise((done) => setTimeout(done, Math.max(0, 400 - (Date.now() - started))));
      if (!ip || (login && !key)) return reply.code(429).send({ error: 'Too many requests. Try again in 15 minutes.' });
      return { ok: true, message: NEUTRAL };
    });
  }

  const redeem = async (req: FastifyRequest<{ Body: Body }>, kind: 'reset' | 'signin' | 'confirm') => {
    if (!await allow(req, 'account-redeem', 10)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const link = text(req.body.token, 64);
    if (!TOKEN.test(link)) fail(400, 'This link is unavailable. Ask for a fresh one.');
    if (!await allowKey('account-redeem-link:' + sessionHash(link), 5)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    let password: string | null = null;
    if (kind === 'reset') { password = text(req.body.password, 200); const problem = passwordError(password); if (problem) fail(400, problem); }
    const session = secret();
    const r = await open(async (c) => {
      try { return (await c.query('select pulse.acct_link_redeem($1,$2,$3,$4,$5) r', [sessionHash(link), kind, password, sessionHash(session), device(req)])).rows[0].r; }
      catch (e) { if ((e as { code?: string }).code === '23505') fail(409, 'Another Pulse account uses that address'); throw e; }
    });
    if (!r) fail(400, 'This link was used, has expired or was replaced by a newer one. Ask for a fresh one.');
    return { r, session };
  };
  app.post<{ Body: Body }>('/api/v0/auth/account-reset', { schema: { body } }, async (req) => {
    const { r, session } = await redeem(req, 'reset');
    if (r.failed) fail(403, 'Your password is changed, but your account has no active organisation. Open your invitation link again.');
    return { org: r.org, name: r.name, handle: r.handle ?? null, kind: r.kind ?? 'client', token: session, home: r.kind === 'client' ? '/client' : '/', maxAge: 2592000 };
  });
  app.post<{ Body: Body }>('/api/v0/auth/account-link-sign-in', { schema: { body } }, async (req) => {
    const { r, session } = await redeem(req, 'signin');
    if (r.failed) fail(403, 'Your account has no active organisation yet. Open your invitation link again.');
    return { org: r.org, name: r.name, handle: r.handle ?? null, kind: r.kind ?? 'client', token: session, home: r.kind === 'client' ? '/client' : '/', maxAge: 2592000 };
  });
  app.post<{ Body: Body }>('/api/v0/auth/account-confirm', { schema: { body } }, async (req) => {
    const { r } = await redeem(req, 'confirm');
    return { confirmed: true, email: r.email };
  });

  // A client's seat asks to use a new address: the confirmation goes to that address (nothing changes until it is used).
  app.post<{ Body: Body }>('/api/v0/client-portal/email', { schema: { body } }, async (req) => {
    const token = secret();
    const r = await tx(req, async (c) => {
      if (!(await c.query('select pulse.cp_viewer_conn() k')).rows[0].k) fail(403, 'This is for clients of this organisation');
      if (!clientMailAvailable()) fail(503, 'E-mail is not switched on here yet.');
      if (!await allow(req, 'account-email-change', 5)) fail(429, 'Too many requests. Try again in 15 minutes.');
      try { return (await c.query('select pulse.acct_email_change($1,$2) r', [text(req.body.email), sessionHash(token)])).rows[0].r; }
      catch (e) {
        const err = e as { code?: string; message?: string };
        const status = ({ '22023': 400, '23505': 409, '42501': 403, '54000': 429 } as Record<string, number>)[err.code ?? ''];
        if (status) fail(status, String(err.message)); throw e;
      }
    });
    const m = accountMail('confirm', r, accountLink(req, 'confirm', token));
    const sent = await clientMail({ to: r.to, subject: m.subject, body: m.body, company: r.org, replyTo: r.replyTo });
    if (!sent) fail(503, 'The e-mail could not be sent. Try again later.');
    return { ok: true, pending: r.to };
  });
}
