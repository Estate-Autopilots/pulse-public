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
  { k: 'nav.load', t: now - 5000, n: '/tasks', p: '/tasks', d: 840, r: 'render-0000-0001', x: { ttfb: 120, vw: 1440 } },
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

// PERF: the slowest things against the day before, the browser's wait beside the API's own time, and what a page's
// server render waited on (its API calls carry the page's request id).
eq((await call(MEMBER, '/api/v0/me', undefined, { 'x-pulse-request-id': 'render-0000-0001' })).status, 200);
await timing.flush();
eq((await call(MEMBER, '/api/v0/telemetry/slowest')).status, 403, 'member slowest');
const slow = await call(LEAD, '/api/v0/telemetry/slowest');
eq(slow.status, 200, JSON.stringify(slow.data).slice(0, 500));
const me = slow.data.api.find((a) => a.name === 'GET /api/v0/me');
ok(me && me.n >= 3 && me.browserP50 === 140 && me.p95Before === null, JSON.stringify(me));
ok(slow.data.network.n >= 1 && slow.data.network.p50 !== null, JSON.stringify(slow.data.network));
ok(slow.data.pages.some((p) => p.name === '/tasks' && p.kind === 'nav.load' && p.p95 === 840), 'pages by p95');
ok(slow.data.moments.some((m) => m.name === 'form for :email' && m.durationMs === 610 && m.sessionId === sid), 'slowest single movements');
ok(slow.data.renders.some((r) => r.name === '/tasks' && r.ttfbP50 === 120 && r.callsP50 === 1), JSON.stringify(slow.data.renders));

// SPEED-TELEMETRY (14 Nov 2026): How people move and the speed targets, leadership only. A movement the page spent
// partly hidden (x.bg) is counted but left out of speed figures; the network and Next's prefetches are kept as numbers;
// a server row without a person says who called.
const sid2 = 'test-trail-' + Date.now().toString(36);
const t2 = Date.now();
const trail = { v: 1, sid: sid2, sentAt: t2, app: { rel: 'dev-runner01', plat: 'web', dev: 'desktop' }, ev: [
  { k: 'app.session', t: t2 - 9500, x: { vw: 1440, conn: '4g', rtt: 150, down: 9.5, save: true } },
  { k: 'nav.load', t: t2 - 9000, n: '/dashboard', p: '/dashboard', d: 900 },
  { k: 'nav.leave', t: t2 - 8000, n: '/dashboard', p: '/dashboard', d: 4000, x: { act: 3000, idle: 1000, lt: 0, ltms: 0, pf: 2 } },
  { k: 'nav.route', t: t2 - 8000, n: '/tasks', p: '/tasks', d: 700, x: { from: '/dashboard', trig: 'click' } },
  { k: 'nav.leave', t: t2 - 6000, n: '/tasks', p: '/tasks', d: 2000, x: { act: 1500, idle: 500, lt: 0, ltms: 0 } },
  { k: 'nav.route', t: t2 - 6000, n: '/dashboard', p: '/dashboard', d: 90000, x: { from: '/tasks', trig: 'back', bg: 1 } },
  { k: 'nav.route', t: t2 - 3000, n: '/tasks', p: '/tasks', d: 1100, x: { from: '/dashboard', trig: 'click' } },
  { k: 'app.network', t: t2 - 2000, n: '3g', x: { conn: '3g', rtt: 450, down: 1.3 } },
] };
const trailPosted = await call(MEMBER, '/api/v0/telemetry', trail);
eq([trailPosted.status, trailPosted.data.accepted], [200, 8], JSON.stringify(trailPosted.data));
const trailRows = await rows(`select kind, detail from pulse.telemetry_event where session_id = $1 order by at`, [sid2]);
eq(trailRows.find((r) => r.kind === 'app.session').detail, { vw: 1440, conn: '4g', rtt: 150, down: 9.5, save: true }, 'the network is kept as numbers and short codes');
ok(trailRows.some((r) => r.kind === 'app.network') && trailRows.some((r) => r.detail?.bg === 1) && trailRows.some((r) => r.detail?.pf === 2), 'network changes, background and prefetch counts are kept');
for (const url of ['/api/v0/telemetry/trails', '/api/v0/telemetry/speed']) eq((await call(MEMBER, url)).status, 403, `member ${url}`);
const trails = await call(LEAD, '/api/v0/telemetry/trails?days=1');
eq(trails.status, 200, JSON.stringify(trails.data).slice(0, 500));
const move = trails.data.moves.find((m) => m.from === '/dashboard' && m.to === '/tasks');
ok(move && move.n === 2 && move.p90 !== null && move.p90 <= 1100, `moves, timed in the foreground: ${JSON.stringify(trails.data.moves)}`);
const back = trails.data.moves.find((m) => m.from === '/tasks' && m.to === '/dashboard');
ok(back && back.n === 1 && back.p50 === null, `a background move is counted, not timed: ${JSON.stringify(back)}`);
ok(trails.data.pages.some((p) => p.page === '/dashboard' && p.activeP50 === 3000), `active time per screen: ${JSON.stringify(trails.data.pages)}`);
ok(trails.data.people.some((p) => p.personId === P.kabir && p.views >= 3), 'per person');
ok(trails.data.sessions.some((s) => s.id === sid2 && s.path[0] === '/dashboard' && s.path.includes('/tasks') && s.replay === false), `each session's path: ${JSON.stringify(trails.data.sessions)}`);
const mine = await call(LEAD, `/api/v0/telemetry/trails?days=1&person=${P.kabir}&page=${encodeURIComponent('/tasks')}`);
ok(mine.status === 200 && mine.data.person?.id === P.kabir && mine.data.moves.every((m) => m.from === '/tasks' || m.to === '/tasks'), 'one person, one screen');
eq((await call(LEAD, '/api/v0/telemetry/trails?person=not-a-person&page=javascript:alert(1)')).data.person, null, 'a bad filter is ignored');
const speed = await call(LEAD, '/api/v0/telemetry/speed');
eq(speed.status, 200, JSON.stringify(speed.data).slice(0, 500));
eq(speed.data.targets, { route: 1000, api: 500, load: 3000 });
ok(speed.data.now.route !== null && speed.data.now.route < 90000 && speed.data.now.prefetches === 2, `background time is left out: ${JSON.stringify(speed.data.now)}`);
eq((await call(null, '/api/v0/host')).status < 500, true, 'the host lookup answers before sign-in');
await timing.flush();
const anon = await rows(`select detail from pulse.telemetry_event where source = 'server' and name = 'GET /api/v0/host' and person_id is null order by at desc limit 1`);
ok(anon.length === 0 || anon[0].detail?.who === 'anon', `a server row with no person says who called: ${JSON.stringify(anon)}`);

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
ok(maintained.rolled > 0 && maintained.removed === 0, JSON.stringify(maintained));
// NO-DATA-LOSS-4 (2494): raw usage is kept whatever its age (it went after 90 days for the app and 30 for the server).
eq((await rows(`select name from pulse.telemetry_event where name in ('old', 'GET /old', 'GET /kept') order by name`)).map((r) => r.name), ['GET /kept', 'GET /old', 'old'], 'usage is kept whatever its age');
const daily = await rows(`select kind, events, p75_ms from pulse.telemetry_daily where name = '*' and platform = '*' and role = '*' and kind = 'ui.submit'`);
ok(daily.length >= 1 && daily[0].events >= 1, JSON.stringify(daily));
ok((await rows(`select count(*)::int n from pulse.telemetry_daily where name = '*' and role = '*' and app_version = 'dev-runner01' and platform = 'web'`))[0].n >= 1, 'rolled up by version and platform');
ok((await rows(`select count(*)::int n from pulse.telemetry_daily where name = '*' and platform = '*' and role = 'person'`))[0].n >= 1, 'rolled up by role');
// SPEED-TELEMETRY (2105): how people move is kept by day after the raw rows expire; a background move is counted, not timed.
const trailDaily = await rows(`select kind, name, events, people, p50_ms from pulse.telemetry_daily where kind like 'trail.%' order by kind, name`);
ok(trailDaily.some((r) => r.kind === 'trail.move' && r.name === '/dashboard > /tasks' && r.events === 2 && r.p50_ms === 900), JSON.stringify(trailDaily));
ok(trailDaily.some((r) => r.kind === 'trail.move' && r.name === '/tasks > /dashboard' && r.events === 1 && r.p50_ms === null), 'a background move: counted, not timed');
ok(trailDaily.some((r) => r.kind === 'trail.time' && r.name === '/dashboard' && r.p50_ms === 3000) && trailDaily.some((r) => r.kind === 'trail.exit'), 'active time per screen and where sessions end');
const again = await call(LEAD, '/api/v0/telemetry?days=7');
ok(again.data.trend.length >= 1 && again.data.versions.some((v) => v.version === 'dev-runner01'), 'trends by day and version read the rollups');

await app.close();
await pool.end();
await writeFile(process.env.TEST_REPORT, JSON.stringify({ ok: true, checks }));
console.log(`telemetry runner: ${checks} checks`);
