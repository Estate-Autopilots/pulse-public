// EST-2811: "Sign in with Pulse" for apps (Claude, ChatGPT, the Pulse CLI): OAuth 2.1 with dynamic client registration
// (RFC 7591), PKCE S256 only, rotating refresh tokens and revocation (RFC 7009), the same design as Sales X-Ray's
// connector. The web app serves the public addresses (/oauth/*, /.well-known/*, /mcp) and forwards here; the consent
// screen and its decision run on the person's own Pulse sign-in (tx). Tokens are opaque; only SHA-256 is stored
// (migration 1412). An access token lasts 1 hour and acts as its person in API v1 (pulse.v1_person_principal).
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fail, sessionHash, type Open, type Tx } from './routes.js';
import { sharedAddress } from './shared-address.js';

// SELF-SERVE (1521): on Pulse's shared address an app registered once is known in every space, and a connection lives in
// the space where its person approved it (ChatGPT or Claude connected right after signing up). A company's own address
// keeps to its own organisation. The database reads this flag; it is on only around the one oauth call that needs it
// and off again straight after (review, 5 Nov 2026), so nothing else in the transaction reaches another space's rows.
type Q = { query: (q: string, a?: unknown[]) => Promise<unknown> };
const reaching = async <T>(c: Q, run: () => Promise<T>): Promise<T> => {
  await c.query("select set_config('pulse.shared_address',$1,true)", [sharedAddress() ? '1' : '']);
  try { return await run(); } finally { await c.query("select set_config('pulse.shared_address','',true)"); }
};
import { companyOrigin, oauthIssuer } from './tenant-context.js';

type Body = Record<string, unknown>;
/** The scopes an app may ask for, with the words the consent screen shows. Role checks still apply on every call. */
export const OAUTH_SCOPES: Record<string, string> = {
  'people.read': 'See who you are, find colleagues and (HR) read staff records and the onboarding roster',
  'people.write': 'HR and admins: correct staff records, send sign-in help; everyone: undo your own app changes',
  'search.read': 'Search people, tasks and projects you can see',
  'tasks.read': 'Read the tasks you can see', 'tasks.write': 'Create and update tasks as you',
  'projects.read': 'Read the projects you can see', 'projects.write': 'Create and update projects as you',
  'chats.read': 'Read your conversations', 'chats.write': 'Send chat messages, create chat groups and change their members as you',
  // AGENT-API (owner, 4 Nov 2026): the money path and clients, for Claude, ChatGPT, the CLI and bots.
  'companies.read': 'Find clients, contacts and leads', 'companies.write': 'Add clients as you',
  'billing.read': 'Leadership, Finance and the Accountant: read the catalogue, stock, quotations and invoices',
  'billing.write': 'Leadership and Finance: draft and revise quotations and invoices, add catalogue items, record stock and payments as you',
  'events.read': 'Admins and leadership: read bug reports', 'events.write': 'Admins and leadership: triage bug reports',
  // API-PLATFORM (owner, 5 Nov 2026): the finance ledger and HR, each bounded by the person's own role.
  'finance.read': 'Leadership and Finance: read the finance ledger (entries and expenses)', 'finance.write': 'Leadership and Finance: record expenses as you',
  'hr.read': 'Read your leave and attendance (HR and admins: everyone\'s)', 'hr.write': 'Ask for leave as you (HR: file it for someone)',
  'contracts.read': 'Read your contracts (admins, leadership and Finance: the company\'s)', 'contracts.write': 'Draft, send and accept contracts and record money under them as you',
  'connectors.read': 'Use the read-only tools of the apps your company connected', 'connectors.write': 'Use the tools of the apps your company connected that change things (with confirmation)',
  'pr.read': 'Read the company Story, briefs, audiences and creative drafts (PR Studio)', 'pr.write': 'Add to the Story, write briefs and draft creatives in PR Studio (nothing is sent)',
};
export const DEFAULT_SCOPES = Object.keys(OAUTH_SCOPES);
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** Eight letters without vowels or look-alikes (no words, no 0/O or 1/I), shown as XXXX-XXXX. */
const USER_CODE = 'BCDFGHJKLMNPQRSTVWXZ';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (prefix: string) => prefix + randomBytes(32).toString('base64url');
const str = (v: unknown, max = 512) => typeof v === 'string' && v.length <= max ? v : '';
const ip = (req: FastifyRequest) => String(req.headers['x-pulse-client-ip'] ?? req.ip);
const oauthError = (reply: FastifyReply, status: number, error: string, description?: string) =>
  reply.code(status).header('cache-control', 'no-store').header('pragma', 'no-cache').send({ error, ...(description ? { error_description: description } : {}) });

/** https anywhere, or http on this computer only (a CLI's loopback listener). Exact strings; no fragment or user. */
export function redirectOk(uri: unknown): boolean {
  if (typeof uri !== 'string' || uri.length > 512 || /[\s\u0000-\u001f]/.test(uri)) return false;
  let u: URL; try { u = new URL(uri); } catch { return false; }
  if (u.hash || u.username || u.password || uri.includes('#')) return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
}
export function scopesOf(raw: unknown): string[] | null {
  const asked = typeof raw === 'string' && raw.trim() ? [...new Set(raw.trim().split(/\s+/))] : DEFAULT_SCOPES;
  // Unknown scopes (an app's own "openid", "offline_access") are dropped, never granted; none left is an error.
  const known = asked.filter(s => s in OAUTH_SCOPES);
  return known.length ? known : null;
}

export function registerOAuth(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  const allow = (key: string, limit: number) => open(async c => (await c.query('select pulse.auth_allow($1,$2) ok', [sessionHash(key), limit])).rows[0].ok as boolean);

  // RFC 7591 dynamic registration: open to any app, rate limited; the consent screen says it is unverified.
  app.post<{ Body: Body }>('/api/v0/oauth/register', { bodyLimit: 8192 }, async (req, reply) => {
    if (!await allow('oauth-register:' + ip(req), 10)) return oauthError(reply.header('retry-after', '900'), 429, 'slow_down', 'Too many registrations; try again later');
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const name = str(b.client_name, 200).trim(), uris = b.redirect_uris, method = b.token_endpoint_auth_method ?? 'client_secret_basic';
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) || /estate\s*autopilots/i.test(name) || /^pulse$/i.test(name))
      return oauthError(reply, 400, 'invalid_client_metadata', 'client_name must be 1 to 80 characters and not pose as Pulse itself');
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || new Set(uris).size !== uris.length || !uris.every(redirectOk))
      return oauthError(reply, 400, 'invalid_redirect_uri', 'Give 1 to 5 exact https redirect URIs (http only on 127.0.0.1 or localhost)');
    if (!['none', 'client_secret_basic', 'client_secret_post'].includes(String(method))) return oauthError(reply, 400, 'invalid_client_metadata', 'Unsupported token_endpoint_auth_method');
    const grants = Array.isArray(b.grant_types) ? b.grant_types : ['authorization_code', 'refresh_token'];
    if (!grants.includes('authorization_code') || grants.some(g => !['authorization_code', 'refresh_token'].includes(g))) return oauthError(reply, 400, 'invalid_client_metadata', 'grant_types must be authorization_code (and refresh_token)');
    if (b.response_types !== undefined && JSON.stringify(b.response_types) !== '["code"]') return oauthError(reply, 400, 'invalid_client_metadata', 'response_types must be ["code"]');
    const clientId = 'pcl_' + randomBytes(12).toString('hex'), secret = method === 'none' ? null : token('pcs_');
    await open(c => c.query('select pulse.oauth_register($1,$2,$3,$4)', [clientId, name, uris, secret ? sha(secret) : null]));
    return reply.code(201).header('cache-control', 'no-store').send({ client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name,
      redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: method,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}) });
  });

  // The consent screen's facts. A bad client or redirect is an error on the screen, never a redirect elsewhere.
  type Ask = { client_id?: string; redirect_uri?: string; scope?: string; state?: string; code_challenge?: string; code_challenge_method?: string; response_type?: string };
  const check = async (c: Parameters<Parameters<Tx>[1]>[0], q: Ask) => {
    const client = (await reaching(c, () => c.query('select pulse.oauth_client_peek($1) v', [str(q.client_id, 40)]))).rows[0].v as { name: string; redirectUris: string[] } | null;
    if (!client) fail(400, 'This app is not registered here. Start the connection again from the app.');
    if (!client!.redirectUris.includes(str(q.redirect_uri))) fail(400, 'This app gave a return address it did not register. Start again from the app.');
    if (q.response_type !== 'code') fail(400, 'Unsupported response_type');
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(str(q.code_challenge))) fail(400, 'This app must use PKCE (S256)');
    const scopes = scopesOf(q.scope);
    if (!scopes) fail(400, 'This app asked for no permission Pulse knows');
    return { client: client!, scopes: scopes! };
  };
  // SELF-SERVE (owner, 4 Nov 2026: a new person creates their account while connecting the Pulse connector from ChatGPT
  // or Claude): the sign-in page names the app it continues to, and offers "Create your account" with the way back
  // here. Signed out, public: the name the app registered (unverified, as the consent screen says), never more.
  app.get<{ Querystring: { client_id?: string } }>('/api/v0/oauth/authorize/app', async (req) => {
    if (!await allow('oauth-app-name:' + str(req.headers['x-pulse-client-ip'], 80), 120)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const client = (await open(async c => reaching(c, () => c.query('select pulse.oauth_client_peek($1) v', [str(req.query.client_id, 40)])))).rows[0].v as { name: string } | null;
    return { name: client?.name ? client.name.slice(0, 80) : null };
  });
  app.get<{ Querystring: Ask }>('/api/v0/oauth/authorize', req => tx(req, async (c, v) => {
    if (v.nativeDevice || v.side === 'client' || !v.person) fail(403, 'Sign in with your staff account in the browser to connect an app');
    const { client, scopes } = await check(c, req.query);
    const company = (await c.query('select name from pulse.org where id=pulse.current_org()')).rows[0]?.name ?? 'Pulse';
    return { app: { name: client.name, verified: false }, returnsTo: new URL(str(req.query.redirect_uri)).host, person: v.name, company,
      scopes: scopes.map(key => ({ key, label: OAUTH_SCOPES[key] })) };
  }));
  app.post<{ Body: Ask & { approve?: boolean } }>('/api/v0/oauth/authorize', req => tx(req, async (c, v) => {
    if (v.nativeDevice || v.side === 'client' || !v.person) fail(403, 'Sign in with your staff account in the browser to connect an app');
    const q = req.body ?? {}, { scopes } = await check(c, q);
    const back = new URL(str(q.redirect_uri));
    if (q.state) back.searchParams.set('state', str(q.state, 1024));
    back.searchParams.set('iss', oauthIssuer());
    if (q.approve !== true) { back.searchParams.set('error', 'access_denied'); return { redirect: back.href }; }
    const code = token('poc_');
    await reaching(c, () => c.query('select pulse.oauth_code_issue($1,$2,$3,$4,$5)', [sha(code), q.client_id, scopes, q.redirect_uri, q.code_challenge]));
    back.searchParams.set('code', code);
    return { redirect: back.href };
  }));

  // Token and revoke take the client from HTTP Basic or the body (the web route turns a form post into this JSON).
  const client = (req: FastifyRequest<{ Body: Body }>) => {
    const basic = /^Basic ([A-Za-z0-9+/=]+)$/.exec(String(req.headers.authorization ?? ''));
    if (basic) { const [id, ...rest] = Buffer.from(basic[1], 'base64').toString().split(':'); return { id: decodeURIComponent(id), secret: decodeURIComponent(rest.join(':')) || null, basic: true }; }
    return { id: str(req.body?.client_id, 40), secret: str(req.body?.client_secret, 100) || null, basic: false };
  };
  app.post<{ Body: Body }>('/api/v0/oauth/token', { bodyLimit: 8192 }, async (req, reply) => {
    if (!await allow('oauth-token:' + ip(req), 120)) return oauthError(reply.header('retry-after', '60'), 429, 'slow_down');
    const b = req.body ?? {}, who = client(req), access = token('pat_'), refresh = token('prt_');
    const secret = who.secret ? sha(who.secret) : null;
    let result: { error?: string; scope?: string; expiresIn?: number };
    if (b.grant_type === 'authorization_code') {
      const verifier = str(b.code_verifier, 128);
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError(reply, 400, 'invalid_grant', 'A PKCE code_verifier is required');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      result = await open(async c => (await reaching(c, () => c.query('select pulse.oauth_exchange($1,$2,$3,$4,$5,$6,$7) v',
        [sha(str(b.code, 100)), who.id, secret, str(b.redirect_uri), challenge, sha(access), sha(refresh)]))).rows[0].v);
    } else if (b.grant_type === 'refresh_token') {
      result = await open(async c => (await reaching(c, () => c.query('select pulse.oauth_refresh($1,$2,$3,$4,$5) v',
        [sha(str(b.refresh_token, 100)), who.id, secret, sha(access), sha(refresh)]))).rows[0].v);
    } else if (b.grant_type === DEVICE_GRANT) {
      // AGENT-API (1511): the device code's poll (RFC 8628 §3.4); pending, slow_down, denied and expired are 400s.
      result = await open(async c => (await c.query('select pulse.oauth_device_exchange($1,$2,$3,$4,$5) v',
        [sha(str(b.device_code, 100)), who.id, secret, sha(access), sha(refresh)])).rows[0].v);
    } else return oauthError(reply, 400, 'unsupported_grant_type');
    if (result.error === 'invalid_client') return oauthError(who.basic ? reply.header('www-authenticate', 'Basic realm="pulse"') : reply, 401, 'invalid_client');
    if (result.error) return oauthError(reply, 400, result.error);
    return reply.header('cache-control', 'no-store').header('pragma', 'no-cache')
      .send({ access_token: access, token_type: 'Bearer', expires_in: result.expiresIn, refresh_token: refresh, scope: result.scope });
  });
  app.post<{ Body: Body }>('/api/v0/oauth/revoke', { bodyLimit: 8192 }, async (req, reply) => {
    const who = client(req);
    const ok = await open(async c => (await reaching(c, () => c.query('select pulse.oauth_revoke($1,$2,$3) v', [sha(str(req.body?.token, 100)), who.id, who.secret ? sha(who.secret) : null]))).rows[0].v);
    if (!ok) return oauthError(reply, 401, 'invalid_client');
    return reply.header('cache-control', 'no-store').send({});
  });

  // AGENT-API (owner, 4 Nov 2026), 1511: `pulse login` on a server or over SSH, by the device authorization grant
  // (RFC 8628). The CLI shows an eight-letter code; the person opens /oauth/device signed in to Pulse and approves.
  app.post<{ Body: Body }>('/api/v0/oauth/device_authorization', { bodyLimit: 8192 }, async (req, reply) => {
    if (!await allow('oauth-device:' + ip(req), 30)) return oauthError(reply.header('retry-after', '900'), 429, 'slow_down', 'Too many sign-in codes; try again later');
    const b = req.body && typeof req.body === 'object' ? req.body : {}, who = client(req as FastifyRequest<{ Body: Body }>);
    const scopes = scopesOf(b.scope);
    if (!scopes) return oauthError(reply, 400, 'invalid_scope');
    const device = token('pdc_');
    const userCode = Array.from(randomBytes(8), x => USER_CODE[x % USER_CODE.length]).join('');
    const ok = await open(async c => (await c.query('select pulse.oauth_device_issue($1,$2,$3,$4) v', [sha(device), userCode, who.id, scopes])).rows[0].v);
    if (!ok) return oauthError(reply, 401, 'invalid_client');
    const base = companyOrigin(), shown = `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
    return reply.header('cache-control', 'no-store').send({ device_code: device, user_code: shown, verification_uri: `${base}/oauth/device`,
      verification_uri_complete: `${base}/oauth/device?user_code=${shown}`, expires_in: 600, interval: 5 });
  });
  const userCode = (v: unknown) => str(v, 20).toUpperCase().replace(/[^A-Z]/g, '');
  app.get<{ Querystring: { user_code?: string } }>('/api/v0/oauth/device', req => tx(req, async (c, v) => {
    if (v.nativeDevice || v.side === 'client' || !v.person) fail(403, 'Sign in with your staff account in the browser to connect an app');
    const d = (await c.query('select pulse.oauth_device_peek($1) v', [userCode(req.query.user_code)])).rows[0].v as { app: string; scopes: string[] } | null;
    if (!d) fail(404, 'That code is not waiting here: it is mistyped, used or older than 10 minutes. Run pulse login again for a new one.');
    const company = (await c.query('select name from pulse.org where id=pulse.current_org()')).rows[0]?.name ?? 'Pulse';
    return { app: { name: d!.app, verified: false }, person: v.name, company, scopes: d!.scopes.map(key => ({ key, label: OAUTH_SCOPES[key] ?? key })) };
  }));
  app.post<{ Body: { user_code?: string; approve?: boolean } }>('/api/v0/oauth/device', req => tx(req, async (c, v) => {
    if (v.nativeDevice || v.side === 'client' || !v.person) fail(403, 'Sign in with your staff account in the browser to connect an app');
    if (!(await c.query('select pulse.oauth_device_decide($1,$2) v', [userCode(req.body?.user_code), req.body?.approve === true])).rows[0].v)
      fail(404, 'That code is not waiting here any more. Run pulse login again for a new one.');
    return { ok: true, approved: req.body?.approve === true };
  }));

  // The person's own connections, for Account / Connected apps and `pulse auth status`.
  app.get('/api/v0/oauth/connections', req => tx(req, async c => ({ connections: (await c.query('select pulse.oauth_my_grants() v')).rows[0].v })));
  app.post<{ Params: { id: string } }>('/api/v0/oauth/connections/:id/end', req => tx(req, async c => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) fail(400, 'Choose a connection');
    if (!(await c.query('select pulse.oauth_grant_end($1) v', [req.params.id])).rows[0].v) fail(404, 'Connection unavailable');
    return { ok: true };
  }));
}
