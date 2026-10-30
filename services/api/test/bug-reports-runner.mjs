// BUG-REPORT (1201): a member reports a bug (scrubbed, numbered, the same command id twice is one report), sees their own,
// cannot triage; an admin lists, triages, groups a duplicate and makes a Pulse task. Synthetic people only.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const call = async (method, url, token, payload) => { const r = await app.inject({ method, url, headers: { 'x-pulse-client-ip': randomBytes(6).toString('hex'), ...(token ? { 'x-pulse-session': token } : {}) }, ...(payload === undefined ? {} : { payload }) });
  return { status: r.statusCode, type: r.headers['content-type'], body: String(r.headers['content-type'] ?? '').includes('json') && r.body ? r.json() : null }; };
const signIn = async username => (await call('POST', '/api/v0/auth/sign-in', null, { username, password: 'Synthetic-account-2026!' })).body.token;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const report = (extra = {}) => ({ commandId: randomBytes(12).toString('hex'), words: 'The save button spins forever on the leave form. token=abc123', blocksWork: true,
  route: '/people/7f3c2a10-1b2c-4d5e-8f90-112233445566?tab=leave&secret=x', platform: 'web', appVersion: 'dev-abc1234',
  context: { browser: 'Chrome 141', viewport: '1280x800', release: 'dev-abc1234', cookie: 'nope' },
  errors: [{ at: new Date().toISOString(), kind: 'error', message: 'TypeError: x is undefined Bearer abcdefghijklmnopqrstu', source: 'https://pulse.example/_next/app.js?v=1', line: 12 }],
  network: [{ at: new Date().toISOString(), method: 'post', path: '/api/v0/leave/123456?token=zzz', status: 500, ms: 812 }],
  trail: [{ at: new Date().toISOString(), kind: 'ui.click', name: 'Save', page: '/me?tab=leave', ms: 30 }], screenshot: PNG, ...extra });
try {
  const admin = await signIn('auth.admin'), person = await signIn('auth.person');
  assert.ok(admin && person);
  assert.equal((await call('POST', '/api/v0/bug-reports', null, report())).status, 401);
  assert.equal((await call('POST', '/api/v0/bug-reports', person, { commandId: 'abcdefgh1234', words: '  ' })).status, 400);
  const body = report();
  const sent = await call('POST', '/api/v0/bug-reports', person, body);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.screenshot, 'kept'); assert.equal(sent.body.recording, 'none');
  const again = await call('POST', '/api/v0/bug-reports', person, body);
  assert.equal(again.body.id, sent.body.id, 'sending the same report again is one report');
  // A bad picture is left out; the report still goes.
  const second = await call('POST', '/api/v0/bug-reports', person, report({ screenshot: 'data:image/png;base64,AAAA', words: 'Second report' }));
  assert.equal(second.status, 200); assert.equal(second.body.screenshot, 'skipped'); assert.equal(second.body.number, sent.body.number + 1);
  const mine = await call('GET', '/api/v0/bug-reports/mine', person);
  assert.equal(mine.body.rows.length, 2); assert.equal(mine.body.rows[1].status, 'new');
  // Scrubbed on the server too: no token, no query, ids as :id.
  const detail = (await call('GET', `/api/v0/bug-reports/${sent.body.id}`, person)).body;
  assert.equal(detail.route, '/people/:id');
  assert.match(detail.words, /\[secret\]/); assert.doesNotMatch(detail.words, /abc123/);
  assert.equal(detail.errors[0].source, '/_next/app.js:12'); assert.match(detail.errors[0].message, /Bearer \[token\]/);
  assert.equal(detail.network[0].path, '/api/v0/leave/:id'); assert.equal(detail.network[0].method, 'POST');
  assert.equal(detail.context.cookie, undefined); assert.equal(detail.severity, 'high', 'stops my work suggests high');
  assert.equal(detail.canTriage, false);
  const shot = await call('GET', `/api/v0/bug-reports/${sent.body.id}/screenshot`, person);
  assert.equal(shot.status, 200); assert.equal(shot.type, 'image/png');
  // The person cannot triage or list everyone's.
  assert.equal((await call('GET', '/api/v0/bug-reports', person)).status, 403);
  assert.equal((await call('POST', `/api/v0/bug-reports/${sent.body.id}`, person, { status: 'fixed' })).status, 403);
  assert.equal((await call('POST', `/api/v0/bug-reports/${sent.body.id}/task`, person, {})).status, 403);
  // The admin's list, triage and grouping.
  const list = (await call('GET', '/api/v0/bug-reports', admin)).body;
  assert.equal(list.counts.new, 2); assert.equal(list.rows.length, 2);
  assert.equal(list.rows.find((r) => r.id === sent.body.id).similar, 1, 'same screen and first error: similar');
  const fixing = await call('POST', `/api/v0/bug-reports/${sent.body.id}`, admin, { status: 'fixing', severity: 'blocker', assigneeId: process.env.PULSE_PERSON_ID, note: 'Looking at the leave save.' });
  assert.equal(fixing.status, 200, JSON.stringify(fixing.body)); assert.equal(fixing.body.status, 'fixing'); assert.equal(fixing.body.severity, 'blocker');
  assert.equal((await call('POST', `/api/v0/bug-reports/${second.body.id}`, admin, { duplicateOf: `#${second.body.number}` })).status, 400, 'not a duplicate of itself');
  const dup = await call('POST', `/api/v0/bug-reports/${second.body.id}`, admin, { duplicateOf: `#${sent.body.number}` });
  assert.equal(dup.body.duplicateNumber, sent.body.number);
  assert.equal((await call('POST', `/api/v0/bug-reports/${sent.body.id}`, admin, { status: 'nope' })).status, 400);
  const task = await call('POST', `/api/v0/bug-reports/${sent.body.id}/task`, admin, {});
  assert.equal(task.status, 200, JSON.stringify(task.body)); assert.match(task.body.taskId, /^[0-9a-f-]{36}$/);
  assert.equal((await call('POST', `/api/v0/bug-reports/${sent.body.id}/task`, admin, {})).body.existing, true);
  const history = (await call('GET', `/api/v0/bug-reports/${sent.body.id}`, admin)).body;
  assert.deepEqual(history.events.map((e) => e.kind), ['status', 'severity', 'assignee', 'note', 'task']);
  // The reporter sees where it stands.
  assert.equal((await call('GET', '/api/v0/bug-reports/mine', person)).body.rows.find((r) => r.id === sent.body.id).status, 'fixing');
  // Signed out: the sign-in and other public pages report too, with an optional name and contact; a bot's hidden field drops it.
  const out = await call('POST', '/api/v0/auth/bug-report', null, report({ name: 'Synthetic Visitor', contact: 'visitor@example.test', words: 'The sign-in button does nothing' }));
  assert.equal(out.status, 200, JSON.stringify(out.body)); assert.equal(out.body.screenshot, 'kept');
  const bot = await call('POST', '/api/v0/auth/bug-report', null, report({ website: 'http://spam.example', words: 'spam' }));
  assert.equal(bot.status, 200); assert.equal(bot.body.id, null);
  assert.equal((await call('POST', '/api/v0/auth/bug-report', null, report({ contact: 'not a contact' }))).status, 400);
  const inbox = (await call('GET', '/api/v0/bug-reports?status=all', admin)).body.rows;
  const row = inbox.find((r) => r.id === out.body.id);
  assert.equal(row.signedOut, true); assert.equal(row.reporterName, 'Synthetic Visitor'); assert.equal(row.reporterContact, 'visitor@example.test');
  assert.ok(!inbox.some((r) => r.words === 'spam'));
  console.log('bug reports runner: ok');
} finally { await app.close(); await pool.end(); }
