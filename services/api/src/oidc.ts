// PULSE-ID (owner, 25 Oct 2026): "Sign in with Pulse". Pulse as an OpenID Connect provider for apps (first: Sales
// X-Ray), built to AC's agreed pulse-identity-contract exactly: docs/architecture/PULSE_IDENTITY_AND_DATA_API.md §6.
//  * Authorization code + PKCE S256 (required), state and nonce; exact redirect URIs; one-time 60 s codes.
//  * Opaque access (1 h) and refresh tokens (60 days, rotated; a reused one ends its chain, and a personal connection),
//    stored as SHA-256 only;
//    the ID token is an RS256 JWT (10 minutes) signed with the key file in the server's secret store (oidc-keys.ts).
//  * Records and every check that matters live in 1115_pulse_identity.sql (SECURITY DEFINER functions); this file
//    speaks the protocol. The browser part of /oauth/authorize is the web page (apps/web/app/oauth/authorize).
// Switch: PULSE_OIDC=1, with PULSE_OIDC_SIGNING_KEY_FILE (or PULSE_OIDC_SIGNING_KEY) and an issuer (PULSE_OIDC_ISSUER or
// PULSE_PUBLIC_URL).
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import sharp from 'sharp';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { authIp } from './account-security.js';
import { answer } from './accounts.js';
import { deviceLabel, passwordError } from './auth-policy.js';
import { budget, type Budget } from './v1-limits.js';
import { fail, sessionHash, type Open, type Tx, type Viewer } from './routes.js';
import { halfHash, pictureUrl, signJwt, signingKeys, type SigningKey } from './oidc-keys.js';

export const oidcOn = () => process.env.PULSE_OIDC === '1';
/** The issuer exactly as discovery says it: the install's public address, no trailing slash. Null when unset. */
export function oidcIssuer(): string | null {
  const raw = process.env.PULSE_OIDC_ISSUER || process.env.PULSE_PUBLIC_URL || '';
  try { const u = new URL(raw); return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? u.origin : null; } catch { return null; }
}

export const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'pulse.orgs', 'pulse.org.read', 'pulse.org.webhooks', 'pulse.signals.write',
  'pulse.clients.read', 'pulse.leads.write', 'pulse.calls.write', 'pulse.money.read'] as const;
export const ORG_SCOPES = new Set(['pulse.org.read', 'pulse.org.webhooks', 'pulse.signals.write', 'pulse.leads.write', 'pulse.calls.write', 'pulse.money.read']);
const CLAIMS = ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'amr', 'azp', 'at_hash', 'name', 'given_name', 'family_name', 'preferred_username',
  'picture', 'updated_at', 'title', 'team', 'email', 'email_verified', 'pulse_orgs', 'pulse_org_id'];

const token = (prefix: string) => prefix + randomBytes(32).toString('base64url');
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const newClientId = () => 'papp_' + [...randomBytes(20)].map((b) => ALPHABET[b % 36]).join('');
export const newClientSecret = () => token('psec_');
/** RFC 7636 S256: base64url(SHA-256(verifier)). */
export const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
export const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
export const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^pxc_[A-Za-z0-9_-]{43}$/, ACCESS = /^pxa_[A-Za-z0-9_-]{43}$/, REFRESH = /^pxr_[A-Za-z0-9_-]{43}$/, SECRET = /^psec_[A-Za-z0-9_-]{43}$/;
export const scopeList = (raw: unknown) => [...new Set(String(raw ?? '').split(' ').filter(Boolean))];

export type PublicApp = { id: string; clientId: string; name: string; maker: string | null; homeUrl: string | null; verified: boolean; development: boolean;
  status: string; redirectUris: string[]; scopes: string[]; logo: number | null };
export type AuthorizeQuery = Record<string, string | undefined>;
/** What an authorize request asks for, once checked. `fatal`: show Pulse's own error page and never redirect (unknown
 *  app, unregistered return address). `error`: send the person back to the app with it. */
export type Checked =
  | { fatal: 'unknown_app' | 'bad_redirect'; app?: PublicApp }
  | { error: string; description: string; app: PublicApp; redirectUri: string; state?: string }
  | { app: PublicApp; redirectUri: string; state: string; nonce: string | null; scopes: string[]; kind: 'personal' | 'org'; challenge: string; prompt: string | null; orgHint: string | null; loginHint: string | null };

export function checkAuthorize(q: AuthorizeQuery, app: PublicApp | null): Checked {
  if (!app || app.status !== 'active') return { fatal: 'unknown_app' };
  const redirectUri = q.redirect_uri ?? '';
  if (!app.redirectUris.includes(redirectUri)) return { fatal: 'bad_redirect', app };
  const state = q.state;
  const bad = (error: string, description: string) => ({ error, description, app, redirectUri, state });
  if (q.response_type !== 'code') return bad('unsupported_response_type', 'Pulse answers response_type=code only');
  if (!state || state.length < 8 || state.length > 512) return bad('invalid_request', 'state is required (8 to 512 characters)');
  if (q.code_challenge_method !== 'S256' || !CHALLENGE.test(q.code_challenge ?? '')) return bad('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  if (q.request || q.request_uri) return bad('request_not_supported', 'Request objects are not supported');
  const asked = scopeList(q.scope);
  if (!asked.includes('openid')) return bad('invalid_scope', 'openid is required');
  const nonce = q.nonce ?? null;
  if (!nonce || nonce.length > 255) return bad('invalid_request', 'nonce is required (at most 255 characters)');
  if (q.prompt && !['none', 'consent', 'login', 'select_account'].includes(q.prompt)) return bad('invalid_request', 'Unknown prompt');
  const scopes = asked.filter((s) => (SCOPES as readonly string[]).includes(s) && app.scopes.includes(s));
  return { app, redirectUri, state, nonce, scopes, kind: scopes.some((s) => ORG_SCOPES.has(s)) ? 'org' : 'personal', challenge: q.code_challenge!,
    prompt: q.prompt ?? null, orgHint: q.pulse_org_hint ?? null, loginHint: q.login_hint ?? null };
}
/** The app's return address with the answer added (its own query kept), and iss (RFC 9207). */
export function returnTo(redirectUri: string, params: Record<string, string | undefined | null>, issuer: string) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries({ ...params, iss: issuer })) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  return url.href;
}

/** RFC 6749 §2.3.1: Basic (form-encoded parts) or the body; never both. */
export function clientCredentials(authorization: unknown, body: Record<string, unknown>): { id: string; secret: string } | { error: string } {
  const basic = typeof authorization === 'string' ? /^Basic ([A-Za-z0-9+/=]+)$/i.exec(authorization) : null;
  const inBody = typeof body.client_secret === 'string';
  if (basic && inBody) return { error: 'invalid_request' };
  if (basic) {
    const raw = Buffer.from(basic[1], 'base64').toString('utf8'), at = raw.indexOf(':');
    if (at < 1) return { error: 'invalid_client' };
    try {
      const id = decodeURIComponent(raw.slice(0, at).replace(/\+/g, ' ')), secret = decodeURIComponent(raw.slice(at + 1).replace(/\+/g, ' '));
      if (typeof body.client_id === 'string' && body.client_id !== id) return { error: 'invalid_request' };
      return { id, secret };
    } catch { return { error: 'invalid_client' }; }
  }
  if (inBody && typeof body.client_id === 'string') return { id: body.client_id, secret: String(body.client_secret) };
  return { error: 'invalid_client' };
}

type TokenAnswer = { error?: string; kind: 'personal' | 'org'; org: string; scopes: string[]; refresh: boolean; appId: string; nonce?: string | null;
  authTime?: number; amr?: string; claims: (Record<string, unknown> & { photo?: { member: string; version: number } }) | null };
/** The claims an app gets, with the photo turned into its signed address. */
export function publicClaims(claims: Record<string, unknown> & { photo?: { member: string; version: number } }, issuer: string, key: SigningKey, clientId: string, org: string) {
  const { photo, ...rest } = claims;
  return { ...rest, ...(photo ? { picture: pictureUrl(issuer, key, clientId, org, photo.member, photo.version) } : {}) };
}
export function idToken(key: SigningKey, issuer: string, clientId: string, r: TokenAnswer, access: string, now = Math.floor(Date.now() / 1000)) {
  return signJwt(key, { iss: issuer, aud: clientId, azp: clientId, iat: now, exp: now + 600, ...(r.authTime ? { auth_time: r.authTime } : {}),
    ...(r.nonce ? { nonce: r.nonce } : {}), ...(r.amr ? { amr: [r.amr] } : {}), at_hash: halfHash(access),
    ...publicClaims(r.claims ?? {}, issuer, key, clientId, r.org), ...(r.kind === 'org' ? { pulse_org_id: r.org } : {}) });
}

export function discovery(issuer: string) {
  return {
    issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, userinfo_endpoint: `${issuer}/oauth/userinfo`,
    jwks_uri: `${issuer}/oauth/jwks`, revocation_endpoint: `${issuer}/oauth/revoke`, scopes_supported: [...SCOPES], response_types_supported: ['code'],
    response_modes_supported: ['query'], grant_types_supported: ['authorization_code', 'refresh_token'], subject_types_supported: ['pairwise'],
    id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], code_challenge_methods_supported: ['S256'],
    claims_supported: CLAIMS, prompt_values_supported: ['none', 'consent'], authorization_response_iss_parameter_supported: true,
    request_parameter_supported: false, request_uri_parameter_supported: false, claims_parameter_supported: false,
    pulse_org_api_base: `${issuer}/api/v1/connect`, service_documentation: `${issuer}/developers`,
  };
}

const oauthError = (reply: FastifyReply, status: number, error: string, description?: string) => {
  if (status === 401) reply.header('www-authenticate', 'Basic realm="pulse"');
  return reply.code(status).header('cache-control', 'no-store').header('pragma', 'no-cache').send({ error, ...(description ? { error_description: description } : {}) });
};
const one = async <T>(c: PoolClient, sql: string, args: unknown[]): Promise<T> => (await c.query(sql, args)).rows[0]?.r as T;
// Bodies of signed-in routes are checked after the sign-in (a signed-out call is 401 and a refused role 403 first, as
// the access matrix expects of every route).
const ajv = new Ajv2020({ allErrors: false, strict: false, coerceTypes: false, removeAdditional: false, useDefaults: false });
const compiled = new WeakMap<object, ReturnType<typeof ajv.compile>>();
function body<T>(schema: object, value: unknown): T {
  let valid = compiled.get(schema);
  if (!valid) { valid = ajv.compile(schema); compiled.set(schema, valid); }
  if (!valid(value)) fail(400, `Please check the request${valid.errors?.[0] ? `: ${valid.errors[0].instancePath || '/'} ${valid.errors[0].message}` : ''}`);
  return value as T;
}
const LOOSE = { type: 'object', maxProperties: 20 } as const;
const STATUS = { type: 'object', required: ['on'], properties: { on: { type: 'boolean' } } } as const;
const VERIFY = { type: 'object', required: ['verified'], properties: { verified: { type: 'boolean' } } } as const;
const LOGO = { type: 'object', properties: { image: { type: 'string', maxLength: 1_400_000 } } } as const;

export function registerOidcRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  const allow = (req: FastifyRequest, key: string, limit: number) => open(async (c) => (await c.query('select pulse.auth_allow($1,$2) ok', [sessionHash(`${key}:${authIp(req)}`), limit])).rows[0].ok as boolean);
  const perClient = new Map<string, Budget>();
  const clientBudget = (id: string) => {
    let b = perClient.get(id);
    if (!b) { if (perClient.size > 1000) perClient.clear(); b = budget(60); perClient.set(id, b); }
    return b;
  };
  const ready = async () => {
    const issuer = oidcIssuer(), keys = await signingKeys();
    return oidcOn() && issuer && keys.ok ? { issuer, keys: keys.keys } : null;
  };
  const appOf = (c: PoolClient, clientId: string) => one<PublicApp | null>(c, 'select pulse.oidc_app_public($1) r', [clientId.slice(0, 40)]);

  // ----- discovery and keys (public) -------------------------------------------------------------------------------
  app.get('/.well-known/openid-configuration', async (_req, reply) => {
    if (!oidcOn()) return reply.callNotFound();
    const on = await ready();
    if (!on) return reply.code(503).header('cache-control', 'no-store').send({ error: 'temporarily_unavailable', error_description: 'Sign in with Pulse is not set up on this server yet' });
    return reply.header('cache-control', 'public, max-age=300').send(discovery(on.issuer));
  });
  app.get('/oauth/jwks', async (_req, reply) => {
    if (!oidcOn()) return reply.callNotFound();
    const on = await ready();
    if (!on) return reply.code(503).header('cache-control', 'no-store').send({ error: 'temporarily_unavailable' });
    return reply.header('cache-control', 'public, max-age=300').send({ keys: on.keys.map((k) => k.jwk) });
  });
  app.get<{ Params: { client: string } }>('/oauth/app-logo/:client', async (req, reply) => {
    if (!oidcOn()) return reply.callNotFound();
    const row = await open(async (c) => (await c.query('select logo, mime from pulse.oidc_app_logo($1)', [req.params.client.slice(0, 40)])).rows[0]);
    if (!row?.logo) return reply.code(404).send({ error: 'No logo' });
    return reply.type(row.mime).header('cache-control', 'public, max-age=300').header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox").send(row.logo);
  });

  // ----- the authorize page's calls (apps/web/app/oauth/authorize) -------------------------------------------------
  const QUERY = { type: 'object', maxProperties: 30, additionalProperties: { type: 'string', maxLength: 2048 } } as const;
  /** Signed out or in: is this a request Pulse can answer, and what does the screen show of the app? */
  app.get<{ Querystring: AuthorizeQuery }>('/api/v0/oidc/authorize/check', { schema: { querystring: QUERY } }, async (req) => {
    const on = await ready();
    if (!on) fail(404, 'Sign in with Pulse is not set up on this server');
    // An office behind one address signs many people in: generous, only against floods.
    if (!await allow(req, 'oidc-authorize', 300)) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const r = checkAuthorize(req.query, await open((c) => appOf(c, req.query.client_id ?? '')));
    const shown = r.app && { name: r.app.name, maker: r.app.maker, verified: r.app.verified, homeUrl: r.app.homeUrl, development: r.app.development,
      logo: r.app.logo ? `/oauth/app-logo/${r.app.clientId}?v=${r.app.logo}` : null };
    if ('fatal' in r) return { fatal: r.fatal, app: shown ?? null };
    if ('error' in r) return { app: shown, redirect: returnTo(r.redirectUri, { error: r.error, error_description: r.description, state: r.state }, on!.issuer) };
    return { app: shown, kind: r.kind, scopes: r.scopes, prompt: r.prompt, orgHint: r.orgHint, loginHint: r.loginHint };
  });
  /** Signed in: who is allowing, in which organisation, and whether a connection already covers the request. */
  const STATE = { type: 'object', required: ['query'], properties: { query: QUERY } } as const;
  app.post<{ Body: unknown }>('/api/v0/oidc/authorize/state', { schema: { body: LOOSE } }, (req) => tx(req, async (c, v) => {
    if (!v.person || v.nativeDevice) fail(403, 'Allow apps from your browser account');
    if (!oidcOn()) fail(404, 'Sign in with Pulse is not set up on this server');
    const b = body<{ query: AuthorizeQuery }>(STATE, req.body);
    const app2 = await appOf(c, b.query.client_id ?? ''), r = checkAuthorize(b.query, app2);
    if (!('scopes' in r)) fail(400, 'This sign-in request is not valid');
    const ok = r as Extract<Checked, { scopes: string[] }>;
    return one(c, 'select pulse.oidc_consent_state($1) r', [JSON.stringify({ clientId: ok.app.clientId, scopes: ok.scopes })]);
  }));
  /** Allow: the connection is made or widened and the app gets a one-time code. */
  const ALLOW = { type: 'object', required: ['query'], properties: { query: QUERY, off: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } } } } as const;
  app.post<{ Body: unknown }>('/api/v0/oidc/authorize/allow', { schema: { body: LOOSE } }, (req) => tx(req, async (c, v) => {
      if (!v.person || v.nativeDevice) fail(403, 'Allow apps from your browser account');
      const on = await ready();
      if (!on) fail(404, 'Sign in with Pulse is not set up on this server');
      if (!await allow(req, 'oidc-allow', 120)) fail(429, 'Too many attempts. Try again in 15 minutes.');
      const b = body<{ query: AuthorizeQuery; off?: string[] }>(ALLOW, req.body);
      const r = checkAuthorize(b.query, await appOf(c, b.query.client_id ?? ''));
      if (!('scopes' in r)) fail(400, 'This sign-in request is not valid');
      const ok = r as Extract<Checked, { scopes: string[] }>;
      const code = token('pxc_'), session = await sessionOf(c, req, v);
      await one(c, 'select pulse.oidc_authorize($1) r', [JSON.stringify({ clientId: ok.app.clientId, redirectUri: ok.redirectUri, scopes: ok.scopes,
        off: (b.off ?? []).filter((s) => ORG_SCOPES.has(s) || s === 'pulse.clients.read'), challenge: ok.challenge, nonce: ok.nonce,
        codeHash: sessionHash(code), authTime: session.authTime, amr: session.amr })]);
      return { redirect: returnTo(ok.redirectUri, { code, state: ok.state }, on!.issuer) };
  }));
  /** Cancel, or what the page cannot do without the person (prompt=none): back to the app with the error. */
  app.post<{ Body: { query: AuthorizeQuery; error: string } }>('/api/v0/oidc/authorize/refuse', {
    schema: { body: { type: 'object', required: ['query', 'error'], properties: { query: QUERY, error: { enum: ['access_denied', 'login_required', 'consent_required', 'interaction_required', 'account_selection_required'] } } } },
  }, async (req) => {
    const on = await ready();
    if (!on) fail(404, 'Sign in with Pulse is not set up on this server');
    const r = checkAuthorize(req.body.query, await open((c) => appOf(c, req.body.query.client_id ?? '')));
    if ('fatal' in r) fail(400, 'This sign-in request is not valid');
    const ok = r as Exclude<Checked, { fatal: string }>;
    return { redirect: returnTo(ok.redirectUri, { error: req.body.error, state: ok.state }, on!.issuer) };
  });

  // ----- sign-up: "New to Pulse? Create your account", from an app's sign-in (signed out) -----------------------------
  // A new Pulse account and the organisation it starts, with a session there; then back to the consent screen. Only
  // while Sign in with Pulse is on: elsewhere a Pulse is joined by invitation or started from an account.
  app.post<{ Body: Record<string, unknown> }>('/api/v0/auth/signup', { schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'handle', 'email', 'password', 'orgName'], properties: {
    name: { type: 'string', maxLength: 120 }, handle: { type: 'string', maxLength: 40 }, email: { type: 'string', maxLength: 254 }, password: { type: 'string', maxLength: 200 },
    orgName: { type: 'string', maxLength: 80 } } } } }, async (req) => {
    if (!oidcOn()) fail(404, 'Not found');
    if (!await allow(req, 'signup', 5)) fail(429, 'Too many sign-ups from here. Try again in 15 minutes.');
    const body = req.body as Record<string, string>, problem = passwordError(body.password);
    if (problem) fail(400, problem);
    const session = randomBytes(32).toString('base64url');
    const r = await open(async (c) => {
      try { return (await c.query('select pulse.account_signup($1,$2,$3) r', [JSON.stringify(body), sessionHash(session), deviceLabel(String(req.headers['x-pulse-device-agent'] ?? req.headers['user-agent'] ?? ''))])).rows[0].r; }
      catch (e) { const err = e as { code?: string; message?: string }; if (err.code === '23505' || err.code === '22023' || err.code === '54000') fail(err.code === '23505' ? 409 : err.code === '54000' ? 429 : 400, String(err.message)); throw e; }
    });
    if (!r) fail(403, 'Pulse could not open your new organisation. Try signing in.');
    return { ...answer(r, session), maxAge: 2592000 };
  });

  // ----- the token endpoint, userinfo and revocation (server to server, form-encoded) -------------------------------
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16384 },
      (_req, body, done) => { try { done(null, Object.fromEntries(new URLSearchParams(String(body)))); } catch (e) { done(e as Error, undefined); } });
    scope.post('/oauth/token', async (req, reply) => {
      if (!oidcOn()) return reply.callNotFound();
      const on = await ready();
      if (!on) return oauthError(reply, 503, 'temporarily_unavailable', 'Sign in with Pulse is not set up on this server');
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, string>;
      const who = clientCredentials(req.headers.authorization, body);
      if ('error' in who || !SECRET.test(who.secret)) {
        if (!await allow(req, 'oidc-client-fail', 30)) return oauthError(reply, 429, 'slow_down', 'Too many failed attempts');
        return oauthError(reply, 'error' in who && who.error === 'invalid_request' ? 400 : 401, 'error' in who ? who.error : 'invalid_client');
      }
      // The app's own budget is charged only once its secret is right: a client id is public, so a stranger with it
      // must not use up the app's token calls.
      if (!await open((c) => one<boolean>(c, 'select pulse.oidc_client_ok($1,$2) r', [who.id.slice(0, 40), sessionHash(who.secret)]))) {
        if (!await allow(req, 'oidc-client-fail', 30)) return oauthError(reply, 429, 'slow_down', 'Too many failed attempts');
        return oauthError(reply, 401, 'invalid_client');
      }
      const spend = clientBudget(who.id);
      if (spend()) { reply.header('retry-after', String(spend.state().reset)); return oauthError(reply, 429, 'slow_down', 'Too many token requests for this app'); }
      const access = token('pxa_'), refresh = token('pxr_'), base = { clientId: who.id.slice(0, 40), secretHash: sessionHash(who.secret), accessHash: sessionHash(access) };
      let r: TokenAnswer;
      if (body.grant_type === 'authorization_code') {
        if (!CODE.test(body.code ?? '') || !VERIFIER.test(body.code_verifier ?? '') || typeof body.redirect_uri !== 'string') return oauthError(reply, 400, 'invalid_request', 'code, code_verifier and redirect_uri are required');
        r = await open((c) => one<TokenAnswer>(c, 'select pulse.oidc_token_code($1) r', [JSON.stringify({ ...base, codeHash: sessionHash(body.code), redirectUri: body.redirect_uri,
          verifierChallenge: s256(body.code_verifier), refreshHash: sessionHash(refresh) })]));
      } else if (body.grant_type === 'refresh_token') {
        if (!REFRESH.test(body.refresh_token ?? '')) return oauthError(reply, 400, 'invalid_grant');
        r = await open((c) => one<TokenAnswer>(c, 'select pulse.oidc_token_refresh($1) r', [JSON.stringify({ ...base, refreshHash: sessionHash(body.refresh_token),
          newRefreshHash: sessionHash(refresh), ...(body.scope ? { scopes: scopeList(body.scope) } : {}) })]));
      } else return oauthError(reply, 400, 'unsupported_grant_type');
      if (r.error === 'invalid_client') {
        if (!await allow(req, 'oidc-client-fail', 30)) return oauthError(reply, 429, 'slow_down', 'Too many failed attempts');
        return oauthError(reply, 401, 'invalid_client');
      }
      if (r.error) return oauthError(reply, 400, r.error);
      return reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send({
        access_token: access, token_type: 'Bearer', expires_in: 3600, ...(r.refresh ? { refresh_token: refresh } : {}), scope: r.scopes.join(' '),
        ...(r.claims ? { id_token: idToken(on.keys[0], on.issuer, who.id, r, access) } : {}), ...(r.kind === 'org' ? { pulse_org_id: r.org } : {}) });
    });
    scope.post('/oauth/revoke', async (req, reply) => {
      if (!oidcOn()) return reply.callNotFound();
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, string>;
      const who = clientCredentials(req.headers.authorization, body);
      if ('error' in who || !SECRET.test(who.secret)) {
        if (!await allow(req, 'oidc-client-fail', 30)) return oauthError(reply, 429, 'slow_down');
        return oauthError(reply, 401, 'invalid_client');
      }
      const tok = String(body.token ?? '');
      if (!ACCESS.test(tok) && !REFRESH.test(tok)) return reply.header('cache-control', 'no-store').send({});
      const r = await open((c) => one<{ error?: string }>(c, 'select pulse.oidc_token_revoke($1) r', [JSON.stringify({ clientId: who.id.slice(0, 40), secretHash: sessionHash(who.secret), tokenHash: sessionHash(tok) })]));
      if (r.error) return oauthError(reply, 401, 'invalid_client');
      return reply.header('cache-control', 'no-store').send({});
    });
    const userinfo = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!oidcOn()) return reply.callNotFound();
      const on = await ready();
      if (!on) return oauthError(reply, 503, 'temporarily_unavailable');
      const m = /^Bearer (pxa_[A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? ''));
      const refuse = (status: number, error: string) => reply.code(status).header('www-authenticate', `Bearer error="${error}"`).header('cache-control', 'no-store').send({ error });
      if (!m) return refuse(401, 'invalid_token');
      const r = await open(async (c) => {
        const p = await one<{ error?: string; app: string; clientId: string; person: string; scopes: string[]; org: string; kind: string } | null>(c, 'select pulse.oidc_principal($1,$2,false) r', [sessionHash(m[1]), 'openid']);
        if (!p || p.error) return { p };
        return { p, claims: await one<Record<string, unknown> | null>(c, 'select pulse.oidc_claims($1,$2,$3) r', [p.app, p.person, p.scopes]) };
      });
      if (!r.p) return refuse(401, 'invalid_token');
      if (r.p.error) return refuse(403, 'insufficient_scope');
      if (!r.claims) return refuse(401, 'invalid_token');
      return reply.header('cache-control', 'no-store').send({ ...publicClaims(r.claims, on.issuer, on.keys[0], r.p.clientId, r.p.org), ...(r.p.kind === 'org' ? { pulse_org_id: r.p.org } : {}) });
    };
    scope.get('/oauth/userinfo', userinfo);
    scope.post('/oauth/userinfo', userinfo);
  });

  // ----- Settings → Developer apps (admins of the install's own organisation) ----------------------------------------
  const APP_BODY = { type: 'object', additionalProperties: false, required: ['name', 'redirectUris'], properties: {
    name: { type: 'string', minLength: 2, maxLength: 80 }, maker: { type: 'string', maxLength: 80 }, homeUrl: { type: 'string', maxLength: 300 },
    redirectUris: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', maxLength: 300 } },
    scopes: { type: 'array', maxItems: 20, items: { enum: [...SCOPES] } }, development: { type: 'boolean' } } } as const;
  const manage = (c: PoolClient, op: string, p: object) => one<Record<string, unknown>>(c, 'select pulse.oidc_app_manage($1,$2) r', [op, JSON.stringify(p)]);
  /** An install admin first (403 for anyone else), then the body. */
  const admin = (c: PoolClient) => c.query('select pulse.oidc_install_admin()');
  app.get('/api/v0/oidc/apps', (req) => tx(req, async (c) => ({ apps: await manage(c, 'list', {}), issuer: oidcIssuer(), on: !!(await ready()) })));
  app.post<{ Body: unknown }>('/api/v0/oidc/apps', { schema: { body: LOOSE } }, (req) => tx(req, async (c) => {
    await admin(c);
    const b = body<Record<string, unknown>>(APP_BODY, req.body), clientId = newClientId(), clientSecret = newClientSecret();
    const r = await manage(c, 'save', { ...b, clientId, secretHash: sessionHash(clientSecret) });
    return { ...r, clientSecret, warning: 'Shown once. Put it in the app’s own secret store; Pulse keeps only a fingerprint of it.' };
  }));
  app.post<{ Params: { id: string }; Body: unknown }>('/api/v0/oidc/apps/:id', { schema: { body: LOOSE } }, (req) => tx(req, async (c) => {
    await admin(c); return manage(c, 'save', { ...body<Record<string, unknown>>(APP_BODY, req.body), id: uuid(req.params.id) });
  }));
  app.post<{ Params: { id: string } }>('/api/v0/oidc/apps/:id/secret', (req) => tx(req, async (c) => {
    const clientSecret = newClientSecret();
    return { ...await manage(c, 'secret', { id: uuid(req.params.id), secretHash: sessionHash(clientSecret) }), clientSecret,
      warning: 'Shown once. The previous secret keeps working for 24 hours, so the app can switch without a gap.' };
  }));
  app.post<{ Params: { id: string }; Body: unknown }>('/api/v0/oidc/apps/:id/status', { schema: { body: LOOSE } }, (req) => tx(req, async (c) => {
    await admin(c); return manage(c, 'status', { id: uuid(req.params.id), on: body<{ on: boolean }>(STATUS, req.body).on });
  }));
  app.post<{ Params: { id: string }; Body: unknown }>('/api/v0/oidc/apps/:id/verify', { schema: { body: LOOSE } }, (req) => tx(req, async (c) => {
    await admin(c); return manage(c, 'verify', { id: uuid(req.params.id), verified: body<{ verified: boolean }>(VERIFY, req.body).verified });
  }));
  app.post<{ Params: { id: string }; Body: { image?: unknown } }>('/api/v0/oidc/apps/:id/logo', { bodyLimit: 1_500_000, schema: { body: LOOSE } }, (req) => tx(req, async (c) => {
    await admin(c);
    const image = body<{ image?: string }>(LOGO, req.body).image;
    let logo: string | null = null;
    if (image) {
      const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image);
      if (!m) fail(400, 'Choose a PNG, JPEG or WebP image');
      // Re-encoded here: a square PNG of at most 256 px, nothing of the original file's metadata kept.
      logo = (await sharp(Buffer.from(m![2], 'base64'), { limitInputPixels: 25_000_000 }).resize(256, 256, { fit: 'cover' }).png().toBuffer().catch(() => fail(400, 'This image could not be read'))).toString('base64');
    }
    return manage(c, 'logo', { id: uuid(req.params.id), logo, mime: logo ? 'image/png' : null });
  }));

  // ----- Settings → Connected apps and Account → Connected apps -------------------------------------------------------
  const connections = (c: PoolClient, op: string, p: object) => one<Record<string, unknown>>(c, 'select pulse.oidc_connections($1,$2) r', [op, JSON.stringify(p)]);
  app.get('/api/v0/oidc/connections', (req) => tx(req, async (c, v) => { if (!v.person) fail(403, 'Connections belong to a person'); return connections(c, 'list', {}); }));
  app.post<{ Params: { id: string }; Body: unknown }>('/api/v0/oidc/connections/:id/scopes', { schema: { body: LOOSE } }, (req) => tx(req, async (c) => {
    const scopes = Array.isArray((req.body as { scopes?: unknown })?.scopes) ? ((req.body as { scopes: unknown[] }).scopes).filter((s): s is string => typeof s === 'string').slice(0, 20) : [];
    return connections(c, 'scopes', { id: uuid(req.params.id), scopes });
  }));
  app.post<{ Params: { id: string } }>('/api/v0/oidc/connections/:id/end', (req) => tx(req, async (c) => connections(c, 'end', { id: uuid(req.params.id) })));
}

const uuid = (x: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x) ? x : fail(404, 'No such record');
/** When and how the person signed in (an Access identity: Cloudflare's sign-in; a session: its start and kind). */
async function sessionOf(c: PoolClient, req: FastifyRequest, v: Viewer): Promise<{ authTime: string; amr: 'pwd' | 'google' | 'sso' }> {
  if (v.via === 'access') return { authTime: new Date().toISOString(), amr: 'sso' };
  const s = (await c.query('select created_at, via from pulse.login_session where token_hash=$1', [sessionHash(String(req.headers['x-pulse-session'] ?? ''))])).rows[0];
  return { authTime: (s?.created_at ? new Date(s.created_at) : new Date()).toISOString(), amr: s?.via === 'google' ? 'google' : 'pwd' };
}
