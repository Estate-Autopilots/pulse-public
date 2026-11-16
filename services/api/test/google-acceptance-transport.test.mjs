import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { canonicalHost, hostEcho, malformedCallback } from './google-acceptance-transport.mjs';

test('loopback transport sends the canonical Host on the wire', async () => {
 assert.equal((await hostEcho()).receivedHost, canonicalHost);
});

test('malformed callback requires the exact redirect and refuses a Pulse session', async () => {
 let location = '/login?next=%2F&google=state_invalid', cookie = 'pulse_oidc=; Max-Age=0';
 const server = http.createServer((q, r) => {
  assert.equal(q.headers.host, canonicalHost);
  assert.equal(q.url, '/api/v0/auth/google/callback?state=synthetic-invalid&code=synthetic-invalid');
  r.writeHead(302, { location, 'set-cookie': [cookie] }); r.end();
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const options = { port: server.address().port };
 try {
  assert.deepEqual(await malformedCallback(options), { status: 302, location, sessionIssued: false });
  location = '/login?google=provider_error';
  await assert.rejects(malformedCallback(options), { code: 'ERR_ASSERTION' });
  location = '/login?next=%2F&google=state_invalid'; cookie = 'pulse_session=synthetic-only; Secure; HttpOnly';
  await assert.rejects(malformedCallback(options), { code: 'ERR_ASSERTION' });
 } finally { await new Promise(resolve => server.close(resolve)); }
});
