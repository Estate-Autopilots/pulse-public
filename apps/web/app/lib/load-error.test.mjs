import assert from 'node:assert/strict';
import test from 'node:test';
import { UNAVAILABLE, apiFailure, describeFailure } from './load-error.mjs';

const RETRY = 'Pulse couldn’t get this page’s data just now. Check your connection, then try again.';
const safe = describeFailure(UNAVAILABLE);

test('EST-1197: a refusal Pulse wrote for people shows as it is, without Try again', () => {
  // A page's own words, the API's sign-in and permission refusals, a module switched off, the denied-permission line.
  for (const text of ['Only an admin imports WhatsApp history. The owner operates real imports.', 'Companies are set up by an admin of this install\'s own company.',
    'Sign in to Pulse to see your workspace.', 'Access denied for this account', 'Admin access required', 'Leadership and admins design processes', 'Work and tasks are off for your organisation.']) {
    assert.deepEqual(describeFailure(text), { retry: false, title: 'This view is unavailable', text });
  }
});

test('EST-1197: Pulse unreachable or busy says so plainly and offers Try again', () => {
  for (const text of ['Pulse data is temporarily unavailable', 'The data service is reconnecting. Refresh to try again.', 'Client service reconnecting. Try again.', 'This view is unavailable.', '', undefined, null]) {
    assert.deepEqual(describeFailure(text), { retry: true, title: 'This didn’t load', text: RETRY }, String(text));
  }
});

test('EST-1197: raw server text never reaches the screen', () => {
  for (const raw of ['not_initialised', '{"status":"unavailable","part":"database"}', 'TypeError: fetch failed', 'connect ECONNREFUSED 127.0.0.1:4000', 'Request failed with status 503',
    '<html><body>Bad gateway</body></html>', 'Error: relation "pulse.x" does not exist\n    at Parser.parse (/app/node_modules/pg/lib/parser.js:12:3)', 'Unexpected token < in JSON at position 0', 'x'.repeat(400)]) {
    assert.deepEqual(describeFailure(raw), safe, raw);
  }
});

test('EST-1197 review: a sentence is trusted for where it came from, never for how it looks', () => {
  // Credentials, reason phrases and well-formed sentences that Pulse's source never wrote all get the safe line.
  for (const raw of ['Authorization: Bearer synthetic-review-canary', 'X-Pulse-Session: synthetic-review-canary', 'Upstream database refused connection to 10.0.0.8:5432.',
    'Bad Gateway', 'Service Unavailable', 'Not Found', 'Internal Server Error', 'Password: hunter2-synthetic', 'Upload files up to 100 MB; larger ones go to Drive.']) {
    assert.deepEqual(describeFailure(raw), safe, raw);
  }
});

test('EST-1197 review: only Pulse’s own 4xx sentences reach a page; anything else becomes the safe line', () => {
  const refusal = 'Only an admin imports WhatsApp history. The owner operates real imports.';
  assert.equal(apiFailure(403, { error: refusal }), refusal, 'a trusted permission notice is unchanged');
  assert.equal(describeFailure(apiFailure(403, { error: refusal })).retry, false);
  assert.equal(apiFailure(403, { error: 'Leadership access required' }), 'Leadership access required');
  // CTO and QA probes at bc120af6: an unknown 4xx text, even one shaped like a sentence, is never shown.
  assert.deepEqual(describeFailure(apiFailure(400, { error: 'X-Pulse-Session: synthetic-review-canary' })), safe);
  assert.deepEqual(describeFailure(apiFailure(403, { error: 'Upstream database refused connection to 10.0.0.8:5432.' })), safe);
  assert.deepEqual(describeFailure(apiFailure(503, { error: 'Authorization: Bearer synthetic-review-canary' })), safe);
  // A trusted sentence is trusted only as a 4xx answer: a 5xx body is never passed on.
  assert.equal(apiFailure(503, { error: refusal }), UNAVAILABLE, '5xx bodies are never trusted');
  assert.equal(apiFailure(502, null), UNAVAILABLE); assert.equal(apiFailure(503, null), UNAVAILABLE); assert.equal(apiFailure(undefined, null), UNAVAILABLE);
  assert.equal(apiFailure(404, { message: 'Route GET:/x not found', error: 'Not Found', statusCode: 404 }), 'Not Found', 'module-off.tsx keys on 404 "Not Found"');
  assert.deepEqual(describeFailure('Not Found'), safe, 'and Message never shows it raw');
  assert.equal(apiFailure(404, { error: 'not_initialised' }), UNAVAILABLE);
  assert.equal(apiFailure(401, { error: 'unauthorized' }), 'Sign in to Pulse to see your workspace.');
  assert.equal(describeFailure(apiFailure(401, { error: 'X-Pulse-Session: synthetic-review-canary' })).retry, false, 'sign-in is a fixed product line');
  for (const status of [400, 409, 422, 502, 503, 504]) assert.deepEqual(describeFailure(apiFailure(status, { error: 'anything at all' })), safe, String(status));
});
