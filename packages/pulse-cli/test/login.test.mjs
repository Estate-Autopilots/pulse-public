// The pulse command end to end against a local fake Pulse that speaks the same OAuth (discovery, dynamic registration,
// PKCE, rotating refresh, revoke) and v1 shapes as services/api: the test plays the browser that chooses Allow.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../dist/cli.js', import.meta.url);
const ME = { id: '0b6c2f1e-1d2c-4a5b-8c9d-0e1f2a3b4c5d', name: 'Asha Rao', username: 'asha', roles: ['hr'], app: 'Pulse CLI', company: 'Synthetic Co' };

function fakePulse() {
  const s = { clients: new Map(), codes: new Map(), access: new Map(), refresh: new Map(), revoked: [], calls: [], expiresIn: 3600 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), origin = `http://127.0.0.1:${server.address().port}`;
    let raw = ''; for await (const c of req) raw += c;
    const body = req.headers['content-type']?.includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
    const json = (status, v, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(v)); };
    const problem = (status, detail) => json(status, { type: 'about:blank', title: 'x', status, detail, requestId: 'req-1' }, { 'content-type': 'application/problem+json', ...(status === 429 ? { 'retry-after': '7' } : {}) });
    s.calls.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: origin, authorization_endpoint: `${origin}/oauth/mcp/authorize`,
      token_endpoint: `${origin}/oauth/mcp/token`, registration_endpoint: `${origin}/oauth/mcp/register`, revocation_endpoint: `${origin}/oauth/mcp/revoke` });
    if (url.pathname === '/oauth/mcp/register') {
      assert.equal(body.token_endpoint_auth_method, 'none'); assert.equal(body.client_name, 'Pulse CLI');
      assert.match(body.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      const id = 'pcl_' + randomBytes(6).toString('hex'); s.clients.set(id, body.redirect_uris); return json(201, { client_id: id });
    }
    if (url.pathname === '/oauth/mcp/authorize') { // the person chose Allow on the consent screen
      const q = Object.fromEntries(url.searchParams);
      assert.equal(q.code_challenge_method, 'S256'); assert.ok(s.clients.get(q.client_id).includes(q.redirect_uri));
      const code = 'code-' + randomBytes(6).toString('hex'); s.codes.set(code, q);
      const back = new URL(q.redirect_uri); back.searchParams.set('code', code); back.searchParams.set('state', q.state); back.searchParams.set('iss', origin);
      res.writeHead(302, { location: back.href }); return res.end();
    }
    if (url.pathname === '/oauth/mcp/token') {
      const issue = () => { const a = 'pat_' + randomBytes(32).toString('base64url'), r = 'prt_' + randomBytes(32).toString('base64url');
        s.access.set(a, true); s.refresh.set(r, body.client_id); return json(200, { access_token: a, refresh_token: r, token_type: 'Bearer', expires_in: s.expiresIn, scope: 'people.read people.write' }); };
      if (body.grant_type === 'authorization_code') {
        const q = s.codes.get(body.code); s.codes.delete(body.code);
        if (!q || q.redirect_uri !== body.redirect_uri || createHash('sha256').update(body.code_verifier).digest('base64url') !== q.code_challenge) return json(400, { error: 'invalid_grant' });
        return issue();
      }
      if (body.grant_type === 'refresh_token') {
        if (s.refresh.get(body.refresh_token) !== body.client_id) return json(400, { error: 'invalid_grant' });
        s.refresh.delete(body.refresh_token); s.refreshed = (s.refreshed ?? 0) + 1; return issue();
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/oauth/mcp/revoke') { s.revoked.push(body.token); s.refresh.delete(body.token); s.access.delete(body.token); return json(200, {}); }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!bearer || !(s.access.has(bearer) || bearer === 'pat_static_token_for_tests_000000000000000000')) return problem(401, 'Sign in again');
    if (url.pathname === '/api/v1/people/me') return json(200, ME);
    if (url.pathname === '/api/v1/people') return json(200, { items: [{ ...ME, status: 'active', role: 'hr', department: 'People', workEmail: 'asha@example.com', query: url.searchParams.get('query') }] });
    if (url.pathname === '/api/v1/events/bug-reports') return problem(403, 'Admins and leadership only');
    if (url.pathname === '/api/v1/people/me/changes') return problem(429, 'Slow down');
    if (url.pathname.endsWith('/corrections') && req.method === 'POST') {
      assert.match(req.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
      return json(200, { changed: true, field: body.field, from: null, to: body.value, changeId: 'c1', undoUntil: '2026-11-04' });
    }
    return problem(404, 'Unknown path');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, s, origin: `http://127.0.0.1:${server.address().port}` })));
}

function run(args, env, onStderr) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI.pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args], { env: { ...process.env, PULSE_TOKEN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; onStderr?.(stderr); });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('browser sign-in, whoami, tables and JSON, renewal, refusals and logout', async () => {
  const { server, s, origin } = await fakePulse();
  const dir = mkdtempSync(join(tmpdir(), 'pulse-cli-login-'));
  const env = { PULSE_CONFIG_DIR: join(dir, 'cfg'), PULSE_HOST: origin };
  try {
    // The "browser": open the printed consent link; Pulse redirects to the CLI's loopback listener.
    let opened = false;
    const login = await run(['login', '--no-browser'], env, async text => {
      const link = /(http:\/\/127\.0\.0\.1:\d+\/oauth\/mcp\/authorize\?\S+)/.exec(text)?.[1];
      if (!link || opened) return; opened = true;
      const consent = await fetch(link, { redirect: 'manual' });
      const page = await fetch(consent.headers.get('location'));
      assert.match(await page.text(), /Signed in to Pulse/);
    });
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, /Signed in to http:\/\/127\.0\.0\.1:\d+ as Asha Rao \(@asha\) · hr\./);
    const file = join(dir, 'cfg', 'credentials.json'), saved = JSON.parse(readFileSync(file, 'utf8'));
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    const cred = saved.hosts[origin];
    assert.equal(cred.kind, 'oauth'); assert.equal(saved.defaultHost, origin);

    const who = await run(['whoami'], env);
    assert.equal(who.code, 0, who.stderr);
    assert.match(who.stdout, /^Asha Rao \(@asha\)/); assert.match(who.stdout, /via\s+browser sign-in/); assert.match(who.stdout, /company\s+Synthetic Co/);
    const people = await run(['people', 'search', 'asha', '--host', origin], env);
    assert.match(people.stdout, /^ID\s+NAME\s+USERNAME\s+STATUS\s+ROLE\s+DEPARTMENT\s+WORKEMAIL\n0b6c2f1e/);
    const asJson = await run(['people', 'search', 'asha', '--json'], env);
    assert.equal(JSON.parse(asJson.stdout).items[0].query, 'asha');
    const raw = await run(['api', 'GET', '/api/v1/people?query=raw'], env);
    assert.equal(JSON.parse(raw.stdout).items[0].query, 'raw');
    const fixed = await run(['hr', 'correct', ME.id, '--field', 'joinedOn', '--value', '2026-08-01', '--reason', 'Offer letter'], env);
    assert.match(fixed.stdout, /changed\s+yes/); assert.match(fixed.stdout, /to\s+2026-08-01/);

    // Refusals: exit codes and plain sentences, never a token.
    const forbidden = await run(['bugs', 'list'], env);
    assert.equal(forbidden.code, 3); assert.match(forbidden.stderr, /Pulse refused: Admins and leadership only \(request req-1\)/);
    const limited = await run(['changes', 'list'], env);
    assert.equal(limited.code, 5); assert.match(limited.stderr, /Try again in 7 seconds/);
    const bad = await run(['hr', 'correct', 'asha'], env);
    assert.equal(bad.code, 4); assert.match(bad.stderr, /must be an id/);

    // An access token near expiry is renewed once (rotating refresh) and saved.
    const store = JSON.parse(readFileSync(file, 'utf8')); store.hosts[origin].expiresAt = Date.now();
    await import('node:fs').then(fs => fs.writeFileSync(file, JSON.stringify(store)));
    assert.equal((await run(['whoami', '--json'], env)).code, 0);
    assert.equal(s.refreshed, 1);
    const renewed = JSON.parse(readFileSync(file, 'utf8')).hosts[origin];
    assert.notEqual(renewed.refreshToken, cred.refreshToken);

    for (const r of [login, who, people, asJson, fixed, forbidden, limited]) {
      for (const t of [cred.accessToken, cred.refreshToken, renewed.accessToken]) assert.ok(!(r.stdout + r.stderr).includes(t), 'no token in output');
    }

    const out = await run(['logout'], env);
    assert.match(out.stdout, /Signed out of/);
    assert.ok(s.revoked.includes(renewed.refreshToken));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).hosts[origin], undefined);
    const after = await run(['whoami'], env);
    assert.equal(after.code, 2); assert.match(after.stderr, /Not signed in to/);

    // A pasted token is checked against Pulse before it is stored; PULSE_TOKEN overrides stored sign-ins.
    const pasted = await run(['login', '--token', 'pat_static_token_for_tests_000000000000000000'], env);
    assert.equal(pasted.code, 0, pasted.stderr); assert.match(pasted.stdout, /with a token/);
    assert.equal((await run(['login', '--token', 'pat_wrong_wrong_wrong_wrong'], env)).code, 2);
    const viaEnv = await run(['whoami'], { ...env, PULSE_TOKEN: 'pat_nope_nope_nope_nope_nope' });
    assert.equal(viaEnv.code, 2); assert.ok(!viaEnv.stderr.includes('pat_nope'));
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('help everywhere and usage errors exit 4', async () => {
  const env = { PULSE_CONFIG_DIR: join(tmpdir(), 'pulse-cli-none') };
  const main = await run(['--help'], env);
  assert.equal(main.code, 0); assert.match(main.stdout, /pulse login/); assert.match(main.stdout, /hr …/);
  const hr = await run(['hr', '--help'], env);
  assert.match(hr.stdout, /correct\s+HR or admin corrects one field/);
  const one = await run(['groups', 'create', '--help'], env);
  assert.match(one.stdout, /Usage: pulse groups create <name> \[options\]/); assert.match(one.stdout, /--all-active-staff/);
  const ops = await run(['ops', '--json'], env);
  assert.ok(JSON.parse(ops.stdout).some(o => o.operationId === 'undoChange' && o.command === 'changes undo'));
  assert.equal((await run(['nope'], env)).code, 4);
  assert.equal((await run(['people', 'search', '--bogus'], env)).code, 4);
  assert.match((await run(['--version'], env)).stdout, /^\d+\.\d+\.\d+/);
});
