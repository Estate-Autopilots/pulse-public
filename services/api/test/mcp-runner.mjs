// Real transaction/RLS parity with synthetic tenants and v1-work-runner's test-only person resolver.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from 'node:http';
import { v1BearerProxy } from '../../../apps/web/app/api/proxy.mjs';
import { attachV1Seam } from '../dist/v1.js';

export async function verifyMcp(app, w, foreign, person, owner) {
  const receipts = [], waiting = new Map();
  attachV1Seam({ settled: call => { receipts.push(call); waiting.get(call.requestId)?.(call); waiting.delete(call.requestId); } });
  const receiptFor = id => receipts.find(call => call.requestId === id) ?? new Promise(resolve => waiting.set(id, resolve));
  const headers = key => ({ authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' });
  const rpc = async (method, params = {}, key = w.keys.app, extra = {}) => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/mcp', headers: { ...headers(key), ...extra }, payload: { jsonrpc: '2.0', id: 1, method, params } });
    const receipt = await receiptFor(r.headers['x-request-id']);
    assert.equal(receipts.filter(call => call.requestId === receipt.requestId).length, 1, 'one audit seam per transport/tool attempt');
    assert.match(r.headers['cache-control'], /no-store/); assert.ok(r.headers['x-request-id']);
    if (r.statusCode !== 200) return { r, value: r.json() };
    assert.match(r.headers['content-type'], /^text\/event-stream/);
    const value = r.body.split('\n').filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5))).find(v => v.id === 1);
    assert.ok(value, r.body); return { r, value: value.result ?? value, receipt };
  };
  const tool = (name, args, key) => rpc('tools/call', { name, arguments: args }, key);
  for (const key of [w.keys.ai, w.keys.app]) {
    const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } }, key);
    assert.equal(init.value.protocolVersion, '2025-11-25'); assert.equal(init.r.headers['mcp-session-id'], undefined);
    const listed = await rpc('tools/list', {}, key);
    assert.deepEqual(listed.value.tools.map(t => t.name).sort(), ['getProject', 'getTask', 'listProjects', 'listTasks']);
    assert.equal(Number(listed.r.headers['ratelimit-remaining']), Number(init.r.headers['ratelimit-remaining']) - 1, 'discovery spends one budget across all scopes');
    for (const [name, path, args] of [['listTasks', 'tasks', {}], ['listProjects', 'projects', {}],
      ['getTask', 'tasks/' + w.tasks[0], { params: { taskId: w.tasks[0] } }]]) {
      const http = await app.inject({ url: '/api/v1/' + path, headers: headers(key) });
      const mcp = await tool(name, args, key);
      assert.equal(mcp.value.isError, undefined); assert.deepEqual(mcp.value.structuredContent, http.json());
      assert.equal(mcp.receipt.operationId, name); assert.equal(mcp.receipt.principal.kind, key === w.keys.app ? 'app' : 'ai');
      assert.equal(mcp.value._meta.requestId, mcp.r.headers['x-request-id']);
      assert.equal(mcp.r.headers['ratelimit-remaining'], String(Number(http.headers['ratelimit-remaining']) - 1));
    }
    for (const taskId of [w.tasks[4], foreign.tasks[0]]) {
      const denied = await tool('getTask', { params: { taskId } }, key);
      assert.equal(denied.value._meta.httpStatus, 404); assert.equal(denied.receipt.status, 404);
    }
    assert.equal((await tool('createTask', { body: { title: 'Synthetic denied' }, idempotencyKey: randomUUID() }, key)).value._meta.httpStatus, 403);
    assert.equal((await tool('listTasks', { query: { unexpected: 'x' } }, key)).value._meta.httpStatus, 400);
  }
  // Revoked/foreign and ungranted credentials win over malformed operation inputs, even for hidden writes.
  const revoked = w.keys.ai.slice(0, -64) + '0'.repeat(64);
  for (const [token, status] of [[revoked, 401], [foreign.keys.ai, 401], [w.keys.ai, 403]]) {
    const http = await app.inject({ method: 'POST', url: '/api/v1/tasks', headers: headers(token), payload: { unexpected: true } });
    assert.equal(http.statusCode, status, http.body);
    for (const args of [{ body: { unexpected: true } }, { extra: true }, { idempotencyKey: 42 }, { idempotencyKey: 'bad' }]) {
      const denied = await tool('createTask', args, token);
      assert.equal(denied.value._meta.httpStatus, http.statusCode);
      assert.equal(denied.value.structuredContent.detail, http.json().detail);
    }
  }
  assert.equal((await tool('hiddenUnregisteredTool', {}, w.keys.app)).value._meta.httpStatus, 404);
  const batch = await app.inject({ method: 'POST', url: '/api/v1/mcp', headers: headers(person), payload: [1, 2].map(id =>
    ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'createTask', arguments: { body: { title: 'Batch must not save' }, idempotencyKey: randomUUID() } } })) });
  const batchReceipt = await receiptFor(batch.headers['x-request-id']);
  assert.equal(batch.statusCode, 400); assert.equal(receipts.filter(call => call.requestId === batchReceipt.requestId).length, 1);
  assert.equal(batchReceipt.operationId, 'mcpTransport'); assert.equal(batchReceipt.principal, null);
  assert.equal((await tool('listTasks', {}, person)).value.structuredContent.items.some(t => t.title === 'Batch must not save'), false);
  assert.equal((await rpc('tools/call', { arguments: {} })).value.error.code, -32602);
  assert.equal((await rpc('tools/call', { name: 'createTask', arguments: [] }, revoked)).r.statusCode, 401);
  const invalidNotification = await app.inject({ method: 'POST', url: '/api/v1/mcp', headers: headers(revoked),
    payload: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'listTasks', arguments: {} } } });
  assert.equal(invalidNotification.statusCode, 401);
  const notification = await app.inject({ method: 'POST', url: '/api/v1/mcp', headers: headers(w.keys.app), payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(notification.statusCode, 202); assert.equal(notification.body, '');
  assert.equal((await tool('getTask', { params: { taskId: w.tasks[0] } }, foreign.keys.ai)).value._meta.httpStatus, 401);
  assert.deepEqual((await rpc('tools/list', {}, w.keys.writeOnly)).value.tools, []);
  assert.equal((await tool('listTasks', {}, w.keys.writeOnly)).value._meta.httpStatus, 403);
  const key = randomUUID(), body = { title: 'Synthetic MCP replay', projectId: w.projects[0] };
  const http = await app.inject({ method: 'POST', url: '/api/v1/tasks', headers: { ...headers(person), 'idempotency-key': key }, payload: body });
  assert.equal(http.statusCode, 200, http.body);
  for (let i = 0; i < 2; i++) assert.deepEqual((await tool('createTask', { body, idempotencyKey: key }, person)).value.structuredContent, http.json());
  assert.equal((await tool('createTask', { body: { ...body, title: 'Changed' }, idempotencyKey: key }, person)).value._meta.httpStatus, 409);
  assert.equal((await rpc('tools/list', {}, w.keys.app, { 'mcp-protocol-version': 'unsupported' })).r.statusCode, 400);
  assert.equal((await rpc('tools/list', {}, w.keys.app, { 'mcp-session-id': 'stale' })).r.statusCode, 400);
  for (const extra of [{ cookie: 'pulse_session=synthetic' }, { 'x-pulse-session': 'synthetic' }, { 'cf-access-authenticated-user-email': 'synthetic@example.test' }])
    assert.equal((await rpc('tools/list', {}, w.keys.app, extra)).r.statusCode, 401);
  assert.equal((await rpc('tools/list', {}, w.keys.app, { origin: 'https://foreign.test' })).r.statusCode, 403);
  for (const method of ['GET', 'DELETE', 'PUT']) assert.equal((await app.inject({ method, url: '/api/v1/mcp', headers: headers(w.keys.app) })).statusCode, 405);
  // Run the maintained client through the actual bearer proxy over HTTP, including notifications and errors.
  const address = await app.listen({ host: '127.0.0.1', port: 0 }), client = new Client({ name: 'synthetic', version: '1' });
  const proxy = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const abort = new AbortController(); res.once('close', () => abort.abort());
      const r = await v1BearerProxy(new Request('http://' + req.headers.host + '/api/v1/mcp', { method: req.method, headers: req.headers,
        signal: abort.signal, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) }), { params: Promise.resolve({ path: ['mcp'] }) },
        (_url, options) => fetch(address + '/api/v1/mcp', options));
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
    } catch { res.destroy(); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const url = new URL('http://127.0.0.1:' + proxy.address().port + '/api/v1/mcp');
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: headers(w.keys.app) } }));
    assert.equal((await client.listTools()).tools.length, 4);
    assert.equal((await client.callTool({ name: 'getTask', arguments: { params: { taskId: w.tasks[0] } } })).structuredContent.id, w.tasks[0]);
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(url, { method, headers: headers(w.keys.app) }); assert.equal(r.status, 405); await r.text();
    }
    const unsupported = await fetch(url, { method: 'POST', headers: { ...headers(w.keys.app), 'content-type': 'application/json', 'mcp-protocol-version': 'unsupported' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) });
    assert.equal(unsupported.status, 400); await unsupported.text();
    const malformed = await fetch(url, { method: 'POST', headers: { ...headers(w.keys.app), 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: {} }) });
    assert.equal(malformed.status, 200); assert.match(await malformed.text(), /-32602/);
    // Hold a real write at the executor seam, disconnect before its reply, then release and replay the commit.
    const started = Promise.withResolvers(), gate = Promise.withResolvers(), disconnected = Promise.withResolvers(), settled = Promise.withResolvers();
    let attempts = 0;
    const disconnectKey = randomUUID(), disconnectedBody = { title: 'Synthetic disconnected MCP write', projectId: w.projects[0] };
    attachV1Seam({ before: async (_ctx, op, _input, req, reply) => {
      if (op.operationId === 'createTask' && req.headers['idempotency-key'] === disconnectKey) {
        reply.raw.once('close', disconnected.resolve); started.resolve(); await gate.promise;
      }
    }, settled: call => { if (call.idempotencyKey === disconnectKey && ++attempts === 2) settled.resolve(); } });
    const controller = new AbortController(), lost = fetch(url, { method: 'POST', signal: controller.signal,
      headers: { ...headers(person), 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call',
        params: { name: 'createTask', arguments: { body: disconnectedBody, idempotencyKey: disconnectKey } } }) }).catch(() => null);
    try { await started.promise; controller.abort(); await lost; await disconnected.promise; } finally { gate.resolve(); }
    const replay = await tool('createTask', { body: disconnectedBody, idempotencyKey: disconnectKey }, person);
    assert.equal(replay.value._meta.httpStatus, 200);
    await settled.promise; // Both persistence calls complete before checking; no polling or timing assumptions.
    const c = await owner.connect();
    try {
      await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [w.org]);
      const audited = await c.query('select request_id from pulse_priv.v1_call where idempotency_key=$1', [disconnectKey]);
      assert.equal(audited.rows.length, 2); assert.equal(new Set(audited.rows.map(r => r.request_id)).size, 2);
      await c.query('commit');
    } finally { await c.query('rollback'); c.release(); }
    assert.equal(receipts.filter(r => r.idempotencyKey === disconnectKey).length, 2);
  } finally { await client.close(); await new Promise(resolve => proxy.close(resolve)); }
  console.log('MCP: bearer-proxied SDK session, auth/input parity, no batch effects, one audit/budget, disconnect/replay and tenant isolation pass');
}
