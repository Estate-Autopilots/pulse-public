// FLOW-A: the pure parts of Flow (services/api/src/flow, ai/flow-assist.ts): kinds and converters, a definition's
// problems in words, what the engine is compiled from (a wired need gates, a context port never does), older workflows
// and boards read as processes, due dates and Pip's line in words, record types and the Asset ID, the grounded
// assistant, and the templates.
import assert from 'node:assert/strict';
import test from 'node:test';
import { boardDef, compile, converters, legacyDef, normalizeFlow, problems } from '../dist/flow/model.js';
import { MODULES } from '../dist/flow/registry.js';
import { assetId, cleanData, normalizeRecordType, RECORD_TYPE } from '../dist/flow/record-types.js';
import { TEMPLATES } from '../dist/flow/templates/index.js';
import { PACKS, packPayload, wordsOf } from '../dist/flow/packs.js';
import { SCREENS } from '../dist/screens.js';
import { kindFits } from '../dist/flow/types.js';
import { dueOf, pipLine, shortTitle, waitWords } from '../dist/flow/views.js';
import { groundedAssistant } from '../dist/ai/flow-assist.js';

const step = (id, module, more = {}) => ({ id, module, title: more.title ?? id, who: { by: 'starter' }, ...more });

test('the registry: unique keys, the old blocks, honest engines, ports of known kinds', () => {
  const keys = MODULES.map((m) => m.key); assert.equal(new Set(keys).size, keys.length);
  for (const k of ['lead_capture', 'handoff_in', 'sales_xray', 'quotation', 'follow_up', 'approval', 'decision', 'site_visit', 'data_capture', 'checklist', 'handoff', 'wait', 'notify', 'tax_invoice', 'webhook', 'end'])
    assert.ok(keys.includes(k), k);
  for (const m of MODULES) { assert.ok(['live', 'partial', 'stub'].includes(m.engine), m.key); assert.ok(m.status.length > 10, m.key);
    for (const p of [...m.needs, ...m.makes]) assert.ok(['contact', 'talk', 'doc', 'media', 'answers', 'money', 'verdict', 'slot', 'list', 'any'].includes(p.kind), `${m.key}.${p.key}`); }
  assert.ok(kindFits('talk', 'any') && kindFits('any', 'doc') && !kindFits('talk', 'doc'));
});

test('a wire whose kinds do not fit is an error with the converters that fit, best first', () => {
  assert.equal(converters('talk', 'doc')[0], 'transcribe');
  assert.ok(converters('slot', 'talk').includes('meeting'));
  const def = normalizeFlow({ steps: [step('a', 'meeting'), step('b', 'check')], wires: [{ from: { step: 'a', port: 'talk' }, to: { step: 'b', port: 'draft' } }] });
  const p = problems(def).find((x) => x.level === 'error' && x.fix);
  assert.match(p.text, /makes a talk, and “b” needs a document/); assert.equal(p.fix.modules[0], 'transcribe');
});

test('nothing can be wired into a start; a loop of required needs would never open', () => {
  const def = normalizeFlow({ steps: [step('a', 'checklist'), step('b', 'checklist'), step('s', 'start')],
    wires: [{ from: { step: 'a', port: 'done' }, to: { step: 'b', port: 'in' } }, { from: { step: 'b', port: 'done' }, to: { step: 'a', port: 'in' } }, { from: { step: 'a', port: 'done' }, to: { step: 's', port: 'in' } }] });
  const errs = problems(def).filter((x) => x.level === 'error').map((x) => x.text);
  assert.ok(errs.some((t) => /starts a run/.test(t)), errs.join('|')); assert.ok(errs.some((t) => /wait on each other/.test(t)), errs.join('|'));
});

test('compile: a wired need gates, an unwired or context need does not; a decision branches; a wait is a timer', () => {
  const def = normalizeFlow({ steps: [step('a', 'checklist'), step('b', 'doc_section'), step('d', 'decision'), step('w', 'wait', { settings: { hours: 2 } })],
    wires: [{ from: { step: 'a', port: 'done' }, to: { step: 'b', port: 'context' } }, { from: { step: 'a', port: 'done' }, to: { step: 'd', port: 'in' } }] });
  const c = compile(def);
  assert.equal(c.steps.b.needs.find((n) => n.key === 'context').required, false);
  assert.equal(c.steps.b.needs.find((n) => n.key === 'in').required, false, 'unwired');
  assert.equal(c.steps.d.needs.find((n) => n.key === 'in').required, true);
  assert.equal(c.steps.d.branch, true); assert.equal(c.steps.w.finish, 'timer'); assert.equal(c.steps.w.hours, 2);
});

test('normalise: ids stay unique, unknown wires are dropped, days per variant follow the variant field', () => {
  const def = normalizeFlow({ fields: [{ key: 'package', label: 'Package', type: 'choice', variant: true, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }],
    steps: [step('x', 'checklist', { due: { from: 'day1', days: { a: 2, b: 3 } } }), step('x', 'checklist')], wires: [{ from: { step: 'x', port: 'done' }, to: { step: 'nope', port: 'in' } }] });
  assert.deepEqual(def.steps.map((s) => s.id), ['x', 's1']); assert.equal(def.wires.length, 0);
  assert.deepEqual(def.steps[0].due, { from: 'day1', days: { a: 2, b: 3 }, field: 'package', workdays: true });
});

test('an old workflow and a board read as processes', () => {
  const { def } = legacyDef([{ id: 's1', title: 'Brief', detail: '• Read it\n• Ask', kind: 'task', role: 'PGS', personId: null, phase: 'Start', next: null },
    { id: 's2', title: 'Approve', detail: null, kind: 'approval', role: 'Client', personId: null, phase: 'Start', next: [{ to: 's3', label: 'Approved' }, { to: 's1', label: 'Send back' }] },
    { id: 's3', title: 'Go', detail: null, kind: 'task', role: 'PGS', personId: null, phase: null, next: null }]);
  assert.deepEqual(def.steps.map((s) => s.module), ['checklist', 'approval', 'checklist']);
  assert.deepEqual(def.steps[0].checklist, ['Read it', 'Ask']); assert.deepEqual(def.roles.map((r) => r.label), ['PGS', 'Client']);
  assert.equal(def.wires.length, 2, 'the send-back wire is left out');
  const b = boardDef([{ id: 'w1', name: 'Sales', steps: [{ id: 'b1', title: 'Lead', kind: 'task', module: 'lead_capture', next: [{ to: 'b2', label: null }] }, { id: 'b2', title: 'Pass on', kind: 'task', module: 'handoff', handoff: { workflowId: 'w2' }, next: null }] },
    { id: 'w2', name: 'Survey', steps: [{ id: 'b1', title: 'From sales', kind: 'task', module: 'handoff_in', next: [{ to: 'b2', label: null }] }, { id: 'b2', title: 'Visit', kind: 'task', module: 'site_visit', next: null }] }]).def;
  assert.deepEqual(b.stages.map((s) => s.label), ['Sales', 'Survey']);
  assert.ok(b.wires.some((w) => w.from.step === 't1.b2' && w.to.step === 't2.b1'), 'the hand-off is a wire into the next tab');
  assert.equal(problems(b).filter((p) => p.level === 'error').length, 0, JSON.stringify(problems(b)));
});

test('due dates and Pip in words', () => {
  assert.equal(dueOf('2026-10-21', '2026-10-21', 'open', 4, true).text, 'Due today · Day 4');
  assert.equal(dueOf('2026-10-19', '2026-10-21', 'open', null, true).text, '2 days late');
  assert.equal(dueOf(null, '2026-10-21', 'waiting', 4, false).text, 'Day 4 · the clock starts when the inputs are in');
  assert.equal(shortTitle('First drop: draft links for all three posted'), 'First drop');
  assert.equal(waitWords({ port: 'in', label: 'x', kind: 'any', from: { step: '1.4', title: 'Save the transcript', who: { id: 'p', name: 'Rila Kireteso' }, role: 'CS' }, owner: null, ownerRole: null }), 'Save the transcript from Rila');
  const line = pipLine([{ title: 'Blueprint: done', state: 'open', due: { on: '2026-10-19', text: '2 days late', late: true, days: -2 }, waitingFor: [], blocked: null, who: { id: 'p', name: 'Rila K' } }], 'running', '2026-10-15', 0);
  assert.equal(line, '1 step late (Blueprint).');
});

test('records: the Asset ID, data kept to its type, a company\'s own type', () => {
  assert.equal(assetId({ project: 'Skyline Residences', asset: 'Model Video', persona: 'P1', angle: 'light', hook: 2, version: 1 }), 'SR_MV_P1_LIGHT_H02_V01');
  const { data, missing } = cleanData(RECORD_TYPE.get('fact'), { statement: 'x', source: 'Website', nope: 1, ads_ok: 'yes' });
  assert.deepEqual(data, { statement: 'x', source: 'Website', ads_ok: true }); assert.deepEqual(missing, []);
  assert.deepEqual(cleanData(RECORD_TYPE.get('fact'), { source: 'Nowhere' }).missing, ['Statement', 'Source']);
  const own = normalizeRecordType({ key: 'panel', name: 'Panel', fields: [{ key: 'serial', label: 'Serial' }], statuses: [{ key: 'in', label: 'In stock', next: ['out', 'gone'] }, { key: 'out', label: 'Fitted', next: [] }] });
  assert.deepEqual(own.type.statuses[0].next, ['out']); assert.ok('error' in normalizeRecordType({ key: 'persona', name: 'x' }));
});

test('Pip checks drafts against the Word Library, facts, constraints and offers; summarises and drafts from the SOP', async () => {
  const records = [{ type: 'word', title: 'homes', status: 'approved', data: { use: 'homes', avoid: 'flats' } },
    { type: 'fact', title: 'Metro 5 min away', status: 'to_verify', data: { statement: 'Metro 5 min away' } },
    { type: 'offer', title: 'Diwali offer', status: 'approved', data: { name: 'Diwali offer', valid_until: '2026-10-01' } }];
  const r = await groundedAssistant.assist({ action: 'check', step: { title: 'WCC', module: 'check', checklist: [], qualityTest: ['Under 20 words'] }, sop: null, text: '',
    drafts: [{ title: 'Script', text: 'The best flats in town. Metro 5 min away. Diwali offer ends soon. ₹ 1.2 Cr onwards.' }], records, fields: {}, today: '2026-10-21' });
  const rules = r.findings.map((f) => `${f.rule}:${f.level}`);
  for (const x of ['Word Library:fix', 'Claims:fix', 'Facts:check', 'Offers:fix', 'Quality test:ok']) assert.ok(rules.includes(x), `${x} in ${rules}`);
  assert.equal(groundedAssistant.model, null);
  const s = await groundedAssistant.assist({ action: 'summarise', step: { title: 'm', module: 'meeting', checklist: [], qualityTest: [] }, sop: null,
    text: 'We have 220 homes. PENDING: clubhouse date. We will send the price sheet by Monday.', drafts: [], records: [], fields: {}, today: '2026-10-21' });
  assert.ok(s.followups.some((f) => /price sheet/.test(f)) && s.tags[0].tag === 'PENDING');
  const d = await groundedAssistant.assist({ action: 'draft', step: { title: 'Persona', module: 'doc_section', checklist: [], qualityTest: [] }, sop: { title: 'Persona SOP', body: 'Field 1: Who they are\nField 2: Situation\nSome long sentence that is not a heading at all, because it ends with a stop.' },
    text: '', drafts: [], records, fields: {}, today: '2026-10-21' });
  assert.deepEqual(d.headings, ['Field 1: Who they are', 'Field 2: Situation']);
});

test('the templates: no errors, the EA step IDs of the master doc, no agency words in Solar', () => {
  for (const t of TEMPLATES.filter((x) => x.key !== 'blank')) assert.deepEqual(problems(t.definition).filter((p) => p.level === 'error'), [], t.key);
  const ea = TEMPLATES.find((t) => t.key === 'ea_creative').definition;
  for (const id of ['0.1', '0.2', '0.3', '0.4', '1.1', '1.2', '1.3', '1.4', '1.5', '2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8', '3.9', '3.10', '3.11', '3.12', '3.13', '3.14', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '5.4', '5.5', '5.6'])
    assert.ok(ea.steps.some((s) => s.id === id), id);
  assert.equal(ea.rules.length, 13); assert.equal(ea.clock.from, 'intake');
  assert.deepEqual(ea.steps.find((s) => s.id === '2.7').due.days, { starter: 4, growth: 5, sellout: 6 });
  const solar = JSON.stringify(TEMPLATES.find((t) => t.key === 'solar_install').definition);
  assert.ok(!/Blueprint|Persona|Creative Strateg|Asset ID|CS\b/.test(solar));
});

test('FLOW-E: industry packs are data on the primitives: their processes, roles, screens and record types hold, and no agency words leak', () => {
  const screens = new Set(SCREENS.map((x) => x.key));
  assert.ok(PACKS.some((p) => p.key === 'neutral') && PACKS.length >= 7);
  for (const p of PACKS) {
    const payload = packPayload(p);
    assert.equal(payload.processes.length, p.templates.length, `${p.key}: every starter exists`);
    for (const pr of payload.processes) {
      assert.deepEqual(problems(pr.definition).filter((x) => x.level === 'error'), [], `${p.key}/${pr.template}`);
      assert.ok(pr.definition.steps.every((s) => s.block), `${pr.template}: made of primitives`);
      // A process's roles are the pack's roles (by name), so its steps land on whoever holds them.
      // (The client's own steps are followed up by the project's owner: a client role is not the company's.)
      for (const r of pr.definition.roles.filter((x) => x.key !== 'client')) assert.ok(p.roles.some((x) => x.name === r.label || x.key === r.key), `${p.key}: role ${r.label}`);
    }
    assert.equal(payload.recordTypes.length, p.recordTypes.length, `${p.key}: record types valid`);
    for (const r of p.roles) { assert.match(r.key, /^[a-z0-9][a-z0-9_]{0,39}$/); for (const k of r.screens) assert.ok(screens.has(k), `${p.key}/${r.key}: screen ${k}`); }
    if (p.key !== 'real_estate_marketing') assert.ok(!/Blueprint|Pod\b|Growth Strategist|Creative Strateg|Sell-Out|\bGS\b|\bEA\b/.test(JSON.stringify(payload)), `${p.key}: no agency words`);
  }
  assert.deepEqual(wordsOf({ client: ' Customer ', run: '' }).client, 'Customer');
  assert.equal(wordsOf({ run: '' }).run, 'Run');
});
