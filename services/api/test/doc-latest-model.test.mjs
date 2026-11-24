import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { latestDocAnswer } from '../dist/doc-latest.js';

// REPLAY-FIXES #4: a quotation link from a chat always leads to the newest version, or says why there is none.
const A = 'a0000000-0000-4000-8000-000000000001', B = 'b0000000-0000-4000-8000-000000000002', C = 'c0000000-0000-4000-8000-000000000003';

test('the linked quotation itself when it is the newest', () => {
  assert.deepEqual(latestDocAnswer({ asked: A, chain: [A], deleted: false, fromChat: null }), { id: A, state: 'here' });
});

test('a revised quotation leads to its newest version, however many revisions later', () => {
  assert.deepEqual(latestDocAnswer({ asked: A, chain: [A, B], deleted: false, fromChat: null }), { id: B, state: 'replaced' });
  assert.deepEqual(latestDocAnswer({ asked: A, chain: [A, B, C], deleted: false, fromChat: [C] }), { id: C, state: 'replaced' });
});

test('a deleted draft leads to the newest quotation kept for the chat it was linked in', () => {
  assert.deepEqual(latestDocAnswer({ asked: A, chain: [], deleted: true, fromChat: [B] }), { id: B, state: 'replaced' });
  assert.deepEqual(latestDocAnswer({ asked: A, chain: [], deleted: true, fromChat: [B, C] }), { id: C, state: 'replaced' });
});

test('with nothing newer it says deleted, or not open to this person, never a bare not found', () => {
  assert.deepEqual(latestDocAnswer({ asked: A, chain: [], deleted: true, fromChat: null }), { id: null, state: 'deleted' });
  assert.deepEqual(latestDocAnswer({ asked: A, chain: [], deleted: false, fromChat: [] }), { id: null, state: 'unavailable' });
  assert.deepEqual(latestDocAnswer({ asked: A, chain: [], deleted: false, fromChat: [A] }), { id: null, state: 'unavailable' }, 'the chat only names the same one');
});

test('the route reads under the person\'s own row policies, follows at most 20 revisions and takes the chat only as an id', () => {
  const src = readFileSync(new URL('../src/erp.ts', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf('"/api/v0/erp/documents/:id/latest"'), src.indexOf('"/api/v0/erp/documents/:id", (req)'));
  assert.ok(route.length > 100, 'the route is registered before GET /api/v0/erp/documents/:id');
  assert.match(route, /await reader\(c\)/);
  assert.match(route, /v\.depth<20/);
  assert.match(route, /UUID\.test\(req\.query\.chat\)/);
  assert.doesNotMatch(route, /security definer|set role|bypass/i);
});
