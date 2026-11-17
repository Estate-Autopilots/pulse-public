// TASK-MERGE: the merge suggester (merge-model.ts) proposes duplicates and clusters from real structure and words, says
// why, never pairs a task with its own subtask, and leaves alone pairs people said are different. Fake titles only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { briefNotes, pairScore, propose } from '../dist/merge-model.js';

const P = '00000000-0000-4000-8000-00000000aa01', Q = '00000000-0000-4000-8000-00000000aa02';
let n = 0;
const t = (title, extra = {}) => ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, title, projectId: P, projectName: 'Demo Heights', category: 'social', dueOn: '2026-11-10', parentId: null, ...extra });

test('two tasks that read as the same work are one duplicate proposal, with the reasons', () => {
  const a = t('EXAMPLE Instagram reel edit for Demo Heights launch'), b = t('EXAMPLE Instagram reel edit Demo Heights launch v2'), c = t('EXAMPLE Pay the electricity bill', { category: 'admin', projectId: null, projectName: null });
  const out = propose([a, b, c]);
  const dup = out.find((p) => p.kind === 'duplicate');
  assert.ok(dup, 'a duplicate is proposed');
  assert.deepEqual(new Set(dup.taskIds), new Set([a.id, b.id]));
  assert.equal(dup.shape, 'task'); assert.equal(dup.method, 'words');
  assert.match(dup.reason, /same words/);
  assert.ok(dup.score >= 0.6 && dup.score <= 1);
});

test('many small tasks about one thing in one project become one brief proposal', () => {
  const posts = ['EXAMPLE Demo Heights carousel post amenities', 'EXAMPLE Demo Heights carousel post location', 'EXAMPLE Demo Heights carousel post floor plans',
    'EXAMPLE Demo Heights carousel post pricing', 'EXAMPLE Demo Heights carousel post testimonials'].map((x, i) => t(x, { dueOn: `2026-11-1${i}` }));
  const other = t('EXAMPLE Renew the office internet plan', { projectId: Q, projectName: 'Office', category: 'admin' });
  const out = propose([...posts, other]);
  const brief = out.find((p) => p.kind === 'cluster');
  assert.ok(brief, 'a cluster is proposed');
  assert.equal(brief.shape, 'brief');
  assert.ok(brief.taskIds.length >= 3 && !brief.taskIds.includes(other.id));
  assert.match(brief.title, /carousel/i);
});

test('a subtask is not a duplicate of its parent, and pairs said to be different stay apart', () => {
  const parent = t('EXAMPLE Brochure design for Demo Heights launch');
  const child = t('EXAMPLE Brochure design for Demo Heights launch back page', { parentId: parent.id });
  assert.equal(pairScore(parent, child).dup, 0);
  const a = t('EXAMPLE Site visit video for Demo Heights tower'), b = t('EXAMPLE Site visit video Demo Heights tower');
  const k = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
  assert.ok(propose([a, b]).some((p) => p.kind === 'duplicate'));
  assert.equal(propose([a, b], { apart: new Set([k]) }).length, 0);
});

test('one shared word in different projects is never a cluster', () => {
  const xs = [t('EXAMPLE Reel for Demo One', { projectId: P }), t('EXAMPLE Logo for Demo Two', { projectId: Q }), t('EXAMPLE Invoice for Demo Three', { projectId: null, projectName: null })];
  assert.equal(propose(xs).length, 0);
});

test('steps of one piece of work (one project, due together) become a brief even without shared words', () => {
  const day = ['EXAMPLE Send the invites at 10:00', 'EXAMPLE Help anyone stuck signing in', 'EXAMPLE Check the list of leavers'].map((x) => t(x, { projectId: Q, projectName: 'Demo launch', category: null, dueOn: '2026-11-13' }));
  const later = t('EXAMPLE Pay the vendors', { projectId: Q, projectName: 'Demo launch', category: null, dueOn: '2026-11-30' });
  const brief = propose([...day, later]).find((p) => p.kind === 'cluster');
  assert.ok(brief); assert.deepEqual(new Set(brief.taskIds), new Set(day.map((x) => x.id)));
  assert.match(brief.reason, /due the same day/); assert.match(brief.title, /Demo launch/);
});

test('a brief lists each original as a numbered step, inside the notes limit', () => {
  const notes = briefNotes([{ title: 'EXAMPLE one', dueOn: '2026-11-10', notes: 'x'.repeat(5000) }, { title: 'EXAMPLE two', dueOn: null, notes: null }], 'brief', 'Same launch');
  assert.match(notes, /^Why: Same launch/);
  assert.match(notes, /\n1\. EXAMPLE one \(was due 2026-11-10\)\n2\. EXAMPLE two/);
  assert.ok(notes.length <= 3900);
});
