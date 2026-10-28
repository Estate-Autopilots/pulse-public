import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { deviceLabel } from './auth-policy.js';
import { fail, sessionHash, type Tx, type Open } from './routes.js';
import { companyOrigin, normaliseHost, requestCompany } from './tenant-context.js';
import { googleClient, hostedGoogleCompany } from './google-client.js';
import { beginGoogleLink, googleConfigured, linkVerifiedGoogle, readGoogleLink, readGooglePolicy, type VerifiedGoogleClaims } from './google-sign-in.js';

// EST-1397 / frozen rc.1 §3: authorization code + PKCE S256, state bound to the HttpOnly pulse_oidc cookie, nonce.
// The web proxy (EST-1399) owns the cookies: it turns x-pulse-oidc-set, x-pulse-session-token and
// x-pulse-two-step-challenge into HttpOnly cookies and sends pulse_oidc back as x-pulse-oidc. No token is in a URL.
export type GoogleConfiguration = () => Promise<oidc.Configuration>;
export type GoogleNotice = (result: Record<string, unknown>, device: string, id: string) => void;
const ISSUER = 'https://accounts.google.com', CALLBACK = '/api/v0/auth/google/callback';
const secret = () => randomBytes(32).toString('base64url');
/** Cache by company + client. Secrets stay in memory until restart; a failed discovery can retry. No issuer override. */
export function createGoogleDiscovery(discover: typeof oidc.discovery = oidc.discovery): GoogleConfiguration {
 const cache = new Map<string, Promise<oidc.Configuration>>();
 return async () => {
  const client = googleClient();
  if (!client) throw new Error('Google sign-in is not configured');
  const key = JSON.stringify([client.company, client.clientId]);
  if (!cache.has(key)) cache.set(key, discover(new URL(ISSUER), client.clientId,
   { client_secret: client.clientSecret, [oidc.clockTolerance]: 60 }).catch(error => { cache.delete(key); throw error; }));
  return cache.get(key)!;
 };
}
export const googleDiscovery = createGoogleDiscovery();
/** Contract §3: the one check for every return path; anything else returns to "/". */
export function safeNext(next: unknown, origin = new URL(companyOrigin()).origin) {
 if (typeof next !== 'string' || next.length > 2000 || !/^\/(?!\/)/.test(next) || /[\u0000-\u001f\u007f\\]|%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(next)) return '/';
 const url = new URL(next, origin);
 return url.origin === origin && !/^\/(login|api)(\/|$)/.test(url.pathname) ? url.pathname + url.search + url.hash : '/';
}
/** Only this request company's claimed host, or the install's configured public address, can own a callback. */
export function googleOwnAddress(req: FastifyRequest) {
 const raw = req.headers['x-pulse-host'];
 if (hostedGoogleCompany()) return !!requestCompany()?.host && normaliseHost(raw) === requestCompany()?.host;
 try { return !!process.env.PULSE_PUBLIC_URL && (raw === undefined || normaliseHost(raw) === normaliseHost(new URL(process.env.PULSE_PUBLIC_URL).host)); } catch { return false; }
}
export function registerGoogleSignInFlow(app: FastifyInstance, tx: Tx, open: Open, notice: GoogleNotice, configure: GoogleConfiguration = googleDiscovery) {
 // The ID token signature is checked against Google's JWKS too, not only trusted from the TLS token response.
 const configuration = () => configure().then(config => { oidc.enableNonRepudiationChecks(config); return config; });
 // ONBOARD: an invitation's attempt goes back to the invitation page (it keeps the link in the tab), except Pulse's own
 // 2-step code, which the sign-in page asks for.
 const back = (reply: FastifyReply, mode: string, next: string, reason: string) => reply.redirect(mode === 'link' ? `/account?google=${reason}` : mode === 'invite' && reason !== 'two_step' ? `/login/set-password?google=${reason}` : `/login?${new URLSearchParams({ next, google: mode === 'silent' && reason !== 'two_step' ? 'silent_failed' : reason })}`, 302);
 const ip = (req: FastifyRequest) => String(req.headers['x-pulse-client-ip'] ?? req.ip);
 // ONBOARD: mode=invite carries the ticket the invitation page got from POST /api/v0/auth/invite-peek (never the
 // invitation token itself); Google's account chooser is pointed at the invited address.
 app.get<{ Querystring: { mode: 'signin' | 'silent' | 'link' | 'invite'; next?: string; ticket?: string } }>('/api/v0/auth/google/start', { schema: { querystring: { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { enum: ['signin', 'silent', 'link', 'invite'] }, next: { type: 'string', maxLength: 2000 }, ticket: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } } } } }, async (req, reply) => {
  const { mode } = req.query, next = mode === 'link' ? '/account' : mode === 'invite' ? '/dashboard?welcome=1' : safeNext(req.query.next), policy = await open(readGooglePolicy);
  if (!googleConfigured() || !googleOwnAddress(req) || policy.enabled !== true) return reply.callNotFound();
  if (!(await open(async c => (await c.query('select pulse.auth_allow($1,30) ok', [sessionHash('google-start:' + ip(req))])).rows[0].ok))) fail(429, 'Too many attempts. Try again in 15 minutes.');
  const config = await configuration().catch(() => null);
  if (!config) return back(reply, mode, next, mode === 'silent' ? 'silent_failed' : 'provider_error');
  const browser = secret(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
  let state = oidc.randomState(), hint: string | null = null;
  const ticketHash = mode === 'invite' && req.query.ticket ? sessionHash(req.query.ticket) : undefined;
  if (mode === 'invite') {
   hint = ticketHash ? await open(async c => (await c.query('select pulse.google_invite_hint($1) e', [ticketHash])).rows[0].e) : null;
   if (!hint) return back(reply, mode, next, 'state_invalid');
  }
  if (mode === 'link') {
   const begun = await tx(req, async (c, v) => { if (v.via !== 'password' || v.nativeDevice) fail(403, 'Use your browser account session'); return beginGoogleLink(c, String(req.headers['x-pulse-session']), browser, nonce, verifier); });
   if (begun.error) return back(reply, mode, next, begun.error);
   state = begun.state;
  } else await open(c => c.query('select pulse.google_auth_attempt($1,$2)', ['begin', JSON.stringify({ stateHash: sessionHash(state), cookieHash: sessionHash(browser), nonce, verifier, mode, next, ...(ticketHash ? { ticketHash } : {}) })]));
  const url = oidc.buildAuthorizationUrl(config, { redirect_uri: new URL(CALLBACK, companyOrigin()).href, scope: 'openid email profile', state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
   ...(mode === 'silent' ? { prompt: 'none' } : mode === 'link' ? { prompt: 'select_account', max_age: '300' } : hint ? { prompt: 'select_account', login_hint: hint } : {}), ...(policy.allowedDomains.length === 1 ? { hd: policy.allowedDomains[0] } : {}) });
  return reply.header('x-pulse-oidc-set', browser).redirect(url.href, 302);
 });
 app.get<{ Querystring: Record<string, string> }>(CALLBACK, { schema: { querystring: { type: 'object', maxProperties: 10, additionalProperties: { type: 'string', maxLength: 4096 } } } }, async (req, reply) => {
  if (!googleOwnAddress(req)) return reply.callNotFound();
  const query = new URLSearchParams(req.query), state = query.get('state') ?? '', browser = String(req.headers['x-pulse-oidc'] ?? '');
  // Each attempt is consumed before the code is exchanged, so a replayed state or code finds nothing.
  let attempt = await open(async c => (await c.query('select pulse.google_auth_attempt($1,$2) d', ['take', JSON.stringify({ stateHash: sessionHash(state), cookieHash: sessionHash(browser) })])).rows[0].d);
  if (attempt.error) attempt = { ...await open(c => readGoogleLink(c, state, browser)), mode: 'link', next: '/account' };
  if (attempt.error) return back(reply, 'signin', '/', 'state_invalid');
  const { mode, next, ticketHash } = attempt as { mode: string; next: string; ticketHash?: string };
  let claims: oidc.IDToken | undefined;
  try {
   claims = (await oidc.authorizationCodeGrant(await configuration(), new URL(`${CALLBACK}?${query}`, companyOrigin()), { pkceCodeVerifier: attempt.verifier, expectedState: state, expectedNonce: attempt.nonce, ...(mode === 'link' ? { maxAge: 300 } : {}) })).claims();
   // The library checks iat's type; the contract also refuses issue times ahead of our 60 s leeway.
   if (claims && (!Number.isFinite(claims.iat) || claims.iat > Date.now() / 1000 + 60 || claims.iat > claims.exp)) claims = undefined;
  } catch (error) { req.log.warn({ code: (error as { code?: string }).code ?? 'unknown' }, 'Google sign-in refused'); }
  const domains: string[] = (await open(readGooglePolicy)).allowedDomains;
  // External consent screens let personal Google accounts reach this callback: no hd, or another hd, is refused.
  const reason = !claims || claims.iss !== ISSUER || claims.email_verified !== true || typeof claims.email !== 'string' ? (mode === 'silent' ? 'silent_failed' : 'provider_error')
   : typeof claims.hd !== 'string' || !domains.includes(claims.hd) ? 'domain_not_allowed' : null;
  if (mode === 'link') {
   const linked = await open(c => linkVerifiedGoogle(c, state, browser, (reason ? {} : claims) as VerifiedGoogleClaims));
   return back(reply, mode, next, reason ?? linked.error ?? 'linked');
  }
  if (reason || !claims) return back(reply, mode, next, reason ?? 'provider_error');
  const token = secret(), challenge = secret(), device = deviceLabel(String(req.headers['x-pulse-device-agent'] ?? req.headers['user-agent'] ?? ''));
  // ONBOARD: an invitation links the verified Google account when its e-mail is exactly the invited address, then signs in.
  const result = await open(async c => (mode === 'invite'
   ? await c.query('select pulse.google_invite_accept($1,$2,$3,$4,$5) d', [ticketHash ?? '', JSON.stringify({ iss: claims.iss, sub: claims.sub, email: claims.email, email_verified: claims.email_verified, hd: claims.hd }), sessionHash(challenge), sessionHash(token), device])
   : await c.query('select pulse.google_sign_in($1,$2,$3,$4,$5) d', [claims.iss, claims.sub, sessionHash(challenge), sessionHash(token), device])).rows[0].d);
  if (result.error) return back(reply, mode, next, result.error);
  // The 2-step challenge stays out of the URL; the proxy keeps it for POST /api/v0/auth/two-step (5 minutes).
  if (result.twoStep) { reply.header('x-pulse-two-step-challenge', challenge); return back(reply, mode, next, 'two_step'); }
  notice(result, device, String(req.headers['x-pulse-device-id'] ?? sessionHash(String(req.headers['user-agent'] ?? 'API'))));
  return reply.header('x-pulse-session-token', token).redirect(next, 302);
 });
}
