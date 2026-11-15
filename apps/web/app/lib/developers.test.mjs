import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { operations, prepareRequest, sendRequest } from '../developers/model.ts';
const key = 'psvc_00000000-0000-4000-8000-000000000001_' + 'a'.repeat(43);
const op = { path: '/api/v1/tasks/{id}', method: 'get', parameters: [{ name: 'limit', in: 'query' }] };
const args = [key, '{"id":"synthetic-task"}', '{"limit":"1"}', '', '', false];
test('reference discovers live operations and legacy paths, excluding operator and arbitrary URLs', () => {
  const found = operations({ openapi: '3.1.0', paths: { '/api/v1/tasks/{id}': { get: { summary: 'Read task' } }, '/api/v1/service/clients': { $ref: './service.yaml#/paths/example' }, '/api/v1/operator/keys': { get: {} }, 'https://evil.test/api/v1/tasks': { get: {} }, '/api/v1/tasks/../operator/keys': { get: {} } } });
  assert.equal(found.length, 2); assert.equal(found[1].method, 'get'); assert.match(found[1].summary, /clients.read/);
  assert.throws(() => operations({ openapi: '3.0.0', paths: {} }));
});
test('try-it actually sends only a bearer to the same origin, without cookies, redirects or stored credentials', async () => {
  const request = prepareRequest(op, ...args); let calls = 0;
  const answer = await sendRequest(request, new AbortController().signal, async (url, init) => {
    calls++; assert.equal(url, '/api/v1/tasks/synthetic-task?limit=1'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); assert.equal(init.referrerPolicy, 'no-referrer');
    assert.deepEqual(init.headers, { Authorization: `Bearer ${key}` });
    return Response.json({ synthetic: true }, { headers: { 'x-request-id': 'synthetic-request', 'ratelimit-remaining': '9' } });
  });
  assert.equal(calls, 1); assert.equal(answer.status, 200); assert.match(answer.text, /x-request-id: synthetic-request/); assert.match(answer.text, /ratelimit-remaining: 9/);
});
test('arbitrary endpoints, traversal, secret-bearing input and malformed keys are refused before fetch', () => {
  for (const path of ['https://evil.test/api/v1/tasks', '//evil.test/tasks', '/api/v1/operator/keys', '/api/v0/me', '/api/v1/tasks/%2e%2e/operator', '/api/v1/service/arbitrary']) assert.throws(() => prepareRequest({ ...op, path }, ...args));
  for (const id of ['..', '//evil.test', '%2foperator', 'a?token=secret']) assert.throws(() => prepareRequest(op, key, JSON.stringify({ id }), '{}', '', '', false));
  for (const token of ['', 'malformed', key + '\n']) assert.throws(() => prepareRequest(op, token, ...args.slice(1)));
  assert.throws(() => prepareRequest(op, key, args[1], JSON.stringify({ token: key }), '', '', false));
  assert.throws(() => prepareRequest(op, key, args[1], '{"limit":"' + key.replace('p', '\\u0070') + '"}', '', '', false));
  assert.throws(() => prepareRequest(op, key, args[1], '{"origin":"evil.test"}', '', '', false));
  assert.throws(() => prepareRequest(op, key, args[1], '{}', key, '', false));
});
test('writes require deliberate confirmation and an idempotency key; responses remain text and are bounded', async () => {
  const write = { path: '/api/v1/tasks', method: 'post' };
  assert.throws(() => prepareRequest(write, key, '{}', '{}', '{}', 'synthetic-write', false));
  assert.throws(() => prepareRequest(write, key, '{}', '{}', '{}', '', true));
  const request = prepareRequest(write, key, '{}', '{}', '{}', 'synthetic-write', true);
  assert.equal(request.init.headers['Idempotency-Key'], 'synthetic-write'); assert.equal(request.init.body, '{}');
  const result = await sendRequest(request, new AbortController().signal, async () => new Response('x'.repeat(70000), { status: 429 }));
  assert.equal(result.status, 429); assert.match(result.text, /Response truncated/); assert.ok(result.text.length < 66000);
});
test('the public boundary precedes all session calls; reference has no storage, telemetry or history writes', () => {
  const layout = readFileSync(new URL('../layout.tsx', import.meta.url), 'utf8');
  assert.ok(layout.indexOf("if (path === '/developers')") < layout.indexOf('portalApi<{'));
  const source = readFileSync(new URL('../developers/reference.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|sendBeacon|pushState|replaceState|dangerouslySetInnerHTML/);
  assert.match(source, /pagehide/); assert.match(source, /pending.current\?\.abort/); assert.match(source, /input.value = ''/);
});
