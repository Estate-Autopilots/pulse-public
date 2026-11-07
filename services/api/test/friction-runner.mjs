// BUGKIT-TELEMETRY (1682): usage events and a masked replay go in as two synthetic people; the hourly scan finds the rage
// and dead clicks; leadership sees the friction dashboard, opens a bug task from an alert, dismisses another, reads the
// heatmap and the replay; a replay with typed text is refused; per-person adoption is admins' only. Synthetic data only.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG)), app = createApp(pool, pool);
const ip = () => randomBytes(6).toString('hex');
const call = async (method, url, token, payload) => { const r = await app.inject({ method, url, headers: { 'x-pulse-client-ip': ip(), ...(token ? { 'x-pulse-session': token } : {}) }, ...(payload === undefined ? {} : { payload }) });
  return { status: r.statusCode, type: r.headers['content-type'], raw: r.rawPayload, body: String(r.headers['content-type'] ?? '').includes('json') && r.body ? r.json() : null }; };
const signIn = async username => (await call('POST', '/api/v0/auth/sign-in', null, { username, password: 'Synthetic-account-2026!' })).body.token;
const sid = (tag) => `EXMP${tag}${randomBytes(6).toString('hex')}`;
const batch = (s, ev) => ({ v: 1, sid: s, app: { rel: 'dev-synthetic', plat: 'web', dev: 'desktop' }, sentAt: Date.now(), ev: ev.map((e, i) => ({ t: Date.now() - 60_000 + i * 100, ...e })) });
const rage = (n) => Array.from({ length: n }, () => ({ k: 'ui.rage', n: 'button Save', p: '/tasks', x: { sel: 'button.saveButton', fx: 0.62, fy: 0.41, clicks: 4 } }));
const dead = (n) => Array.from({ length: n }, () => ({ k: 'ui.dead', n: 'button Filter', p: '/tasks', x: { sel: 'button.filterChip', fx: 0.2, fy: 0.15 } }));
const gz = (events) => gzipSync(Buffer.from(JSON.stringify(events))).toString('base64');
try {
  const admin = await signIn('auth.admin'), person = await signIn('auth.person');
  assert.ok(admin && person);
  const s1 = sid('a'), s2 = sid('b');
  const one = await call('POST', '/api/v0/telemetry', person, batch(s1, [
    { k: 'app.session' }, { k: 'nav.load', n: '/login', p: '/login', d: 900 }, { k: 'ui.click', n: 'button Check in', p: '/me', d: 120, x: { fx: 0.5, fy: 0.3, sel: 'button.checkin' } },
    { k: 'ui.click', n: 'button New task', p: '/tasks', d: 80, x: { fx: 0.9, fy: 0.1 } }, { k: 'ui.form.start', n: 'new-task', p: '/tasks' }, { k: 'ui.form.abandon', n: 'new-task', p: '/tasks', x: { touched: 2, errs: 1 } },
    { k: 'nav.leave', n: '/tasks', p: '/tasks', d: 60_000, x: { act: 40_000, idle: 20_000 } }, ...rage(5), ...dead(3)]));
  assert.equal(one.status, 200, JSON.stringify(one.body));
  const two = await call('POST', '/api/v0/telemetry', admin, batch(s2, [{ k: 'app.session' }, ...rage(5), ...dead(3), { k: 'nav.load', n: '/tasks', p: '/tasks', d: 700, x: { vw: 1280, vh: 800 } }]));
  assert.equal(two.status, 200);

  // A replay chunk: masked on the device (the field's value is stars), compressed.
  const t0 = Date.now() - 30_000;
  const frame = [{ type: 4, timestamp: t0, data: { href: 'http://pulse.invalid/tasks', width: 1280, height: 800 } },
    { type: 2, timestamp: t0 + 5, data: { node: { type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: 'input', attributes: { type: 'text', value: '*****' }, childNodes: [] }] }, initialOffset: { left: 0, top: 0 } } },
    { type: 3, timestamp: t0 + 900, data: { source: 5, id: 2, text: '******', isChecked: false } }];
  const chunk = { sid: s1, seq: 0, route: '/tasks', from: t0, to: t0 + 900, n: frame.length, reason: 'sample', gz: gz(frame) };
  const stored = await call('POST', '/api/v0/telemetry/replay', person, chunk);
  assert.equal(stored.status, 200, JSON.stringify(stored.body)); assert.equal(stored.body.accepted, true);
  // Typed text in an input event, or in a field's value, is refused and never stored.
  const typed = await call('POST', '/api/v0/telemetry/replay', person, { ...chunk, seq: 1, gz: gz([{ type: 3, timestamp: t0 + 1000, data: { source: 5, id: 2, text: 'secret words', isChecked: false } }]) });
  assert.equal(typed.status, 400); assert.match(typed.body.error, /typed text/);
  const value = await call('POST', '/api/v0/telemetry/replay', person, { ...chunk, seq: 2, gz: gz([{ ...frame[1], data: { node: { type: 0, childNodes: [{ type: 2, tagName: 'input', attributes: { value: 'EXMP0001234' } }] } } }]) });
  assert.equal(value.status, 400);

  // The hourly scan finds both problems (5+ hits by 2 people).
  await pool.query('select pulse.friction_scan()');

  assert.equal((await call('GET', '/api/v0/telemetry/friction', person)).status, 403, 'a member does not see the dashboard');
  const d = await call('GET', '/api/v0/telemetry/friction?days=7', admin);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const rageAlert = d.body.alerts.find((a) => a.kind === 'rage' && a.route === '/tasks');
  const deadAlert = d.body.alerts.find((a) => a.kind === 'dead' && a.route === '/tasks');
  assert.ok(rageAlert && deadAlert, JSON.stringify(d.body.alerts));
  assert.equal(rageAlert.hits, 10); assert.equal(rageAlert.people, 2); assert.equal(rageAlert.target, 'button.saveButton');
  const hot = d.body.hotspots.find((h) => h.route === '/tasks');
  assert.equal(hot.rage, 10); assert.equal(hot.dead, 6); assert.equal(hot.targets[0].sel, 'button.saveButton');
  const checkin = d.body.funnels.find((f) => f.key === 'checkin');
  assert.ok(checkin.steps[0].sessions >= 2 && checkin.steps[1].sessions >= 1, JSON.stringify(checkin));
  assert.ok(d.body.dropOffs.forms.some((f) => f.name === 'new-task' && f.abandons === 1));
  const screen = d.body.timePerScreen.find((t) => t.page === '/tasks');
  assert.equal(screen.activeMs, 40_000); assert.equal(screen.idleMs, 20_000);
  assert.ok(d.body.replays.some((r) => r.sid === s1 && r.chunks === 1));
  assert.equal(d.body.canSeeAdoption, true);

  // An alert becomes one bug task (twice is the same task); another is dismissed.
  assert.equal((await call('POST', `/api/v0/telemetry/friction/${rageAlert.id}`, person, { task: true })).status, 403);
  const task = await call('POST', `/api/v0/telemetry/friction/${rageAlert.id}`, admin, { task: true });
  assert.equal(task.status, 200, JSON.stringify(task.body)); assert.ok(task.body.taskId);
  assert.equal((await call('POST', `/api/v0/telemetry/friction/${rageAlert.id}`, admin, { task: true })).body.taskId, task.body.taskId);
  assert.equal((await call('POST', `/api/v0/telemetry/friction/${rageAlert.id}`, admin, { status: 'dismissed' })).status, 404, 'a task is not dismissed');
  assert.equal((await call('POST', `/api/v0/telemetry/friction/${deadAlert.id}`, admin, { status: 'dismissed' })).body.status, 'dismissed');
  assert.equal((await call('POST', `/api/v0/telemetry/friction/${deadAlert.id}`, admin, { status: 'gone' })).status, 400);
  const after = (await call('GET', '/api/v0/telemetry/friction', admin)).body;
  assert.equal(after.alerts.find((a) => a.id === rageAlert.id).status, 'task');
  assert.equal(after.alerts.some((a) => a.id === deadAlert.id), false, 'a dismissed alert leaves the list');
  await pool.query('select pulse.friction_scan()');
  assert.equal((await call('GET', '/api/v0/telemetry/friction', admin)).body.alerts.some((a) => a.id === deadAlert.id), false, 'and stays dismissed after the next scan');

  // The heatmap and the replay.
  const heat = (await call('GET', '/api/v0/telemetry/heat?route=%2Ftasks', admin)).body;
  assert.equal(heat.frame.sid, s1); assert.deepEqual(heat.viewport, { width: 1280, height: 800 });
  assert.ok(heat.points.some((p) => p.kind === 'rage' && p.fx === 0.62) && heat.points.some((p) => p.kind === 'click'));
  assert.equal((await call('GET', '/api/v0/telemetry/heat', admin)).status, 400);
  assert.equal((await call('GET', `/api/v0/telemetry/replay/${s1}`, person)).status, 403);
  const meta = (await call('GET', `/api/v0/telemetry/replay/${s1}`, admin)).body;
  assert.equal(meta.chunks.length, 1); assert.equal(meta.chunks[0].events, 3);
  const bytes = await call('GET', `/api/v0/telemetry/replay/${s1}/0`, admin);
  assert.equal(bytes.status, 200); assert.equal(bytes.type, 'application/gzip');
  const back = JSON.parse(gunzipSync(bytes.raw).toString('utf8'));
  assert.equal(back.length, 3); assert.doesNotMatch(JSON.stringify(back), /secret words|EXMP0001234/);
  assert.equal((await call('GET', `/api/v0/telemetry/replay/${s1}/9`, admin)).status, 404);
  assert.ok((await call('GET', '/api/v0/telemetry/replays?route=%2Ftasks', admin)).body.rows.some((r) => r.sid === s1));

  // Per-person adoption: admins only, with its purpose.
  assert.equal((await call('GET', '/api/v0/telemetry/adoption', person)).status, 403);
  const adoption = (await call('GET', '/api/v0/telemetry/adoption', admin)).body;
  assert.match(adoption.purpose, /Not for performance reviews/);
  const me = adoption.people.find((p) => p.activeMinutes > 0);
  assert.ok(me && me.sessions >= 1, JSON.stringify(adoption.people));
  console.log('friction runner: ok');
} finally { await app.close(); await pool.end(); }
