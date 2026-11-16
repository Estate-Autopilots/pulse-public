import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { budget, tokenBudgets } from '../dist/v1-limits.js';
import { PAGE_QUERY, pageResponse, pageV1 } from '../dist/v1-paging.js';
import { defineV1Operation, registerV1, v1Scope } from '../dist/v1.js';
import { serviceScope } from '../dist/service-key.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = n => `pak_${String(n).repeat(8)}_${'a'.repeat(64)}`;
const input = { params: {}, query: { limit: '1', status: 'open' }, body: undefined };
const ctx = { tenantId: id(1), principal: { tokenId: id(2), id: id(3) } };
const closed = properties => ({ type: 'object', additionalProperties: false, properties });

test('independent bounded windows reset exactly at the boundary; live tokens cannot be evicted', () => {
  let now = 0; const spend = tokenBudgets(() => now, 2), failed = budget(120, () => now);
  for (let i = 0; i < 120; i++) assert.equal(spend('org', 'one').limited, false);
  assert.equal(spend('org', 'one').limited, true);
  assert.equal(spend('org', 'two').remaining, 119);
  assert.equal(spend('org', 'three').limited, true);
  for (let i = 0; i < 500; i++) failed();
  assert.equal(spend('org', 'two').remaining, 118);
  now = 59_999; assert.equal(spend('org', 'one').reset, 1);
  now = 60_000; assert.equal(spend('org', 'one').remaining, 119);
  assert.equal(spend('org', 'three').remaining, 119); assert.equal(failed(), false);
});

test('encrypted keysets bind tenant, token, viewer, operation, path and filters; limits are canonical', async () => {
  const rows = [1, 2, 3].map(n => ({ id: id(n) })), fetch = async (after, take) => rows.filter(r => r.id > (after ?? '')).slice(0, take);
  const first = await pageV1(ctx, 'fixtureList', input, fetch); assert.deepEqual(first.items, [rows[0]]);
  const next = { ...input, query: { ...input.query, cursor: first.nextCursor } };
  assert.deepEqual((await pageV1(ctx, 'fixtureList', next, fetch)).items, [rows[1]]);
  for (const [c, op, i] of [[{ ...ctx, tenantId: id(9) }, 'fixtureList', next],
    [{ ...ctx, principal: { ...ctx.principal, tokenId: id(9) } }, 'fixtureList', next],
    [{ ...ctx, principal: { ...ctx.principal, id: id(9) } }, 'fixtureList', next], [ctx, 'otherList', next],
    [ctx, 'fixtureList', { ...next, params: { parent: id(9) } }], [ctx, 'fixtureList', { ...next, query: { ...next.query, status: 'closed' } }]]) {
    await assert.rejects(pageV1(c, op, i, () => assert.fail('cursor refusal must precede fetch')), { status: 400 });
  }
  for (const cursor of ['', 'bad', first.nextCursor.slice(0, -2) + 'AA'])
    await assert.rejects(pageV1(ctx, 'fixtureList', { ...next, query: { ...next.query, cursor } }, fetch), { status: 400 });
  for (const limit of ['0', '101', '01', '1.5', '-1', 'Infinity'])
    await assert.rejects(pageV1(ctx, 'fixtureList', { ...input, query: { limit } }, fetch), { status: 400 });
  assert.equal((await pageV1(ctx, 'fixtureList', { ...next, query: { ...next.query, limit: '100' } }, fetch)).nextCursor, null);
  await assert.rejects(pageV1(ctx, 'fixtureList', input, async () => [rows[1], rows[0]]), { status: 500 });
});

test('front door: paging, closed query, two tokens, auth flood, validation/replay/429 audit exactly once', async () => {
  const audit = [], responses = []; let token = 1;
  const client = { query: async (sql, args) => {
    if (sql.includes('v1_agent_principal')) { token = Number(args[0].slice(4, 5)); return { rows: [{ v: id(token) }] }; }
    if (sql.includes('v1_agent_token_id')) return { rows: [{ v: id(token) }] };
    if (sql.includes('current_viewer()')) return { rows: [{ id: id(token), actor: 'synthetic' }] };
    if (sql.includes('v1_replay')) return { rows: [{ v: null }] };
    return { rows: [] };
  } };
  const data = [1, 2, 3, 4].map(n => ({ id: id(n), owner: id(n === 2 ? 2 : 1) }));
  defineV1Operation({ operationId: 'fixtureList', method: 'GET', path: '/api/v1/tasks/paging', scope: 'tasks.read', summary: 'Synthetic list',
    query: closed(PAGE_QUERY), response: pageResponse(closed({ id: { type: 'string' }, owner: { type: 'string' } })),
    handler: (c, i) => pageV1(c, 'fixtureList', i, async (after, take) => data.filter(r => r.owner === c.principal.id && r.id > (after ?? '')).slice(0, take)) });
  defineV1Operation({ operationId: 'fixtureWriteLimit', method: 'POST', path: '/api/v1/tasks/writeLimit', scope: 'tasks.write', summary: 'Synthetic write',
    response: closed({}), authorize: async () => {}, handler: async () => ({}) });
  const app = Fastify(); v1Scope(app, { query: async (_sql, args) => { audit.push(args); } }); serviceScope(app);
  registerV1(app, { open: work => work(client, id(9)) });
  const call = async (suffix = '', n = 1, extra = {}) => {
    const r = await app.inject({ url: '/api/v1/tasks/paging' + suffix, headers: { authorization: `Bearer ${key(n)}` }, ...extra });
    responses.push(r); return r;
  };
  try {
    const a = await call('?limit=1'), b = await call('?limit=2&cursor=' + a.json().nextCursor);
    assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200);
    assert.deepEqual([...a.json().items, ...b.json().items].map(r => r.id), [id(1), id(3), id(4)]); assert.equal(b.json().nextCursor, null);
    for (const suffix of ['?cursor=bad', '?limit=101', '?unknown=x', '?limit=1&limit=2']) assert.equal((await call(suffix)).statusCode, 400);
    assert.equal((await call('?cursor=' + a.json().nextCursor, 2)).statusCode, 400);
    assert.equal((await call('', 1, { method: 'POST', url: '/api/v1/tasks/writeLimit' })).statusCode, 400);
    for (let i = 0; i < 121; i++) assert.equal((await call('', 1, { headers: {} })).statusCode, i === 120 ? 429 : 401);
    for (let i = 0; i < 121; i++) {
      const r = await call(); if (r.statusCode === 429) break;
    }
    const limited = await call(); assert.equal(limited.statusCode, 429); assert.ok(Number(limited.headers['retry-after']) >= 1);
    assert.equal((await call('', 2)).statusCode, 200);
    assert.equal(audit.length, responses.length); assert.equal(new Set(audit.map(a => a[0])).size, responses.length);
    for (const r of responses) {
      for (const h of ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']) assert.match(String(r.headers[h]), /^\d+$/);
      if (r.statusCode >= 400) { assert.equal(r.json().requestId, r.headers['x-request-id']); assert.match(r.headers['content-type'], /problem\+json/); }
    }
    assert.equal(audit.filter(a => a[7] === 429).length, responses.filter(r => r.statusCode === 429).length);
  } finally { await app.close(); }
});
