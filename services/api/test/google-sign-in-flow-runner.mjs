import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { startGoogle } from './google-harness.mjs';
import { createApp } from '../dist/app.js';
import { testMail } from '../dist/auth-mail.js';
import { safeNext } from '../dist/google-sign-in-flow.js';
const google = await startGoogle(), { codes, config, at } = google;
const now = () => Math.floor(Date.now() / 1000);
Object.assign(process.env, { PULSE_GOOGLE_CLIENT_ID: 'synthetic-client', PULSE_GOOGLE_CLIENT_SECRET_FILE: '/synthetic-unread', PULSE_PUBLIC_URL: 'https://pulse.example.test' });
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool, undefined, undefined, async () => config);
const password = 'Synthetic-account-2026!', person = process.env.PULSE_PERSON_ID, settings = { enabled: true, allowedDomains: ['example.test'], trustGoogle2Step: false, passwordSignIn: 'on' };
const call = async (method, url, token, payload, headers = {}) => { const r = await app.inject({ method, url, headers: { ...(token ? { 'x-pulse-session': token } : {}), ...headers }, ...(payload === undefined ? {} : { payload }) }); return { status: r.statusCode, body: r.body ? r.json() : null }; };
const signIn = async username => (await call('POST', '/api/v0/auth/sign-in', null, { username, password })).body.token;
const via = async token => { const c = await pool.connect(); try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [process.env.PULSE_ORG_ID]); return (await c.query('select via from pulse.login_session where token_hash=$1', [createHash('sha256').update(token).digest('hex')])).rows[0]?.via; } finally { await c.query('rollback'); c.release(); } };
const start = async (query, token) => {
 const r = await app.inject({ method: 'GET', url: '/api/v0/auth/google/start?' + new URLSearchParams(query), headers: { 'x-pulse-client-ip': randomBytes(6).toString('hex'), ...(token ? { 'x-pulse-session': token } : {}) } });
 assert.equal(r.statusCode, 302, r.body); const url = new URL(r.headers.location);
 assert.equal(r.headers['set-cookie'], undefined); assert.match(r.headers['x-pulse-oidc-set'], /^[A-Za-z0-9_-]{43}$/);
 return { url, state: url.searchParams.get('state'), browser: r.headers['x-pulse-oidc-set'] };
};
const finish = async (s, claims = {}, params) => {
 const code = randomBytes(12).toString('base64url');
 codes.set(code, { challenge: s.url.searchParams.get('code_challenge'), claims: { iss: 'https://accounts.google.com', aud: 'synthetic-client', sub: 'synthetic-google-subject', email: 'person@example.test', email_verified: true, hd: 'example.test', iat: now(), exp: now() + 3600, auth_time: now(), nonce: s.url.searchParams.get('nonce'), ...claims } });
 const query = new URLSearchParams(params ?? { state: s.state, code }); seen.push(...query.values());
 const r = await app.inject({ method: 'GET', url: '/api/v0/auth/google/callback?' + query, headers: { 'x-pulse-oidc': s.browser, 'x-pulse-device-id': 'synthetic-google-device' } });
 assert.equal(r.statusCode, 302); assert.equal(r.headers['set-cookie'], undefined); assert.ok(!/code=|token/i.test(r.headers.location));
 return { location: r.headers.location, code, token: r.headers['x-pulse-session-token'], challenge: r.headers['x-pulse-two-step-challenge'] };
};
const seen = [];
const signedIn = async () => (await finish(await start({ mode: 'signin' }))).token;
const totp = setupKey => { let bits = 0, value = 0; const bytes = [], counter = Buffer.alloc(8); for (const c of setupKey) { value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
 counter.writeBigInt64BE(BigInt(Math.floor(Date.now() / 30000))); const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(); return String((mac.readUInt32BE(mac[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0'); };
try {
 for (const unsafe of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/%09/evil.example', '/%0a/evil.example', '/%0d%0a/evil.example', '/%5c/evil.example', 'https://evil.example', '/login?next=/x', '/a/../login', '/api/v0/me', 'tasks']) assert.equal(safeNext(unsafe), '/', unsafe);
 assert.equal(safeNext('/tasks/7?view=board'), '/tasks/7?view=board');
 const admin = await signIn('auth.admin'); let own = await signIn('auth.person');
 assert.equal((await call('GET', '/api/v0/auth/branding')).body.google, true);
 // Another address of this install can never complete a callback: no button, no start.
 assert.equal((await call('GET', '/api/v0/auth/branding', null, undefined, { 'x-pulse-host': 'other.example.test' })).body.google, false);
 assert.equal((await app.inject({ method: 'GET', url: '/api/v0/auth/google/start?mode=signin', headers: { 'x-pulse-host': 'other.example.test' } })).statusCode, 404);
 // Sign-in never creates a person: an unlinked Google account goes back to the login page.
 let s = await start({ mode: 'signin', next: '/tasks/7?view=board' });
 assert.equal(s.url.origin + s.url.pathname, at + '/auth'); assert.equal(s.url.searchParams.get('prompt'), null);
 for (const [name, value] of Object.entries({ client_id: 'synthetic-client', response_type: 'code', scope: 'openid email profile', code_challenge_method: 'S256', hd: 'example.test', redirect_uri: 'https://pulse.example.test/api/v0/auth/google/callback' })) assert.equal(s.url.searchParams.get(name), value, name);
 assert.equal((await finish(s)).location, '/login?next=%2Ftasks%2F7%3Fview%3Dboard&google=not_linked');
 // Link: a fresh Google proof (auth_time within 5 minutes) under a normal Pulse session.
 s = await start({ mode: 'link' }, own); assert.equal(s.url.searchParams.get('prompt'), 'select_account'); assert.equal(s.url.searchParams.get('max_age'), '300');
 assert.equal((await finish(s, { auth_time: now() - 400 })).location, '/account?google=provider_error');
 assert.equal((await finish(await start({ mode: 'link' }, own))).location, '/account?google=linked');
 assert.equal((await finish(await start({ mode: 'signin', next: '/%09/evil.example' }))).location, '/');
 // Success: the deep link, a 12 h pulse_session recorded as Google, and the new-device notice.
 const notices = () => testMail.filter(m => m.title === 'New device signed in to Pulse').length, before = notices();
 s = await start({ mode: 'signin', next: '/tasks/7?view=board' }); const ok = await finish(s);
 assert.equal(ok.location, '/tasks/7?view=board'); assert.match(ok.token, /^[A-Za-z0-9_-]{43}$/);
 assert.equal((await call('GET', '/api/v0/me', ok.token)).status, 200); assert.equal(await via(ok.token), 'google');
 await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(notices(), before + 1);
 // Replays: the spent state finds no attempt; a fresh state cannot reuse the spent code; a forged browser cookie fails.
 assert.equal((await finish(s, {}, { state: s.state, code: ok.code })).location, '/login?next=%2F&google=state_invalid');
 s = await start({ mode: 'signin' }); assert.equal((await finish(s, {}, { state: s.state, code: ok.code })).location, '/login?next=%2F&google=provider_error');
 assert.equal((await finish({ ...(await start({ mode: 'signin' })), browser: 'forged' })).location, '/login?next=%2F&google=state_invalid');
 for (const [claims, reason] of [[{ aud: 'other-client' }, 'provider_error'], [{ iss: 'https://evil.example' }, 'provider_error'], [{ nonce: 'other-nonce' }, 'provider_error'], [{ iat: now() + 120 }, 'provider_error'], [{ exp: now() - 120, iat: now() - 3720 }, 'provider_error'],
  [{ forged: true }, 'provider_error'], [{ email_verified: false }, 'provider_error'], [{ hd: 'other.example' }, 'domain_not_allowed'], [{ hd: undefined }, 'domain_not_allowed'], [{ sub: 'synthetic-unlinked' }, 'not_linked']])
  assert.equal((await finish(await start({ mode: 'signin' }), claims)).location, '/login?next=%2F&google=' + reason, JSON.stringify(claims));
 // Quiet sign-in: prompt=none once; Google's login_required becomes silent_failed (no loop), a live Google session signs in.
 s = await start({ mode: 'silent', next: '/clients' }); assert.equal(s.url.searchParams.get('prompt'), 'none');
 assert.equal((await finish(s, {}, { state: s.state, error: 'login_required' })).location, '/login?next=%2Fclients&google=silent_failed');
 assert.equal((await finish(await start({ mode: 'silent' }), { sub: 'synthetic-unlinked' })).location, '/login?next=%2F&google=silent_failed');
 assert.equal((await finish(await start({ mode: 'silent', next: '/clients' }))).location, '/clients');
 // Sign-out ends only this Pulse session; the admin's sign-out-all and disabling end Google sessions on the next request.
 const local = await signedIn(); assert.equal((await call('POST', '/api/v0/auth/sign-out', local, {})).status, 200);
 assert.equal((await call('GET', '/api/v0/me', local)).status, 401); assert.equal((await call('GET', '/api/v0/me', own)).status, 200);
 const revoked = await signedIn(); assert.equal((await call('POST', `/api/v0/people/${person}/login`, admin, { action: 'sign-out-all' })).status, 200);
 assert.equal((await call('GET', '/api/v0/me', revoked)).status, 401);
 assert.equal((await call('POST', `/api/v0/people/${person}/login`, admin, { action: 'disable' })).status, 200);
 assert.equal((await finish(await start({ mode: 'signin' }))).location, '/login?next=%2F&google=account_disabled');
 assert.equal((await call('POST', `/api/v0/people/${person}/login`, admin, { action: 'enable' })).status, 200); own = await signIn('auth.person');
 // Pulse 2-step still applies with Trust Google 2-step on (ships off): the challenge travels in a header, never the URL.
 const setup = await call('POST', '/api/v0/auth/account', own, { action: 'totp-start', current: password });
 const recovery = (await call('POST', '/api/v0/auth/account', own, { action: 'totp-enable', current: password, code: totp(setup.body.setupKey) })).body.recoveryCodes;
 assert.equal((await call('PUT', '/api/v0/admin/sign-in/google', admin, { ...settings, trustGoogle2Step: true })).status, 200);
 const two = await finish(await start({ mode: 'signin', next: '/tasks/7' }));
 assert.equal(two.location, '/login?next=%2Ftasks%2F7&google=two_step'); assert.equal(two.token, undefined);
 const verified = await call('POST', '/api/v0/auth/two-step', null, { code: recovery[0], challenge: two.challenge });
 assert.equal(verified.status, 200); assert.equal(await via(verified.body.token), 'google');
 // Unlink ends Google sessions; turning Google off hides it.
 const pending = await finish(await start({ mode: 'signin' }));
 assert.equal((await call('POST', '/api/v0/auth/google/unlink', own, {})).status, 200); assert.equal((await call('GET', '/api/v0/me', verified.body.token)).status, 401);
 assert.equal((await call('POST', '/api/v0/auth/two-step', null, { code: recovery[1], challenge: pending.challenge })).status, 401);
 assert.equal((await finish(await start({ mode: 'signin' }))).location, '/login?next=%2F&google=not_linked');
 assert.equal((await call('PUT', '/api/v0/admin/sign-in/google', admin, { ...settings, enabled: false })).status, 200);
 assert.equal((await app.inject({ method: 'GET', url: '/api/v0/auth/google/start?mode=signin' })).statusCode, 404); assert.equal((await call('GET', '/api/v0/auth/branding')).body.google, false);
} finally { await app.close(); await pool.end(); await google.close(); process.stderr.write('GOOGLE-QUERY ' + JSON.stringify(seen.filter(v => v.length >= 16)) + '\n'); }
