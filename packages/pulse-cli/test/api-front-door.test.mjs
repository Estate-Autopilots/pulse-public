// The pulse command against the real API v1 front door (services/api/dist: auth, scopes, problem+json, rate limits,
// idempotent replay) with a synthetic database seam, as services/api's own v1 tests do. Skipped until the API is built
// (CI builds it before the test step).
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const api = new URL('../../../services/api/', import.meta.url);
const built = existsSync(new URL('dist/v1.js', api));
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const GOOD = 'pat_' + 'A'.repeat(43), NO_SCOPE = 'pat_' + 'B'.repeat(43), UNKNOWN = 'pat_' + 'C'.repeat(43);
const sha = s => createHash('sha256').update(s).digest('hex');
const PERSON = '00000000-0000-4000-8000-000000000001';

test('CLI exit codes and output match the API front door: 200, 401, 403, replay, 429', { skip: !built && 'services/api/dist is not built' }, async () => {
  const Fastify = (await import(pathToFileURL(createRequire(new URL('package.json', api)).resolve('fastify')).href)).default;
  const { defineV1Operation, registerV1, v1Scope } = await import(new URL('dist/v1.js', api).href);
  const { serviceScope } = await import(new URL('dist/service-key.js', api).href);
  let writes = 0;
  const closed = properties => ({ type: 'object', additionalProperties: false, properties });
  defineV1Operation({ operationId: 'cliFixtureRead', method: 'GET', path: '/api/v1/people/cli-fixture', scope: 'people.read', summary: 'Synthetic CLI read',
    response: closed({ kind: { type: 'string' }, id: { type: 'string' } }), handler: async c => ({ kind: c.principal.kind, id: c.principal.id }) });
  defineV1Operation({ operationId: 'cliFixtureWrite', method: 'POST', path: '/api/v1/people/cli-fixture', scope: 'people.write', summary: 'Synthetic CLI write',
    body: closed({ text: { type: 'string' } }), response: closed({ n: { type: 'number' } }), authorize: async () => {}, handler: async () => ({ n: ++writes }) });
  const receipts = new Map(), app = Fastify();
  v1Scope(app); serviceScope(app); // the failed-sign-in budget lives on the service scope
  registerV1(app, { open: async work => {
    let viewer = null;
    const client = { query: async (sql, args = []) => {
      let v = null;
      if (sql.includes('v1_person_principal')) { if (args[0] === sha(GOOD)) { v = 'token-1'; viewer = PERSON; } }
      else if (sql.includes('v1_person_token_live')) v = args[0] === sha(NO_SCOPE);
      else if (sql.includes('current_viewer()')) return { rows: [{ id: viewer, actor: viewer && 'person:synthetic' }] };
      else if (sql.includes('v1_replay')) { const slot = args.slice(0, 3).join(':'); if (args[4]) receipts.set(slot, args[4]); v = receipts.get(slot) ?? null; }
      return { rows: [{ v }] };
    } };
    return work(client, '00000000-0000-4000-8000-0000000000aa');
  } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const host = `http://127.0.0.1:${app.server.address().port}`, dir = mkdtempSync(join(tmpdir(), 'pulse-cli-api-'));
  const run = async (token, ...args) => {
    try { return { ...await exec(process.execPath, [CLI, ...args], { env: { ...process.env, PULSE_HOST: host, PULSE_TOKEN: token, PULSE_CONFIG_DIR: dir } }), code: 0 }; }
    catch (e) { return e; }
  };
  try {
    for (const [token, status, exit] of [[GOOD, 200, 0], [NO_SCOPE, 403, 3], [UNKNOWN, 401, 2]]) {
      const direct = await fetch(`${host}/api/v1/people/cli-fixture`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(direct.status, status);
      const r = await run(token, 'api', 'GET', '/api/v1/people/cli-fixture');
      assert.equal(r.code, exit, r.stderr);
      assert.ok(!(r.stdout + r.stderr).includes(token), 'no token in output');
      if (status === 200) assert.deepEqual(JSON.parse(r.stdout), await direct.json());
      else assert.match(r.stderr, /\(request [0-9a-f-]{36}\)/);
    }
    // The same Idempotency-Key and body replays the first answer: one write.
    for (let i = 0; i < 2; i++) {
      const r = await run(GOOD, 'api', 'POST', '/api/v1/people/cli-fixture', '--data', '{"text":"x"}', '--idempotency-key', '00000000-0000-4000-8000-000000000009');
      assert.equal(r.code, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), { n: 1 });
    }
    assert.equal(writes, 1);
    const fresh = await run(GOOD, 'api', 'POST', '/api/v1/people/cli-fixture', '--data', '{"text":"x"}');
    assert.deepEqual(JSON.parse(fresh.stdout), { n: 2 });
    const unknownField = await run(GOOD, 'api', 'POST', '/api/v1/people/cli-fixture', '--data', '{"nope":1}');
    assert.equal(unknownField.code, 4);
    for (let i = 0; i < 125; i++) await app.inject({ url: '/api/v1/people/cli-fixture', headers: { authorization: `Bearer ${GOOD}` } });
    const limited = await run(GOOD, 'api', 'GET', '/api/v1/people/cli-fixture');
    assert.equal(limited.code, 5, limited.stderr); assert.match(limited.stderr, /Too many requests/);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
