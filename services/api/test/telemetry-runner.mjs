// TELEMETRY acceptance (migration 0983, services/api/src/telemetry.ts) against a real database (tests/core/test_telemetry.py):
// a member's browser batch is stored as that member, in their company, reduced to templates; the API's own timing of a
// request carries its request id, person, role and database time; only leadership reads the overview and a session's
// timeline, where the browser's API call is joined to the server's; the budget refuses a flood; rollups and retention.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { installServerTiming } from '../dist/telemetry.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const timing = installServerTiming(app, pool, { everyMs: 3_600_000 });
const ORG = process.env.PULSE_ORG_ID, DOMAIN = process.env.TEST_DOMAIN, P = JSON.parse(process.env.TEST_PEOPLE);
const LEAD = `kedab@${DOMAIN}`, MEMBER = `kabir@${DOMAIN}`;
let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const call = async (who, url, payload, extra = {}) => {
  const headers = { 'x-pulse-client-ip': '10.11.12.13', ...(who ? { 'cf-access-authenticated-user-email': who } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...extra };
  const r = await app.inject({ url, method: payload !== undefined ? 'POST' : 'GET', headers, ...(payload !== undefined ? { payload } : {}) });
  return { status: r.statusCode, data: r.headers['content-type']?.includes('json') ? r.json() : r.body };
};
const rows = async (sql, args = []) => {
  const c = await pool.connect();
  try { await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [ORG]); const r = (await c.query(sql, args)).rows; await c.query('commit'); return r; }
  finally { c.release(); }
};

const sid = 'test-session-' + Date.now().toString(36);
const now = Date.now();
const batch = { v: 1, sid, sentAt: now, app: { rel: 'dev-runner01', plat: 'web', dev: 'desktop' }, ev: [
  { k: 'nav.load', t: now - 5000, n: '/tasks', p: '/tasks', d: 840, x: { ttfb: 120, vw: 1440 } },
  { k: 'ui.click', t: now - 4000, n: 'button New task', p: '/tasks', d: 230, x: { sel: 'main>button.btn', paint: 18, text: 'typed words must go' } },
  { k: 'api', t: now - 3900, n: `GET /api/v0/people/${P.kabir}?q=private`, p: '/tasks', d: 140, s: 200, r: 'req-0000-0002' },
  { k: 'ui.submit', t: now - 3000, n: `form for ${MEMBER}`, p: '/tasks', d: 610, x: { fields: ['title', 'due'] } },
  { k: 'error.js', t: now - 2000, n: `Cannot read x of ${P.kabir}`, p: '/tasks' },
  { k: 'nav.route', t: now - 1000, n: `/people/${P.kabir}`, p: '/people/:id', d: 420, x: { from: '/tasks', trig: 'click' } },
] };

// Signed out: refused before anything is read. Signed in: a batch, or 400.
eq((await call(null, '/api/v0/telemetry', batch)).status, 401, 'signed out');
eq((await call(MEMBER, '/api/v0/telemetry', {})).status, 400, 'not a batch');
const posted = await call(MEMBER, '/api/v0/telemetry', batch);
eq(posted.status, 200, JSON.stringify(posted.data));
eq(posted.data, { accepted: 6, dropped: 0 });
const stored = await rows(`select kind, name, page, duration_ms, status, request_id, person_id::text person, role, platform, app_version, detail
  from pulse.telemetry_event where session_id = $1 order by at`, [sid]);
eq(stored.length, 6);
ok(stored.every((r) => r.person === P.kabir && r.role === 'person' && r.platform === 'web' && r.app_version === 'dev-runner01'), 'stored as the member who sent it');
const byKind = Object.fromEntries(stored.map((r) => [r.kind, r]));
eq(byKind.api.name, 'GET /api/v0/people/:id?q', 'route template, query keys only');
eq(byKind.api.request_id, 'req-0000-0002');
eq(byKind['ui.click'].detail, { sel: 'main>button.btn', paint: 18 }, 'text-like detail is dropped');
eq(byKind['ui.submit'].name, 'form for :email');
eq(byKind['ui.submit'].detail, { fields: ['title', 'due'] });
eq(byKind['error.js'].name, 'Cannot read x of :id');
eq(byKind['nav.route'].name, '/people/:id');
const kept = JSON.stringify(stored.map((r) => [r.name, r.page, r.detail]));
ok(!kept.includes(P.kabir.slice(0, 8)) && !kept.includes(DOMAIN) && !kept.includes('typed words') && !kept.includes('private'), 'no id, e-mail or typed text survives');

// The API's own timing: route template, status, request id, person, role and database time.
eq((await call(MEMBER, '/api/v0/me', undefined, { 'x-pulse-request-id': 'req-0000-0002' })).status, 200);
eq((await call(MEMBER, '/api/v0/me', undefined, { 'x-pulse-request-id': 'bad id!' })).status, 200);
await timing.flush();
const server = await rows(`select name, status, request_id, person_id::text person, role, value db, detail, platform from pulse.telemetry_event
  where source = 'server' and name = 'GET /api/v0/me' order by at desc limit 2`);
eq(server.length, 2, 'every request is timed');
const joined = server.find((r) => r.request_id === 'req-0000-0002');
ok(joined && joined.status === 200 && joined.person === P.kabir && joined.role === 'person' && joined.platform === 'server', JSON.stringify(server));
ok(joined.db > 0 && joined.detail.q > 0, 'database time and query count');
ok(server.some((r) => r.request_id === null), 'a malformed request id is not kept');
eq((await rows(`select count(*)::int n from pulse.telemetry_event where source = 'server' and name like 'POST /api/v0/telemetry%'`))[0].n, 0, 'the ingest itself is not timed');

// Leadership only.
for (const url of ['/api/v0/telemetry', `/api/v0/telemetry/sessions/${sid}`]) eq((await call(MEMBER, url)).status, 403, `member ${url}`);
const overview = await call(LEAD, '/api/v0/telemetry?days=1');
eq(overview.status, 200, JSON.stringify(overview.data).slice(0, 500));
const o = overview.data;
ok(o.totals.sessions >= 1 && o.totals.views >= 2 && o.totals.actions >= 2 && o.totals.errors >= 1, JSON.stringify(o.totals));
ok(o.actions.some((a) => a.name === 'button New task' && a.p75 === 230), 'slowest interactions');
ok(o.pages.some((p) => p.name === '/people/:id'), 'slowest pages');
ok(o.server.some((s) => s.name === 'GET /api/v0/me' && s.n >= 2), 'slowest API routes');
ok(o.client.some((c) => c.name === 'GET /api/v0/people/:id?q'), 'API calls as people waited');
ok(o.errors.some((e) => e.kind === 'error.js'), 'errors');
ok(o.people.some((p) => p.personId === P.kabir && p.actions === 2), 'per person');
ok(o.roles.some((r) => r.role === 'person'), 'per role');
ok(o.sessions.some((s) => s.id === sid), 'sessions');
const timeline = await call(LEAD, `/api/v0/telemetry/sessions/${sid}`);
eq(timeline.status, 200);
eq(timeline.data.events.map((e) => e.kind), ['nav.load', 'ui.click', 'api', 'ui.submit', 'error.js', 'nav.route'], 'in order');
const apiEvent = timeline.data.events.find((e) => e.kind === 'api');
ok(apiEvent.serverMs !== null && apiEvent.serverRoute === 'GET /api/v0/me', 'the browser call is joined to the API\'s own timing');
eq((await call(LEAD, '/api/v0/telemetry/sessions/bad id')).status, 400);

// A flood is refused; a batch is capped; an oversized body is refused before it is read.
const big = await call(MEMBER, '/api/v0/telemetry', { sid, sentAt: Date.now(), ev: Array.from({ length: 320 }, () => ({ k: 'ui.click', t: Date.now(), n: 'button' })) });
eq([big.status, big.data.accepted, big.data.dropped], [200, 300, 20]);
eq((await call(MEMBER, '/api/v0/telemetry', { sid, ev: [{ k: 'ui.click', n: 'x'.repeat(300_000) }] })).status, 413);
let refused = 0;
for (let i = 0; i < 70 && !refused; i++) if ((await call(MEMBER, '/api/v0/telemetry', { sid, sentAt: Date.now(), ev: [{ k: 'ui.click', t: Date.now() }] })).status === 429) refused = i;
ok(refused > 0 && refused <= 60, `a flood is refused (after ${refused})`);

// Rollups and retention.
const c = await pool.connect();
try {
  await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [ORG]);
  await c.query(`insert into pulse.telemetry_event (org_id, at, source, kind, name) values (pulse.current_org(), now() - interval '100 days', 'client', 'ui.click', 'old'),
    (pulse.current_org(), now() - interval '40 days', 'server', 'api.server', 'GET /old'), (pulse.current_org(), now() - interval '20 days', 'server', 'api.server', 'GET /kept')`);
  await c.query('commit');
} finally { c.release(); }
const maintained = (await pool.query('select pulse.telemetry_maintain() r')).rows[0].r;
ok(maintained.rolled > 0 && maintained.removed >= 2, JSON.stringify(maintained));
eq((await rows(`select name from pulse.telemetry_event where name in ('old', 'GET /old', 'GET /kept') order by name`)).map((r) => r.name), ['GET /kept'], 'retention: 90 days client, 30 days server');
const daily = await rows(`select kind, events, p75_ms from pulse.telemetry_daily where name = '*' and platform = '*' and role = '*' and kind = 'ui.submit'`);
ok(daily.length >= 1 && daily[0].events >= 1, JSON.stringify(daily));
ok((await rows(`select count(*)::int n from pulse.telemetry_daily where name = '*' and role = '*' and app_version = 'dev-runner01' and platform = 'web'`))[0].n >= 1, 'rolled up by version and platform');
ok((await rows(`select count(*)::int n from pulse.telemetry_daily where name = '*' and platform = '*' and role = 'person'`))[0].n >= 1, 'rolled up by role');
const again = await call(LEAD, '/api/v0/telemetry?days=7');
ok(again.data.trend.length >= 1 && again.data.versions.some((v) => v.version === 'dev-runner01'), 'trends by day and version read the rollups');

await app.close();
await pool.end();
await writeFile(process.env.TEST_REPORT, JSON.stringify({ ok: true, checks }));
console.log(`telemetry runner: ${checks} checks`);
