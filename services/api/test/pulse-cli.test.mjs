import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import '../dist/app.js';
import { defineV1Operation, registerV1, v1Scope, v1OpenApi } from '../dist/v1.js';
import { serviceScope } from '../dist/service-key.js';
const exec = promisify(execFile), cli = new URL('../../../packages/pulse-cli/pulse.mjs', import.meta.url).pathname;
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const key = n => `psvc_${id(n)}_${String(n).repeat(43)}`;
const closed = properties => ({ type: 'object', additionalProperties: false, properties });
let writes = 0;
defineV1Operation({ operationId: 'cliFixtureRead', method: 'GET', path: '/api/v1/tasks/cli-read', scope: 'tasks.read', summary: 'Synthetic CLI read',
  response: closed({ company: { type: 'string' } }), handler: async c => ({ company: c.tenantId }) });
defineV1Operation({ operationId: 'cliFixtureWrite', method: 'POST', path: '/api/v1/tasks/cli-write', scope: 'tasks.write', summary: 'Synthetic CLI write',
  body: closed({ text: { type: 'string' } }), response: closed({ id: { type: 'number' } }), authorize: async () => {}, handler: async () => ({ id: ++writes }) });
// Synthetic database seam only: actual v1 auth, scopes, HTTP Problems, rate limits and replay hooks run unchanged.
async function company(n) {
  const receipts = new Map(), app = Fastify(); v1Scope(app); serviceScope(app);
  registerV1(app, { open: async work => {
    let token;
    const client = { query: async (sql, args = []) => {
      let v = null;
      if (sql.includes('v1_service_principal')) { token = args[0]; if (token === id(n)) v = token; }
      if (sql.includes('service_key_hash') && (args[0] === id(n) || args[0] === id(3))) v = createHash('sha256').update(String(args[0] === id(3) ? 3 : n).repeat(43)).digest('hex');
      if (sql.includes('current_viewer()')) return { rows: [{ id: token, actor: 'synthetic' }] };
      if (sql.includes('v1_replay')) { const slot = args.slice(0, 3).join(':'); if (args[4]) receipts.set(slot, args[4]); v = receipts.get(slot) ?? null; }
      return { rows: [{ v }] };
    } };
    return work(client, id(n));
  } });
  await app.listen({ host: '127.0.0.1', port: 0 }); return app;
}
test('CLI matches direct HTTP 200/401/403/429 across two companies; actual front-door replay creates once', async () => {
  const a = await company(1), b = await company(2), dir = await mkdtemp(join(tmpdir(), 'pulse-cli-api-'));
  const run = async (app, token, operation, ...args) => {
    try { return { ...await exec(process.execPath, [cli, operation, ...args], { env: { ...process.env, PULSE_URL: app.listeningOrigin, PULSE_API_KEY: token, XDG_CONFIG_HOME: dir } }), code: 0 }; }
    catch (e) { return e; }
  };
  try {
    const listed = JSON.parse((await run(a, key(1), 'ops')).stdout);
    const expected = Object.entries(v1OpenApi().paths).flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ method, path, operationId: op.operationId })));
    assert.deepEqual(listed.map(({ method, path, operationId }) => ({ method, path, operationId })), expected);
    for (const [app, token, status, exit] of [[a, key(1), 200, 0], [b, key(2), 200, 0], [b, key(1), 401, 2], [a, key(3), 403, 3], [a, 'invalid', 401, 2]]) {
      const r = await fetch(app.listeningOrigin + '/api/v1/tasks/cli-read', { headers: { Authorization: 'Bearer ' + token } });
      assert.equal(r.status, status); const c = await run(app, token, 'cliFixtureRead'); assert.equal(c.code, exit);
      assert.ok(!(c.stdout + c.stderr).includes(token));
      if (status === 200) assert.deepEqual(JSON.parse(c.stdout), await r.json()); else assert.match(c.stderr, new RegExp('HTTP ' + status));
    }
    await writeFile(join(dir, 'data.json'), '{"text":"synthetic"}');
    for (let i = 0; i < 2; i++) { const c = await run(a, key(1), 'cliFixtureWrite', '--data', '@' + join(dir, 'data.json'), '--idempotency-key', id(9)); assert.equal(c.code, 0); assert.deepEqual(JSON.parse(c.stdout), { id: 1 }); }
    assert.equal(writes, 1);
    for (let i = 0; i < 121; i++) await a.inject({ url: '/api/v1/tasks/cli-read' });
    assert.equal((await fetch(a.listeningOrigin + '/api/v1/tasks/cli-read')).status, 429);
    const limited = await run(a, 'invalid', 'cliFixtureRead'); assert.equal(limited.code, 5); assert.match(limited.stderr, /HTTP 429/);
  } finally { await a.close(); await b.close(); await rm(dir, { recursive: true, force: true }); }
});
