// AGENT-API (4 Nov 2026): `pulse login --device` (RFC 8628) against a local fake Pulse: the code is shown, the poll is
// pending until the person approves, slow_down widens the wait, a Cancel is a clear refusal, and only tokens come back.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PULSE_CLI_NO_MAIN = '1';
const dir = mkdtempSync(join(tmpdir(), 'pulse-cli-device-'));
process.env.PULSE_CONFIG_DIR = dir;
const { deviceLogin } = await import('../dist/auth.js');

function fake(decide) {
  const s = { polls: 0, asked: null };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), origin = `http://127.0.0.1:${server.address().port}`;
    let raw = ''; for await (const c of req) raw += c;
    const body = req.headers['content-type']?.includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
    const json = (status, v) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: origin, authorization_endpoint: `${origin}/oauth/mcp/authorize`,
      token_endpoint: `${origin}/oauth/mcp/token`, registration_endpoint: `${origin}/oauth/mcp/register`, revocation_endpoint: `${origin}/oauth/mcp/revoke`,
      device_authorization_endpoint: `${origin}/oauth/mcp/device_authorization` });
    if (url.pathname === '/oauth/mcp/register') { assert.equal(body.token_endpoint_auth_method, 'none'); return json(201, { client_id: 'pcl_device0001' }); }
    if (url.pathname === '/oauth/mcp/device_authorization') {
      s.asked = body; return json(200, { device_code: 'pdc_' + randomBytes(32).toString('base64url'), user_code: 'BCDF-GHJK', verification_uri: `${origin}/oauth/device`,
        verification_uri_complete: `${origin}/oauth/device?user_code=BCDF-GHJK`, expires_in: 600, interval: 5 });
    }
    if (url.pathname === '/oauth/mcp/token') {
      assert.equal(body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code'); assert.equal(body.client_id, 'pcl_device0001');
      s.polls++;
      const answer = decide(s.polls);
      if (answer === 'ok') return json(200, { access_token: 'pat_' + randomBytes(32).toString('base64url'), refresh_token: 'prt_' + randomBytes(32).toString('base64url'), expires_in: 3600, scope: 'tasks.read' });
      return json(400, { error: answer });
    }
    res.writeHead(404).end();
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ s, server, host: `http://127.0.0.1:${server.address().port}` })));
}

test('device login: shows the code, waits while pending, slows down when asked, then signs in', async () => {
  const { s, server, host } = await fake(n => n === 1 ? 'authorization_pending' : n === 2 ? 'slow_down' : 'ok');
  const lines = [], waits = [];
  try {
    const cred = await deviceLogin(host, { scopes: 'tasks.read', log: l => lines.push(l), sleep: async ms => { waits.push(ms); } });
    assert.equal(cred.kind, 'oauth'); assert.match(cred.accessToken, /^pat_/); assert.equal(cred.clientId, 'pcl_device0001');
    assert.equal(s.asked.scope, 'tasks.read');
    assert.ok(lines.join('\n').includes('BCDF-GHJK') && lines.join('\n').includes('/oauth/device'));
    assert.ok(!lines.join('\n').includes('pdc_'), 'the device code is never printed');
    assert.deepEqual(waits, [5000, 5000, 10000], 'slow_down adds 5 seconds');
  } finally { server.close(); }
});

test('device login: Cancel on Pulse is a sign-in refusal, an expired code says to start again', async () => {
  for (const [answer, words] of [['access_denied', /cancelled/i], ['expired_token', /expired/i]]) {
    const { server, host } = await fake(() => answer);
    try { await assert.rejects(deviceLogin(host, { log: () => {}, sleep: async () => {} }), e => words.test(e.message) && e.exitCode === 2); }
    finally { server.close(); }
  }
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
