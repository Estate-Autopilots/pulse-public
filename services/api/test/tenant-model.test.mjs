import test from 'node:test';
import assert from 'node:assert/strict';
import { accentCheck, contrast, feedbackInput, handoverInput, moduleForPath, parseCsv, peopleFromCsv, pilotCheckInput, planSpec, publicOrigin, readiness, setupGuide, suggest } from '../dist/tenant-model.js';
import { accessHeaderAllowed, normaliseHost } from '../dist/tenant-context.js';
import { checklist } from '../dist/tenants.js';

// UX-TENANT: synthetic companies and people only.
test('modules cover their API areas and nothing else', () => {
  assert.equal(moduleForPath('/api/v0/tasks?mine=1'), 'tasks');
  assert.equal(moduleForPath('/api/v0/work/asks/x/accept'), 'tasks');
  assert.equal(moduleForPath('/api/v0/workflows/runs'), 'tasks');
  assert.equal(moduleForPath('/api/v0/chats/direct'), 'chats');
  assert.equal(moduleForPath('/api/v0/erp/documents'), 'finance');
  assert.equal(moduleForPath('/api/v0/money'), 'finance');
  for (const path of ['/api/v0/projects', '/api/v0/people', '/api/v0/me', '/api/v0/settings/modules', '/api/v0/taskforce', '/api/v0/financial']) assert.equal(moduleForPath(path), null, path);
});

test('CSV: quotes, commas, blank lines and a BOM', () => {
  assert.deepEqual(parseCsv('﻿a,"b, c","d ""e"""\r\n\r\n1,2,3'), [['a', 'b, c', 'd "e"'], ['1', '2', '3']]);
  assert.deepEqual(parseCsv('x\n"multi\nline"'), [['x'], ['multi\nline']]);
});

test('people from a CSV: columns in any order, usual spellings, Workspace first/last name', () => {
  const r = peopleFromCsv('Work Email,Full Name,Designation,Department,Reports To,Pulse Role,Pod\nz@x.test,Zara Synthetic,Setter,Sales,d@x.test,MANAGER,Setters\n');
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.rows, [{ name: 'Zara Synthetic', email: 'z@x.test', title: 'Setter', pod: 'Setters', team: 'Sales', manager: 'd@x.test', access: 'manager' }]);
  const g = peopleFromCsv('First Name,Last Name,Primary Email\nIshan,Synthetic,i@x.test\n');
  assert.equal(g.rows[0].name, 'Ishan Synthetic'); assert.equal(g.rows[0].email, 'i@x.test');
  assert.match(peopleFromCsv('Email\na@x.test').problems[0], /No name column/);
  assert.match(peopleFromCsv('').problems[0], /empty/);
});

test('an accent must carry white text', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.equal(accentCheck('#5b45d6').ok, true);
  assert.equal(accentCheck('#1d4ed8').ok, true);
  assert.equal(accentCheck('#ffee00').ok, false);
  assert.equal(accentCheck('blue').ok, false);
});

test('suggestions from a company name', () => {
  assert.deepEqual(suggest('Atlas Crest (rehearsal)'), { slug: 'atlas-crest-rehearsal', code: 'ACR' });
  assert.deepEqual(suggest('Zenith'), { slug: 'zenith', code: 'ZENI' });
});

test('addresses: hosts only, Access only on the install company, rehearsal links keep the port', () => {
  assert.equal(normaliseHost('Pulse.atlascrest.example:443'), 'pulse.atlascrest.example');
  assert.equal(normaliseHost('ac-rehearsal.localhost:47391'), 'ac-rehearsal.localhost');
  for (const bad of ['localhost', '127.0.0.1:3200x', 'a b.com', '', null, 'x'.repeat(260) + '.com']) assert.equal(normaliseHost(bad), null, String(bad));
  assert.equal(accessHeaderAllowed(null, false), true);
  assert.equal(accessHeaderAllowed({ org: 'o', signIn: 'access', status: 'active', rehearsal: false }, false), true);
  assert.equal(accessHeaderAllowed({ org: 'o', signIn: 'password', status: 'active', rehearsal: false }, false), false);
  assert.equal(accessHeaderAllowed(null, true), false);
  assert.equal(publicOrigin('pulse.example.test', 'https://pulse.estateautopilots.com'), 'https://pulse.example.test');
  assert.equal(publicOrigin('ac-rehearsal.localhost', undefined, '127.0.0.1:47391'), 'http://ac-rehearsal.localhost:47391');
  assert.equal(publicOrigin(null, 'https://pulse-dev.example.test/'), 'https://pulse-dev.example.test');
});

test('the checklist blocks opening until the company, an admin and a fresh isolation check exist', () => {
  const base = { id: 's', name: 'Synthetic Co', status: 'setup', steps: {}, org: { id: 'o', name: 'Synthetic Co', slug: 'synthetic-co', code: 'SYN', timeZone: 'Asia/Kolkata', dataRegion: 'in', status: 'setup', rehearsal: true, host: 'syn.localhost', signIn: 'password' } };
  let c = checklist(base, { reason: 'off' });
  assert.equal(c.canOpen, false); assert.deepEqual(c.blocked, ['First admin', 'Isolation check']);
  c = checklist({ ...base, admin: { personId: 'p', name: 'A', email: 'a@x.test', username: 'a', title: 'Admin', invitation: 'prepared', linkReady: false, sentAt: null, expiresAt: null, signedIn: false },
    steps: { isolation: { at: new Date().toISOString(), leaks: 0, tables: 200 } } }, { reason: null });
  assert.equal(c.canOpen, true);
  c = checklist({ ...base, admin: { personId: 'p', name: 'A', email: 'a@x.test' }, steps: { isolation: { at: new Date().toISOString(), leaks: 2, tables: 200 } } }, { reason: null });
  assert.equal(c.canOpen, false); assert.equal(c.items.find((i) => i.key === 'isolation').state, 'blocked');
  c = checklist({ ...base, admin: { personId: 'p', name: 'A', email: 'a@x.test' }, steps: { isolation: { at: '2026-01-01T00:00:00Z', leaks: 0, tables: 200 } } }, { reason: null });
  assert.equal(c.canOpen, false, 'an isolation check over an hour old must be run again');
  assert.equal(checklist(base, { reason: null }).items.find((i) => i.key === 'route').state, 'done', 'a *.localhost rehearsal needs no DNS');
});

// R53: the setup plan's input, the handover's input and the guide written from the database's gates (synthetic only).
test('a setup plan keeps known fields only, bounded', () => {
  const spec = planSpec({ company: { name: 'Synthetic Closers', code: 'SYNTHETIC', host: 'syn.localhost', rehearsal: true, orgId: 'x', admin: 'y' },
    modules: { tasks: true }, rules: [{ role: 'member', action: 'task.assign', scope: 'pod', extra: 1 }],
    sources: [{ key: 'people-csv', kind: 'csv', label: 'People', categories: ['people'], secret: 'no' }], orgId: 'other', copyFrom: 'EA' });
  assert.deepEqual(Object.keys(spec).sort(), ['company', 'modules', 'rules', 'sources']);
  assert.deepEqual(spec.company, { name: 'Synthetic Closers', code: 'SYNT', host: 'syn.localhost', rehearsal: true });
  assert.deepEqual(spec.rules, [{ role: 'member', action: 'task.assign', scope: 'pod' }]);
  assert.deepEqual(spec.sources, [{ key: 'people-csv', kind: 'csv', label: 'People', categories: ['people'] }]);
  assert.deepEqual(planSpec(null), {});
  assert.equal(planSpec({ sources: Array.from({ length: 50 }, () => ({})) }).sources.length, 31, 'one past the limit, so the database says so');
});

test('the handover input: only named fields, nothing is a problem', () => {
  assert.match(handoverInput({}).problem, /Nothing to record/);
  const h = handoverInput({ support: '  Pulse   Help ', restore: { on: '2026-10-12', minutes: '42', result: 'passed', isolated: true, ref: 'Synthetic receipt' }, other: 1 });
  assert.equal(h.problem, null);
  assert.deepEqual(h.body, { support: 'Pulse Help', restore: { on: '2026-10-12', minutes: 42, result: 'passed', isolated: true, ref: 'Synthetic receipt' } });
  assert.deepEqual(handoverInput({ operatorId: '', termsRef: '' }).body, { operatorId: null, termsRef: null });
});

const GATES = ['admin', 'identity', 'sources', 'devices', 'walkthrough', 'isolation', 'backup', 'handover', 'terms'];
const gates = (ok, extra = {}) => ({
  company: { name: 'Synthetic Closers', status: 'active', activation: 'trial', rehearsal: false, host: 'pulse.synthetic.example', prefix: 'orgs/x/' },
  facts: { admins: 1, adminsSignedIn: 1, adminsTwoStep: 1, people: 4, withEmail: 4, duplicateNames: 0, sharedEmails: 0, sources: 1, sourcesReady: 1, offices: 0,
    hrConfirmed: false, attendance: false, signIns: 2, invitationsSent: 0, devices: 0, connectorsActive: 0 },
  sources: [{ key: 'company-drive', connector: 'ea-connect' }], handover: {},
  gates: GATES.map((key) => ({ key, ok: ok.includes(key), label: `Gate ${key}`, detail: `detail ${key}` })),
  ready: GATES.every((g) => ok.includes(g)), blocked: GATES.filter((g) => !ok.includes(g)).map((g) => `Gate ${g}`), ...extra });

test('the guide: who does what, automatic or manual, and what still blocks activation', () => {
  const g = setupGuide(gates(['admin', 'isolation']), 'operator', 'setup-1');
  const by = Object.fromEntries(g.map((s) => [s.key, s]));
  assert.deepEqual(g.map((s) => s.key), ['created', 'address', 'open', 'admin', 'identity', 'sources', 'policies', 'devices', 'walkthrough', 'feedback', 'isolation', 'backup', 'handover', 'terms', 'activate', 'staff']);
  assert.deepEqual([by.created.who, by.created.how], ['Pulse', 'automatic']);
  assert.deepEqual([by.admin.state, by.identity.state, by.isolation.state], ['done', 'todo', 'done']);
  assert.equal(by.activate.state, 'blocked'); assert.match(by.activate.detail, /Gate backup/);
  assert.deepEqual(by.sources.errands, ['E13']); assert.deepEqual(by.terms.errands, ['E08', 'E18']); assert.deepEqual(by.backup.errands, ['E19']);
  assert.equal(by.policies.gate, false, 'offices and shifts do not block activation (attendance stays off)');
  assert.equal(by.staff.state, 'later');
  assert.equal(by.backup.href, '/companies/setup-1?step=activate'); assert.equal(by.identity.href, null, 'the operator does not act inside the company');
  const own = Object.fromEntries(setupGuide(gates(GATES), 'company').map((s) => [s.key, s]));
  assert.equal(own.identity.href, '/people'); assert.equal(own.backup.href, null);
  assert.equal(own.activate.state, 'todo');
  const live = Object.fromEntries(setupGuide(gates(GATES, { company: { ...gates([]).company, activation: 'live' } }), 'company').map((s) => [s.key, s]));
  assert.deepEqual([live.activate.state, live.staff.state], ['done', 'todo']);
  const notOpen = Object.fromEntries(setupGuide(gates([], { company: { ...gates([]).company, status: 'setup' } }), 'operator', 's').map((s) => [s.key, s]));
  assert.equal(notOpen.admin.state, 'waiting');
  const rehearsal = Object.fromEntries(setupGuide(gates([], { company: { ...gates([]).company, rehearsal: true, host: 'r.localhost' } }), 'operator', 's').map((s) => [s.key, s]));
  assert.deepEqual([rehearsal.address.state, rehearsal.terms.errands], ['done', []]);
  // R54: the pilot's steps. Devices and HR's walkthrough block activation; feedback never does.
  assert.deepEqual([by.devices.who, by.devices.gate, by.devices.errands], ['Company admin and HR', true, ['E03']]);
  assert.deepEqual([by.walkthrough.who, by.walkthrough.gate, by.walkthrough.errands], ['HR', true, ['E06', 'E18']]);
  assert.deepEqual([by.feedback.gate, by.feedback.state], [false, 'waiting']);
  assert.deepEqual([notOpen.devices.state, notOpen.walkthrough.state], ['waiting', 'waiting']);
  assert.deepEqual([rehearsal.devices.errands, rehearsal.walkthrough.errands], [[], []]);
  assert.equal(own.devices.href, '/settings?tab=devices');
});

const feedback = (answers, shown) => ({ answers, minimum: 5, shownAnswers: shown, shownOn: shown ? '2026-10-13' : null,
  questions: shown ? [{ key: 'effort', label: 'Pulse saves me effort', average: 4.2, agree: 80 }, { key: 'calm', label: 'Pulse feels calm, not pushy', average: 3.8, agree: 60 }] : [] });
const pilot = (extra = {}) => ({ devices: [{ platform: 'android', evidence: 'simulator', result: 'passed', on: '2026-10-13' }], platforms: 1, passed: 1, installed: 0,
  devicesOk: true, walkthrough: { evidence: 'mock', result: 'passed', on: '2026-10-13' }, walkthroughOk: true, feedback: feedback(3, null), ...extra });

test('the feedback step shows totals only from the minimum, as of the last multiple of five', () => {
  const few = Object.fromEntries(setupGuide(gates(GATES, { pilot: pilot() }), 'company').map((s) => [s.key, s]));
  assert.equal(few.feedback.state, 'todo'); assert.match(few.feedback.detail, /3 answered so far; the totals show from 5 answers/);
  const shown = Object.fromEntries(setupGuide(gates(GATES, { pilot: pilot({ feedback: feedback(7, 5) }) }), 'company').map((s) => [s.key, s]));
  assert.equal(shown.feedback.state, 'done'); assert.match(shown.feedback.detail, /7 answered\. As of 5 answers: saves me effort: 4\.2 of 5; feels calm, not pushy: 3\.8 of 5/);
});

test('readiness: an explicit verdict, every open gate with its owner errands, and a rehearsal is never a launch', () => {
  const real = readiness(gates(['admin', 'identity', 'isolation'], { pilot: pilot() }));
  assert.equal(real.verdict, 'not_ready'); assert.equal(real.rehearsal, false);
  assert.equal(real.title, 'Not ready for staff: 6 of 9 gates open');
  assert.deepEqual(real.open.map((o) => o.key), ['sources', 'devices', 'walkthrough', 'backup', 'handover', 'terms']);
  assert.deepEqual(real.errands, ['E03', 'E06', 'E08', 'E10', 'E13', 'E18', 'E19']);
  assert.deepEqual(real.evidence, ['android: passed (simulator)', 'HR walkthrough: passed (mock)']);
  assert.match(real.summary, /owner's explicit rollout instruction/);
  const ready = readiness(gates(GATES));
  assert.deepEqual([ready.verdict, ready.open, ready.errands], ['ready', [], []]);
  assert.match(ready.title, /^Ready: every gate passes/);
  const company = { ...gates([]).company, rehearsal: true };
  const rehearsal = readiness(gates(GATES, { company }));
  assert.equal(rehearsal.verdict, 'ready'); assert.equal(rehearsal.title, 'Rehearsal ready: every gate passes');
  assert.match(rehearsal.summary, /not a live company launch/);
  const openRehearsal = readiness(gates(['admin'], { company }));
  assert.match(openRehearsal.title, /^Rehearsal not ready: 8 of 9 gates open/);
  assert.deepEqual(openRehearsal.open.find((o) => o.key === 'terms').errands, [], 'a rehearsal owes no live terms');
  const live = readiness(gates(GATES, { company: { ...company, activation: 'live' } }));
  assert.deepEqual([live.verdict, live.title], ['live', 'Rehearsal company, activated for its synthetic staff']);
});

test('pilot inputs: only known fields, bounded; the database decides the values', () => {
  assert.deepEqual(pilotCheckInput({ kind: 'device', platform: 'android', evidence: 'installed_device', result: 'passed', covers: ['pair', 'offline'], note: 'Synthetic', extra: 1 }),
    { kind: 'device', platform: 'android', evidence: 'installed_device', result: 'passed', covers: ['pair', 'offline'], note: 'Synthetic' });
  assert.deepEqual(pilotCheckInput(null), { kind: '', evidence: '', result: '', covers: [] });
  assert.equal(pilotCheckInput({ covers: Array(30).fill('pair') }).covers.length, 12);
  assert.deepEqual(feedbackInput({ effort: 5, fair: '4', calm: 2.5, easy: 'x', who: 'me' }), { effort: 5, fair: 4, calm: null, easy: null });
});
