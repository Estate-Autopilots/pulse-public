// MAILBOX (owner, 28 Oct 2026): every company on the platform sends its own sign-in, invitation, reset and HR mail from
// its own Google Workspace mailbox. Only the install's company had a sender (the server's Google mailbox, ADR-0032);
// another company's mail was dropped. Now its admin connects the mailbox once (Settings → Mail → Connect):
//  * Google sign-in as the sending account (e.g. hr@company.com), authorization code + PKCE S256, scopes
//    `openid email` + `gmail.send` only (Pulse can send, never read). The state is bound to the admin and their session
//    (migration 1370, org_mailbox_attempt); it comes back to the web page /settings/mailbox/google, which posts it here.
//  * The refresh token is sealed with the document keyring before it reaches the database (document-keys.ts, bound to
//    the company: `<org>/mailbox/google`), is never returned to a browser and never logged. The worker opens it with
//    pulse_sdk.document_keys for queued HR mail (notifications.py); this module opens it for sign-in and invitation mail.
//  * The OAuth client: the company's own (its folder of the secret store, `google-mail.json`, installed with
//    `pulse-connect google-client --purpose mail`), else the platform's (PULSE_MAIL_GOOGLE_CLIENT_ID with
//    PULSE_MAIL_GOOGLE_CLIENT_SECRET or PULSE_MAIL_GOOGLE_CLIENT_SECRET_FILE). Neither set: Connect says so, nothing else changes.
//  * The install's own company keeps its server mailbox exactly as before; nothing here applies to it.
//  * A non-production host mails only its staging allow-list and the mailbox's own address (as the install sender does).
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { admin, fail, failCode, sessionHash, type Open, type Tx, type Viewer } from './routes.js';
import { open as openSealed, requireKeyring, seal } from './document-keys.js';
import { companyOrigin, requestCompany } from './tenant-context.js';
import { companyOAuthClient } from './google-client.js';
import { platformMail } from './platform-config.js';

type Body = Record<string, unknown>;
export const MAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const MAILBOX_CALLBACK = '/settings/mailbox/google';
/** Google's endpoints (tests point them at a synthetic Google). */
export const mailGoogle = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo', send: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
  revoke: 'https://oauth2.googleapis.com/revoke',
};
/** What an admin or HR reads when Pulse could not e-mail because the company has no mailbox (the web shows Connect). */
export const MAILBOX_MISSING = 'Pulse can’t send e-mail for this company yet: connect your Google Workspace mailbox in Settings → Mail (an organisation admin does this once). Nothing was sent.';
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const context = (org: string) => `${org}/mailbox/google`;
const sink = () => process.env.PULSE_CI === '1' || process.env.NODE_ENV === 'test' || process.env.PULSE_AUTH_MAIL_MODE === 'sink';

export type MailClient = { kind: 'platform' | 'company'; clientId: string; clientSecret: string };
/** The OAuth client a company's mailbox signs in with: its own, else the platform's; `kind` asks for one of them. */
export function mailClient(org: string, kind?: 'platform' | 'company'): MailClient | null {
  if (kind !== 'platform') {
    const own = companyOAuthClient(org, 'google-mail');
    if (own) return { kind: 'company', clientId: own.clientId, clientSecret: own.clientSecret };
    if (kind === 'company') return null;
  }
  const id = process.env.PULSE_MAIL_GOOGLE_CLIENT_ID?.trim();
  let secret = process.env.PULSE_MAIL_GOOGLE_CLIENT_SECRET?.trim() ?? '';
  if (!secret && process.env.PULSE_MAIL_GOOGLE_CLIENT_SECRET_FILE) {
    try { secret = readFileSync(process.env.PULSE_MAIL_GOOGLE_CLIENT_SECRET_FILE, 'utf8').trim(); } catch { secret = ''; }
  }
  return id && secret ? { kind: 'platform', clientId: id, clientSecret: secret } : null;
}

/** The company of this request when it is not the install's own (the install keeps its server mailbox). */
export function hostedMailCompany(): string | null {
  const r = requestCompany();
  return r?.company && r.company.org !== r.installOrg ? r.company.org : null;
}

class MailboxError extends Error { constructor(message: string, readonly reconnect = false) { super(message); } }
async function google(url: string, init: RequestInit): Promise<Body> {
  let r: Response;
  try { r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) }); }
  catch { throw new MailboxError('Google did not answer. Try again in a minute.'); }
  const data = await r.json().catch(() => ({})) as Body;
  if (!r.ok) {
    const code = String(data.error ?? '');
    // invalid_grant: the mailbox's owner removed Pulse's access, changed the password or the admin blocked the app.
    if (code === 'invalid_grant' || r.status === 401) throw new MailboxError('Google no longer accepts Pulse for this mailbox: connect it again.', true);
    throw new MailboxError(`Google refused (${r.status}${code ? ` ${code.replace(/[^\w.-]/g, '').slice(0, 40)}` : ''}).`);
  }
  return data;
}
const form = (x: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(x).toString() });

// Access tokens live an hour; kept in memory per company and refresh token (a reconnect gets a new one).
const tokens = new Map<string, { key: string; token: string; until: number }>();
type Sealed = { address: string; client: 'platform' | 'company'; key_id: string; token_wrapped: Buffer; token_sealed: Buffer };
async function accessToken(org: string, m: Sealed) {
  const key = createHash('sha256').update(m.token_sealed).digest('hex');
  const hit = tokens.get(org);
  if (hit && hit.key === key && hit.until > Date.now() + 60_000) return hit.token;
  const client = mailClient(org, m.client) ?? (() => { throw new MailboxError('The Google sign-in this mailbox was connected with is no longer set up on this Pulse: connect it again.', true); })();
  const ring = await requireKeyring('mail');
  const plain = openSealed(ring, { keyId: m.key_id, dataKey: m.token_wrapped, data: m.token_sealed }, context(org));
  let refresh: string;
  try { refresh = plain.toString('utf8'); } finally { plain.fill(0); }
  const t = await google(mailGoogle.token, form({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' }));
  if (typeof t.access_token !== 'string') throw new MailboxError('Google gave no access for this mailbox: connect it again.', true);
  tokens.set(org, { key, token: t.access_token, until: Date.now() + Math.max(60, Number(t.expires_in ?? 3600)) * 1000 });
  return t.access_token;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const header = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
/** A plain-text message, From the company's name and its mailbox. */
export function mimeMessage(m: { from: string; fromName?: string | null; to: string; subject: string; body: string }) {
  const name = (m.fromName ?? '').replace(/["\\\r\n]/g, '').trim().slice(0, 80);
  const lines = [`From: ${name ? `"${header(name)}" ` : ''}<${m.from}>`, `To: <${m.to}>`, `Subject: ${header(m.subject.replace(/[\r\n]+/g, ' ').slice(0, 200))}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(m.body).replace(/.{76}/g, '$&\r\n')];
  return lines.join('\r\n');
}

/** Tests read what would have gone out (CI and the mail sink never reach Google). */
export const testCompanyMail: { org: string; from: string; to: string; title: string; body: string }[] = [];

// Mail goes out after the request that caused it (no transaction at hand): through the tenant connection the routes
// register, inside the request's company.
let reader: Open | null = null;
/** Send from the company's own mailbox. `no_mailbox`: none connected (counted for the admin); `refused`: this host may
 *  not mail that address; `failed`: Google refused (recorded on the mailbox, shown in Settings → Mail). */
type Run = <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;
export async function companyMail(org: string, to: string, title: string, body: string, within?: Run): Promise<'sent' | 'no_mailbox' | 'refused' | 'failed'> {
  const run: Run | null = within ?? (reader ? (fn) => reader!((c) => fn(c)) : null);
  if (!run || !EMAIL.test(to)) return 'failed';
  const found = await run(async (c) => {
    const m = (await c.query('select * from pulse.org_mailbox_sealed()')).rows[0] as Sealed | undefined;
    if (!m) { await c.query('select pulse.org_mail_blocked_note()'); return null; }
    const name = (await c.query('select name from pulse.org where id=pulse.current_org()')).rows[0]?.name as string | undefined;
    return { m, name: name ?? null };
  }).catch(() => undefined);
  if (found === undefined) return 'failed';
  if (!found) return 'no_mailbox';
  const { m, name } = found;
  const recipient = to.trim().toLowerCase();
  if (sink()) { testCompanyMail.push({ org, from: m.address, to: recipient, title, body }); return 'sent'; }
  if (!allowedRecipient(recipient, m.address)) return 'refused';
  try {
    const token = await accessToken(org, m);
    await google(mailGoogle.send, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(mimeMessage({ from: m.address, fromName: name, to: recipient, subject: title, body })).toString('base64url') }) });
    await run((c) => c.query('select pulse.org_mailbox_report(true)')).catch(() => {});
    return 'sent';
  } catch (e) {
    if (e instanceof MailboxError && e.reconnect) tokens.delete(org);
    const reason = e instanceof MailboxError ? e.message : 'Sending failed.';
    await run((c) => c.query('select pulse.org_mailbox_report(false,$1)', [reason])).catch(() => {});
    return 'failed';
  }
}

/** Production mails anyone; any other host only its staging allow-list and the mailbox's own address. */
export function allowedRecipient(to: string, mailbox: string) {
  const { mailProductionHost, mailStagingAllow } = platformMail();
  let host = '';
  try { host = new URL(process.env.PULSE_PUBLIC_URL ?? 'https://invalid.local').hostname.toLowerCase(); } catch { host = ''; }
  return (!!mailProductionHost && host === mailProductionHost) || mailStagingAllow.includes(to) || to === mailbox.toLowerCase();
}

/** Whether the request's (hosted) company has a mailbox: signed-out recovery asks before it promises an e-mail. */
export async function companyMailboxReady(c: PoolClient) {
  if (!hostedMailCompany()) return false;
  return !!(await c.query('select pulse.org_mailbox_ready() ok')).rows[0]?.ok;
}

/** Refuse with the Connect prompt (409, code mailbox_not_connected: a 5xx answer's words are hidden by app.ts) when the
 *  hosted company has no mailbox, else with the caller's own words and status. */
export async function mailRefusal(text: string): Promise<never> {
  const org = hostedMailCompany();
  const missing = !!org && !!reader && await reader(async (c) => !(await c.query('select pulse.org_mailbox_ready() ok')).rows[0]?.ok).catch(() => false);
  return missing ? failCode(409, MAILBOX_MISSING, 'mailbox_not_connected') : fail(503, text);
}

const sessionKey = (req: FastifyRequest, v: Viewer) => sessionHash('mailbox:' + String(req.headers['x-pulse-session'] ?? req.headers['x-pulse-access-id'] ?? `${v.email}`));
const must = (v: Viewer) => { if (!admin(v) || !v.person) fail(403, 'Only an organisation admin connects the company mailbox'); };

export function registerMailboxRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  reader = open;
  const state = async (c: PoolClient, v: Viewer): Promise<Body> => {
    const s = (await c.query('select pulse.org_mailbox_state() d')).rows[0].d as Body;
    const client = mailClient(v.org);
    return { ...s, configured: !!client, clientKind: client?.kind ?? null, redirectUri: new URL(MAILBOX_CALLBACK, companyOrigin()).href,
      ...(s.install ? { installSender: platformMail().mailFrom } : {}) };
  };
  app.get('/api/v0/mailbox', (req) => tx(req, async (c, v) => { must(v); return state(c, v); }));

  app.post<{ Body: Body }>('/api/v0/mailbox/google/start', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c, v) => {
    must(v);
    const s = (await c.query('select pulse.org_mailbox_state() d')).rows[0].d as Body;
    if (s.install) fail(409, 'This company sends from this Pulse server’s own mailbox; nothing to connect.');
    const client = mailClient(v.org);
    if (!client) failCode(409, 'Google mail sign-in is not set up on this Pulse yet. Ask the Pulse administrator to add the Google OAuth client (docs/ops/MAILBOX.md).', 'mailbox_unconfigured');
    const stateToken = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    await c.query('select pulse.org_mailbox_begin($1,$2,$3)', [sessionHash(stateToken), sessionKey(req, v), verifier]);
    const url = new URL(mailGoogle.authorize);
    const hint = typeof req.body?.hint === 'string' && EMAIL.test(req.body.hint) ? req.body.hint : '';
    for (const [k, value] of Object.entries({ client_id: client!.clientId, redirect_uri: new URL(MAILBOX_CALLBACK, companyOrigin()).href, response_type: 'code',
      scope: `openid email ${MAIL_SCOPE}`, access_type: 'offline', prompt: 'consent select_account', state: stateToken,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(hint ? { login_hint: hint } : {}) })) url.searchParams.set(k, value);
    return { url: url.href };
  }));

  app.post<{ Body: Body }>('/api/v0/mailbox/google/finish', { schema: { body: { type: 'object' } } }, async (req) => {
    const stateToken = typeof req.body?.state === 'string' ? req.body.state.slice(0, 200) : '', code = typeof req.body?.code === 'string' ? req.body.code.slice(0, 2000) : '';
    // The attempt is used up (committed) before the code is exchanged: a replayed state finds nothing.
    // The caller is signed in and an admin before the request itself is judged (access matrix: 401/403 first).
    const { verifier, org } = await tx(req, async (c, v) => { must(v); if (!stateToken || !code) fail(400, 'Google did not send Pulse back a sign-in. Press Connect again.'); return { verifier: (await c.query('select pulse.org_mailbox_take($1,$2) v', [sessionHash(stateToken), sessionKey(req, v)])).rows[0].v as string | null, org: v.org }; });
    if (!verifier) fail(400, 'This Google sign-in has expired or was already used. Press Connect again.');
    const client = mailClient(org) ?? fail(409, 'Google mail sign-in is not set up on this Pulse any more.');
    let t: Body, who: Body;
    try {
      t = await google(mailGoogle.token, form({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: new URL(MAILBOX_CALLBACK, companyOrigin()).href, grant_type: 'authorization_code', code_verifier: verifier! }));
      if (!String(t.scope ?? '').split(/\s+/).includes(MAIL_SCOPE)) fail(400, 'Google did not give Pulse permission to send mail. Press Connect again and allow “Send email on your behalf”.');
      if (typeof t.refresh_token !== 'string' || typeof t.access_token !== 'string') fail(400, 'Google did not give Pulse lasting access. Press Connect again (remove Pulse under your Google Account → Security → Third-party access first if it was connected before).');
      who = await google(mailGoogle.userinfo, { headers: { authorization: `Bearer ${t.access_token}` } });
    } catch (e) { if (e instanceof MailboxError) fail(409, e.message); throw e; }
    const address = String(who.email ?? '').trim().toLowerCase();
    if (!EMAIL.test(address) || who.email_verified !== true) fail(400, 'Google did not confirm this account’s e-mail address. Use the company mailbox that should send.');
    const sealed = seal(await requireKeyring('mail'), Buffer.from(String(t.refresh_token), 'utf8'), context(org));
    tokens.delete(org);
    return tx(req, async (c, v) => {
      must(v);
      if (v.org !== org) fail(409, 'You switched organisation while connecting. Press Connect again.');
      await c.query('select pulse.org_mailbox_save($1,$2,$3,$4,$5)', [address, client.kind, sealed.keyId, sealed.dataKey, sealed.data]);
      return state(c, v);
    });
  });

  app.post<{ Body: Body }>('/api/v0/mailbox/test', { schema: { body: { type: 'object' } } }, async (req) => {
    const { org, to, name } = await tx(req, async (c, v) => {
      must(v);
      const m = (await c.query('select address from pulse.org_mailbox_sealed()')).rows[0] as { address: string } | undefined;
      if (!m) failCode(409, MAILBOX_MISSING, 'mailbox_not_connected');
      return { org: v.org, to: m!.address, name: v.name };
    });
    const sent = await companyMail(org, to, 'Pulse can send from this mailbox', `${name} connected this mailbox to Pulse. Sign-in links, invitations, password resets and HR notices for your company now come from this address.\n\nNo reply is needed.`, (fn) => tx(req, (c) => fn(c)));
    if (sent !== 'sent') {
      const s = await tx(req, async (c, v) => state(c, v));
      fail(409, String(s.lastError ?? 'Pulse could not send the test e-mail. Try again in a minute.'));
    }
    return { sent: true, to };
  });

  app.post<{ Body: Body }>('/api/v0/mailbox/disconnect', { schema: { body: { type: 'object' } } }, async (req) => {
    const { org, m } = await tx(req, async (c, v) => { must(v); return { org: v.org, m: (await c.query('select * from pulse.org_mailbox_sealed()')).rows[0] as Sealed | undefined }; });
    // Tell Google too (best effort: the token is gone from Pulse either way).
    if (m && !sink()) {
      try {
        const plain = openSealed(await requireKeyring('mail'), { keyId: m.key_id, dataKey: m.token_wrapped, data: m.token_sealed }, context(org));
        const token = plain.toString('utf8'); plain.fill(0);
        await fetch(mailGoogle.revoke, { ...form({ token }), signal: AbortSignal.timeout(10000) }).catch(() => {});
      } catch { /* the keyring or Google is unavailable: removing it from Pulse is what counts */ }
    }
    tokens.delete(org);
    return tx(req, async (c, v) => { must(v); await c.query('select pulse.org_mailbox_disconnect()'); return state(c, v); });
  });
}
