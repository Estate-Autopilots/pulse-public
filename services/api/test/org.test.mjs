import test from 'node:test';
import assert from 'node:assert/strict';
import { propose } from '../dist/org.js';

// Synthetic people only.
const staff = [
  { id: 'ceo', name: 'Rila Kapoor', role: 'Co-founder / CEO', pod: 'Leadership', department: 'Leadership', managerId: null, synthetic: false },
  { id: 'sales', name: 'Neha Jivop', role: 'Sales', pod: 'Leadership', department: 'Leadership', managerId: null, synthetic: false },
  { id: 'pgs1', name: 'Ahoro Rao', role: 'PGS', pod: 'Pod 1', department: 'Performance', managerId: null, synthetic: false },
  { id: 'pgs2', name: 'Vikram Seduh', role: 'PGS', pod: 'Pod 1', department: 'Performance', managerId: null, synthetic: false },
  { id: 'ed1', name: 'Kabir Shah', role: 'Video Editor', pod: 'Pod 1', department: 'Creative', managerId: null, synthetic: false },
  { id: 'cam', name: 'Dev Panab', role: 'Videographer', pod: 'Shared', department: 'Production', managerId: null, synthetic: false },
  { id: 'hr', name: 'Sana Khan', role: 'HR', pod: 'Shared', department: 'Operations', managerId: 'ceo', synthetic: false },
];
const base = { staff, heads: new Map(), pods: ['Leadership', 'Pod 1', 'Shared'], unitRoles: new Map([['pgs1', new Map([['Pod 1', ['PGS']]])]]),
  pgs: new Map([['pgs1', 60], ['pgs2', 20]]), pm: new Map([['pgs1', 40]]), worksWith: new Map([['cam', { id: 'pgs1', n: 30 }]]), gives: new Map([['pgs1', new Map([['ed1', 6]])]]), groups: new Map([['cam', ['Shared']]]) };

test('pod heads come from roles and work evidence; the CEO heads Leadership', () => {
  const p = propose(base);
  const heads = p.filter((x) => x.kind === 'pod_head').map((x) => [x.pod, x.personId]);
  assert.deepEqual(heads, [['Leadership', 'ceo'], ['Pod 1', 'pgs1']]);
  assert.ok(p.find((x) => x.pod === 'Pod 1').evidence.some((e) => /PGS role on Pod 1/.test(e)));
});

test('lines: pod members to their head, heads and leadership to the CEO, others to whose clients they work on; nobody already placed', () => {
  const lines = Object.fromEntries(propose(base).filter((x) => x.kind === 'manager').map((x) => [x.personId, x.managerId]));
  assert.equal(lines.ed1, 'pgs1'); assert.equal(lines.pgs2, 'pgs1');
  assert.equal(lines.pgs1, 'ceo'); assert.equal(lines.sales, 'ceo');
  assert.equal(lines.cam, 'pgs1', 'works on the Pod 1 PGS’s clients');
  assert.equal(lines.ceo, undefined, 'the top of the company reports to nobody');
  assert.equal(lines.hr, undefined, 'already has a manager');
});

test('the usual steps of a client package come from the tracker groups, in their usual order', async () => {
  const { usualSteps } = await import('../dist/pool-proposals.js');
  const rows = [];
  for (const [k, key] of ['a', 'b', 'c', 'd'].entries()) ['Onboarding', 'Scripting', 'Video shoot', 'VOV edit'].forEach((step, i) => rows.push({ key, step, first: `2026-0${k + 1}-1${i}` }));
  rows.push({ key: 'e', step: 'Booking velocity check', first: '2026-05-01' });
  assert.deepEqual(usualSteps(rows).map((s) => s.step), ['Onboarding', 'Scripting', 'Video shoot', 'VOV edit']);
});
