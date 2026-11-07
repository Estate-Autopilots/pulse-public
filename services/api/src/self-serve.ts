// ONBOARD-SELF (owner, 2 Nov 2026): "start your company on Pulse", self-serve. The routes around the start itself
// (accounts.ts /account/start and /account/invites carry the start and the invitations by e-mail):
//   * proving the account's e-mail with a 6-digit code (signed in), and the code before an account exists (signed out,
//     through /auth/signup, which oidc.ts hands here when it carries a step or a code);
//   * the first-run guide inside a company that started itself (checklist for leadership, tips per seat).
// Abuse safety: per-address and per-account limits (auth_allow, pulse.email_code, pulse.onboard_org), a proven e-mail
// before any company starts, and no address or domain claiming here (pulse.org_domain stays the operator's).
import { randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authIp } from './account-security.js';
import { answer } from './accounts.js';
import { pulseMail, pulseMailAvailable } from './auth-mail.js';
import { deviceLabel, passwordError } from './auth-policy.js';
import { CHECKLIST, SEAT, SEATS, onboardingPlan } from './self-serve-model.js';
import { fail, sessionHash, type Open, type Tx } from './routes.js';
import { hostCompany } from './tenant-context.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 20 } as const;
const text = (x: unknown, max = 200) => String(x ?? '').slice(0, max);
const device = (req: FastifyRequest) => deviceLabel(String(req.headers['x-pulse-device-agent'] ?? req.headers['user-agent'] ?? ''));
/** The stored form of a 6-digit code (never the code itself). */
export const codeHash = (code: string) => sessionHash(`email-code:${code}`);
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
const digits = (x: unknown) => String(x ?? '').replace(/\D/g, '').slice(0, 6);
export const CODE_SENT = 'A 6-digit code is on its way. It works for 15 minutes. No e-mail after a minute? Check spam, then ask for a new code.';
export const CODE_REFUSED = 'That code isn’t right or has expired. Codes work for 15 minutes; after five wrong tries ask for a new one.';
const codeMail = (code: string) => `Your Pulse code is ${code}\n\nType it on Pulse to confirm this e-mail address. It works for 15 minutes. Never share it: Pulse will never ask you for it.\n\nIf you didn't ask for it, ignore this e-mail: nothing happens without the code.`;

/** Plain sentences for the database's refusals (as accounts.ts). */
async function plain<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e) {
    const err = e as { code?: string; message?: string; statusCode?: number };
    if (err.statusCode) throw e;
    const status = ({ '42501': 403, '22023': 400, '23505': 409, P0002: 404, '54000': 429 } as Record<string, number>)[err.code ?? ''];
    if (status) fail(status, String(err.message ?? 'Not possible'));
    throw e;
  }
}

type Allow = (req: FastifyRequest, key: string, limit: number) => Promise<boolean>;
export const allowFor = (open: Open): Allow => (req, key, limit) =>
  open(async (c) => (await c.query('select pulse.auth_allow($1,$2) ok', [sessionHash(key + ':' + authIp(req)), limit])).rows[0].ok as boolean);

/** Signed out, /auth/signup with a step or a code: "Start your company on Pulse" for someone without an account.
 *  step 'code' mails a code to the address; step 'check' checks it (without using it up); with the code, the account
 *  (its e-mail proven) and the company are made and the answer carries a session there. */
export async function selfServeSignup(req: FastifyRequest<{ Body: Body }>, open: Open) {
  const allow = allowFor(open);
  const b = req.body ?? {};
  // A company's own address belongs to that company: a new company starts at Pulse's own address only.
  if (hostCompany()) fail(404, 'Start a new company from Pulse’s own address');
  const email = text(b.email, 254).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Give your e-mail address');
  if (b.step === 'code') {
    if (!await allow(req, 'start-code', 10)) fail(429, 'Too many codes from here. Try again in 15 minutes.');
    if (!pulseMailAvailable()) fail(503, 'E-mail is not set up on this Pulse yet, so no code can be sent. Ask your Pulse operator.');
    const code = newCode();
    const r = await open(async (c) => plain(async () => (await c.query('select pulse.signup_code_send($1,$2) r', [email, codeHash(code)])).rows[0].r));
    if (r.exists) fail(409, 'That e-mail already has a Pulse account. Sign in with it, then start your company from there.');
    if (r.send) await pulseMail(email, 'Your Pulse code', codeMail(code)).catch(() => false);
    return { ok: true, message: CODE_SENT };
  }
  const code = digits(b.code);
  if (b.step === 'check') {
    if (!await allow(req, 'start-check', 30)) fail(429, 'Too many tries. Try again in 15 minutes.');
    const ok = code.length === 6 && await open(async (c) => (await c.query('select pulse.signup_code_check($1,$2) ok', [email, codeHash(code)])).rows[0].ok as boolean);
    if (!ok) fail(400, CODE_REFUSED);
    return { ok: true };
  }
  if (!await allow(req, 'signup', 5)) fail(429, 'Too many sign-ups from here. Try again in 15 minutes.');
  if (code.length !== 6) fail(400, CODE_REFUSED);
  const password = text(b.password, 200); const problem = passwordError(password); if (problem) fail(400, problem);
  const company = (b.company && typeof b.company === 'object' ? b.company : {}) as Body;
  const plan = onboardingPlan(company); if ('error' in plan) fail(400, plan.error);
  const token = randomBytes(32).toString('base64url');
  const r = await open(async (c) => plain(async () => (await c.query('select pulse.account_signup_onboard($1,$2,$3,$4,$5) r', [
    JSON.stringify({ name: text(b.name, 120), handle: text(b.handle, 40), email, password }), JSON.stringify(plan), codeHash(code), sessionHash(token), device(req)])).rows[0].r));
  if (r?.badCode) fail(400, CODE_REFUSED);
  if (!r) fail(403, 'Pulse could not open your new company. Try signing in.');
  return { ...answer(r, token), code: r.code, maxAge: 2592000, home: '/start/team' };
}

export function registerSelfServeRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  const allow = allowFor(open);
  // The account's e-mail and whether it is proven (the wizard asks before the last step).
  app.get('/api/v0/account/verify-email', (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'A Pulse account belongs to a person');
    // Cloudflare Access proves the e-mail it carries.
    if (v.via === 'access' && v.email) await c.query('select pulse.account_email_proven($1)', [v.email]);
    return (await c.query('select pulse.account_email_state() s')).rows[0].s;
  }));
  // Send a code to the account's e-mail (or a new address for it).
  app.post<{ Body: Body }>('/api/v0/account/verify-email', { schema: { body } }, async (req) => {
    if (!await allow(req, 'verify-email', 20)) fail(429, 'Too many codes from here. Try again in 15 minutes.');
    if (!pulseMailAvailable()) fail(503, 'E-mail is not set up on this Pulse yet, so no code can be sent. Ask your Pulse operator.');
    const code = newCode();
    const r = await tx(req, async (c, v) => {
      if (!v.person || v.nativeDevice) fail(403, 'Confirm your e-mail from your browser account');
      return plain(async () => (await c.query('select pulse.account_email_verify_start($1,$2) r', [text(req.body?.email, 254), codeHash(code)])).rows[0].r);
    });
    if (r.send) await pulseMail(r.email, 'Your Pulse code', codeMail(code)).catch(() => false);
    return { email: r.email, verified: r.verified === true, message: r.verified ? 'Your e-mail is already confirmed.' : CODE_SENT };
  });
  app.post<{ Body: Body }>('/api/v0/account/verify-email/confirm', { schema: { body } }, async (req) => {
    if (!await allow(req, 'verify-email-confirm', 30)) fail(429, 'Too many tries. Try again in 15 minutes.');
    const code = digits(req.body?.code);
    const r = await tx(req, async (c, v) => {
      if (!v.person || v.nativeDevice) fail(403, 'Confirm your e-mail from your browser account');
      if (code.length !== 6) return { ok: false };
      return plain(async () => (await c.query('select pulse.account_email_verify_finish($1) r', [codeHash(code)])).rows[0].r);
    });
    if (!r.ok) fail(400, CODE_REFUSED);
    return r;
  });

  // The first-run guide in a company that started itself: null elsewhere (EA and operator-made companies see nothing).
  const guide = (state: Record<string, unknown> | null) => {
    if (!state) return { guide: null };
    const seat = SEAT.get(state.seat as never) ?? SEAT.get('staff')!;
    const done = new Map(((state.items ?? []) as { key: string; done: boolean }[]).map((i) => [i.key, i.done]));
    return { guide: { org: state.org, lead: state.lead, dismissed: state.dismissed, templates: state.templates, startedAt: state.startedAt,
      seat: { key: seat.key, label: seat.label, sees: seat.sees, wont: seat.wont, tips: seat.tips },
      // SELF-SERVE (1520): a space set up by its type brings its own cards (label, link and note come with each).
      space: state.space ?? null,
      items: !state.lead ? [] : state.cards ? (state.items as { key: string; label: string; href: string; note: string; done: boolean }[]).map((i) => ({ key: i.key, label: i.label, href: i.href, note: i.note, done: i.done === true }))
        : CHECKLIST.map((i) => ({ ...i, done: done.get(i.key) === true })) }, seats: SEATS };
  };
  app.get('/api/v0/account/onboarding', (req) => tx(req, async (c) => guide((await c.query('select pulse.onboarding_state() s')).rows[0].s)));
  app.post<{ Body: Body }>('/api/v0/account/onboarding', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Sign in as a person first');
    const item = text(req.body?.item, 20);
    return guide(await plain(async () => (await c.query('select pulse.onboarding_mark($1,$2) s', [item, req.body?.done !== false])).rows[0].s));
  }));
}
