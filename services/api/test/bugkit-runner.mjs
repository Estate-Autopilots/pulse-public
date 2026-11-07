// BUGKIT-TELEMETRY (1682): usage settings (everyone reads, admins change), replay chunks (masked kept, typed text refused),
// a report with picked elements, comment threads, a trigger and a replay window, grouping by element, the team's answer
// in a thread. Synthetic people only.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const call = async (method, url, token, payload) => { const r = await app.inject({ method, url, headers: { 'x-pulse-client-ip': randomBytes(6).toString('hex'), ...(token ? { 'x-pulse-session': token } : {}) }, ...(payload === undefined ? {} : { payload }) });
  return { status: r.statusCode, body: String(r.headers['content-type'] ?? '').includes('json') && r.body ? r.json() : null }; };
const signIn = async username => (await call('POST', '/api/v0/auth/sign-in', null, { username, password: 'Synthetic-account-2026!' })).body.token;
const now = Date.now();
const events = (value) => [{ type: 4, timestamp: now - 3000, data: { href: 'https://pulse.example/tasks', width: 1440, height: 900 } },
  { type: 2, timestamp: now - 2900, data: { node: { type: 0, childNodes: [{ type: 2, tagName: 'input', attributes: { type: 'text', value }, childNodes: [] }] } } },
  { type: 3, timestamp: now - 1000, data: { source: 2, type: 2, id: 1, x: 10, y: 10 } }];
const chunk = (seq, value = '*****', reason = 'sample') => ({ sid: 'synthSession0001', seq, route: '/tasks', from: now - 3000, to: now - 1000, n: 3, reason, gz: gzipSync(JSON.stringify(events(value))).toString('base64') });
const pin = (sel, text) => ({ sel, component: 'TaskBoard', label: 'Save', tag: 'button', box: { x: 40, y: 120, w: 90, h: 32 }, vw: 1440, vh: 900, sy: 0, comments: text ? [{ text, at: new Date().toISOString() }] : [] });
const report = (extra = {}) => ({ commandId: randomBytes(12).toString('hex'), words: 'The save button does nothing on the task board.', route: '/tasks', platform: 'web', appVersion: 'dev-abc1234',
  context: { browser: 'Chrome 141', viewport: '1440x900' }, errors: [], trail: [], network: [{ at: new Date().toISOString(), method: 'POST', path: '/api/v0/tasks', status: 500, ms: 90, requestId: 'reqSynthetic0001' }], ...extra });
try {
  const admin = await signIn('auth.admin'), person = await signIn('auth.person');
  assert.ok(admin && person);
  // Settings: on by default; everyone reads what a device needs; only an admin changes them and sees retention.
  const mine = await call('GET', '/api/v0/telemetry/settings', person);
  assert.equal(mine.status, 200); assert.equal(mine.body.enabled, true); assert.equal(mine.body.replay, true); assert.equal(mine.body.retentionDays, undefined);
  assert.equal((await call('POST', '/api/v0/telemetry/settings', person, { replay: false })).status, 403);
  const saved = await call('POST', '/api/v0/telemetry/settings', admin, { retentionDays: 14, sample: 0.5 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.retentionDays, 14); assert.equal(saved.body.sample, 0.5);
  assert.equal((await call('POST', '/api/v0/telemetry/settings', admin, { retentionDays: 2 })).status, 400);
  // Replay: a masked chunk is kept once; typed text is refused.
  const first = await call('POST', '/api/v0/telemetry/replay', person, chunk(0));
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.deepEqual(first.body, { accepted: true, stored: true });
  assert.equal((await call('POST', '/api/v0/telemetry/replay', person, chunk(0))).body.stored, false, 'the same chunk twice is one');
  const typed = await call('POST', '/api/v0/telemetry/replay', person, chunk(1, 'my secret note'));
  assert.equal(typed.status, 400); assert.match(typed.body.error, /typed text/);
  assert.equal((await call('POST', '/api/v0/telemetry/replay', null, chunk(2))).status, 401);
  // Replay switched off: sampled chunks are not kept, a chunk attached to a report still is.
  await call('POST', '/api/v0/telemetry/settings', admin, { replay: false });
  assert.equal((await call('POST', '/api/v0/telemetry/replay', person, chunk(3))).body.accepted, false);
  assert.equal((await call('POST', '/api/v0/telemetry/replay', person, chunk(4, '*', 'report'))).body.accepted, true);
  await call('POST', '/api/v0/telemetry/settings', admin, { replay: true });
  // A report with picked elements, a thread each, what offered it, and the replay window.
  const sent = await call('POST', '/api/v0/bug-reports', person, report({ pins: [pin('[data-testid="task-board"] > button.save', 'Nothing happens when I click this'), pin('#due-date')],
    trigger: 'rage', replay: { sid: 'synthSession0001', from: now - 3000, to: now - 1000 } }));
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const detail = (await call('GET', `/api/v0/bug-reports/${sent.body.id}`, admin)).body;
  assert.equal(detail.pins.length, 2); assert.equal(detail.pins[0].component, 'TaskBoard'); assert.equal(detail.pins[0].comments[0].text, 'Nothing happens when I click this');
  assert.deepEqual(detail.pins[0].box, { x: 40, y: 120, w: 90, h: 32 });
  assert.equal(detail.trigger, 'rage'); assert.equal(detail.replaySession, 'synthSession0001');
  assert.equal(detail.network[0].requestId, 'reqSynthetic0001');
  assert.ok(detail.context.role, JSON.stringify(detail.context)); assert.ok(detail.context.org);
  // A bad pin and a bad trigger are dropped, the report still goes.
  const odd = await call('POST', '/api/v0/bug-reports', person, report({ pins: [{ sel: '<script>', box: {} }, pin('[data-testid="task-board"] > button.save')], trigger: 'boom' }));
  assert.equal(odd.status, 200);
  const oddDetail = (await call('GET', `/api/v0/bug-reports/${odd.body.id}`, admin)).body;
  assert.equal(oddDetail.pins.length, 1); assert.equal(oddDetail.trigger, null);
  // Grouped by screen and element: both reports point at the same button.
  const groups = await call('GET', '/api/v0/bug-reports/groups', admin);
  assert.equal(groups.status, 200);
  const g = groups.body.groups.find((x) => x.selector === '[data-testid="task-board"] > button.save');
  assert.ok(g, JSON.stringify(groups.body)); assert.equal(g.n, 2); assert.equal(g.reports.length, 2);
  assert.equal((await call('GET', '/api/v0/bug-reports/groups', person)).status, 403);
  // The team answers in the element's thread; the reporter cannot post there.
  const reply = await call('POST', `/api/v0/bug-reports/${sent.body.id}/pins`, admin, { pin: 0, text: 'Thanks, looking at it now' });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.pins[0].comments.at(-1).team, true); assert.equal(reply.body.pins[0].comments.length, 2);
  assert.equal((await call('POST', `/api/v0/bug-reports/${sent.body.id}/pins`, admin, { pin: 9, text: 'x' })).status, 400);
  assert.equal((await call('POST', `/api/v0/bug-reports/${sent.body.id}/pins`, person, { pin: 0, text: 'x' })).status, 403);
  console.log('bugkit runner: ok');
} finally { await app.close(); await pool.end(); }
