// ONBOARD: an invitation e-mailed to a company Google address → invite-peek → Continue with Google (mode=invite) →
// callback against the synthetic issuer: linked and signed in with no Pulse password; the wrong account goes back to
// the invitation page. Synthetic people only (Tara Kapoor, example.test).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { startGoogle } from './google-harness.mjs';
import { createApp } from '../dist/app.js';
import { testMail } from '../dist/auth-mail.js';
const google = await startGoogle(), { codes, config, at } = google;
const now = () => Math.floor(Date.now() / 1000);
Object.assign(process.env, { PULSE_GOOGLE_CLIENT_ID: 'synthetic-client', PULSE_GOOGLE_CLIENT_SECRET_FILE: '/synthetic-unread', PULSE_PUBLIC_URL: 'https://pulse.example.test' });
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool, undefined, undefined, async () => config);
const tara = process.env.PULSE_PERSON_ID, personal = process.env.TEST_PERSONAL_ID, TARA = 'tara.kapoor@example.test';
const call = async (method, url, token, payload, headers = {}) => { const r = await app.inject({ method, url, headers: { 'x-pulse-client-ip': randomBytes(6).toString('hex'), ...(token ? { 'x-pulse-session': token } : {}), ...headers }, ...(payload === undefined ? {} : { payload }) }); return { status: r.statusCode, body: r.body ? r.json() : null }; };
const via = async token => { const c = await pool.connect(); try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [process.env.PULSE_ORG_ID]); return (await c.query('select via from pulse.login_session where token_hash=$1', [createHash('sha256').update(token).digest('hex')])).rows[0]?.via; } finally { await c.query('rollback'); c.release(); } };
const start = async query => {
 const r = await app.inject({ method: 'GET', url: '/api/v0/auth/google/start?' + new URLSearchParams(query), headers: { 'x-pulse-client-ip': randomBytes(6).toString('hex') } });
 assert.equal(r.statusCode, 302, r.body);
 if (!r.headers.location.startsWith(at)) return { location: r.headers.location };
 const url = new URL(r.headers.location); assert.match(r.headers['x-pulse-oidc-set'], /^[A-Za-z0-9_-]{43}$/);
 return { url, state: url.searchParams.get('state'), browser: r.headers['x-pulse-oidc-set'] };
};
const finish = async (s, claims = {}) => {
 const code = randomBytes(12).toString('base64url');
 codes.set(code, { challenge: s.url.searchParams.get('code_challenge'), claims: { iss: 'https://accounts.google.com', aud: 'synthetic-client', sub: 'synthetic-tara', email: TARA, email_verified: true, hd: 'example.test', iat: now(), exp: now() + 3600, auth_time: now(), nonce: s.url.searchParams.get('nonce'), ...claims } });
 const r = await app.inject({ method: 'GET', url: '/api/v0/auth/google/callback?' + new URLSearchParams({ state: s.state, code }), headers: { 'x-pulse-oidc': s.browser, 'x-pulse-device-id': 'synthetic-invite-device' } });
 assert.equal(r.statusCode, 302); assert.ok(!/code=|token|ticket/i.test(r.headers.location));
 return { location: r.headers.location, token: r.headers['x-pulse-session-token'] };
};
const lastLink = to => { const m = testMail.filter(x => x.to === to).at(-1); assert.ok(m, 'an invitation e-mail to ' + to); const token = /\/login\/set-password#([A-Za-z0-9_-]{43})/.exec(m.body)?.[1]; assert.ok(token, m.body); return { mail: m, token }; };
try {
 const admin = (await call('POST', '/api/v0/auth/sign-in', null, { username: 'auth.admin', password: 'Synthetic-account-2026!' })).body.token;
 assert.ok(admin);
 // HR's Account access → Send invitation to Tara's company address: the e-mail says Continue with Google, no password.
 assert.equal((await call('POST', `/api/v0/people/${tara}/login`, admin, { action: 'invite' })).status, 200);
 const { mail, token } = lastLink(TARA);
 assert.match(mail.body, /company Google account \(tara\.kapoor@example\.test\) is your Pulse login/);
 assert.match(mail.body, /Continue with Google/); assert.doesNotMatch(mail.body, /Choose your password/);
 assert.match(mail.body, /https:\/\/pulse\.example\.test\/login\/how/);
 // invite-peek: the token in the body only; malformed tokens are refused, unknown ones are "not an invitation".
 assert.equal((await call('POST', '/api/v0/auth/invite-peek', null, { token: 'short' })).status, 400);
 assert.deepEqual((await call('POST', '/api/v0/auth/invite-peek', null, { token: randomBytes(32).toString('base64url') })).body, { invite: false, google: false });
 const peek = async () => { const r = await call('POST', '/api/v0/auth/invite-peek', null, { token }); assert.equal(r.status, 200); return r.body; };
 let p = await peek();
 assert.equal(p.invite, true); assert.equal(p.google, true); assert.equal(p.email, TARA); assert.match(p.ticket, /^[A-Za-z0-9_-]{43}$/);
 // Another address of this install never offers Google.
 assert.equal((await call('POST', '/api/v0/auth/invite-peek', null, { token }, { 'x-pulse-host': 'other.example.test' })).body.google, false);
 p = await peek();
 // Start: Google's chooser is pointed at the invited address; no ticket, or a stale one, goes back to the invitation page.
 let s = await start({ mode: 'invite', ticket: p.ticket });
 for (const [name, value] of Object.entries({ login_hint: TARA, prompt: 'select_account', hd: 'example.test', redirect_uri: 'https://pulse.example.test/api/v0/auth/google/callback' })) assert.equal(s.url.searchParams.get(name), value, name);
 assert.equal((await start({ mode: 'invite' })).location, '/login/set-password?google=state_invalid');
 assert.equal((await start({ mode: 'invite', ticket: randomBytes(32).toString('base64url') })).location, '/login/set-password?google=state_invalid');
 // The wrong Google account (same company) goes back to the invitation page; that ticket is spent.
 assert.equal((await finish(s, { sub: 'synthetic-colleague', email: 'someone@example.test' })).location, '/login/set-password?google=invite_email_mismatch');
 assert.equal((await start({ mode: 'invite', ticket: p.ticket })).location, '/login/set-password?google=state_invalid');
 assert.equal((await finish(await start({ mode: 'invite', ticket: (await peek()).ticket }), { hd: 'other.example' })).location, '/login/set-password?google=domain_not_allowed');
 // The right one: linked, signed in (12 h, recorded as Google), straight to the dashboard's welcome.
 const ok = await finish(await start({ mode: 'invite', ticket: (await peek()).ticket }));
 assert.equal(ok.location, '/dashboard?welcome=1'); assert.match(ok.token, /^[A-Za-z0-9_-]{43}$/);
 const me = await call('GET', '/api/v0/me', ok.token); assert.equal(me.status, 200); assert.equal(me.body.person, tara);
 assert.equal(await via(ok.token), 'google');
 // The invitation is used up; Continue with Google on Sign in now works for Tara like anyone linked.
 assert.deepEqual(await peek(), { invite: false, google: false });
 assert.equal((await finish(await start({ mode: 'signin', next: '/tasks' }))).location, '/tasks');
 // A personal address: the invitation keeps the password path (no Google offer), and its e-mail says so.
 assert.equal((await call('POST', `/api/v0/people/${personal}/login`, admin, { action: 'invite' })).status, 200);
 const other = lastLink('personal@gmail.example');
 assert.match(other.mail.body, /Choose your password/);
 assert.deepEqual((await call('POST', '/api/v0/auth/invite-peek', null, { token: other.token })).body, { invite: true, google: false });
 console.log('google invitation runner: ok');
} finally { await app.close(); await pool.end(); await google.close(); }
