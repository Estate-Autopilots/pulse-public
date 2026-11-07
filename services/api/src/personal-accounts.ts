// ACCOUNT-CODE (owner, 2 Nov 2026: Pulse as a SaaS): personal Pulse accounts sign in with a code e-mailed to the
// account's address (the same "E-mail me a sign-in code" as staff, account-security.ts), and sign up without a password:
// name and e-mail, an optional company, a code to the e-mail, then the account, its organisation and a session
// (1465 account_code_* and account_signup_*). Both are on at the shared address (the install's own, e.g.
// pulse.estateautopilots.com) and off at a company's own address unless that company allows personal accounts
// (pulse_priv.auth_policy.personal_accounts).
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { answer } from './accounts.js';
import { authIp } from './account-security.js';
import { authMail, authMailAvailable } from './auth-mail.js';
import { deviceLabel, otpCode, passwordError } from './auth-policy.js';
import { companyMailboxReady, hostedMailCompany } from './mailbox.js';
import { planFrom } from './self-serve-space.js';
import { fail, sessionHash, type Open } from './routes.js';
import { companyOrigin, requestCompany } from './tenant-context.js';
import { sharedAddress } from './shared-address.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 15, additionalProperties: true } as const;
const text = (v: unknown, max = 254) => String(v ?? '').slice(0, max);
const secret = () => randomBytes(32).toString('base64url');
const device = (req: FastifyRequest) => deviceLabel(String(req.headers['x-pulse-device-agent'] ?? req.headers['user-agent'] ?? ''));
const ACCOUNT_SESSION_AGE = 2592000;

export { sharedAddress } from './shared-address.js';

/** The organisation whose own address this is (null on the shared address). */
export const addressOrg = () => sharedAddress() ? null : requestCompany()?.hostOrg ?? null;

/** Personal accounts (passwordless sign-up, account code sign-in) are on here: always at the shared address; at a
 *  company's own address only when that company allows them. */
export async function personalAccountsHere(open: Open): Promise<boolean> {
  if (sharedAddress()) return true;
  const org = addressOrg();
  if (!org) return false;
  return open(async (c) => (await c.query('select pulse.personal_accounts_allowed($1) ok', [org])).rows[0].ok === true);
}

/** The e-mail with an account's sign-in code. */
export const accountCodeBody = (code: string, handle: string) => `Your Pulse sign-in code is ${code}\n\nType it on the Pulse sign-in page to sign in to your Pulse account${handle ? ` @${handle}` : ''}. It works once and expires in 10 minutes. Never share it: Pulse will never ask you for it.\n\nIf this wasn't you, ignore this e-mail: nobody can sign in without the code, and your password has not changed.`;
export const signupCodeBody = (code: string) => `Your Pulse sign-up code is ${code}\n\nType it on the Pulse sign-up page to confirm this e-mail and create your Pulse account. It works once and expires in 10 minutes. Never share it: Pulse will never ask you for it.\n\nIf you didn't ask to join Pulse, ignore this e-mail: no account is made without the code.`;
export const signupExistingBody = (origin: string) => `Someone (probably you) asked to create a Pulse account with this e-mail, but it already has one.\n\nSign in instead: ${origin}/login and choose "E-mail me a sign-in code". A code comes to this address; no password needed.\n\nIf this wasn't you, ignore this e-mail: nothing has changed.`;
export const SIGNUP_CODE_SENT = 'A 6-digit code is on its way to that e-mail. It works once, for 10 minutes. No e-mail after a minute? Check spam, then ask for a new code.';
const WRONG_CODE = 'That code isn’t right, has expired or was already used. Codes work once, for 10 minutes; after five wrong tries ask for a new one.';

/** A new account code for what was typed, or null; the caller e-mails it. Only after the staff code found nobody. */
export async function accountCodeIssue(c: PoolClient, input: string): Promise<{ code: string; delivery: string; handle: string; account: string } | null> {
  return (await c.query('select pulse.account_code_issue($1) d', [input])).rows[0].d;
}

/** Signing in to an account with its code: the account session's answer (as account-sign-in answers), or null. */
export async function accountCodeFinish(open: Open, req: FastifyRequest, input: string, code: string) {
  const token = secret(), challenge = secret();
  const r = await open(async (c) => (await c.query('select pulse.account_code_finish($1,$2,$3,$4,$5,$6) d', [input, code, sessionHash(token), device(req), addressOrg(), sessionHash(challenge)])).rows[0].d);
  if (!r) return null;
  // LOGIN-OTP: a seat with an authenticator: its code next (auth/two-step), not a refusal.
  if (r.twoStep && r.challenge === true) return { twoStep: true, challenge };
  if (r.failed) fail(401, r.twoStep ? 'Your account uses two-step verification: sign in with your username at your organisation\'s own Pulse address.'
    : 'Your account has no active organisation yet. Open your invitation link again, or create your account on Pulse.');
  return { ...answer(r, token), maxAge: ACCOUNT_SESSION_AGE, unify: false, mustChange: false };
}

/** LOGIN-OTP: the authenticator code for an account challenge (account sign-in or account code at the shared address):
 *  the account session's answer (the web keeps it for 30 days, as account-sign-in), or null. */
export async function accountTwoStepFinish(open: Open, req: FastifyRequest, challenge: string, code: string) {
  const token = secret();
  const r = await open(async (c) => (await c.query('select pulse.account_two_step_finish($1,$2,$3,$4) d', [sessionHash(challenge), code, sessionHash(token), device(req)])).rows[0].d);
  if (!r) return null;
  if (r.failed) fail(401, 'Your account has no active organisation yet. Open your invitation link again, or create your account on Pulse.');
  return { ...answer(r, token), maxAge: ACCOUNT_SESSION_AGE, unify: false, mustChange: false };
}

/** Database refusals in plain words (the functions raise with our own message). */
async function plain<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e) {
    const err = e as { code?: string; message?: string; statusCode?: number };
    if (err.statusCode) throw e;
    const status = ({ '22023': 400, '23505': 409, '54000': 429 } as Record<string, number>)[err.code ?? ''];
    if (status) fail(status, String(err.message ?? 'Not possible'));
    throw e;
  }
}

const signupFields = (b: Body) => ({ name: text(b.name, 120), handle: text(b.handle, 40).trim().replace(/^@/, '').toLowerCase(),
  email: text(b.email, 254).trim().toLowerCase(), orgName: text(b.orgName, 80) });

export function registerPersonalAccounts(app: FastifyInstance, { open }: { open: Open }) {
  const allow = (req: FastifyRequest, key: string, limit: number) => open(async (c) => (await c.query('select pulse.auth_allow($1,$2) ok', [sessionHash(key + ':' + authIp(req)), limit])).rows[0].ok as boolean);

  // Step 1: what a sign-up would be, checked (never whether the e-mail has an account), and a code to the e-mail. The
  // answer is the same, and takes the same time, whether a code, a "sign in instead" note or nothing (ration) went out.
  app.post<{ Body: Body }>('/api/v0/auth/signup-code', { schema: { body } }, async (req, reply) => {
    const started = Date.now();
    if (!await personalAccountsHere(open)) fail(404, 'Not found');
    if (!await allow(req, 'signup-code', 20)) fail(429, 'Too many sign-ups from here. Try again in 15 minutes.');
    const p = signupFields(req.body);
    const problem = await open(async (c) => (await c.query('select pulse.account_signup_problem($1) p', [JSON.stringify(p)])).rows[0].p as string | null);
    if (problem) fail(problem.startsWith('Someone already has') ? 409 : 400, problem);
    const result = await open(async (c) => {
      if (!authMailAvailable() && !(await companyMailboxReady(c))) { if (hostedMailCompany()) await c.query('select pulse.org_mail_blocked_note()'); return { mailUnavailable: true }; }
      const key = (await c.query('select pulse.auth_allow($1,10) ok', [sessionHash('signup-code-input:' + p.email)])).rows[0].ok;
      return key ? plain(async () => (await c.query('select pulse.account_signup_code_issue($1) d', [p.email])).rows[0].d) : null;
    });
    if (result?.mailUnavailable) return reply.code(503).send({ code: 'MAIL_UNAVAILABLE', error: 'E-mail is not set up here yet, so no code can be sent. Try again later.' });
    if (result) {
      const origin = companyOrigin().replace(/\/$/, '');
      setImmediate(() => { void (result.existing ? authMail(result.delivery, 'You already have a Pulse account', signupExistingBody(origin), '')
        : authMail(result.delivery, 'Your Pulse sign-up code', signupCodeBody(String(result.code)), '')).catch(() => false); });
    }
    await new Promise((done) => setTimeout(done, Math.max(0, 350 - (Date.now() - started))));
    return { ok: true, message: SIGNUP_CODE_SENT };
  });

  // CONSOLIDATION (1535): the sign-up page's "is this @handle free?". The answer is only available, taken or invalid
  // (never whose it is, an organisation or an e-mail), takes the same time either way, is rationed per address (120 a
  // quarter of an hour) and is off wherever sign-up is off. A handle kept as a redirect after an account merge is taken.
  app.post<{ Body: Body }>('/api/v0/auth/handle-check', { schema: { body } }, async (req) => {
    const started = Date.now();
    if (!await personalAccountsHere(open)) fail(404, 'Not found');
    if (!await allow(req, 'handle-check', 120)) fail(429, 'Too many checks from here. Try again in 15 minutes.');
    const handle = text(req.body?.handle, 40).trim().replace(/^@/, '').toLowerCase();
    const said = await open(async (c) => (await c.query('select pulse.handle_check($1) s', [handle])).rows[0].s as string);
    await new Promise((done) => setTimeout(done, Math.max(0, 150 - (Date.now() - started))));
    return { status: said === 'available' || said === 'taken' ? said : 'invalid' };
  });

  // Step 2: the code back, with the details (and a password only if one was chosen): the account, its organisation
  // (the company named, or a personal workspace) and a session, like account-sign-in's (the web keeps it as the cookie).
  app.post<{ Body: Body }>('/api/v0/auth/signup-confirm', { schema: { body } }, async (req) => {
    if (!await personalAccountsHere(open)) fail(404, 'Not found');
    if (!await allow(req, 'signup-confirm', 100)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const p = signupFields(req.body), password = text(req.body.password, 200), code = otpCode(text(req.body.code, 40));
    if (password) { const problem = passwordError(password); if (problem) fail(400, problem); }
    if (!/^\d{6}$/.test(code) || !p.email) fail(401, WRONG_CODE);
    const token = secret();
    // SELF-SERVE (owner, 4 Nov 2026): with the two answers ("Which describes you?", "What will you use Pulse for?") the
    // account opens on its first space set up for its type (self-serve-setup.ts), and lands where that space starts.
    if (req.body.setup !== undefined) {
      const plan = planFrom(req.body.setup, p.name);
      const r = await open(async (c) => plain(async () => (await c.query('select pulse.account_signup_setup($1,$2,$3,$4,$5) r', [JSON.stringify({ ...p, password }), code, sessionHash(token), device(req), JSON.stringify(plan)])).rows[0].r));
      if (!r) fail(401, WRONG_CODE);
      return { ...answer(r, token), maxAge: ACCOUNT_SESSION_AGE, personal: r.personal === true, home: String(r.home ?? '/') };
    }
    const r = await open(async (c) => plain(async () => (await c.query('select pulse.account_signup_confirm($1,$2,$3,$4) r', [JSON.stringify({ ...p, password }), code, sessionHash(token), device(req)])).rows[0].r));
    if (!r) fail(401, WRONG_CODE);
    const a = answer(r, token);
    // No company yet: the account home (Organisations), where Start your own Pulse opens one. SELFSERVE-P1: a company
    // just started opens on its first-run setup (/welcome), not the dashboard.
    return { ...a, maxAge: ACCOUNT_SESSION_AGE, personal: r.personal === true, home: r.personal === true ? '/orgs' : '/welcome' };
  });
}
