import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromSop, normalizeTrigger, normalizeWorkflow, triggerWords } from '../dist/workflow-model.js';
import { advise, titleKey } from '../dist/workflow-intel.js';

// Synthetic people and work only.
const P = (id, name, role, open, extra = {}) => ({ id, name, role, pod: 'Pod 1', photoAt: null, open, workflows: 0, activeSteps: 0, categories: [], history: {}, ...extra });

test('a workflow keeps its rules within limits: who does a step, conditions, joins, waits', () => {
  const r = normalizeWorkflow({ steps: [
    { id: 'a', title: 'Survey', role: 'Technician' },
    { id: 'b', title: 'Big job?', kind: 'decision', next: [{ to: 'c', label: 'Big', when: { field: 'install.panels', op: 'gt', value: 10 } }, { to: 'd', label: 'Small', when: { field: 'x', op: 'nope' } }] },
    { id: 'c', title: 'Supervisor visit', assign: { by: 'person', personId: '00000000-0000-4000-8000-000000000001' }, join: 'all' },
    { id: 'd', title: 'Wait', kind: 'wait' },
    { id: 'e', title: 'Pool it', assign: { by: 'pool', scope: 'pod' }, formId: 'not-a-uuid' }] });
  const s = r.def.steps;
  assert.deepEqual(s[0].assign, { by: 'role', role: 'Technician' });
  assert.deepEqual(s[1].next[0].when, { field: 'install.panels', op: 'gt', value: 10 });
  assert.equal(s[1].next[1].when, null, 'an unknown operator is dropped');
  assert.deepEqual(s[2].assign, { by: 'person', personId: '00000000-0000-4000-8000-000000000001' }); assert.equal(s[2].join, 'all');
  assert.equal(s[3].waitHours, 24); assert.deepEqual(s[4].assign, { by: 'pool', scope: 'pod' }); assert.equal(s[4].formId, null);
  assert.equal(normalizeWorkflow({ steps: [{ title: 'Which way?', kind: 'decision' }] }).error, 'Step 1 is a decision: give it at least two ways to go');
});

test('triggers in words, with their limits', () => {
  assert.deepEqual(normalizeTrigger({ kind: 'schedule', every: 'week', weekday: 9, at: '25:00' }), { kind: 'schedule', every: 'week', at: '09:00', weekday: 7, projectId: null });
  assert.equal(normalizeTrigger({ kind: 'milestone' }).error, "Choose the milestone: a kind of work finished, or the project's status");
  assert.equal(triggerWords(normalizeTrigger({ kind: 'milestone', category: 'video_shoot' }), { category: () => 'Video shoot' }), 'When Video shoot work is finished on a project');
  assert.equal(triggerWords({ kind: 'package' }), 'When a new client package is made in Pulse');
  assert.equal(triggerWords({ kind: 'schedule', every: 'month', day: 1, at: '10:00' }), 'On day 1 of every month at 10:00');
  assert.equal(normalizeTrigger({ kind: 'form' }).error, 'Choose the form that starts it');
});

test('from an SOP, every step keeps its owner', () => {
  const def = fromSop({ steps: [{ id: 's1', title: 'Brief', role: 'PGS', kind: 'task', next: null, involves: [], inputs: [], outputs: [], kpis: [], links: [] }, { id: 's2', title: 'Design', personId: '00000000-0000-4000-8000-000000000002', role: null, kind: 'task', next: null, involves: [], inputs: [], outputs: [], kpis: [], links: [] }], phases: [], roles: [], outputs: [], watch: [] });
  assert.deepEqual(def.steps.map((s) => s.assign.by), ['role', 'person']);
});

test('Pip: who could do a step, what to watch, the effect of a person, management steps and reuse', () => {
  const def = normalizeWorkflow({ steps: [
    { id: 'a', title: 'Shoot the walkthrough', role: 'Videographer', category: 'video_shoot', slaHours: 24 },
    { id: 'b', title: 'Edit the video', role: 'Video Editor', category: 'video_edit' },
    { id: 'c', title: 'Design the thumbnail', role: 'Graphic Designer', category: 'design', slaHours: 48 },
    { id: 'd', title: 'Send to the client', assign: { by: 'person', personId: '00000000-0000-4000-8000-000000000004' }, category: 'client_service', slaHours: 4 }] }).def;
  const facts = {
    people: [P('00000000-0000-4000-8000-000000000001', 'Ahoro Nair', 'Videographer', 9, { history: { video_shoot: { n: 6, days: 0.5, late: 0 } } }), P('00000000-0000-4000-8000-000000000002', 'Zoya Khan', 'Videographer', 2),
      P('00000000-0000-4000-8000-000000000003', 'Ishaan Gobap', 'Video Editor', 4, { workflows: 5, history: { video_edit: { n: 10, days: 2, late: 5 } } }), P('00000000-0000-4000-8000-000000000004', 'Asha Rao', 'PGS', 16, { history: { client_service: { n: 4, days: 1, late: 0 } } })],
    holders: { Videographer: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'], 'Video Editor': ['00000000-0000-4000-8000-000000000003'], 'Graphic Designer': [] }, categories: { video_shoot: 'Video shoot', video_edit: 'Video editing', design: 'Design', client_service: 'Client service' },
    similar: { a: { n: 8, minutes: 300, cycleDays: 0.8 }, b: { n: 12, minutes: 480, cycleDays: 2.5 } },
    past: [{ kind: 'workflow', id: 'w9', name: 'Old video flow', titles: ['Shoot walkthrough', 'Edit videos', 'Upload'] }, { kind: 'sop', id: 's9', name: 'HR onboarding', titles: ['Collect documents', 'Create accounts'] }],
    modes: { '00000000-0000-4000-8000-000000000004': 'request' } };
  const a = advise(def, facts, { stepId: 'a', personId: '00000000-0000-4000-8000-000000000002' });
  const [shoot, edit, design, send] = a.steps;
  assert.deepEqual(shoot.candidates.map((c) => c.name), ['Ahoro Nair', 'Zoya Khan'], 'experience outweighs a lighter load here');
  assert.ok(shoot.candidates[0].reasons.includes('Holds Videographer') && shoot.candidates[0].reasons.some((r) => r.startsWith('6 done')));
  assert.ok(shoot.effect.lines.some((l) => l.startsWith('Zoya has 2 open tasks')) && shoot.effect.lines.some((l) => /has not done Video shoot work/.test(l)));
  assert.equal(shoot.estimate.basis, '8 finished Video shoot tasks');
  assert.ok(edit.flags.some((f) => f.text.startsWith('Only Ishaan holds')));
  assert.ok(edit.flags.some((f) => f.text === 'Ishaan is on 5 running workflows'));
  assert.ok(edit.flags.some((f) => f.text === 'No SLA: Pulse cannot tell when this step is late'));
  assert.ok(design.flags.some((f) => f.text.startsWith('Nobody holds “Graphic Designer”')));
  assert.ok(send.effect.warn && send.effect.lines.some((l) => l.startsWith("Outside Asha's domains")), 'a named person outside their domains is a warning');
  assert.ok(send.flags.some((f) => f.text === 'Asha has 16 open tasks'));
  assert.deepEqual(a.suggestions.map((s) => s.key), ['handover', 'review', 'close'], 'three roles and no handover; nothing checked before the client; no close-out');
  assert.equal(a.suggestions.find((s) => s.key === 'review').after, 'c', 'the review goes before the step that reaches the client');
  assert.deepEqual(a.reuse.map((r) => r.id), ['w9']);
  assert.equal(titleKey('Shooting the walkthrough videos'), 'shoot walkthrough video');
});
