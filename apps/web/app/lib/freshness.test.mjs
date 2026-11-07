import test from 'node:test';
import assert from 'node:assert/strict';
import { freshnessState } from './freshness.mjs';
const now = Date.parse('2026-10-09T12:00:00Z');
test('warn after 24 hours, including an idle open tab crossing the boundary', () => {
  const at = '2026-10-08T12:00:00Z';
  assert.equal(freshnessState(at, at, now).stale, false);
  assert.match(freshnessState(at, at, now + 1).warning, /Data is stale/);
});
test('fresh imports do not hide an old or invalid upstream crawl', () => {
  assert.equal(freshnessState('2026-10-09T11:59:00Z', '2026-10-05T12:00:00Z', now).stale, true);
  assert.equal(freshnessState('invalid', null, now).stale, true);
  assert.equal(freshnessState(null, null, now).warning, null);
  assert.equal(freshnessState('2026-10-09T11:59:00Z', null, now).stale, false);
});
