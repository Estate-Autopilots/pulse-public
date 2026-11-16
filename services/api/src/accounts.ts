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
import { fail, failCode, sessionHash, type Open, type Tx } from './routes.js';
import { requestCompany } from './tenant-context.js';
import { linkOrigin } from './connect.js';
import { PACK, PACKS, packPayload } from './flow/packs.js';
import { pulseMail } from './auth-mail.js';
import { CHANNELS, SEAT, inviteMail, inviteText, onboardingPlan, type Channel, type SeatKey } from './self-serve-model.js';
import { planFrom } from './self-serve-space.js';
import { parentToken, tabChild, tabToken } from './tab-session.js';
import { browserToken, deviceForget, deviceOf, trustDevice } from './device-trust.js';
import { companyOrigin } from './tenant-context.js';
import { answerChallenge, authenticationOptions, registrationOptions, verifyAssertion, verifyRegistration, type KnownPasskey } from './webauthn.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 20 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const text = (x: unknown, max = 200) => String(x ?? '').slice(0, max);
const secret = () => randomBytes(32).toString('base64url');
const device = (req: FastifyRequest) => deviceLabel(String(req.headers['x-pulse-device-agent'] ?? req.headers['user-agent'] ?? ''));
const id = (x: unknown, what = 'Choose a valid record') => UUID.test(String(x)) ? String(x) : fail(400, what);

/** Plain sentences for the database's refusals (they arrive as Postgres errors with our own message).
 *  BUGFIX #29: ACCOUNT-META's "sign in as yourself" refusal (hint personal_sign_in) keeps its reason as the answer's code,
 *  so the switcher asks "Confirm it's you" (POST account/prove) instead of a dead end. */
export async function plain<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e) {
    const err = e as { code?: string; message?: string; statusCode?: number; hint?: string };
    if (err.statusCode) throw e;
    const status = ({ '42501': 403, '22023': 400, '23505': 409, P0002: 404, '28000': 401, '54000': 429 } as Record<string, number>)[err.code ?? ''];
    if (status && err.hint === 'personal_sign_in') failCode(status, String(err.message ?? 'Not possible'), 'personal_sign_in');
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

/** ACCOUNT-META: the e-mail with the code that proves a new sign-in e-mail. */
export const addEmailBody = (code: string, handle: string) => `Your Pulse code is ${code}\n\nType it in Settings → Account access to add this e-mail to your Pulse account${handle ? ` @${handle}` : ''}. It works once and expires in 10 minutes.\n\nOnly add a mailbox that you alone read: anyone who reads it could sign in as you. If you did not ask for this, ignore this e-mail; nothing changes.`;

/** SWITCH-SMOOTH: the e-mail with the code for "Confirm it's you" (to the account's own e-mail only). */
export const proveCodeBody = (code: string) => `Your Pulse code is ${code}\n\nType it in Pulse to confirm it's you. Then all your companies open on that device without asking again. The code works once and expires in 10 minutes.\n\nIf you did not ask for this, ignore this e-mail; nothing changes.`;

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

/** ORG-PER-TAB: the company `org` opened in the asking tab (its child session of the browser's sign-in, reopened if
 *  it was signed out here). The answer is a switch's without a token; a company the account is not in is "Not found". */
async function openInTab(c: PoolClient, req: FastifyRequest, org: string) {
  const parent = parentToken(req) ?? fail(401, 'Sign in to Pulse');
  const row = (await c.query('select * from pulse.account_tab_session($1,$2,$3,true)', [sessionHash(parent), sessionHash(tabToken(parent, org)), org])).rows[0];
  // BUGFIX #29 / ACCOUNT-META (2125, 2142): a company's own sign-in opens that company only: the switch's sentence and
  // code, so the switcher asks "Confirm it's you" (account/prove) and opens it then.
  if (row?.state === 'personal') failCode(403, String((await c.query('select pulse.acct_personal_needed() t')).rows[0].t), 'personal_sign_in');
  if (!row || row.state === 'closed') fail(404, 'Not found');
  const o = ((await c.query('select pulse.account_me() a')).rows[0].a?.orgs ?? []).find((x: { id: string }) => x.id === org) as { name?: string; handle?: string | null; kind?: string } | undefined;
  return { org, name: String(o?.name ?? 'your company'), handle: o?.handle ?? null, kind: String(o?.kind ?? 'staff'), hostOwn: requestCompany()?.hostOrg === org,
    home: o?.kind === 'client' ? '/tasks' : '/', tab: true };
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
  // Switch organisation: the same human there, no sign-in again. AUTH-UNIFY (1291): a signed-in session moves itself to
  // the other organisation (the same token, so the browser keeps its cookie; membership checked, audited in both); only an
  // Access identity, which has no session to move, gets a new one there.
  app.post<{ Body: Body }>('/api/v0/account/switch', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Switch organisations from your browser account');
    const org = id(req.body.org, 'Choose an organisation');
    // ORG-PER-TAB: from a tab in another company (a child session), the switch opens the company in that tab only.
    if (tabChild(req)) return openInTab(c, req, org);
    const current = req.headers['x-pulse-session'];
    if (v.via === 'password' && typeof current === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(current)) {
      const r = await plain(async () => (await c.query('select pulse.account_move($1,$2) r', [org, sessionHash(current)])).rows[0].r);
      return answer(r, current);
    }
    const token = secret();
    const r = await plain(async () => (await c.query('select pulse.account_switch($1,$2,$3) r', [org, sessionHash(token), device(req)])).rows[0].r);
    return answer(r, token);
  }));
  // BUGFIX #29 (2142): "Confirm it's you". A company's own sign-in opens that company only (ACCOUNT-META); typing the
  // account's own Pulse password once makes this browser session the person's, so the switch they asked for goes
  // through without signing out. Rationed per address and per account; wrong passwords count toward the account's lock.
  app.post<{ Body: Body }>('/api/v0/account/prove', { schema: { body } }, async (req) => {
    if (!await allow(req, 'account-prove', 20)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const r = await tx(req, async (c, v) => {
      if (!v.person || v.nativeDevice || v.via !== 'password') fail(403, 'Confirm it is you from the browser you signed in on');
      return plain(async () => (await c.query('select pulse.account_prove($1) r', [text(req.body.password, 200)])).rows[0].r as { personal?: boolean; wrong?: boolean });
    });
    if (r?.wrong) fail(401, 'That is not your Pulse password. Try again, or use “Forgot your password?” on the sign-in page.');
    // SWITCH-SMOOTH: this browser proved the person: it is theirs for 180 days (device-trust.ts).
    if (r?.personal === true) await trustDevice(open, req, browserToken(req.headers), 'password', sessionHash);
    return { personal: r?.personal === true };
  });
  // SWITCH-SMOOTH (2165, owner 16 Nov 2026: "I don't even know what my password is"): "Confirm it's you" in one tap. A
  // 6-digit code goes to the account's own e-mail (its main personal sign-in e-mail: never a shared mailbox like admin@,
  // never a company's record), then the code makes this browser's sign-in the person's, and the browser is trusted for
  // 180 days. One code a minute, five an hour, five tries; rationed per address too.
  app.post<{ Body: Body }>('/api/v0/account/prove-code', { schema: { body } }, async (req) => {
    const action = text(req.body.action, 10);
    const r = await tx(req, async (c, v) => {
      // Signed out answers 401 first (tx), then what was asked is checked.
      if (!v.person || v.nativeDevice || v.via !== 'password') fail(403, 'Confirm it is you from the browser you signed in on');
      if (action !== 'send' && action !== 'finish') fail(400, 'Choose send or finish');
      if (!await allow(req, 'account-prove-code-' + action, action === 'send' ? 10 : 30)) fail(429, 'Too many attempts. Try again in 15 minutes.');
      return plain(async () => (action === 'send'
        ? (await c.query('select pulse.account_prove_code_start() r')).rows[0].r
        : (await c.query('select pulse.account_prove_code_finish($1) r', [text(req.body.code, 20)])).rows[0].r) as
        { personal?: boolean; noEmail?: boolean; wrong?: boolean; expired?: boolean; code?: string; delivery?: string; masked?: string });
    });
    if (r?.personal) { await trustDevice(open, req, browserToken(req.headers), 'code', sessionHash); return { personal: true }; }
    if (action === 'finish') failCode(401, r?.expired ? 'That code has run out. Send a new one.' : 'That code is not right. Check the newest e-mail from Pulse, or send a new code.', r?.expired ? 'code_expired' : 'code_wrong');
    if (r?.noEmail || !r?.delivery) failCode(409, 'Your account has no e-mail of your own yet, so Pulse cannot send a code. Use your Pulse password, or add your own e-mail in Settings → Account access.', 'no_own_email');
    const ok = await pulseMail(r.delivery, 'Your Pulse code', proveCodeBody(String(r.code)));
    await open((c) => c.query('select pulse.account_mail_result(null,$1,$2)', ['account_code', ok])).catch(() => null);
    if (!ok) fail(503, 'The code could not be sent right now. Try again in a minute, or use your Pulse password.');
    return { sent: true, to: String(r.masked ?? ''), resendIn: 60 };
  });
  // SWITCH-SMOOTH (2178, owner: "If anything, passkey or a PIN"): the account's own passkeys. Adding one needs a sign-in that
  // already proved the person (a company's own sign-in never adds one); proving with one makes this browser's sign-in the
  // person's in one tap (Windows Hello, a fingerprint, a phone) and trusts the browser. The relying party is the address
  // the person is on; @simplewebauthn/server checks every answer (webauthn.ts) and only the public key is kept.
  app.get('/api/v0/account/passkeys', (req) => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Open Account access from your browser account');
    return plain(async () => (await c.query('select pulse.account_passkeys() r')).rows[0].r);
  }));
  app.post<{ Body: Body }>('/api/v0/account/passkey', { schema: { body } }, async (req) => {
    const action = text(req.body.action, 20);
    const r = await tx(req, async (c, v) => {
      // Signed out answers 401 first (tx), then what was asked is checked.
      if (!v.person || v.nativeDevice || v.via !== 'password') fail(403, 'Use passkeys from the browser you signed in on');
      if (!['register-options', 'register', 'prove-options', 'prove', 'remove'].includes(action)) fail(400, 'Choose what to do with the passkey');
      if (!await allow(req, 'account-passkey-' + action, 30)) fail(429, 'Too many attempts. Try again in 15 minutes.');
      const origin = companyOrigin(), rpID = new URL(origin).hostname;
      if (action === 'remove') return plain(async () => (await c.query('select pulse.account_passkey_remove($1) r', [id(req.body.id, 'Choose a passkey')])).rows[0].r);
      if (action === 'register-options' || action === 'prove-options') {
        const bytes = randomBytes(32);
        const begun = await plain(async () => (await c.query('select pulse.account_passkey_begin($1,$2) r', [action === 'register-options' ? 'register' : 'prove', bytes.toString('base64url')])).rows[0].r) as
          { account: string; name: string; display: string; credentials: KnownPasskey[] } | null;
        if (!begun) failCode(404, 'There is no passkey on your account yet.', 'no_passkey');
        return action === 'register-options'
          ? registrationOptions({ rpID, challenge: bytes, userId: begun!.account, name: begun!.name, display: begun!.display, exclude: begun!.credentials })
          : authenticationOptions({ rpID, challenge: bytes, allow: begun!.credentials });
      }
      const response = req.body.response, ch = answerChallenge(response);
      if (!ch) fail(400, 'This passkey answer could not be read. Try again.');
      if (action === 'register') {
        const cred = await verifyRegistration({ response, challenge: ch!, origin, rpID });
        if (!cred) fail(400, 'This passkey could not be checked. Try again.');
        const added = (await c.query('select pulse.account_passkey_add($1,$2) r', [ch, JSON.stringify({ ...cred, name: text(req.body.name, 60) })])).rows[0].r as { ok?: boolean; error?: string };
        if (added?.error) fail(400, added.error);
        return { ok: true };
      }
      const credId = (response as { id?: unknown } | null)?.id;
      if (typeof credId !== 'string' || credId.length > 1024) fail(400, 'This passkey answer could not be read. Try again.');
      const key = (await c.query('select pulse.account_passkey_for($1,$2) r', [ch, credId])).rows[0].r as { publicKey: string; counter: number; transports: string[] } | null;
      const count = key ? await verifyAssertion({ response, challenge: ch!, origin, rpID, credential: { id: credId as string, ...key } }) : null;
      // Not this account's passkey, or the signature does not hold: the ceremony is used up and nothing is proved.
      const proved = (await c.query('select pulse.account_passkey_prove($1,$2,$3) r', [ch, count === null ? '' : credId, count ?? 0])).rows[0].r as { personal?: boolean; wrong?: boolean };
      return proved;
    });
    if (action === 'prove') {
      if (!(r as { personal?: boolean })?.personal) failCode(401, 'That passkey did not work here. Try again, or use the code we e-mail you.', 'passkey_wrong');
      await trustDevice(open, req, browserToken(req.headers), 'passkey', sessionHash);
      return { personal: true };
    }
    return r;
  });
  // SWITCH-SMOOTH: before a switch starts, which of my companies this sign-in may not open yet and how it can prove me
  // (the switcher shows a lock on those and asks first, instead of "Opening…" and then a refusal).
  app.get('/api/v0/account/crossing', (req) => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'A Pulse account belongs to a person');
    return plain(async () => (await c.query('select pulse.account_crossing() r')).rows[0].r);
  }));
  // SWITCH-SMOOTH: Settings -> Account access: the browsers I proved myself on (trusted for 180 days), and "Forget".
  app.get('/api/v0/account/devices', (req) => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Open Account access from your browser account');
    return plain(async () => (await c.query('select pulse.account_devices($1) r', [deviceOf(req.headers)])).rows[0].r);
  }));
  app.post<{ Body: Body }>('/api/v0/account/devices', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Change your sign-in from your browser account');
    if (req.body.action !== 'forget') fail(400, 'Choose what to do with the device');
    const one = req.body.all === true ? null : id(req.body.id, 'Choose a device');
    const r = await plain(async () => (await c.query('select pulse.account_device_forget($1,$2) r', [one, deviceOf(req.headers)])).rows[0].r);
    deviceForget();
    return r;
  }));
  // ACCOUNT-META (2125, owner 15 Nov 2026): Settings -> Account access. The e-mails that sign this account in (only ones the
  // person alone reads; never a shared mailbox like admin@), its sessions in every company, and whether this sign-in
  // proved the person (a company's own sign-in opens that company only and cannot change any of this).
  app.get('/api/v0/account/access', (req) => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Open Account access from your browser account');
    return plain(async () => (await c.query('select pulse.account_access() a')).rows[0].a);
  }));
  // Add (a code to the address, then "only I can read this mailbox"), remove, or make an e-mail the main one.
  app.post<{ Body: Body }>('/api/v0/account/emails', { schema: { body } }, async (req) => {
    const action = text(req.body.action, 10), email = text(req.body.email, 254).trim().toLowerCase();
    const r = await tx(req, async (c, v) => {
      // Signed out answers 401 first (tx), then what was asked is checked.
      if (!v.person || v.nativeDevice) fail(403, 'Change your sign-in from your browser account');
      if (!['start', 'finish', 'remove', 'primary'].includes(action)) fail(400, 'Choose what to do with the e-mail');
      if ((action === 'start' || action === 'finish') && !await allow(req, 'account-email-' + action, 30)) fail(429, 'Too many attempts. Try again in 15 minutes.');
      return plain(async () => action === 'start' ? (await c.query('select pulse.account_email_start($1) d', [email])).rows[0].d
        : action === 'finish' ? (await c.query('select pulse.account_email_finish($1,$2,$3) d', [email, text(req.body.code, 12), req.body.own === true])).rows[0].d
        : action === 'remove' ? (await c.query('select pulse.account_email_remove($1) d', [email])).rows[0].d
        : (await c.query('select pulse.account_email_primary($1) d', [email])).rows[0].d);
    });
    if (action !== 'start') return r;
    const ok = await pulseMail(r.delivery, 'Your Pulse code to add this e-mail', addEmailBody(String(r.code), String(r.handle ?? '')));
    await open((c) => c.query('select pulse.account_mail_result(null,$1,$2)', ['login_email', ok])).catch(() => null);
    if (!ok) fail(503, 'The code could not be sent right now. Try again in a minute.');
    return { sent: true, to: String(r.masked ?? ''), resendIn: 60 };
  });
  // ORG-PER-TAB (owner, 14 Nov 2026): open one of my companies in this browser tab only. The browser's sign-in stays
  // where it is (other tabs keep their company); this company's session of the same account opens beside it
  // (tab-session.ts, 2141 account_tab_session: members only; a company signed out of here opens again). The answer
  // carries no token: the web keeps the company per tab. An Access identity without a session gets one there, as Switch.
  app.post<{ Body: Body }>('/api/v0/account/tab-open', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Open companies from your browser account');
    const org = id(req.body.org, 'Choose a company');
    if (parentToken(req)) return openInTab(c, req, org);
    const token = secret();
    const r = await plain(async () => (await c.query('select pulse.account_switch($1,$2,$3) r', [org, sessionHash(token), device(req)])).rows[0].r);
    return answer(r, token);
  }));
  // ORG-PER-TAB: a link to a record (doc, task, project) that is not in this company: which other company of my account
  // has it and lets me see it (2141 account_record_home). Any other company answers as a record that does not exist.
  app.get<{ Querystring: { kind?: string; id?: string } }>('/api/v0/account/record-home', (req) => tx(req, async (c, v) => {
    if (!v.person) fail(404, 'Not found');
    const kind = ['doc', 'task', 'project'].includes(String(req.query.kind)) ? String(req.query.kind) : fail(404, 'Not found');
    const r = (await c.query('select pulse.account_record_home($1,$2) r', [kind, id(req.query.id, 'Not found')])).rows[0].r;
    return r ?? fail(404, 'Not found');
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
  // CA-ACCESS (1892): Add people -> pick what they are. A row is { seat, channel, email?, name?, caSalaries? }: by e-mail
  // the API mails the link (as ONBOARD-SELF did); by SMS or WhatsApp the link and a ready message come back once, and the
  // inviter's own phone sends it (nothing leaves the server, and no phone number is kept).
  const inviteByEmail = async (req: FastifyRequest<{ Body: Body }>) => {
    const seen = new Set<string>(); const tokens = new Map<number, string>();
    const rows = (req.body.rows as Body[]).slice(0, 51).flatMap((x, i) => {
      const channel = (CHANNELS as readonly string[]).includes(text(x?.channel, 10)) ? text(x?.channel, 10) as Channel : 'email';
      const email = channel === 'email' ? text(x?.email, 254).trim().toLowerCase() : '';
      const seat = text(x?.seat, 20) || 'staff';
      if (channel === 'email') { if (seen.has(email)) return []; seen.add(email); }
      const token = secret(); tokens.set(i, token);
      return [{ i, email, seat, channel, name: text(x?.name, 120), caSalaries: x?.caSalaries === true, hash: sessionHash(token), title: SEAT.get(seat as SeatKey)?.label ?? '' }];
    });
    const made = await tx(req, async (c, v) => ({
      rows: await plain(async () => (await c.query('select pulse.onboard_invites($1) r', [JSON.stringify({ rows: rows.map(({ i: _i, ...r }) => r) })])).rows[0].r) as { id?: string; email: string; seat: SeatKey; channel: Channel; name?: string | null; status: string; hasAccount?: boolean }[],
      org: String((await c.query('select name from pulse.org where id = pulse.current_org()')).rows[0]?.name ?? 'Pulse'), by: v.name }));
    const mailed: string[] = [];
    const out = [];
    for (const [k, r] of made.rows.entries()) {
      if (r.status !== 'created' || !r.id) { out.push({ email: r.email, name: r.name ?? null, seat: r.seat, channel: r.channel, status: r.status, mailed: false, link: null }); continue; }
      const url = new URL('/join', linkOrigin(req)); url.hash = tokens.get(rows[k].i)!;
      if (r.channel !== 'email') {
        out.push({ email: null, name: r.name ?? null, seat: r.seat, channel: r.channel, status: r.status, mailed: false, link: url.href,
          message: inviteText({ org: made.org, by: made.by, seat: r.seat, link: url.href }) });
        continue;
      }
      const mail = inviteMail({ org: made.org, by: made.by, seat: r.seat, link: url.href, hasAccount: r.hasAccount === true });
      const ok = await pulseMail(r.email, mail.title, mail.body).catch(() => false);
      if (ok) mailed.push(r.id);
      out.push({ email: r.email, name: r.name ?? null, seat: r.seat, channel: r.channel, status: r.status, hasAccount: r.hasAccount === true, mailed: ok, link: ok ? null : url.href,
        message: ok ? null : inviteText({ org: made.org, by: made.by, seat: r.seat, link: url.href }) });
    }
    if (mailed.length) await tx(req, async (c) => c.query('select pulse.onboard_invite_mailed($1::uuid[])', [mailed]));
    return { rows: out, ...(out.some((r) => r.link) ? { warning: 'Send each link privately; it is shown only now.' } : {}) };
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
    // CA-ACCESS: a signed-in session moves itself into the company just joined, as Switch does (AUTH-UNIFY 1291), so a
    // finished second step carries over: a CA who accepts a second company keeps the books open in both.
    const current = req.headers['x-pulse-session'];
    // ORG-PER-TAB: a tab's company session (a child) is never moved; the company just joined opens in that tab.
    if (tabChild(req) && r.org) return openInTab(c, req, String(r.org));
    if (v.via === 'password' && typeof current === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(current) && r.org) {
      await c.query('savepoint carry_session');
      try {
        const moved = (await c.query('select pulse.account_move($1,$2) r', [r.org, sessionHash(current)])).rows[0].r;
        if (moved) return answer(moved, current);
      } catch { await c.query('rollback to savepoint carry_session'); }
    }
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
    // IDENTITY-UNIFY (1746): an old username (or old handle) of one account signs in as that account's handle.
    const typed = text(req.body.login ?? req.body.username, 254).trim().toLowerCase();
    const login = await open(async (c) => String((await c.query('select pulse.login_alias($1) l', [typed])).rows[0].l ?? typed));
    // SIGNIN-OFFICE: per address an office's worth (the sign-in form tries this first for every person); 20 per login.
    if (!await allow(req, 'account-login', 300) || !await allow(req, 'account-login:' + login, 20)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const token = secret(), challenge = secret();
    // LOGIN-OTP (owner, 6 Nov 2026): an authenticator on a seat no longer sends people to their organisation's own address:
    // the right password opens a 5-minute challenge, finished with the authenticator code on auth/two-step.
    const r = await open(async (c) => (await c.query('select pulse.account_sign_in($1,$2,$3,$4,$5) r', [login, text(req.body.password, 200), sessionHash(token), device(req), sessionHash(challenge)])).rows[0].r);
    if (r?.twoStep && r?.challenge === true) return { twoStep: true, challenge };
    // IDENTITY-SIGNIN (1841): the company has this person under an e-mail that already has its own account: no second
    // account is made; that account accepts the company's invitation instead.
    if (r?.failed && r.linkPending) fail(409, 'This company has you under an e-mail that already has its own account. Sign in to that account (E-mail me a code works) and accept this company’s invitation there: the company is then added to it.');
    if (!r || r.failed) fail(401, r?.noOrg ? 'Your account has no active organisation yet. Open your invitation link again.'
      : r?.twoStep ? 'Your account uses two-step verification: sign in with your username at your organisation\'s own Pulse address.'
      : r?.ambiguous ? 'That sign-in matches more than one person. Use your username at your organisation\'s own Pulse address.'
      : 'Sign-in details are unavailable or temporarily locked. Wait 15 minutes or use your organisation\'s sign-in.');
    // AUTH-UNIFY: unify asks once for one password for all workspaces; mustChange opens the issued-password change first.
    // IDENTITY-SIGNIN: "Keep me signed in" unticked: the web keeps this session as a browser-session cookie.
    // ACCOUNT-META (2125): companyOnly: a company's own password opened that company only (the account has a sign-in of its own).
    // SWITCH-SMOOTH: the account's own password proved the person on this browser (the proxy keeps its device key now).
    await trustDevice(open, req, token, 'password', sessionHash, true);
    return { ...answer(r, token), maxAge: 2592000, unify: r.unify === true, mustChange: r.mustChange === true, companyOnly: r.companyOnly === true, ...(req.body.remember === false ? { remember: false } : {}) };
  });

  // The portable profile: what travels with me, and what each organisation may see.
  // IDENTITY-UNIFY (1746): names = the one @handle, the old names that still find the person, and any company where
  // their username stayed its own because someone else there has the handle.
  app.get('/api/v0/account/profile', (req) => tx(req, async (c) => {
    const r = (await c.query('select pulse.account_profile_get() p, pulse.account_names() n')).rows[0];
    return r.p ? { ...r.p, names: r.n } : r.p;
  }));
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
