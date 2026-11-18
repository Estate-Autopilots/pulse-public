// DOREVE-FIX: one person's day and the moments they struggled, found from telemetry alone. The rows are a synthetic copy
// of what production recorded for Datup (Atlas Crest, 5-17 Nov 2026): a parent task's circle refused, a /tasks load
// that painted at once and ran its code 23 s later, the same circle clicked again and again, a slow move, a freeze.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDay as build, what, secs, DEAD_MS, SLOW_MS } from '../dist/struggle-model.js';
// Titles keep a number and its unit together with a no-break space; compared here as plain spaces.
const plain = (v) => typeof v === 'string' ? v.replace(/\u00a0/g, ' ') : Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v;
const buildDay = (rows) => plain(build(rows));

const S = 'sessSYNTH0001', base = Date.UTC(2026, 10, 5, 8, 40, 47);
let n = 0;
const row = (ms, kind, extra = {}) => ({ at: new Date(base + ms).toISOString(), sessionId: S, kind, name: null, page: '/tasks', durationMs: null, value: null, status: null,
  requestId: `reqSYNTH${String(++n).padStart(6, '0')}`, platform: 'web', detail: null, ...extra });
const check = (ms, extra = {}) => row(ms, 'ui.click', { name: 'button', durationMs: 30, detail: { sel: 'tbody>tr>td.checkCol>button.check', api: 0 }, ...extra });

function doreveDay() {
  return [
    row(0, 'nav.load', { name: '/tasks', durationMs: 22994, detail: { cut: 'timeout', wait: 'fetch,busy,dom', paint: 22990, ttfb: 218 } }),
    row(10, 'vital.lcp', { name: '/tasks', durationMs: 312 }),
    row(23000, 'api', { name: 'GET /api/v0/platform-notices', durationMs: 153, status: 200, detail: { during: 'load' } }),
    // the circle, armed, confirmed, refused (before DOREVE-FIX the refusal is only a failed call during the click)
    check(32000), check(33000, { durationMs: 445, detail: { sel: 'tbody>tr>td.checkCol>button.check', api: 2 } }),
    row(33010, 'api', { name: 'POST /api/v0/tasks/:id/move', durationMs: 157, status: 400, detail: { during: 'ui.click' } }),
    check(34000), check(35000, { durationMs: 294, detail: { sel: 'tbody>tr>td.checkCol>button.check', api: 1 } }),
    row(35010, 'api', { name: 'POST /api/v0/tasks/:id/move', durationMs: 120, status: 400, detail: { during: 'ui.click' } }),
    check(37000),
    // after DOREVE-FIX the click itself says it was refused
    row(57000, 'ui.click', { name: 'button Mark done', durationMs: 111, detail: { sel: 'div.island>div.pill>div.content>button.act', api: 1, fail: 400, failed: 'POST /api/v0/tasks/:id/move' } }),
    // a background poll's 404 is not a person refused
    row(58000, 'api', { name: 'GET /api/v0/briefs/tick', durationMs: 100, status: 404 }),
    row(60000, 'nav.route', { name: '/tasks/:id', durationMs: 4100, detail: { from: '/tasks', trig: 'click', pending: 'GET /api/v0/work/options' } }),
    row(61000, 'perf.longtask', { durationMs: 1300, detail: { busy: 'nav.route' } }),
    row(65000, 'ui.early', { durationMs: 21000, value: 3, detail: { first: 900, last: 21000, ready: 21900, buttons: 2 } }),
    row(70000, 'nav.leave', { name: '/tasks/:id', durationMs: 10000, detail: { act: 8000, idle: 2000 } }),
  ];
}

test('a refused circle is one struggle, from the old rows (a failed call during the click) and the new (detail.fail)', () => {
  const d = buildDay(doreveDay());
  const refused = d.struggles.filter((s) => s.kind === 'refused');
  assert.equal(refused.length, 3, JSON.stringify(refused, null, 1));
  assert.equal(refused[0].title, "Clicked a task's circle; it was refused");
  assert.equal(refused[0].detail, 'POST tasks/:id/move answered 400');
  assert.equal(refused[2].title, 'Clicked “Mark done”; it was refused');
  assert.equal(d.totals.failed, 2, 'the background 404 is not counted as a refusal');
  assert.ok(!d.struggles.some((s) => /briefs/.test(s.detail)));
  assert.equal(refused[2].detail, 'POST tasks/:id/move answered 400', 'the new rows say the same');
});

test('a page that painted at once but ran its code 23 s later is a dead start', () => {
  const d = buildDay(doreveDay());
  const dead = d.struggles.find((s) => s.kind === 'dead_start');
  assert.ok(dead);
  assert.equal(dead.title, '/tasks looked ready but did not respond for 23 s');
  assert.equal(dead.detail, 'It appeared in 312 ms, but clicks did nothing for 23 s');
  assert.ok(dead.ms >= DEAD_MS);
  const early = d.struggles.find((s) => s.kind === 'early_clicks');
  assert.equal(early.title, 'Clicked 3 time(s) while /tasks was still starting');
});

test('the same circle clicked again and again is found once; slow moves and freezes are found', () => {
  const d = buildDay(doreveDay());
  const repeat = d.struggles.filter((s) => s.kind === 'repeat');
  assert.equal(repeat.length, 1);
  assert.match(repeat[0].title, /^Clicked a task's circle 5 times in 5\.0 s$/);
  const slow = d.struggles.find((s) => s.kind === 'slow');
  assert.equal(slow.title, 'Waited 4.1 s for /tasks/:id');
  assert.equal(slow.detail, 'Still loading: GET /api/v0/work/options');
  assert.ok(slow.ms >= SLOW_MS);
  const freeze = d.struggles.find((s) => s.kind === 'freeze');
  assert.equal(freeze.title, '/tasks froze for 1.3 s');
  assert.equal(freeze.detail, 'While a page was opening', 'plain words, not the collector\'s code');
  assert.deepEqual(d.struggles.map((s) => s.at), [...d.struggles.map((s) => s.at)].sort(), 'in time order');
});

test('steps read as plain words with a tone; slowness per page and per action; totals', () => {
  const d = buildDay(doreveDay());
  const labels = d.steps.map((s) => `${s.tone}:${s.label}`);
  assert.ok(labels.includes('slow:Opened /tasks'), labels.join('\n'));
  assert.ok(labels.includes('fail:Clicked “Mark done” · refused'));
  assert.ok(labels.includes('fail:POST tasks/:id/move refused (400)'));
  assert.ok(labels.includes('slow:Went to /tasks/:id from /tasks'));
  assert.ok(!labels.some((l) => /briefs/.test(l)), 'quiet polls stay out of the story');
  assert.equal(d.slowPages[0].name, '/tasks', 'the 23 s load is the slowest page');
  assert.equal(d.slowActions[0].name.endsWith(' on /tasks'), true);
  assert.deepEqual(d.totals, { sessions: 1, loads: 1, moves: 1, actions: 6, failed: 2, struggles: d.struggles.length, activeMs: 8000 });
});

test('what a click was on, in plain words', () => {
  assert.equal(what({ name: 'button', detail: { sel: 'tbody>tr>td.checkCol>button.check' } }), "a task's circle");
  assert.equal(what({ name: 'button Confirm: mark “X” done', detail: { sel: 'tbody>tr>td.checkCol>button.check' } }), "a task's circle");
  assert.equal(what({ name: 'link /tasks', detail: { sel: 'a.stripBtn' } }), 'the tasks link');
  assert.equal(what({ name: 'button Spent', detail: {} }), '“Spent”');
  assert.equal(what({ name: 'button', detail: { sel: 'main#main-content>aside.stack>div.card>button.close' } }), 'a close');
  assert.equal(what({ name: null, detail: null }), 'something without a label');
  assert.equal(what({ name: 'button A person: A person', detail: {} }), '“A person”', 'a label and value that repeat are said once');
  assert.equal(secs(450), '450\u00a0ms'); assert.equal(secs(22994), '23\u00a0s'); assert.equal(secs(4100), '4.1\u00a0s');
});

test('a quiet, healthy day has no struggles', () => {
  const d = buildDay([row(0, 'nav.load', { name: '/tasks', durationMs: 1800, detail: { paint: 700 } }), row(400, 'api', { name: 'GET /api/v0/tasks/home', durationMs: 200, status: 200 }),
    row(5000, 'ui.click', { name: 'link /chats', durationMs: 600, detail: { sel: 'a.stripBtn' } }), row(5000, 'nav.route', { name: '/chats', durationMs: 600, detail: { from: '/tasks' } })]);
  assert.deepEqual(d.struggles, []);
  assert.equal(d.steps.every((s) => s.tone === 'ok'), true);
});
