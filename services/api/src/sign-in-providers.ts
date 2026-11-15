// LOGIN-VITALS (owner, 13 Nov 2026: "prepare Microsoft and Apple sign-in the same way"): Continue with Microsoft and
// Continue with Apple, built like Continue with Google (google-sign-in-flow.ts): authorization code with state bound to
// the HttpOnly pulse_oidc cookie, nonce, PKCE where the provider supports it, the ID token checked against the
// provider's keys, and the person found by the e-mail the provider verified (pulse.oidc_sign_in_any, migration 2033).
// Off unless the server switches each one on and holds its client; the console steps are in docs/ops/SIGN-IN-PROVIDERS.md.
//
//   PULSE_MICROSOFT_SIGN_IN=1   PULSE_MICROSOFT_CLIENT_ID, PULSE_MICROSOFT_CLIENT_SECRET (or _FILE)
//   PULSE_APPLE_SIGN_IN=1       PULSE_APPLE_CLIENT_ID (the Services ID), PULSE_APPLE_TEAM_ID, PULSE_APPLE_KEY_ID,
//                               PULSE_APPLE_PRIVATE_KEY (or _FILE: the .p8 key; Pulse signs a one-hour client secret)
//
// Only the platform's own addresses and the install's own address use these clients (never a company's own address,
// which has its own Google client and nothing else): the same rule as the install's Google client.
import { createPrivateKey, randomBytes, sign as signWith } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { deviceLabel } from './auth-policy.js';
import { fail, sessionHash, type Open } from './routes.js';
import { companyOrigin, hostCompany } from './tenant-context.js';
import { hostedGoogleCompany } from './google-client.js';
import { googleOwnAddress, safeNext, type GoogleNotice } from './google-sign-in-flow.js';

export type SignInProvider = 'microsoft' | 'apple';
export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = ['microsoft', 'apple'];
type Spec = { label: string; flag: string; issuer: string; scope: string; pkce: boolean; formPost: boolean };
export const PROVIDER: Record<SignInProvider, Spec> = {
  // The multi-tenant endpoint: work and school accounts and personal Microsoft accounts. openid-client checks each ID
  // token's issuer against its own tenant (tid).
  microsoft: { label: 'Microsoft', flag: 'PULSE_MICROSOFT_SIGN_IN', issuer: 'https://login.microsoftonline.com/common/v2.0', scope: 'openid email profile', pkce: true, formPost: false },
  // Apple returns the e-mail only with response_mode=form_post (a POST from appleid.apple.com, which the web proxy turns
  // into a GET of the same callback so the SameSite=Lax binding cookie comes with it). No PKCE: state, nonce and the cookie.
  apple: { label: 'Apple', flag: 'PULSE_APPLE_SIGN_IN', issuer: 'https://appleid.apple.com', scope: 'openid email name', pkce: false, formPost: true },
};
export const providerCallback = (p: SignInProvider) => `/api/v0/auth/${p}/callback`;
/** Personal Microsoft accounts (outlook.com, hotmail.com, live.com) all carry one tenant id, Microsoft's consumer tenant.
 *  It is server configuration (PULSE_MICROSOFT_PERSONAL_TENANT, the value is in SIGN-IN-PROVIDERS.md), not a literal here
 *  (API source holds no UUIDs: test/no-org-fallback.test.mjs). Unset: only work accounts with xms_edov sign in. */
const personalTenant = (env: NodeJS.ProcessEnv) => env.PULSE_MICROSOFT_PERSONAL_TENANT?.trim().toLowerCase() || null;

const fromEnvOrFile = (value: string | undefined, file: string | undefined) => value?.trim() || (file ? readFileSync(file, 'utf8').trim() : '');
type Client = { clientId: string; secret: () => string };

/** The provider's client when the server switched it on and holds everything it needs, else null. */
export function providerClient(p: SignInProvider, env: NodeJS.ProcessEnv = process.env): Client | null {
  if (env[PROVIDER[p].flag] !== '1') return null;
  try {
    if (p === 'microsoft') {
      const clientId = env.PULSE_MICROSOFT_CLIENT_ID?.trim() ?? '', secret = fromEnvOrFile(env.PULSE_MICROSOFT_CLIENT_SECRET, env.PULSE_MICROSOFT_CLIENT_SECRET_FILE);
      return clientId && secret ? { clientId, secret: () => secret } : null;
    }
    const clientId = env.PULSE_APPLE_CLIENT_ID?.trim() ?? '', teamId = env.PULSE_APPLE_TEAM_ID?.trim() ?? '', keyId = env.PULSE_APPLE_KEY_ID?.trim() ?? '';
    const privateKey = fromEnvOrFile(env.PULSE_APPLE_PRIVATE_KEY, env.PULSE_APPLE_PRIVATE_KEY_FILE).replace(/\\n/g, '\n');
    if (!clientId || !teamId || !keyId || !privateKey) return null;
    createPrivateKey(privateKey);
    return { clientId, secret: () => appleClientSecret({ teamId, keyId, clientId, privateKey }) };
  } catch { return null; }
}
export const providerOn = (p: SignInProvider, env: NodeJS.ProcessEnv = process.env) => providerClient(p, env) !== null;

/** Apple's client secret: an ES256 JWT from the team's .p8 key, for one hour (Apple allows up to six months). */
export function appleClientSecret(k: { teamId: string; keyId: string; clientId: string; privateKey: string }, now = Date.now()): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(now / 1000);
  const input = `${part({ alg: 'ES256', kid: k.keyId })}.${part({ iss: k.teamId, iat, exp: iat + 3600, aud: 'https://appleid.apple.com', sub: k.clientId })}`;
  return `${input}.${signWith('sha256', Buffer.from(input), { key: createPrivateKey(k.privateKey), dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

/** The e-mail the provider itself verified, lower case, else null (then nobody is signed in: never a guess).
 *  Microsoft: the `email` claim of a work account is whatever its tenant's admin typed, unverified by default (the
 *  "nOAuth" takeover). It counts only for a personal account (Microsoft verified it) or when Microsoft says the tenant
 *  owns the e-mail's domain: the optional claim xms_edov, which the app registration asks for (SIGN-IN-PROVIDERS.md).
 *  Apple: email_verified (true, or "true" in older tokens); a private relay address only matches if it is on record. */
export function verifiedEmail(p: SignInProvider, claims: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): string | null {
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const yes = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
  if (p === 'apple') return yes(claims.email_verified) ? email : null;
  const personal = personalTenant(env);
  return (personal !== null && typeof claims.tid === 'string' && claims.tid.toLowerCase() === personal) || yes(claims.xms_edov) ? email : null;
}

export type ProviderConfiguration = (p: SignInProvider) => Promise<oidc.Configuration>;
/** Discovery per provider and client, kept in memory; Apple's (its client secret lasts an hour) is renewed every 50 minutes. */
export function createProviderDiscovery(discover: typeof oidc.discovery = oidc.discovery): ProviderConfiguration {
  const cache = new Map<string, Promise<oidc.Configuration>>();
  return async (p) => {
    const client = providerClient(p);
    if (!client) throw new Error(`${PROVIDER[p].label} sign-in is not configured`);
    const key = JSON.stringify([p, client.clientId, p === 'apple' ? Math.floor(Date.now() / 3_000_000) : 0]);
    if (!cache.has(key)) {
      for (const old of cache.keys()) if (old.startsWith(`["${p}"`)) cache.delete(old);
      const secret = client.secret();
      cache.set(key, discover(new URL(PROVIDER[p].issuer), client.clientId, { client_secret: secret, [oidc.clockTolerance]: 60 }, oidc.ClientSecretPost(secret))
        .catch((error) => { cache.delete(key); throw error; }));
    }
    return cache.get(key)!;
  };
}
export const providerDiscovery = createProviderDiscovery();

/** The platform's own addresses and the install's own address (never a company's own address). */
export const providerAddress = (req: FastifyRequest) => !hostedGoogleCompany() && googleOwnAddress(req);
/** Whether the sign-in page offers this provider here (GET /api/v0/auth/branding). */
export const providerOffered = (p: SignInProvider, req: FastifyRequest) => providerOn(p) && providerAddress(req);

const secret = () => randomBytes(32).toString('base64url');
export function registerProviderSignIn(app: FastifyInstance, open: Open, notice: GoogleNotice, configure: ProviderConfiguration = providerDiscovery) {
  // The ID token's signature is checked against the provider's keys too, not only trusted from the TLS token response.
  const configuration = (p: SignInProvider) => configure(p).then((config) => { oidc.enableNonRepudiationChecks(config); return config; });
  const ip = (req: FastifyRequest) => String(req.headers['x-pulse-client-ip'] ?? req.ip);
  for (const p of SIGN_IN_PROVIDERS) {
    const spec = PROVIDER[p], callback = providerCallback(p);
    // Back to the sign-in page with the reason; the page names the provider (idp) in its words.
    const back = (reply: FastifyReply, next: string, reason: string) => reply.redirect(`/login?${new URLSearchParams({ next, idp: p, reason })}`, 302);
    app.get<{ Querystring: { next?: string } }>(`/api/v0/auth/${p}/start`, { schema: { querystring: { type: 'object', additionalProperties: false, properties: { mode: { enum: ['signin'] }, next: { type: 'string', maxLength: 2000 } } } } }, async (req, reply) => {
      if (!providerOn(p) || !providerAddress(req)) return reply.callNotFound();
      const next = safeNext(req.query.next);
      if (!(await open(async (c) => (await c.query('select pulse.auth_allow($1,30) ok', [sessionHash(`${p}-start:` + ip(req))])).rows[0].ok))) fail(429, 'Too many attempts. Try again in 15 minutes.');
      const config = await configuration(p).catch(() => null);
      if (!config) return back(reply, next, 'provider_error');
      const browser = secret(), state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
      await open((c) => c.query('select pulse.google_auth_attempt($1,$2)', ['begin', JSON.stringify({ provider: p, stateHash: sessionHash(state), cookieHash: sessionHash(browser), nonce, verifier, mode: 'signin', next })]));
      const url = oidc.buildAuthorizationUrl(config, { redirect_uri: new URL(callback, companyOrigin()).href, scope: spec.scope, state, nonce,
        ...(spec.pkce ? { code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' } : {}),
        ...(spec.formPost ? { response_mode: 'form_post' } : { prompt: 'select_account' }) });
      return reply.header('x-pulse-oidc-set', browser).redirect(url.href, 302);
    });
    app.get<{ Querystring: Record<string, string> }>(callback, { schema: { querystring: { type: 'object', maxProperties: 10, additionalProperties: { type: 'string', maxLength: 4096 } } } }, async (req, reply) => {
      if (!providerOn(p) || !providerAddress(req)) return reply.callNotFound();
      const query = new URLSearchParams(req.query), state = query.get('state') ?? '', browser = String(req.headers['x-pulse-oidc'] ?? '');
      // Each attempt is consumed before the code is exchanged, so a replayed state or code finds nothing.
      const attempt = await open(async (c) => (await c.query('select pulse.google_auth_attempt($1,$2) d', ['take', JSON.stringify({ provider: p, stateHash: sessionHash(state), cookieHash: sessionHash(browser) })])).rows[0].d);
      if (attempt.error) return back(reply, '/', 'state_invalid');
      const next = String(attempt.next ?? '/');
      let claims: oidc.IDToken | undefined;
      try {
        claims = (await oidc.authorizationCodeGrant(await configuration(p), new URL(`${callback}?${query}`, companyOrigin()),
          { expectedState: state, expectedNonce: attempt.nonce, ...(spec.pkce ? { pkceCodeVerifier: attempt.verifier } : {}) })).claims();
        if (claims && (!Number.isFinite(claims.iat) || claims.iat > Date.now() / 1000 + 60 || claims.iat > claims.exp)) claims = undefined;
      } catch (error) { req.log.warn({ code: (error as { code?: string }).code ?? 'unknown', provider: p }, 'provider sign-in refused'); }
      if (!claims) return back(reply, next, 'provider_error');
      const email = verifiedEmail(p, claims as Record<string, unknown>);
      if (!email) return back(reply, next, 'email_unverified');
      const token = secret(), challenge = secret(), device = deviceLabel(String(req.headers['x-pulse-device-agent'] ?? req.headers['user-agent'] ?? ''));
      const result = await open(async (c) => (await c.query('select pulse.oidc_sign_in_any($1,$2,$3,$4,$5) d',
        [p, JSON.stringify({ iss: claims!.iss, sub: claims!.sub, email, email_verified: true }), sessionHash(challenge), sessionHash(token), device])).rows[0].d);
      if (result.error) return back(reply, next, result.error);
      if (result.twoStep) { reply.header('x-pulse-two-step-challenge', challenge); return back(reply, next, 'two_step'); }
      if (!result.mustChange && !result.enrollmentRequired && !hostCompany()) await open(async (c) => c.query('select pulse.account_land($1)', [sessionHash(token)])).catch(() => null);
      notice(result, device, String(req.headers['x-pulse-device-id'] ?? sessionHash(String(req.headers['user-agent'] ?? 'API'))));
      return reply.header('x-pulse-session-token', token).redirect(next, 302);
    });
  }
}
