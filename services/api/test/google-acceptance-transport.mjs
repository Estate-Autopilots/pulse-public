// Shared by the recovered matrix and focused check. HTTP redirects are never followed.
import http from 'node:http';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const label = 'exact staging build, synthetic Google harness';
export const canonicalHost = 'pulse-staging.estateautopilots.com';
export function stagingRequest(path, { port = 4102, method = 'GET', headers = {}, body } = {}) {
 assert.ok(path.startsWith('/') && !path.startsWith('//'), 'expected a relative staging path');
 const outgoing = new Headers(headers);
 outgoing.set('host', canonicalHost);
 outgoing.set('accept-encoding', 'identity');
 return new Promise((resolve, reject) => {
  const q = http.request({ hostname: '127.0.0.1', port, path, method, headers: Object.fromEntries(outgoing) }, r => {
   const chunks = []; let size = 0;
   r.on('error', reject);
   r.on('data', b => {
    size += b.length;
    if (size > 8 * 1024 * 1024) q.destroy(new Error('staging response exceeds 8 MiB'));
    else chunks.push(b);
   });
   r.on('end', () => {
    const responseHeaders = new Headers();
    for (let i = 0; i < r.rawHeaders.length; i += 2) responseHeaders.append(r.rawHeaders[i], r.rawHeaders[i + 1]);
    const bytes = Buffer.concat(chunks);
    resolve({ status: r.statusCode, headers: responseHeaders, body: bytes,
     json: async () => JSON.parse(bytes.toString()), text: async () => bytes.toString() });
   });
  });
  const deadline = setTimeout(() => q.destroy(new Error('staging request exceeded 10 seconds')), 10000);
  q.on('close', () => clearTimeout(deadline));
  q.on('error', reject);
  q.end(body);
 });
}
export const sessionIssued = r => r.headers.getSetCookie().some(c => /^pulse_session=[^;]/.test(c));
export async function malformedCallback(options) {
 const r = await stagingRequest('/api/v0/auth/google/callback?state=synthetic-invalid&code=synthetic-invalid', options);
 assert.equal(r.status, 302);
 assert.equal(r.headers.get('location'), '/login?next=%2F&google=state_invalid');
 assert.equal(sessionIssued(r), false);
 return { status: r.status, location: r.headers.get('location'), sessionIssued: false };
}
export async function hostEcho() {
 const server = http.createServer((q, r) => r.end(JSON.stringify({ receivedHost: q.headers.host })));
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
 try {
  const r = await stagingRequest('/', { port: server.address().port, headers: { Host: 'ignored.example.test' } });
  assert.equal(r.status, 200);
  const detail = await r.json(); assert.equal(detail.receivedHost, canonicalHost);
  return detail;
 } finally { await new Promise(resolve => server.close(resolve)); }
}
export async function stagingVersion() {
 const r = await stagingRequest('/healthz'); assert.equal(r.status, 200);
 const sha = (await r.json()).release; assert.match(sha, /^[a-f0-9]{40}$/); return sha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 assert.equal(process.argv.length, 3, 'usage: ea-heavy node services/api/test/google-acceptance-transport.mjs <receipt.json>');
 const receipt = { label, scope: 'Focused transport repair only; historical 26/27 unchanged; no matrix or live-provider/product pass',
  node: process.version, startedAt: new Date().toISOString(), checks: [] };
 try {
  receipt.headerEcho = await hostEcho(); receipt.checks.push('actual outgoing canonical Host');
  receipt.runtimeSha = await stagingVersion();
  receipt.callback = await malformedCallback(); receipt.checks.push('exact malformed-callback redirect and no Pulse session');
  receipt.runtimeShaAfter = await stagingVersion(); assert.equal(receipt.runtimeShaAfter, receipt.runtimeSha);
  receipt.checks.push('staging version pinned before/after'); receipt.passed = true;
 } catch (e) { receipt.passed = false; receipt.error = e.message; process.exitCode = 1; }
 receipt.endedAt = new Date().toISOString();
 writeFileSync(process.argv[2], JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
 console.log(JSON.stringify(receipt, null, 2));
}
