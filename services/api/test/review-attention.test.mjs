import assert from 'node:assert/strict';
import test from 'node:test';
import { attention, rankAttention } from '../dist/review-attention.js';

// Synthetic names, places and suggestions only.
const item = (kind, o = {}) => ({ id: `${kind}-1`, kind, title: `${kind} item`, proposed: {}, confidence: 0.8, evidence: {}, entityType: null, entityId: null, ...o });

test('every kind is explained, with the action that resolves it', () => {
  const centre = attention(item('geocode', { proposed: { rule: 'locality_centre', projects: 10, lat: null, place: null, search: 'Hillside, Pune' }, evidence: { why: 'Hillside is placed 58 km from Pune.' }, confidence: 0.7 }), '2026-10-11');
  assert.equal(centre.impact, 90); assert.equal(centre.action.needs, 'point'); assert.equal(centre.dismiss, 'Keep'); assert.equal(centre.why, 'Hillside is placed 58 km from Pune.');
  assert.match(centre.impactNote, /10 projects sit/);
  const folder = attention(item('geocode', { proposed: { rule: 'folder_place', lat: 18.6, lng: 73.8, place: 'Riverside, Pune' } }), '2026-10-11');
  assert.equal(folder.action.label, 'Move to Riverside, Pune'); assert.equal(folder.action.needs, undefined);
  const alias = attention(item('talent', { title: 'Which model is “Asha”? (12 shoot lines)', proposed: { what: 'alias', personId: 'm1', options: [{ id: 'm1', label: 'Asha Rao', note: 'portfolio folder' }, { id: 'm2', label: 'Asha Sen' }] } }), '2026-10-11');
  assert.equal(alias.impact, 36); assert.equal(alias.action.label, "It's Asha Rao"); assert.equal(alias.options.length, 2); assert.match(alias.why, /portfolio folder/);
  const unknown = attention(item('talent', { proposed: { what: 'alias', options: [] } }), '2026-10-11');
  assert.equal(unknown.action.needs, 'option');
  const soon = attention(item('holiday', { proposed: { day: '2026-10-20', name: 'Festival' } }), '2026-10-11');
  const past = attention(item('holiday', { proposed: { day: '2026-05-01', name: 'May Day' } }), '2026-10-11');
  assert.equal(soon.impact, 65); assert.equal(soon.impactNote, 'In 9 days'); assert.equal(past.impact, 8);
  const pod = attention(item('project_pod', { projectName: 'Lakeview', proposed: {} }), '2026-10-11');
  assert.equal(pod.action.needs, 'pod'); assert.match(pod.why, /Lakeview has no pod/);
  assert.equal(attention(item('project_pod', { proposed: { pod: 'Pod 2' } }), '2026-10-11').action.label, 'Assign Pod 2');
  const gap = attention(item('data_gap', { entityType: 'person', entityId: 'p1', personName: 'Ravi', proposed: { missing: ['joining date'] } }), '2026-10-11');
  assert.equal(gap.action, null); assert.equal(gap.href, '/people/p1'); assert.match(gap.why, /Ravi has no joining date/);
  assert.equal(attention(item('identity'), '2026-10-11').action, null);
  assert.equal(attention(item('duplicate', { proposed: { entity: 'client' } }), '2026-10-11').action, null);
  assert.equal(attention(item('duplicate', { proposed: { entity: 'project' } }), '2026-10-11').action.label, 'Merge');
  assert.equal(attention(item('manager', { personName: 'Ravi', managerName: 'Mira' }), '2026-10-11').action.label, 'Report to Mira');
});

test('ranking: impact weighted by confidence, strongest first', () => {
  const ranked = rankAttention([
    item('contact_type', { id: 'c', proposed: { contactType: 'developer' }, confidence: 0.95 }),
    item('geocode', { id: 'g', proposed: { rule: 'locality_centre', projects: 10 }, confidence: 0.5 }),
    item('correction', { id: 'k', confidence: null }),
    item('project_pod', { id: 'p', proposed: { pod: 'Pod 1' }, confidence: 0.9 }),
  ], '2026-10-11');
  assert.deepEqual(ranked.map((r) => r.id), ['g', 'k', 'p', 'c']);
  assert.equal(ranked[1].score, Math.round(70 * (0.55 + 0.45 * 0.6) * 10) / 10);   // no confidence counts as 0.6
});
