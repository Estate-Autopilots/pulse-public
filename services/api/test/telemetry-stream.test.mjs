// WL-ONBOARD-FIX (17 Nov 2026): a live event stream that failed to open is kept in the server's telemetry (the calls
// stream gave up often in production and nothing said why); an opened stream and the streams' JSON stand-ins are not
// special-cased. Pure rules only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepStreamRow, streamOpen } from '../dist/telemetry.js';

test('only a live stream that answered with an error is kept; other routes as before', () => {
  assert.equal(streamOpen('/api/v0/calls/events'), true);
  assert.equal(streamOpen('/api/v0/calls/events?after=120'), true);
  assert.equal(streamOpen('/api/v0/chats/events'), true);
  assert.equal(streamOpen('/api/v0/calls/events/next'), false, 'the JSON read is an ordinary route');
  assert.equal(streamOpen('/api/v0/calls'), false);
  assert.equal(keepStreamRow('/api/v0/calls/events', 200), false);
  assert.equal(keepStreamRow('/api/v0/calls/events', 403), true);
  assert.equal(keepStreamRow('/api/v0/calls/events', 503), true);
  assert.equal(keepStreamRow('/api/v0/calls/events/next', 200), true);
  assert.equal(keepStreamRow('/api/v0/tasks', 200), true);
});
