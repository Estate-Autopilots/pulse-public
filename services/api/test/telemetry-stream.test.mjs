// WL-ONBOARD-FIX (17 Nov 2026): a live event stream that failed to open is kept in the server's telemetry (the calls
// stream gave up often in production and nothing said why); an opened stream and the streams' JSON stand-ins are not
// special-cased. Pure rules only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepStreamRow, streamOpen, timed } from '../dist/telemetry.js';

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

// AI-FIX-6 (BC-020): v1's events read is a page (listEvents), not a stream; it was skipped as one, so the bridge's
// refused event polls left no telemetry row and the refused field's note was lost.
test("v1's events page read is timed; v0 live streams, health and the telemetry ingest still are not", () => {
  assert.equal(timed('/api/v1/events'), true);
  assert.equal(timed('/api/v1/events?cursor=0b8aae29-df12-40bf-b6fd-d4daa2418db7&limit=100'), true);
  assert.equal(timed('/v1/events?types=task.created'), true);
  assert.equal(timed('/api/v1/events/activity?subjectId=x'), true);
  assert.equal(timed('/api/v1/billing/quotations?limit=50'), true);
  assert.equal(timed('/api/v0/calls/events'), false, 'a live stream: its failed opens come via streamOpen');
  assert.equal(timed('/api/v0/chats/events?after=3'), false);
  assert.equal(timed('/api/v0/calls/events/next'), true);
  assert.equal(timed('/healthz'), false);
});
