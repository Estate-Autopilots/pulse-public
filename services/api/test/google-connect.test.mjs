// GOOGLE-CONNECT (10 Nov 2026): the "Vitals OS web" Google OAuth client (project vitals-os-513819) serves Sign in with
// Google, Settings → Mail (Gmail send) and Settings → You → Google Calendar on app, staging and dev.vitalsos.ai. These
// checks pin what Pulse sends to Google and what it does with Google's answers, with everything but Google's consent
// screen real: the routes, PKCE, the redirect addresses, the code exchange, the sealed refresh token, the refresh, the
// send and the calendar events. Google is a stub that checks each request; no network, no database (a stub client
// answers the few SQL calls), synthetic values only.
// When a redirect address changes here, add it to the Google client too (docs/ops/GOOGLE-OAUTH.md).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import Fastify from 'fastify';
import * as oidc from 'openid-client';
import { normaliseHost, runWithCompany } from '../dist/tenant-context.js';
import { registerGoogleSignInFlow } from '../dist/google-sign-in-flow.js';
import { companyMail, MAIL_SCOPE, registerMailboxRoutes } from '../dist/mailbox.js';
import { requireKeyring, seal } from '../dist/document-keys.js';
import { CALENDAR_SCOPE, registerCalendarRoutes } from '../dist/calendar.js';
import { v1Operations } from '../dist/v1.js';

// The OAuth client's "Authorized redirect URIs" (docs/ops/GOOGLE-OAUTH.md).
const HOSTS = ['app.vitalsos.ai', 'staging.vitalsos.ai', 'dev.vitalsos.ai'];
const REGISTERED = new Set(HOSTS.flatMap((h) => [`https://${h}/api/v0/auth/google/callback`, `https://${h}/settings/mailbox/google`, `https://${h}/settings/calendar/google`]));
const CLIENT = 'synthetic-client', SECRET = 'synthetic-secret';
const ORG = '00000000-0000-4000-8000-00000000e001', PERSON = '00000000-0000-4000-8000-00000000e002';

const scratch = mkdtempSync((process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir()) + '/google-connect-');
const saved = { ...process.env };
Object.assign(process.env, {
  // Each environment lists its own family; one list covering all three checks the same code path.
  PULSE_HOST_FAMILIES: JSON.stringify(HOSTS.map((app, i) => ({ name: ['vitals', 'staging', 'dev'][i], app }))),
  PULSE_PUBLIC_URL: 'https://pulse.example.test', PULSE_ENV: 'staging',
  PULSE_GOOGLE_CLIENT_ID: CLIENT, PULSE_GOOGLE_CLIENT_SECRET: SECRET,
  PULSE_MAIL_GOOGLE_CLIENT_ID: CLIENT, PULSE_MAIL_GOOGLE_CLIENT_SECRET: SECRET,
  PULSE_DOCUMENT_KEY_FILE: scratch + '/keyring', PULSE_MAIL_STAGING_ALLOW: 'person@example.test',
});
for (const key of ['PULSE_GOOGLE_CLIENT_SECRET_FILE', 'PULSE_MAIL_GOOGLE_CLIENT_SECRET_FILE', 'PULSE_CONNECTOR_SECRETS_DIR', 'PULSE_AUTH_MAIL_MODE']) delete process.env[key];
writeFileSync(scratch + '/keyring', `gc1 ${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
test.after(() => { process.env = saved; rmSync(scratch, { recursive: true, force: true }); });

/** A stand-in for one database connection: answers each SQL call the routes make by the function it names. */
function db(answers) {
  const calls = [];
  const client = { calls, async query(sql, params = []) {
    calls.push({ sql, params });
    for (const [fn, answer] of Object.entries(answers)) if (sql.includes(fn)) return { rows: await answer(params) };
    throw new Error('unexpected SQL in the stub: ' + sql.slice(0, 80));
  } };
  return client;
}
/** A bare API with the request's address in the tenant context, as app.ts sets it (no company host: the install's client). */
function api(register) {
  const app = Fastify();
  app.addHook('onRequest', (req, _reply, done) => { const raw = req.headers['x-pulse-host']; runWithCompany({ host: normaliseHost(raw), raw, company: null, installOrg: null }, done); });
  // As app.ts renders a refusal: { error, code }.
  app.setErrorHandler((e, _req, reply) => reply.status(e.statusCode ?? 500).send({ error: e.message, ...(e.publicCode ? { code: e.publicCode } : {}) }));
  register(app);
  return app;
}
/** Google's side, checking every request Pulse makes; anything else fails the test. A key ending in `*` matches the
 *  addresses under it (one calendar event each). */
function stubGoogle(handlers) {
  const seen = [], real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), key = u.split('?')[0];
    const handler = handlers[key] ?? Object.entries(handlers).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    seen.push(`${init.method ?? 'GET'} ${key}`);
    if (!handler) throw new Error('Pulse called an address the stub does not know: ' + u);
    const [status, body] = await handler(init, u);
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}
const params = (init) => new URLSearchParams(String(init.body ?? ''));

test('Sign in with Google: each vitalsos.ai host sends its own registered callback, with PKCE S256, state and nonce', async () => {
  const google = new oidc.Configuration({ issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token', jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs', id_token_signing_alg_values_supported: ['RS256'] }, CLIENT, { client_secret: SECRET });
  const begun = [];
  const conn = db({
    'pulse.google_policy()': () => [{ d: { enabled: true, allowedDomains: [], passwordSignIn: 'on', trustGoogle2Step: false } }],
    'pulse.auth_allow': () => [{ ok: true }],
    'pulse.google_auth_attempt': (p) => { begun.push(JSON.parse(p[1])); return [{ d: {} }]; },
  });
  const open = (run) => run(conn, ORG);
  const app = api((a) => registerGoogleSignInFlow(a, async () => { throw new Error('no session in this test'); }, open, () => {}, async () => google));
  try {
    for (const host of HOSTS) {
      const r = await app.inject({ method: 'GET', url: '/api/v0/auth/google/start?mode=signin&next=%2Ftasks', headers: { 'x-pulse-host': host, 'x-pulse-client-ip': '192.0.2.10' } });
      assert.equal(r.statusCode, 302, r.body);
      const to = new URL(r.headers.location), q = to.searchParams;
      assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
      assert.equal(q.get('client_id'), CLIENT);
      assert.equal(q.get('redirect_uri'), `https://${host}/api/v0/auth/google/callback`);
      assert.ok(REGISTERED.has(q.get('redirect_uri')), 'the Google client lists this callback');
      assert.equal(q.get('response_type'), 'code');
      assert.equal(q.get('scope'), 'openid email profile', 'sign-in asks for nothing sensitive');
      assert.equal(q.get('code_challenge_method'), 'S256');
      const attempt = begun.at(-1);
      assert.equal(createHash('sha256').update(attempt.verifier).digest('base64url'), q.get('code_challenge'), 'the verifier kept for the callback matches the challenge');
      assert.equal(attempt.nonce, q.get('nonce'));
      assert.equal(attempt.stateHash, createHash('sha256').update(q.get('state')).digest('hex'), 'only the state\'s hash is stored');
      assert.equal(attempt.next, '/tasks');
      assert.match(r.headers['x-pulse-oidc-set'], /^[A-Za-z0-9_-]{43}$/, 'the browser binding the web proxy turns into an HttpOnly cookie');
    }
    // A host outside the families (and not the install's address) never starts Google with the install's client.
    const other = await app.inject({ method: 'GET', url: '/api/v0/auth/google/start?mode=signin', headers: { 'x-pulse-host': 'elsewhere.example.test' } });
    assert.equal(other.statusCode, 404);
  } finally { await app.close(); }
});

test('Gmail send: connect, code exchange, sealed refresh token, hourly refresh and send, and a revoked grant', async () => {
  const viewer = { email: 'admin@example.test', org: ORG, person: PERSON, role: 'admin', name: 'Synthetic Admin', pod: null, via: 'password', username: 'synthetic.admin', mustChange: false };
  let attempt = null, saved = null, reports = [];
  const conn = db({
    'pulse.org_mailbox_state()': () => [{ d: { install: false, connected: !!saved } }],
    'pulse.org_mailbox_begin': (p) => { attempt = { stateHash: p[0], session: p[1], verifier: p[2] }; return []; },
    'pulse.org_mailbox_take': (p) => { const ok = attempt && p[0] === attempt.stateHash && p[1] === attempt.session; const v = ok ? attempt.verifier : null; attempt = null; return [{ v }]; },
    'pulse.org_mailbox_save': (p) => { saved = { address: p[0], client: p[1], key_id: p[2], token_wrapped: p[3], token_sealed: p[4] }; return []; },
    'pulse.org_mailbox_sealed()': () => (saved ? [saved] : []),
    'from pulse.org where': () => [{ name: 'Synthetic Mail Co' }],
    'pulse.org_mailbox_report': (p) => { reports.push(p); return []; },
  });
  const tx = (_req, run) => run(conn, viewer), open = (run) => run(conn, ORG);
  const app = api((a) => registerMailboxRoutes(a, { tx, open }));
  const host = 'staging.vitalsos.ai', REDIRECT = `https://${host}/settings/mailbox/google`;
  const headers = { 'x-pulse-host': host, 'x-pulse-session': 'synthetic-session-token' };
  let google;
  try {
    // 1. Connect: the address Google sends the admin back to, asking for lasting (offline) send-only access.
    const start = await app.inject({ method: 'POST', url: '/api/v0/mailbox/google/start', headers, payload: { hint: 'hr@example.test' } });
    assert.equal(start.statusCode, 200, start.body);
    const q = new URL(start.json().url).searchParams;
    assert.equal(q.get('redirect_uri'), REDIRECT);
    assert.ok(REGISTERED.has(REDIRECT), 'the Google client lists the mailbox return page');
    assert.deepEqual(q.get('scope').split(' '), ['openid', 'email', MAIL_SCOPE]);
    assert.equal(q.get('access_type'), 'offline'); assert.match(q.get('prompt'), /consent/);
    assert.equal(q.get('code_challenge_method'), 'S256'); assert.equal(q.get('login_hint'), 'hr@example.test');
    const challenge = q.get('code_challenge'), state = q.get('state');
    const REFRESH = 'synthetic-refresh-' + randomBytes(8).toString('hex');
    let refreshes = 0, sent = [];
    google = stubGoogle({
      'https://oauth2.googleapis.com/token': (init) => {
        const f = params(init);
        assert.equal(f.get('client_id'), CLIENT); assert.equal(f.get('client_secret'), SECRET);
        if (f.get('grant_type') === 'authorization_code') {
          assert.equal(f.get('code'), 'synthetic-code'); assert.equal(f.get('redirect_uri'), REDIRECT, 'the exchange names the same return address');
          assert.equal(createHash('sha256').update(f.get('code_verifier')).digest('base64url'), challenge, 'PKCE verifier matches');
          return [200, { access_token: 'synthetic-access-1', refresh_token: REFRESH, scope: `openid email ${MAIL_SCOPE}`, expires_in: 3599, token_type: 'Bearer' }];
        }
        assert.equal(f.get('grant_type'), 'refresh_token');
        if (f.get('refresh_token') !== REFRESH) return [400, { error: 'invalid_grant' }];
        refreshes += 1;
        return [200, { access_token: 'synthetic-access-2', expires_in: 3599, token_type: 'Bearer' }];
      },
      'https://openidconnect.googleapis.com/v1/userinfo': (init) => { assert.equal(init.headers.authorization, 'Bearer synthetic-access-1'); return [200, { email: 'HR@example.test', email_verified: true }]; },
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send': (init) => {
        assert.equal(init.headers.authorization, 'Bearer synthetic-access-2');
        sent.push(Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8'));
        return [200, { id: 'synthetic-message', labelIds: ['SENT'] }];
      },
    });
    // 2. Google returns to the page with code and state; the page posts them. A replayed state is refused.
    const finish = await app.inject({ method: 'POST', url: '/api/v0/mailbox/google/finish', headers, payload: { state, code: 'synthetic-code' } });
    assert.equal(finish.statusCode, 200, finish.body);
    assert.equal(saved.address, 'hr@example.test'); assert.equal(saved.client, 'platform', 'the platform client (PULSE_MAIL_GOOGLE_CLIENT_*)');
    assert.ok(!Buffer.from(saved.token_sealed).includes(REFRESH) && !Buffer.from(saved.token_wrapped).includes(REFRESH), 'the refresh token reaches the database sealed only');
    assert.ok(!JSON.stringify(finish.json()).includes(REFRESH), 'and never goes back to the browser');
    const replay = await app.inject({ method: 'POST', url: '/api/v0/mailbox/google/finish', headers, payload: { state, code: 'synthetic-code' } });
    assert.equal(replay.statusCode, 400);
    // 3. Mail goes out: the refresh token buys an access token once, the second message reuses it within the hour.
    // CI's mail sink would stop before Google; this check runs the real path.
    const ci = process.env.PULSE_CI, nodeEnv = process.env.NODE_ENV;
    delete process.env.PULSE_CI; delete process.env.NODE_ENV;
    try {
      const run = (fn) => fn(conn);
      assert.equal(await companyMail(ORG, 'person@example.test', 'Synthetic invitation', 'Hello from a synthetic test.', run), 'sent');
      assert.equal(await companyMail(ORG, 'person@example.test', 'Second synthetic note', 'Again.', run), 'sent');
      assert.equal(refreshes, 1, 'one refresh for two messages');
      assert.equal(sent.length, 2);
      assert.match(sent[0], /^From: "Synthetic Mail Co" <hr@example\.test>\r\nTo: <person@example\.test>\r\n/);
      assert.equal(await companyMail(ORG, 'stranger@example.test', 'Not on the allow-list', 'x', run), 'refused', 'off production only the staging allow-list is mailed');
      // 4. The owner removes Pulse's access in Google: the next refresh is refused and the mailbox says connect again.
      //    (A new sealed token stands for the grant Google no longer honours; the cached access token is for the old one.)
      const revoked = seal(await requireKeyring('mail'), Buffer.from('synthetic-revoked-refresh'), `${ORG}/mailbox/google`);
      saved = { ...saved, key_id: revoked.keyId, token_wrapped: revoked.dataKey, token_sealed: revoked.data };
      assert.equal(await companyMail(ORG, 'person@example.test', 'After revoke', 'x', run), 'failed');
      assert.match(String(reports.at(-1)?.[0]), /connect it again/, 'Settings → Mail tells the admin to connect again');
    } finally { if (ci !== undefined) process.env.PULSE_CI = ci; if (nodeEnv !== undefined) process.env.NODE_ENV = nodeEnv; }
    assert.ok(google.seen.map((s) => s.split(' ')[1]).every((u) => u.startsWith('https://oauth2.googleapis.com/') || u.startsWith('https://openidconnect.googleapis.com/') || u.startsWith('https://gmail.googleapis.com/')), 'only Google\'s own endpoints');
  } finally { google?.restore(); await app.close(); }
});

test('Calendar: connect, exchange, sync (add, change, remove), the AI reads its next events, a revoked grant, switched off', async () => {
  // CALENDAR-HUB (T2.1.5): a sync reads Google first (its sync token, the person's own events copied in), then pushes.
  process.env.PULSE_GOOGLE_CALENDAR = '1';
  const viewer = { email: 'person@example.test', org: ORG, person: PERSON, role: 'member', name: 'Synthetic Person', pod: null, via: 'password', username: 'synthetic.person', mustChange: false };
  const soon = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  let attempt = null, link = null, pushed = [], reports = [], copied = [], tokens = [], items = [
    { source: 'task', id: '00000000-0000-4000-8000-0000000000a1', title: 'Synthetic task with a due time', start: soon(3), minutes: 30, project: 'Synthetic project', timeZone: 'Asia/Kolkata' },
    { source: 'appointment', id: '00000000-0000-4000-8000-0000000000b1', title: 'Synthetic client meeting', start: soon(5), minutes: 45, place: 'Synthetic office', timeZone: 'Asia/Kolkata' },
  ];
  const same = (x, p) => x.source === p[0] && x.source_id === p[1];
  const conn = db({
    'pulse.calendar_begin': (p) => { attempt = { stateHash: p[0], session: p[1], verifier: p[2] }; return []; },
    'pulse.calendar_take': (p) => { const v = attempt && attempt.stateHash === p[0] && attempt.session === p[1] ? attempt.verifier : null; attempt = null; return [{ v }]; },
    'pulse.calendar_save': (p) => { link = { address: p[0], calendar_id: 'primary', key_id: p[1], token_wrapped: p[2], token_sealed: p[3], push_tasks: true, push_meetings: true }; return []; },
    'pulse.calendar_state()': () => [{ s: link ? { address: link.address } : null }],
    'pulse.calendar_sealed()': () => (link ? [link] : []),
    'pulse.calendar_items': () => [{ i: items }],
    'insert into pulse.calendar_pushed': (p) => { pushed = pushed.filter((x) => !same(x, p)).concat({ source: p[0], source_id: p[1], event_id: p[2], fingerprint: p[3] }); return []; },
    'delete from pulse.calendar_pushed': (p) => { pushed = pushed.filter((x) => !same(x, p)); return []; },
    'from pulse.calendar_pushed': () => pushed.map((x) => ({ ...x, id: x.source_id, pushed_at: new Date() })),
    'pulse.calendar_pull_token': () => [{ t: tokens.at(-1) ?? null }],
    'pulse.calendar_pull_saved': (p) => { tokens.push(p[0]); return []; },
    'pulse.org_time_zone()': () => [{ tz: 'Asia/Kolkata' }],
    'insert into pulse.calendar_event': (p) => { copied.push(p[8]); return [{ added: !copied.slice(0, -1).includes(p[8]) }]; },
    'pulse.calendar_report': (p) => { reports.push(p); return []; },
    'pulse.current_org()::text': () => [{ o: ORG, p: PERSON }],
    'savepoint': () => [],
  });
  const app = api((a) => registerCalendarRoutes(a, { tx: (_req, run) => run(conn, viewer) }));
  const host = 'dev.vitalsos.ai', REDIRECT = `https://${host}/settings/calendar/google`, EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const post = (url, payload = {}) => app.inject({ method: 'POST', url, headers: { 'x-pulse-host': host, 'x-pulse-session': 'synthetic-session-token' }, payload });
  const REFRESH = 'synthetic-calendar-refresh-' + randomBytes(6).toString('hex'), events = new Map();
  let refreshes = 0, challenge = null, google;
  try {
    const start = await post('/api/v0/calendar/google/start');
    assert.equal(start.statusCode, 200, start.body);
    const q = new URL(start.json().url).searchParams;
    assert.equal(q.get('client_id'), CLIENT, 'the sign-in client');
    assert.equal(q.get('redirect_uri'), REDIRECT); assert.ok(REGISTERED.has(REDIRECT), 'the Google client lists the calendar return page');
    assert.deepEqual(q.get('scope').split(' '), ['openid', 'email', CALENDAR_SCOPE]);
    assert.equal(CALENDAR_SCOPE, 'https://www.googleapis.com/auth/calendar.events', 'the one sensitive scope the consent screen lists for Calendar');
    assert.equal(q.get('access_type'), 'offline'); assert.match(q.get('prompt'), /consent/); assert.equal(q.get('code_challenge_method'), 'S256');
    challenge = q.get('code_challenge');
    const event = (init) => JSON.parse(init.body);
    google = stubGoogle({
      'https://oauth2.googleapis.com/token': (init) => {
        const f = params(init);
        assert.equal(f.get('client_id'), CLIENT); assert.equal(f.get('client_secret'), SECRET);
        if (f.get('grant_type') === 'authorization_code') {
          assert.equal(f.get('redirect_uri'), REDIRECT, 'the exchange names the same return address');
          assert.equal(createHash('sha256').update(f.get('code_verifier')).digest('base64url'), challenge, 'PKCE verifier matches');
          return [200, { access_token: 'synthetic-cal-access-1', refresh_token: REFRESH, scope: `openid email ${CALENDAR_SCOPE}`, expires_in: 3599 }];
        }
        assert.equal(f.get('grant_type'), 'refresh_token');
        if (f.get('refresh_token') !== REFRESH) return [400, { error: 'invalid_grant' }];
        refreshes += 1; return [200, { access_token: 'synthetic-cal-access-2', expires_in: 3599 }];
      },
      'https://openidconnect.googleapis.com/v1/userinfo': () => [200, { email: 'Person@example.test', email_verified: true }],
      [EVENTS + '*']: (init, u) => {
        assert.equal(init.headers?.authorization, 'Bearer synthetic-cal-access-2', 'events are called with the refreshed token');
        const id = u.split('?')[0].slice(EVENTS.length + 1), method = init.method ?? 'GET';
        if (method === 'GET') return [200, { items: [...events.values(), { id: 'theirs', summary: 'Synthetic dentist', start: { dateTime: soon(2) }, end: { dateTime: soon(3) } }], nextSyncToken: 'synthetic-sync-token' }];
        if (method === 'POST') { const b = event(init); assert.match(b.id, /^[a-v0-9]{5,1024}$/, 'a valid Google event id (base32hex)'); events.set(b.id, b); return [200, b]; }
        if (method === 'PUT') { if (!events.has(id)) return [404, {}]; events.set(id, { id, ...event(init) }); return [200, events.get(id)]; }
        if (method === 'DELETE') { events.delete(id); return [204, null]; }
        return [405, {}];
      },
    });
    const finish = await post('/api/v0/calendar/google/finish', { state: q.get('state'), code: 'synthetic-code' });
    assert.equal(finish.statusCode, 200, finish.body);
    assert.equal(link.address, 'person@example.test');
    assert.ok(!Buffer.from(link.token_sealed).includes(REFRESH) && !JSON.stringify(finish.json()).includes(REFRESH), 'sealed in the database, never returned');
    assert.equal((await post('/api/v0/calendar/google/finish', { state: q.get('state'), code: 'synthetic-code' })).statusCode, 400, 'a replayed state is refused');
    // Sync: two items become two events; unchanged items cost no event calls; a rename is changed in place and the
    // cancelled meeting is removed. One refresh per sync.
    const counts = async () => { const r = await post('/api/v0/calendar/sync'); assert.equal(r.statusCode, 200, r.body); return [r.json().added, r.json().changed, r.json().removed]; };
    assert.deepEqual(await counts(), [2, 0, 0]); assert.equal(events.size, 2);
    // Two-way: the person's own Google event was copied into Pulse, and Google's sync token kept for the next read.
    assert.deepEqual(copied, ['theirs']); assert.equal(tokens.at(-1), 'synthetic-sync-token');
    assert.deepEqual(await counts(), [0, 0, 0]);
    items = [{ ...items[0], title: 'Synthetic task, renamed' }];
    assert.deepEqual(await counts(), [0, 1, 1]);
    assert.deepEqual([...events.values()].map((e) => e.summary), ['Synthetic task, renamed']);
    assert.equal(refreshes, 3);
    // The AI's my_next_events: Pulse's own task once, plus the person's own Google event (not Pulse's copy again).
    const next = await v1Operations().find((o) => o.operationId === 'myNextEvents').handler({ client: conn }, { query: { hours: '24' } });
    assert.equal(next.google, 'ok');
    assert.deepEqual(next.items.map((i) => i.source).sort(), ['google', 'task']);
    // The person removes Pulse in their Google account: the next sync says connect again.
    const revoked = seal(await requireKeyring('mail'), Buffer.from('synthetic-revoked-refresh'), `${ORG}/${PERSON}/calendar/google`);
    link = { ...link, key_id: revoked.keyId, token_wrapped: revoked.dataKey, token_sealed: revoked.data };
    const gone = await post('/api/v0/calendar/sync');
    assert.equal(gone.statusCode, 409); assert.equal(gone.json().code, 'calendar_reconnect'); assert.match(String(reports.at(-1)?.[0]), /Connect it again/);
    assert.ok(google.seen.map((s) => s.split(' ')[1]).every((u) => /^https:\/\/(oauth2|openidconnect|www)\.googleapis\.com\//.test(u)), 'only Google\'s own endpoints');
    // Switched off (PULSE_GOOGLE_CALENDAR unset, as on production today): Connect refuses and says why.
    delete process.env.PULSE_GOOGLE_CALENDAR;
    const off = await post('/api/v0/calendar/google/start');
    assert.equal(off.statusCode, 409); assert.equal(off.json().code, 'calendar_off');
  } finally { google?.restore(); delete process.env.PULSE_GOOGLE_CALENDAR; await app.close(); }
});
