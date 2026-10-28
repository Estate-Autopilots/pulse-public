// EST-2811: "Sign in with Pulse" for apps (Claude, ChatGPT, the Pulse CLI): OAuth 2.1 with dynamic client registration
// (RFC 7591), PKCE S256 only, rotating refresh tokens and revocation (RFC 7009), the same design as Sales X-Ray's
// connector. The web app serves the public addresses (/oauth/*, /.well-known/*, /mcp) and forwards here; the consent
// screen and its decision run on the person's own Pulse sign-in (tx). Tokens are opaque; only SHA-256 is stored
// (migration 1008). An access token lasts 1 hour and acts as its person in API v1 (pulse.v1_person_principal).
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fail, sessionHash, type Open, type Tx } from './routes.js';
import { companyOrigin } from './tenant-context.js';

type Body = Record<string, unknown>;
/** The scopes an app may ask for, with the words the consent screen shows. Role checks still apply on every call. */
export const OAUTH_SCOPES: Record<string, string> = {
  'people.read': 'See who you are, find colleagues and (HR) read staff records and the onboarding roster',
  'people.write': 'HR and admins: correct staff records, send sign-in help; everyone: undo your own app changes',
  'search.read': 'Search people, tasks and projects you can see',
  'tasks.read': 'Read the tasks you can see', 'tasks.write': 'Create and update tasks as you',
  'projects.read': 'Read the projects you can see', 'projects.write': 'Create and update projects as you',
  'chats.write': 'Create chat groups and change their members as you',
  'events.read': 'Admins and leadership: read bug reports', 'events.write': 'Admins and leadership: triage bug reports',
};
export const DEFAULT_SCOPES = Object.keys(OAUTH_SCOPES);
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
    const client = (await c.query('select pulse.oauth_client_peek($1) v', [str(q.client_id, 40)])).rows[0].v as { name: string; redirectUris: string[] } | null;
    if (!client) fail(400, 'This app is not registered here. Start the connection again from the app.');
    if (!client!.redirectUris.includes(str(q.redirect_uri))) fail(400, 'This app gave a return address it did not register. Start again from the app.');
    if (q.response_type !== 'code') fail(400, 'Unsupported response_type');
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(str(q.code_challenge))) fail(400, 'This app must use PKCE (S256)');
    const scopes = scopesOf(q.scope);
    if (!scopes) fail(400, 'This app asked for no permission Pulse knows');
    return { client: client!, scopes: scopes! };
  };
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
    back.searchParams.set('iss', companyOrigin());
    if (q.approve !== true) { back.searchParams.set('error', 'access_denied'); return { redirect: back.href }; }
    const code = token('poc_');
    await c.query('select pulse.oauth_code_issue($1,$2,$3,$4,$5)', [sha(code), q.client_id, scopes, q.redirect_uri, q.code_challenge]);
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
      result = await open(async c => (await c.query('select pulse.oauth_exchange($1,$2,$3,$4,$5,$6,$7) v',
        [sha(str(b.code, 100)), who.id, secret, str(b.redirect_uri), challenge, sha(access), sha(refresh)])).rows[0].v);
    } else if (b.grant_type === 'refresh_token') {
      result = await open(async c => (await c.query('select pulse.oauth_refresh($1,$2,$3,$4,$5) v',
        [sha(str(b.refresh_token, 100)), who.id, secret, sha(access), sha(refresh)])).rows[0].v);
    } else return oauthError(reply, 400, 'unsupported_grant_type');
    if (result.error === 'invalid_client') return oauthError(who.basic ? reply.header('www-authenticate', 'Basic realm="pulse"') : reply, 401, 'invalid_client');
    if (result.error) return oauthError(reply, 400, result.error);
    return reply.header('cache-control', 'no-store').header('pragma', 'no-cache')
      .send({ access_token: access, token_type: 'Bearer', expires_in: result.expiresIn, refresh_token: refresh, scope: result.scope });
  });
  app.post<{ Body: Body }>('/api/v0/oauth/revoke', { bodyLimit: 8192 }, async (req, reply) => {
    const who = client(req);
    const ok = await open(async c => (await c.query('select pulse.oauth_revoke($1,$2,$3) v', [sha(str(req.body?.token, 100)), who.id, who.secret ? sha(who.secret) : null])).rows[0].v);
    if (!ok) return oauthError(reply, 401, 'invalid_client');
    return reply.header('cache-control', 'no-store').send({});
  });

  // The person's own connections, for Account / Connected apps and `pulse auth status`.
  app.get('/api/v0/oauth/connections', req => tx(req, async c => ({ connections: (await c.query('select pulse.oauth_my_grants() v')).rows[0].v })));
  app.post<{ Params: { id: string } }>('/api/v0/oauth/connections/:id/end', req => tx(req, async c => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) fail(400, 'Choose a connection');
    if (!(await c.query('select pulse.oauth_grant_end($1) v', [req.params.id])).rows[0].v) fail(404, 'Connection unavailable');
    return { ok: true };
  }));
}
