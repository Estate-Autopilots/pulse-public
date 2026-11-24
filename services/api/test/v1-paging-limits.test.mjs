import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { budget, tokenBudgets } from '../dist/v1-limits.js';
import { PAGE_QUERY, pageResponse, pageV1 } from '../dist/v1-paging.js';
import { answerChars, cursorFirst, defineV1Operation, registerV1, v1Scope } from '../dist/v1.js';
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

// PM-BUILD-4 (EA #35, Project Coordinator): over MCP an AI employee's runtime shows 3000 characters of a tool answer. A
// 20-task triage page is ~6,600, so the AI saw ~9 tasks while nextCursor went past all 20 (tasks 10-20 of every page lost).
test('with an answer budget a page holds only whole items that fit and nextCursor resumes at the first item not sent', async () => {
  const tasks = Array.from({ length: 45 }, (_, i) => ({ id: id(i + 1), title: `Task ${i + 1} ${'words '.repeat(30)}`.trim(),
    project: 'Gikolov Properties', assignee: null, due: null, status: 'todo' }));
  const fetch = async (after, take) => tasks.filter(t => t.id > (after ?? '')).slice(0, take);
  const page = { params: {}, query: { limit: '20' }, body: undefined };
  // Without a budget (HTTP, or an MCP client that sends none) nothing changes: 20 a page.
  const whole = await pageV1(ctx, 'listTriageTasks', page, fetch);
  assert.equal(whole.items.length, 20); assert.ok(JSON.stringify(cursorFirst(whole)).length > 6000);
  // With the runtime's 3000: each answer fits whole, and walking the cursors sees every task exactly once, in order.
  const seen = []; let cursor, pages = 0;
  do {
    const got = await pageV1({ ...ctx, answerChars: 3000 }, 'listTriageTasks', { ...page, query: { ...page.query, ...(cursor ? { cursor } : {}) } }, fetch);
    const text = JSON.stringify(cursorFirst(got));
    assert.ok(text.length <= 3000, `page ${pages + 1} is ${text.length} characters`);
    assert.ok(got.items.length >= 1 && got.items.length < 20);
    seen.push(...got.items.map(t => t.id)); cursor = got.nextCursor; pages++;
  } while (cursor && pages < 20);
  assert.deepEqual(seen, tasks.map(t => t.id));
  // One item larger than the budget is still sent (the runtime cuts it), so the walk never stalls.
  const big = [{ id: id(1), title: 'x'.repeat(5000) }, { id: id(2), title: 'y' }];
  const one = await pageV1({ ...ctx, answerChars: 3000 }, 'bigList', page, async (after, take) => big.filter(t => t.id > (after ?? '')).slice(0, take));
  assert.equal(one.items.length, 1); assert.ok(one.nextCursor);
});

test('the MCP answer budget header is read only as a whole number from 500 to 1,000,000', () => {
  assert.equal(answerChars('3000'), 3000); assert.equal(answerChars(['12000', '1']), 12000);
  for (const bad of [undefined, '', 'abc', '2999.5', '-3000', '499', '1000001', 'Infinity']) assert.equal(answerChars(bad), undefined);
});

// PM-BUILD-4 (EA #36, 23 Nov 2026): the Coordinator's saved cursor gave 400 after a release restarted the API.
test('cursors survive a restart: the key comes from the database (2532), and a cursor it cannot open says to start again', async () => {
  const { resetCursorKeyForTest } = await import('../dist/v1-paging.js');
  const dbKey = Buffer.alloc(32, 7), calls = [];
  const client = (key, fail = false) => ({ query: async sql => { calls.push(sql);
    if (/v1_cursor_key\(\)/.test(sql)) { if (fail) throw new Error('function pulse.v1_cursor_key() does not exist'); return { rows: [{ k: key }] }; }
    return { rows: [] }; } });
  const rows = [1, 2, 3].map(n => ({ id: id(n) })), fetch = async (after, take) => rows.filter(r => r.id > (after ?? '')).slice(0, take);
  const withDb = { ...ctx, client: client(dbKey) };
  resetCursorKeyForTest();
  const first = await pageV1(withDb, 'fixtureList', input, fetch);
  resetCursorKeyForTest(); // a new process: nothing in memory, same database
  const next = { ...input, query: { ...input.query, cursor: first.nextCursor } };
  assert.deepEqual((await pageV1({ ...ctx, client: client(dbKey) }, 'fixtureList', next, fetch)).items, [rows[1]]);
  // the key is read once per process, inside a savepoint (a failed read never breaks the caller's transaction)
  assert.equal(calls.filter(s => /v1_cursor_key\(\)/.test(s)).length, 2);
  assert.ok(calls.includes('savepoint v1_cursor_key'));
  // a cursor sealed with another key (made before this change) or for other filters: 400 that says how to go on
  resetCursorKeyForTest();
  for (const c of [{ ...ctx, client: client(Buffer.alloc(32, 9)) }, withDb]) {
    const query = c === withDb ? { ...next.query, status: 'closed' } : next.query;
    resetCursorKeyForTest();
    await assert.rejects(pageV1(c, 'fixtureList', { ...next, query }, () => assert.fail('refused before fetch')),
      e => e.status === 400 && /Ask again without a cursor/.test(String(e.detail ?? e.message)));
  }
  // a database without the key (not migrated yet) still pages with the process key, and asks again on a later page
  resetCursorKeyForTest(); calls.length = 0;
  const old = { ...ctx, client: client(null, true) };
  const p1 = await pageV1(old, 'fixtureList', input, fetch);
  assert.deepEqual((await pageV1(old, 'fixtureList', { ...input, query: { ...input.query, cursor: p1.nextCursor } }, fetch)).items, [rows[1]]);
  assert.ok(calls.includes('rollback to savepoint v1_cursor_key'));
  assert.equal(calls.filter(s => /v1_cursor_key\(\)/.test(s)).length, 2);
  resetCursorKeyForTest();
});
