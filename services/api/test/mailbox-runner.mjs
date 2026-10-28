// MAILBOX over HTTP (tests/core/test_company_mailbox.py): a hosted company's admin connects its own Google mailbox with
// a synthetic Google (no network): members are refused, no client set up says so, the state is bound to the admin's
// session and used once, a grant without gmail.send is refused, the token is sealed, invitations then come from the
// company's address and, after Disconnect, HR gets the Connect prompt (code mailbox_not_connected). Synthetic only.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { testCompanyMail } from '../dist/mailbox.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const host = process.env.TEST_HOST, ADDRESS = 'hr@mailco.example.test';
let checks = 0;
const call = async (method, path, token, payload) => {
  checks++;
  const r = await app.inject({ method, url: '/api/v0/' + path, headers: { 'x-pulse-host': host, 'x-pulse-client-ip': randomBytes(6).toString('hex'), ...(token ? { 'x-pulse-session': token } : {}) }, ...(payload === undefined ? {} : { payload }) });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
// The synthetic Google: token exchange (checks PKCE and the redirect address) and userinfo; anything else is refused.
const real = globalThis.fetch, seen = { tokens: [], scope: 'openid email https://www.googleapis.com/auth/gmail.send' };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === 'https://oauth2.googleapis.com/token') {
    const form = new URLSearchParams(String(init.body));
    seen.tokens.push(form);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('redirect_uri'), `https://${host}/settings/mailbox/google`);
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), seen.challenge);
    return new Response(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh-token', scope: seen.scope, expires_in: 3599 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u === 'https://openidconnect.googleapis.com/v1/userinfo') {
    assert.equal(init.headers.authorization, 'Bearer synthetic-access');
    return new Response(JSON.stringify({ email: 'HR@mailco.example.test', email_verified: true }), { status: 200 });
  }
  if (u.startsWith('https://')) throw new Error('unexpected network call: ' + u);
  return real(url, init);
};
const signIn = async (username) => {
  const r = await call('POST', 'auth/sign-in', null, { username, password: 'Synthetic-account-2026!' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.token); return r.body.token;
};
const start = async (token) => {
  const r = await call('POST', 'mailbox/google/start', token, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const url = new URL(r.body.url);
  seen.challenge = url.searchParams.get('code_challenge');
  return url;
};
try {
  const admin = await signIn(process.env.TEST_ADMIN_USER), member = await signIn(process.env.TEST_PERSON_USER);
  // Members never see or change the company mailbox.
  assert.equal((await call('GET', 'mailbox', member)).status, 403);
  assert.equal((await call('POST', 'mailbox/google/start', member, {})).status, 403);
  let s = await call('GET', 'mailbox', admin);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.connected, false); assert.equal(s.body.install, false); assert.equal(s.body.configured, false);
  assert.equal(s.body.redirectUri, `https://${host}/settings/mailbox/google`);
  assert.ok(!('token_sealed' in s.body));
  // No Google client on this server: Connect says so (the web shows the operator step).
  let r = await call('POST', 'mailbox/google/start', admin, {});
  assert.equal(r.status, 409); assert.equal(r.body.code, 'mailbox_unconfigured');
  // No mailbox yet: HR's invitation answers with the Connect prompt, and the admin sees it counted.
  // (Signing in already counted: the new-device notices could not be e-mailed either.)
  const before = (await call('GET', 'mailbox', admin)).body.blocked;
  assert.ok(before >= 1);
  r = await call('POST', `people/${process.env.TEST_PERSON}/login`, admin, { action: 'invite' });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'mailbox_not_connected'); assert.match(r.body.error, /Settings → Mail/);
  assert.ok((await call('GET', 'mailbox', admin)).body.blocked >= before + 1);

  Object.assign(process.env, { PULSE_MAIL_GOOGLE_CLIENT_ID: 'synthetic-mail-client', PULSE_MAIL_GOOGLE_CLIENT_SECRET: 'synthetic-mail-secret' });
  s = await call('GET', 'mailbox', admin);
  assert.equal(s.body.configured, true); assert.equal(s.body.clientKind, 'platform');
  let url = await start(admin);
  for (const [k, v] of Object.entries({ client_id: 'synthetic-mail-client', redirect_uri: `https://${host}/settings/mailbox/google`, response_type: 'code',
    access_type: 'offline', code_challenge_method: 'S256', scope: 'openid email https://www.googleapis.com/auth/gmail.send' })) assert.equal(url.searchParams.get(k), v, k);
  // A state that is not this admin's, or one already used, connects nothing (and never reaches Google).
  assert.equal((await call('POST', 'mailbox/google/finish', admin, { state: randomBytes(32).toString('base64url'), code: 'c' })).status, 400);
  assert.equal(seen.tokens.length, 0);
  // Google granted sign-in but not "send": refused, nothing kept.
  seen.scope = 'openid email';
  r = await call('POST', 'mailbox/google/finish', admin, { state: url.searchParams.get('state'), code: 'synthetic-code' });
  assert.equal(r.status, 400); assert.match(r.body.error, /permission to send/);
  assert.equal((await call('POST', 'mailbox/google/finish', admin, { state: url.searchParams.get('state'), code: 'synthetic-code' })).status, 400);
  assert.equal((await call('GET', 'mailbox', admin)).body.connected, false);
  // The real thing.
  seen.scope = 'openid email https://www.googleapis.com/auth/gmail.send';
  url = await start(admin);
  r = await call('POST', 'mailbox/google/finish', admin, { state: url.searchParams.get('state'), code: 'synthetic-code' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.connected, true); assert.equal(r.body.address, ADDRESS); assert.equal(r.body.blocked, 0);
  assert.ok(!JSON.stringify(r.body).includes('synthetic-refresh-token'));
  // The token is sealed in the database: never the plain value.
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [process.env.PULSE_ORG_ID]);
    const row = (await c.query('select * from pulse.org_mailbox_sealed()')).rows[0];
    assert.equal(row.address, ADDRESS); assert.ok(!row.token_sealed.toString('latin1').includes('synthetic-refresh-token'));
  } finally { await c.query('rollback'); c.release(); }
  // Send a test: from and to the mailbox itself.
  r = await call('POST', 'mailbox/test', admin, {});
  assert.equal(r.status, 200); assert.equal(r.body.to, ADDRESS);
  assert.equal(testCompanyMail.at(-1).from, ADDRESS); assert.equal(testCompanyMail.at(-1).to, ADDRESS);
  // HR's invitation now goes out from the company's own address, with a link to the company's own Pulse.
  r = await call('POST', `people/${process.env.TEST_PERSON}/login`, admin, { action: 'invite' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const invite = testCompanyMail.at(-1);
  assert.equal(invite.from, ADDRESS); assert.match(invite.to, /^person@/); assert.ok(invite.body.includes(`https://${host}/login/`), invite.body);
  // Disconnect: gone, and the next invitation asks for the mailbox again.
  r = await call('POST', 'mailbox/disconnect', member, {});
  assert.equal(r.status, 403);
  r = await call('POST', 'mailbox/disconnect', admin, {});
  assert.equal(r.status, 200); assert.equal(r.body.connected, false);
  r = await call('POST', `people/${process.env.TEST_PERSON}/login`, admin, { action: 'invite' });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'mailbox_not_connected');
  await writeFile(process.env.PULSE_MAILBOX_REPORT, JSON.stringify({ checks }));
  console.log(`mailbox runner: ok (${checks} calls)`);
} finally { globalThis.fetch = real; await app.close(); await pool.end(); }
