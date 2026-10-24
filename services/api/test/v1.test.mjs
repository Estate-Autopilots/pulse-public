// EST-1611: API v1's registry, OpenAPI drift check and front door on a synthetic database. Part of the API's test run,
// so CI fails when an operation and openapi/v1.yaml disagree either way, or an /api/v1/<area> route bypasses the registry.
// After changing an operation: cd services/api && pnpm build && V1_OPENAPI_WRITE=1 node --test test/v1.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import Fastify from 'fastify';
import { load } from 'js-yaml';
import { createApp } from '../dist/app.js';
import { isV1Path } from '../dist/service-key.js';
import { attachV1Seam, defineV1Operation, registerV1, v1Fail, v1OpenApi, v1Operations } from '../dist/v1.js';

const FILE = new URL('../openapi/v1.yaml', import.meta.url);
const HEADER = '# Pulse API v1: OpenAPI 3.1 written as JSON (which is YAML), generated from services/api/src/v1.ts and compared in CI\n'
  + '# by services/api/test/v1.test.mjs. Regenerate: cd services/api && pnpm build && V1_OPENAPI_WRITE=1 node --test test/v1.test.mjs\n';
const document = () => {
  const spec = v1OpenApi(); let json = JSON.stringify(spec, null, 2);
  // Registry Path Items stay compact; the inlined legacy contract and the served document remain unchanged.
  for (const path of new Set(v1Operations().map(op => op.path))) {
    const item = spec.paths[path], pretty = JSON.stringify(item, null, 2).replace(/\n/g, '\n    ');
    json = json.replace(`${JSON.stringify(path)}: ${pretty}`, `${JSON.stringify(path)}: ${JSON.stringify(item)}`);
  }
  return HEADER + json + '\n';
};
if (process.env.V1_OPENAPI_WRITE === '1') writeFileSync(FILE, document());
const ORG = '00000000-0000-4000-8000-000000001611', VIEWER = '00000000-0000-4000-8000-0000000000ee';
const SECRET = 'a'.repeat(43), APP = `psvc_00000000-0000-4000-8000-0000000000aa_${SECRET}`, AI = `pak_0123abcd_${'b'.repeat(64)}`;

function synthetic({ principal = true, live = true, installed = true, status = 'active' } = {}) {
  const sql = [], routes = [];
  const client = { release() {}, query: async (text, args) => { sql.push(text);
    if (/v1_(service|agent)_principal/.test(text)) {
      const authentic = text.includes('v1_service') ? args[1] === createHash('sha256').update(SECRET).digest('hex') : args[0] === AI;
      return { rows: [{ v: principal && authentic && args.at(-1) === 'tasks.write' ? 'token' : null }] };
    }
    if (text.includes('v1_agent_token_id')) return { rows: [{ v: '00000000-0000-4000-8000-0000000000bb' }] };
    if (text.includes('v1_replay')) return { rows: [{ v: null }] };
    if (text.includes('service_key_hash')) return { rows: [{ v: live ? createHash('sha256').update(SECRET).digest('hex') : null }] };
    if (text.includes('agent_key_resolve')) return { rows: [{ v: live && args[0] === AI ? VIEWER : null }] };
    if (text.includes('current_viewer()')) return { rows: [{ id: VIEWER, actor: 'agent:synthetic' }] };
    return { rows: [] }; } };
  const app = createApp({ query: async text => ({ rows: text.includes('host_org')
    ? [{ org_id: ORG, sign_in: 'password', status, rehearsal: false }] : [{ org_id: installed ? ORG : null }] }) }, { connect: async () => client, query: async () => ({ rows: [] }) },
    route => { for (const method of [route.method].flat()) if (method !== 'HEAD') routes.push(`${method} ${route.url}`); });
  return { app, sql, routes };
}
const committed = readFileSync(FILE, 'utf8'), production = document(), plain = synthetic();
await plain.app.ready();
const closed = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const UUID = { type: 'string', pattern: '^[0-9a-f-]{36}$' };
const fixture = { operationId: 'fixtureTaskNote', method: 'POST', path: '/api/v1/tasks/{taskId}/notes', scope: 'tasks.write', summary: 'Fixture',
  params: closed({ taskId: UUID }, ['taskId']), query: closed({ dry: { type: 'string', enum: ['1'] } }), body: closed({ text: { type: 'string', maxLength: 20 } }, ['text']),
  authorize: async () => {}, response: closed({ ok: { type: 'boolean' } }, ['ok']), handler: async (_ctx, { body }) => body.text === 'leak' ? { ok: true, note: 'x' } : { ok: true } };

test('openapi/v1.yaml is the registry\'s document, and every /api/v1/<area> route is a registry operation', () => {
  const ids = Object.values(v1OpenApi().paths).flatMap(item => Object.values(item).map(op => op.operationId));
  assert.ok(ids.every(id => typeof id === 'string' && id.length)); assert.equal(new Set(ids).size, ids.length);
  assert.equal(committed, production, 'openapi/v1.yaml drifted from the v1 registry: regenerate it (see its header)');
  assert.deepEqual(plain.routes.filter(r => isV1Path(r.split(' ')[1])).sort(),
    v1Operations().map(op => `${op.method} ${op.path.replace(/\{(\w+)\}/g, ':$1')}`).sort());
});

test('EST-2290: the reference is self-contained; the service paths are inlined from service.yaml with their service-key scope', () => {
  const spec = JSON.parse(committed.replace(/^#.*\n/gm, '')), service = load(readFileSync(new URL('../openapi/service.yaml', import.meta.url), 'utf8'));
  // Every reference resolves inside the served document; none points at a document the API does not serve.
  const refs = [], walk = v => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k === '$ref') refs.push(x); else walk(x); };
  walk(spec);
  for (const ref of refs) assert.ok(ref.startsWith('#/components/') && ref.slice(2).split('/').reduce((at, key) => at?.[key], spec), ref);
  const legacy = Object.keys(spec.paths).filter(path => /^\/api\/v1\/(service|catalog)\//.test(path)).sort();
  // Exactly the eight existing paths: never the operator, updates or update-requests paths service.yaml also describes.
  assert.deepEqual(legacy, ['/api/v1/catalog/items', '/api/v1/service/chats/{chatId}/messages', '/api/v1/service/clients', '/api/v1/service/leads',
    '/api/v1/service/people', '/api/v1/service/quotes', '/api/v1/service/quotes/{id}/ready-notice', '/api/v1/service/tasks/mine']);
  for (const path of legacy) {
    assert.deepEqual(Object.keys(spec.paths[path]), Object.keys(service.paths[path]));
    for (const [method, op] of Object.entries(spec.paths[path])) {
      const source = service.paths[path][method], [scope] = op.security[0].serviceKey;
      assert.ok(!JSON.stringify(op).includes('$ref'), `${path} is not fully inlined`);
      assert.deepEqual([op.summary, op.description, Object.keys(op.responses)], [source.summary, source.description, Object.keys(source.responses)]);
      assert.deepEqual(op.security, [{ serviceKey: [scope] }]);
      assert.ok(source.summary.startsWith(`Scope ${scope}:`) && service.components.schemas.Scope.enum.includes(scope), `${path} scope ${scope}`);
    }
  }
  // What a client needs to call them: query and header parameters, request and response bodies, the legacy error shape.
  const clients = spec.paths['/api/v1/service/clients'].get, quotes = spec.paths['/api/v1/service/quotes'].post;
  assert.deepEqual(clients.parameters.map(p => `${p.in}:${p.name}`), ['query:cursor', 'query:limit', 'query:phone']);
  assert.deepEqual(spec.paths['/api/v1/service/tasks/mine'].get.parameters.map(p => `${p.in}:${p.name}`), ['header:Pulse-Person-Token']);
  const client = clients.responses['200'].content['application/json'].schema.properties.items.items;
  assert.deepEqual([client.required, client.properties.salesperson.oneOf[0]], [service.components.schemas.Client.required, service.components.schemas.Salesperson]);
  assert.deepEqual(quotes.requestBody.content['application/json'].schema, service.components.schemas.QuoteDraftRequest);
  assert.deepEqual(quotes.responses['201'].content['application/json'].schema.properties.lines.items, service.components.schemas.QuoteLine);
  assert.deepEqual(clients.responses['401'].content['application/json'].schema, service.components.schemas.Error);
  assert.deepEqual(spec.components.securitySchemes.serviceKey, service.components.securitySchemes.serviceKey);
  // The runtime image ships what the API reads beside dist/ at startup (a missing file stops the API with ENOENT).
  const image = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8').split('FROM python')[1];
  for (const file of ['openapi/service.yaml', 'data']) assert.match(image, new RegExp(`^COPY services/api/${file} services/api/${file}$`, 'm'), file);
});

test('a new operation changes the document (so CI fails until it is regenerated); malformed ones are refused', () => {
  for (const bad of [{ authorize: undefined }, { scope: 'chats.post' }, { path: '/api/v1/service/{taskId}/notes' }, { params: closed({}) },
    { body: { type: 'object', additionalProperties: false, properties: { tags: { type: 'object', properties: {} } } } }, { operationId: 'Bad-id' }]) {
    assert.throws(() => defineV1Operation({ ...fixture, ...bad }), /malformed/);
  }
  defineV1Operation(fixture);
  assert.throws(() => defineV1Operation(fixture), /duplicated/);
  assert.notEqual(document(), production);
  const op = v1OpenApi().paths['/api/v1/tasks/{taskId}/notes'].post;
  assert.deepEqual([op.operationId, op.security, op.requestBody.content['application/json'].schema], ['fixtureTaskNote', [{ bearer: ['tasks.write'] }], fixture.body]);
});

test('the front door: one bearer key alone, 401 before anything else, then scope, then closed input and output', async () => {
  const send = async (options, status, world = synthetic()) => {
    const r = await world.app.inject({ method: 'POST', url: '/api/v1/tasks/00000000-0000-4000-8000-000000000001/notes', payload: { text: 'hi' }, ...options, headers: { 'idempotency-key': ORG, ...options.headers } });
    assert.equal(r.statusCode, status, r.body);
    assert.match(r.headers['cache-control'], /no-store/); assert.match(r.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    if (status >= 400) {
      assert.match(r.headers['content-type'], /^application\/problem\+json/);
      assert.deepEqual(Object.keys(r.json()).sort(), ['detail', 'requestId', 'status', 'title', 'type']);
      assert.equal(r.json().requestId, r.headers['x-request-id']);
    }
    return { body: r.json(), sql: world.sql };
  };
  for (const headers of [{}, { authorization: 'Bearer ' + 'x'.repeat(43) }, { authorization: `Bearer ${APP}`, cookie: 'pulse_session=s' },
    { authorization: `Bearer ${AI}`, 'cf-access-authenticated-user-email': 'synthetic@example.test' }, { 'x-pulse-agent-key': AI }]) {
    const { sql } = await send({ headers: { ...headers, 'content-type': 'application/json' }, payload: '{not json' }, 401);
    assert.deepEqual(sql, []);
  }
  for (const key of [APP, AI]) {
    const authorization = `Bearer ${key}`;
    assert.deepEqual((await send({ headers: { authorization } }, 200)).body, { ok: true });
    const encoded = '/api/v1/%74asks/00000000-0000-4000-8000-000000000001/notes';
    const { sql } = await send({ headers: { authorization, cookie: 'pulse_session=s' }, url: encoded }, 401);
    assert.deepEqual(sql, []);
    assert.deepEqual((await send({ headers: { authorization }, url: encoded }, 200)).body, { ok: true });
    await send({ headers: { authorization }, payload: { text: 'hi', org: ORG } }, 400);
    await send({ headers: { authorization }, url: '/api/v1/tasks/00000000-0000-4000-8000-000000000001/notes?org=x' }, 400);
    await send({ headers: { authorization, 'content-type': 'application/json' }, payload: '{not json' }, 400);
    assert.equal((await send({ headers: { authorization }, payload: { text: 'leak' } }, 500)).body.detail, 'Pulse data is temporarily unavailable');
    await send({ headers: { authorization }, url: '/api/v1/tasks' }, 400); // Registered create rejects this fixture's unknown text field.
    await send({ headers: { authorization } }, 403, synthetic({ principal: false }));
    await send({ headers: { authorization } }, 401, synthetic({ principal: false, live: false }));
  }
  assert.equal((await synthetic().app.inject({ url: '/api/v1/openapi.json' })).json().openapi, '3.1.0');
});

test('every failed-auth path uses the separate 120/min budget; valid keys remain usable', async () => {
  const junkApp = APP.slice(0, -43) + 'c'.repeat(43), junkAi = AI.slice(0, -64) + 'c'.repeat(64);
  for (const headers of [{}, { authorization: 'Bearer junk' }, { authorization: `Bearer ${APP}`, cookie: 'pulse_session=s' },
    { authorization: `Bearer ${junkApp}` }, { authorization: `Bearer ${junkAi}` }]) {
    const { app } = synthetic();
    try {
      const options = { method: 'POST', url: '/api/v1/tasks/00000000-0000-4000-8000-000000000001/notes', payload: { text: 'hi' } };
      for (let i = 1; i <= 121; i++) {
        const r = await app.inject({ ...options, headers });
        assert.equal(r.statusCode, i === 121 ? 429 : 401);
        assert.match(r.headers['content-type'], /^application\/problem\+json/);
        assert.equal(r.json().requestId, r.headers['x-request-id']);
        assert.match(r.headers['cache-control'], /no-store/);
        if (i === 121) { assert.ok(Number(r.headers['retry-after']) >= 1 && Number(r.headers['retry-after']) <= 60); assert.equal(r.json().status, 429); }
        // Valid calls interleaved with junk must neither spend nor depend on the failed-auth budget.
        if (i % 3 === 0 || i === 121) for (const key of [APP, AI]) assert.equal((await app.inject({ ...options, headers: { authorization: `Bearer ${key}`, 'idempotency-key': ORG } })).statusCode, 200);
      }
    } finally { await app.close(); }
  }
});

test('a before seam can set limit headers and refuse with a problem', async () => {
  attachV1Seam({ before: async (_ctx, _op, input, _request, reply) => {
    if (input.query.dry === '1') { reply.header('ratelimit-limit', '1').header('retry-after', '12'); v1Fail(429, 'Token rate limit'); }
  } });
  const { app } = synthetic();
  try {
    const r = await app.inject({ method: 'POST', url: '/api/v1/tasks/00000000-0000-4000-8000-000000000001/notes?dry=1',
      payload: { text: 'hi' }, headers: { authorization: `Bearer ${AI}`, 'idempotency-key': ORG } });
    assert.equal(r.statusCode, 429); assert.equal(r.headers['ratelimit-limit'], '1'); assert.equal(r.headers['retry-after'], '12');
    assert.match(r.headers['content-type'], /^application\/problem\+json/);
  } finally { await app.close(); }
});

test('an operation without a front-door call entry refuses with 404 before opening a transaction', async () => {
  const app = Fastify();
  registerV1(app, { open: async () => assert.fail('No transaction without the front door') });
  try {
    const r = await app.inject({ method: 'POST', url: '/api/v1/tasks/00000000-0000-4000-8000-000000000001/notes', payload: { text: 'hi' } });
    assert.equal(r.statusCode, 404); assert.equal(r.json().requestId, r.headers['x-request-id']);
    assert.match(r.headers['content-type'], /^application\/problem\+json/);
  } finally { await app.close(); }
});

test('replays run later limits and all after hooks; replay and transformed answers stay closed', async () => {
  const trace = [], modes = ['fresh', 'replay', 'limited', 'replay-extra', 'after-extra', 'replay-after-extra'];
  const operationId = 'fixtureReplay';
  defineV1Operation({ ...fixture, operationId, path: '/api/v1/tasks/{taskId}/replay', query: undefined,
    body: closed({ mode: { type: 'string', enum: modes } }, ['mode']),
    handler: async () => { trace.push('handler'); return { ok: true }; } });
  attachV1Seam({ before: async (_ctx, op, { body }) => {
    if (op.operationId !== operationId) return;
    trace.push('idempotency');
    if (!['fresh', 'after-extra'].includes(body.mode)) return body.mode === 'replay-extra' ? { ok: true, extra: true } : { ok: true };
  }, after: async (_ctx, op, _input, answer) => { if (op.operationId === operationId) trace.push('audit'); return answer; } });
  attachV1Seam({ before: async (_ctx, op, { body }, _request, reply) => {
    if (op.operationId !== operationId) return;
    trace.push('limits');
    if (body.mode === 'limited') { reply.header('retry-after', '9'); v1Fail(429, 'Token rate limit'); }
  }, after: async (_ctx, op, { body }, answer) => {
    if (op.operationId !== operationId) return answer;
    trace.push('shape');
    return body.mode.includes('after-extra') ? { ...answer, extra: true } : answer;
  } });
  const { app } = synthetic();
  try {
    for (const mode of modes) {
      trace.length = 0;
      const r = await app.inject({ method: 'POST', url: '/api/v1/tasks/00000000-0000-4000-8000-000000000001/replay',
        headers: { authorization: `Bearer ${AI}`, 'idempotency-key': ORG }, payload: { mode } });
      assert.equal(r.statusCode, mode === 'limited' ? 429 : mode.includes('extra') ? 500 : 200);
      const expected = ['idempotency', 'limits'];
      if (['fresh', 'after-extra'].includes(mode)) expected.push('handler');
      if (!['limited', 'replay-extra'].includes(mode)) expected.push('audit', 'shape');
      assert.deepEqual(trace, expected, mode);
      if (r.statusCode === 200) assert.deepEqual(r.json(), { ok: true });
      else { assert.match(r.headers['content-type'], /^application\/problem\+json/); assert.equal(r.json().extra, undefined); }
      if (mode === 'limited') assert.equal(r.headers['retry-after'], '9');
    }
  } finally { await app.close(); }
});

test('v1 install/setup/inactive-company refusals are Problems; legacy refusal bodies stay unchanged', async () => {
  for (const [options, code, detail] of [[{ installed: false }, 503, 'not_initialised'],
    [{ status: 'setup' }, 503, 'This company is being set up in Pulse. Its admin will tell you when to sign in.'],
    [{ status: 'inactive' }, 403, "This company's Pulse is not available."]]) {
    const { app, sql } = synthetic(options);
    try {
      const headers = { authorization: `Bearer ${AI}`, 'x-pulse-host': 'v1.example.test' };
      for (const prefix of ['/api/v1/tasks', '/api/v1/%74asks', '/a%70i/v1/tasks', '/api/%761/tasks']) {
        const r = await app.inject({ method: 'POST', url: `${prefix}/00000000-0000-4000-8000-000000000001/notes`, headers, payload: { text: 'hi' } });
        assert.equal(r.statusCode, code);
        assert.match(r.headers['content-type'], /^application\/problem\+json/);
        assert.deepEqual(Object.keys(r.json()).sort(), ['detail', 'requestId', 'status', 'title', 'type']);
        assert.equal(r.json().requestId, r.headers['x-request-id']); assert.match(r.headers['x-request-id'], /^[0-9a-f-]{36}$/);
        assert.equal(r.json().detail, detail); assert.equal(r.json().status, code); assert.match(r.headers['cache-control'], /no-store/);
      }
      const legacy = await app.inject({ url: '/api/v0/me', headers: { 'x-pulse-host': 'v1.example.test' } });
      assert.equal(legacy.statusCode, code); assert.deepEqual(legacy.json(), { error: detail });
      assert.deepEqual(sql, []);
    } finally { await app.close(); }
  }
});
