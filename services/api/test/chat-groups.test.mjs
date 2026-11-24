// CHAT-GROUPS (owner report EA #4): what a new group, a request for one and a group's settings take from a request body.
// The database checks every value (2530); these keep the body to the known keys and shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupFields, newGroupBody, personIds } from '../dist/chat-groups.js';

const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';

test('a new group: its name, description, people and settings; nothing else goes through', () => {
  const out = newGroupBody({ name: 'Orchid launch', description: 'x'.repeat(400), memberIds: [a, b, a], category: 'projects', icon: 'megaphone', colour: 'violet',
    adders: 'members', posting: 'admins', note: 'For the shoot', org_id: 'someone else', created_by: b });
  assert.deepEqual(Object.keys(out).sort(), ['adders', 'category', 'colour', 'description', 'icon', 'members', 'name', 'note', 'posting']);
  assert.equal(out.description.length, 300);
  assert.deepEqual(out.members, [a, b]);
  assert.equal(out.note, 'For the shoot');
});

test('settings keep only the known keys; null clears one (a group back to Other groups)', () => {
  assert.deepEqual(groupFields({ category: null, icon: 'bug', role: 'admin' }), { category: null, icon: 'bug' });
  assert.deepEqual(groupFields({}), {});
});

test('people are uuids, at most 256', () => {
  assert.deepEqual(personIds(undefined), []);
  assert.throws(() => personIds(['not-a-person']), /valid person/);
  assert.throws(() => personIds(Array.from({ length: 257 }, () => a)), /256/);
});
