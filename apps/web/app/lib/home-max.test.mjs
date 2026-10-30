import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as finance from './finance-view.mjs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

function source(path, imports = {}) {
  const fixtureModule = { exports: {} }, require = createRequire(new URL(path, import.meta.url));
  const js = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(js, { module: fixtureModule, exports: fixtureModule.exports, Date, Intl, require: (name) => imports[name] ?? require(name) });
  return fixtureModule.exports;
}
const brain = source('../home/brain.ts', { '../lib/finance-view.mjs': finance });
// Presentation imports are inert; issues() and its number formatting execute unchanged.
const { issues } = source('../insights.tsx', {
  './charts': {}, './ui': { viewNames() {} }, './dashboard/dash.module.css': {}, './pod-team': {}, './pod-team-hint': {}, './kit/word': {}, './lib/words.mjs': { lower: (w) => w.toLowerCase() }, './lib/api': { vocabulary: async () => ({}) }, './lib/format': source('./format.ts'),
});
const { deep } = source('../home/deep.ts', { './brain': brain, '../insights': { issues } });
const clean = (x) => JSON.parse(JSON.stringify(x));
const now = Date.parse('2026-10-01T00:01:00+05:30');
const absent = { me: null, live: null, insights: null, home: null, tasks: null, now };
function full() {
  const live = { asOf: '2026-10-01', brief: [], payroll: [],
    revenue: { months: ['2026-07', '2026-08', '2026-09', '2026-10'].map((month, i) => ({ month, invoiced: (i + 1) * 100000, collected: i === 3 ? null : i * 50000 })),
      clients: [{ client: 'Synthetic A', outstanding: 40000, invoices: 2, last: '2026-09' }, { client: 'Synthetic B', outstanding: 90000, invoices: 1 }, { client: 'Synthetic paid', outstanding: 0, invoices: 3 }] },
    burn: { avgMonthlyCost: 300000, avgMonthlyInvoiced: 200000, balance: null, runwayMonths: null },
    collections: { overdue: { amount: 130000, count: 3, confirmed: { amount: 90000, count: 1 }, buckets: [{ bucket: '1–30', amount: 40000, count: 2 }, { bucket: '90+', amount: 90000, count: 1 }] } },
    compliance: { quarters: [1, 2, 3].map((quarter) => ({ quarter, period: '2026-09', gstr1: { filed: false, due: '2026-09-20' }, gstr3b: { filed: false, due: '2026-09-25' } })) }, software: { renewals30: [{}] } };
  const home = { attendance: { present: 2, headcount: 4, entries: ['Synthetic In', 'Synthetic Out'].map((name, i) => ({ name, checkedInAt: '2026-10-01T09:00:00+05:30', checkedOutAt: i ? '2026-10-01T12:00:00+05:30' : null })) }, leave: { pending: [{}], onLeaveToday: [{}] }, topProjects: [] };
  const insights = { portfolio: { activeClients: 4, activeClientsBefore: 3, projectsNoClient: 2 }, quietTotal: 1, quiet: [], identity: { recent: 10, shared: 5 }, people: { headcount: 4, canSignIn: 3, withManager: 1, noPod: 0 }, hrQueue: { leave: 1, corrections: 8 }, attendanceEnabled: false };
  return { ...absent, me: { name: 'Synthetic Admin', role: 'hr' }, live, home, insights, tasks: { rows: [{ id: 't1', title: 'Synthetic task', status: 'todo', dueOn: '2026-09-01' }], waitingOnMe: [{}] } };
}
function read(input) { const brief = brain.think(input); return { brief, data: deep({ ...input, brief }) }; }

test('Max keeps financial values, oldest debt, client order and the nine-move queue without changing Focus limits', () => {
  const input = full(), before = JSON.stringify(input), { brief, data } = read(input);
  assert.deepEqual(clean(data.kpis.map((k) => k.id)), ['owed', 'gap', 'cash', 'invoiced', 'clients', 'people']);
  assert.equal(data.kpis.find((k) => k.id === 'cash').value, '?');
  assert.equal(data.kpis.find((k) => k.id === 'gap').value, '−₹1.00 L');
  assert.deepEqual(clean(data.aging.map((a) => [a.title, a.tone, a.share])), [['90+', 'bad', 1], ['1–30', 'info', 4 / 9]]);
  assert.deepEqual(clean(data.clients.map((c) => c.title)), ['Synthetic B', 'Synthetic A']);
  assert.equal(brief.glance.length, 4); assert.equal(brief.next.length, 6); assert.equal(brief.queue.length, 9);
  assert.deepEqual(clean(brief.next), clean(brief.queue.slice(0, 6)));
  assert.ok(brief.queue.every((m, i, a) => !i || a[i - 1].score >= m.score));
  assert.match(data.fix[0].title, /shared logins/);
  assert.ok(data.fix.some((r) => r.title === '1 request waiting for a decision'));
  assert.equal(JSON.stringify(input), before);
});

test('the owner spark excludes the running IST month and ends at the last full month across UTC midnight', () => {
  const { data } = read(full()), kpi = data.kpis.find((k) => k.id === 'invoiced');
  assert.equal(kpi.label, 'Invoiced Sep 26'); assert.equal(kpi.value, '₹3.00 L');
  assert.deepEqual(clean(kpi.spark), [100000, 200000, 300000]);
  assert.equal(data.months.at(-1).partial, true); assert.equal(data.months.at(-1).collected, null);
  const input = full(); input.now = Date.parse('2027-01-01T00:01:00+05:30');
  input.live.revenue.months = [{ month: '2026-12', invoiced: 200000, collected: null }, { month: '2027-01', invoiced: 1000, collected: null }];
  assert.deepEqual(clean(read(input).data.kpis.find((k) => k.id === 'invoiced').spark), [200000]);
});

test('both attendance paths keep named rows neutral and preserve source order for checked-in and checked-out people', () => {
  const { brief, data } = read(full());
  for (const rows of [brief.allGlance.find((g) => g.id === 'people').sheet.rows, data.team.rows]) {
    assert.deepEqual(clean(rows.map((r) => [r.title, r.tone, r.value])), [['Synthetic In', 'info', '09:00'], ['Synthetic Out', 'info', '09:00']]);
  }
  assert.equal(data.team.away, 1); assert.equal(data.team.pending, 1);
});

test('absent or role-limited sources add no invented money, team, chart or queue', () => {
  const { brief, data } = read(absent);
  assert.deepEqual(clean(data), { kpis: [], months: [], avgCost: null, aging: [], agingTotal: '', clients: [], team: null, fix: [] });
  assert.equal(brief.queue.length, 0);
  const input = full(); input.live = null; input.insights = null;
  assert.deepEqual(clean(read(input).data.kpis.map((k) => k.id)), ['people']);
  input.home.attendance = null; assert.equal(read(input).data.team, null);
});

test('Focus does not load Max; an explicit Max request uses the same optional API responses', async () => {
  let loads = 0; const calls = [], input = full();
  const responses = { 'finance/live': { model: input.live }, home: input.home, insights: input.insights, 'tasks/home': input.tasks };
  const { loadCalm } = source('../home/load.ts', { './brain': brain, './deep': { deep: (value) => { loads++; return deep({ ...value, now }); } }, '../lib/api': { getMe: async () => ({ data: input.me }), api: async (path) => { calls.push(path); return { data: responses[path] }; }, insightsFor: async (path = 'insights') => { calls.push(path); return { data: responses[path] }; } } });
  assert.equal((await loadCalm()).max, undefined); assert.equal(loads, 0);
  const result = await loadCalm({ max: true, home: null, insights: null });
  assert.equal(loads, 1); assert.equal(result.max.team, null); assert.equal(calls.filter((p) => p === 'home').length, 1);
  assert.equal(calls.filter((p) => p === 'insights').length, 1);
  responses['finance/live'] = null; responses['tasks/home'] = null;
  assert.deepEqual(clean((await loadCalm({ max: true, home: null, insights: null })).max.kpis), []);
});

test('the retained Max body renders unknown collections, the full queue and neutral team rows from supplied data', () => {
  const { MaxBody } = source('../home/max.tsx', { './brain': brain,
    './home.module.css': { default: new Proxy({}, { get: (_, key) => key }) } });
  const { data, brief } = read(full());
  const html = renderToStaticMarkup(createElement(MaxBody, { data, brief, onOpen() {}, act() {} }));
  assert.match(html, /so far/); assert.match(html, /not yet known/);
  assert.equal((html.match(/class="qRow"/g) ?? []).length, 9);
  for (const name of ['Synthetic In', 'Synthetic Out']) {
    assert.match(html, new RegExp(`data-tone="info"></i><span class="rowText"><span class="rowTitle">${name}`));
  }
  const input = full(); input.live.revenue.months.forEach((m) => { m.collected = null; });
  const unknown = read(input);
  const noCollections = renderToStaticMarkup(createElement(MaxBody, { ...unknown, onOpen() {}, act() {} }));
  assert.match(noCollections, /Invoiced against costs/); assert.doesNotMatch(noCollections, />Collected </);
});

const { homeMode, drawsCalmHome } = source('../home/focus.ts');
test('cookie, explicit modes and classic resolve consistently; both calm modes get the first-paint shell', () => {
  const viewer = { role: 'admin', home: null, person: 'synthetic-admin', mustChange: false };
  for (const [query, cookie, mode] of [['', undefined, 'focus'], ['', 'max', 'max'], ['mode=focus', 'max', 'focus'], ['mode=max', 'focus', 'max'], ['classic=1', 'focus', 'max'], ['mode=focus&classic=1', 'focus', 'max'], ['mode=unknown', 'max', 'max']]) {
    const search = new URLSearchParams(query);
    assert.equal(homeMode(Object.fromEntries(search), cookie), mode);
    assert.equal(drawsCalmHome('/dashboard', search, viewer), true);
  }
  for (const query of ['tab=delivery&mode=max', 'view=people&mode=focus', 'tab=research&classic=1']) {
    assert.equal(drawsCalmHome('/dashboard', new URLSearchParams(query), viewer), false);
  }
  for (const me of [null, { ...viewer, mustChange: true }, { ...viewer, role: 'editor' }, { ...viewer, home: 'sales' }]) {
    assert.equal(drawsCalmHome('/dashboard', new URLSearchParams('mode=max'), me), false);
  }
  assert.equal(drawsCalmHome('/home', new URLSearchParams(), viewer), true);
});
