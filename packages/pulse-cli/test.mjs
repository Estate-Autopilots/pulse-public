import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile), cli = new URL('./pulse.mjs', import.meta.url).pathname;
const personToken = 'synthetic-person-token';
const key = 'psvc_00000000-0000-4000-8000-000000000001_' + 'a'.repeat(43);
const spec = { openapi: '3.1.0', paths: {
  '/api/v1/service/clients': { get: { parameters: [{ in: 'query', name: 'cursor' }], security: [{ serviceKey: ['clients.read'] }] } },
  '/api/v1/service/tasks/mine': { get: { parameters: [{ in: 'header', name: 'Pulse-Person-Token', required: true }] } },
  '/api/v1/tasks/{id}': { get: { operationId: 'readTask' } }, '/api/v1/tasks': { post: { operationId: 'createTask' } },
  '/api/v1/operator/secret': { get: { operationId: 'forbidden' } }, '//evil.test/api/v1/tasks': { get: { operationId: 'evil' } },
} };
test('standalone executable: discovery, paging bounds, redirects, redaction, replay and company binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-cli-')), requests = [], receipts = new Map(); let mode = 'normal', writes = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); requests.push({ url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/openapi.json') return res.end(JSON.stringify(spec));
    if (url.pathname === '/api/v1/service/tasks/mine') return res.end(JSON.stringify({ echoed: req.headers['pulse-person-token'] }));
    if (mode === 'redirect') { res.writeHead(302, { Location: '/api/v1/operator/secret' }); return res.end(); }
    if (mode === 'error') { res.writeHead(400, { 'x-secret': key }); return res.end(JSON.stringify({ detail: 'Refused ' + key + ' ' + key.slice(-43) })); }
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const slot = req.headers['idempotency-key']; assert.ok(slot);
      if (!receipts.has(slot)) receipts.set(slot, { id: ++writes, body: JSON.parse(body) });
      return res.end(JSON.stringify(receipts.get(slot)));
    }
    if (url.pathname.startsWith('/api/v1/tasks/')) return res.end(JSON.stringify({ secret: key }));
    res.end(JSON.stringify({ items: [url.searchParams.get('cursor') ? 'second' : 'first'], nextCursor: mode === 'cap' ? String(requests.length) : mode === 'repeat' || !url.searchParams.has('cursor') ? 'next' : null }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const run = async (...args) => {
    try { return { ...await exec(process.execPath, [cli, ...args], { env: { ...process.env, PULSE_URL: base, PULSE_API_KEY: key, PULSE_PERSON_TOKEN: personToken, XDG_CONFIG_HOME: dir } }), code: 0 }; }
    catch (e) { return e; }
  };
  try {
    const ops = await run('ops'); assert.equal(ops.code, 0); assert.deepEqual(JSON.parse(ops.stdout).map(o => o.operationId), ['getServiceClients', 'getServiceTasksMine', 'readTask', 'createTask']);
    assert.equal(requests[0].headers.authorization, undefined);
    const mine = await run('getServiceTasksMine'); assert.equal(mine.code, 0); assert.ok(!mine.stdout.includes(personToken)); assert.equal(requests.at(-1).headers['pulse-person-token'], personToken);
    const refused = await run('getServiceTasksMine', '--param', 'Pulse-Person-Token=' + personToken); assert.equal(refused.code, 4); assert.ok(!refused.stderr.includes(personToken));
    assert.deepEqual(JSON.parse((await run('getServiceClients', '--all')).stdout), { items: ['first', 'second'], nextCursor: null });
    for (const m of ['repeat', 'cap']) { mode = m; const r = await run('getServiceClients', '--all'); assert.equal(r.code, 1); assert.equal(r.stdout, ''); }
    mode = 'redirect'; const before = requests.length; assert.equal((await run('readTask', '--param', 'id=one')).code, 1); assert.equal(requests.length, before + 2);
    mode = 'error'; const bad = await run('readTask', '--param', 'id=one'); assert.equal(bad.code, 4); assert.doesNotMatch(bad.stderr, /psvc_|x-secret/); assert.ok(!bad.stderr.includes(key.slice(-43)));
    mode = 'normal'; assert.doesNotMatch((await run('readTask', '--param', 'id=one')).stdout, /psvc_/);
    await writeFile(join(dir, 'data.json'), '{"text":"synthetic"}');
    for (let i = 0; i < 2; i++) assert.equal((await run('createTask', '--data', '@' + join(dir, 'data.json'), '--idempotency-key', '00000000-0000-4000-8000-000000000001')).code, 0);
    assert.equal(writes, 1); assert.equal((await run('createTask', '--data', '@' + join(dir, 'data.json'))).code, 0); assert.equal(writes, 2);
    assert.equal((await run('readTask', '--param', 'id=..')).code, 4);
    for (const url of ['http://public.example', 'https://user:pass@example.test', 'https://example.test/path']) assert.equal((await run('ops', '--url', url)).code, 4);
    const status = await run('auth', 'status'); assert.doesNotMatch(status.stdout, /psvc_/); assert.equal(JSON.parse(status.stdout).keyId, '00000000-0000-4000-8000-000000000001');
    for (const request of requests.filter(r => r.headers.authorization)) { assert.equal(request.headers.authorization, 'Bearer ' + key); assert.equal(request.headers.cookie, undefined); }
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
test('login uses a hidden terminal and an atomic 0600 file; saved credentials are company bound', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-cli-login-'));
  try {
    const script = `import os,pty,subprocess,select,time
master,slave=pty.openpty()
p=subprocess.Popen([os.environ['NODE'],os.environ['CLI'],'auth','login'],stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
out=b''
while b'API key: ' not in out:
 if not select.select([master],[],[],5)[0]: raise Exception('prompt timeout')
 out+=os.read(master,4096)
os.write(master,(os.environ['TEST_KEY']+'\\r').encode())
while True:
 try: out+=os.read(master,4096)
 except OSError: break
assert p.wait(timeout=5)==0
assert os.environ['TEST_KEY'].encode() not in out
os.close(master)
`;
    const env = { ...process.env, PULSE_URL: 'https://company.example', PULSE_API_KEY: '', XDG_CONFIG_HOME: dir, NODE: process.execPath, CLI: cli, TEST_KEY: key };
    await exec('python3', ['-c', script], { env, timeout: 15000 });
    const file = join(dir, 'pulse/auth.json'); assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal(JSON.parse(await readFile(file)).key, key);
    const result = await exec(process.execPath, [cli, 'auth', 'status'], { env }); assert.doesNotMatch(result.stdout + result.stderr, /psvc_/);
    await assert.rejects(exec(process.execPath, [cli, '--url', 'https://other.example', 'auth', 'status'], { env }), e => e.code === 2 && !e.stderr.includes(key));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
