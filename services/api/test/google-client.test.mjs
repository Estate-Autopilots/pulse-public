import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { googleClient, googleConfigured } from '../dist/google-client.js';
import { createGoogleDiscovery, googleOwnAddress, safeNext } from '../dist/google-sign-in-flow.js';
import { runWithCompany } from '../dist/tenant-context.js';

test('hosted clients are private, company-scoped and cached by company + client; install stays on env', async () => {
 const previous = { ...process.env }, base = mkdtempSync((process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir()) + '/google-');
 const install = randomUUID(), a = randomUUID(), b = randomUUID();
 const inside = (org, run) => runWithCompany({ host: 'hosted.example.test', installOrg: install,
  company: { org, signIn: 'password', status: 'active', rehearsal: true } }, run);
 const file = base + '/' + a + '/google-sign-in.json';
 const save = (id = 'hosted-client') => writeFileSync(file, JSON.stringify({ client_id: id, client_secret: 'synthetic-secret' }), { mode: 0o600 });
 try {
  Object.assign(process.env, { PULSE_CONNECTOR_SECRETS_DIR: base, PULSE_GOOGLE_CLIENT_ID: 'install-client',
   PULSE_GOOGLE_CLIENT_SECRET_FILE: base + '/install', PULSE_PUBLIC_URL: 'https://install.example.test' });
  writeFileSync(base + '/install', 'install-secret'); mkdirSync(base + '/' + a, { mode: 0o700 }); save();
  assert.equal(googleClient().clientId, 'install-client');
  assert.equal(inside(install, () => googleClient().clientId), 'install-client');
  mkdirSync(base + '/' + install, { mode: 0o700 });
  writeFileSync(base + '/' + install + '/google-sign-in.json', JSON.stringify({ client_id: 'ignored-company-file', client_secret: 'synthetic' }), { mode: 0o600 });
  delete process.env.PULSE_GOOGLE_CLIENT_ID; assert.equal(inside(install, googleConfigured), false);
  process.env.PULSE_GOOGLE_CLIENT_ID = 'install-client';
  assert.equal(inside(a, googleConfigured), true); assert.equal(inside(b, googleConfigured), false);
  assert.equal(inside(b, googleClient), null, 'hosted company never borrows install client');
  assert.equal(inside(a, () => googleOwnAddress({ headers: { 'x-pulse-host': 'hosted.example.test' } })), true);
  assert.equal(inside(a, () => googleOwnAddress({ headers: { 'x-pulse-host': 'other.example.test' } })), false);
  assert.equal(inside(a, () => safeNext('/tasks?tab=mine')), '/tasks?tab=mine');
  for (const mode of [0o644, 0o400]) { chmodSync(file, mode); assert.equal(inside(a, googleConfigured), false); }
  chmodSync(file, 0o600); chmodSync(base + '/' + a, 0o755); assert.equal(inside(a, googleConfigured), false);
  chmodSync(base + '/' + a, 0o700); unlinkSync(file); symlinkSync(base + '/install', file); assert.equal(inside(a, googleConfigured), false);
  unlinkSync(file); save(); mkdirSync(base + '/' + b, { mode: 0o700 }); rmSync(base + '/' + b, { recursive: true });
  symlinkSync(base + '/' + a, base + '/' + b); assert.equal(inside(b, googleConfigured), false);
  unlinkSync(base + '/' + b); mkdirSync(base + '/' + b, { mode: 0o700 });
  writeFileSync(base + '/' + b + '/google-sign-in.json', JSON.stringify({ client_id: 'hosted-client', client_secret: 'company-b-secret' }), { mode: 0o600 });
  for (const invalid of ['null', '{', '{"client_id":"x","client_secret":""}', '{"client_id":"x","client_secret":"s","extra":1}']) {
   writeFileSync(file, invalid); assert.equal(inside(a, googleConfigured), false);
  }
  save(); let calls = 0, refuse = false;
  const discovery = createGoogleDiscovery(async (_issuer, id) => { calls++; if (refuse) throw Error('synthetic failure'); return { id }; });
  assert.equal((await inside(a, discovery)).id, 'hosted-client'); await inside(a, discovery); assert.equal(calls, 1);
  await inside(b, discovery); assert.equal(calls, 2, 'same client id in another company has its own cache entry');
  await discovery(); assert.equal(calls, 3); save('rotated-client'); await inside(a, discovery); assert.equal(calls, 4);
  save('retry-client'); refuse = true; await assert.rejects(inside(a, discovery)); refuse = false;
  await inside(a, discovery); assert.equal(calls, 6, 'failed discovery is evicted');
 } finally { process.env = previous; rmSync(base, { recursive: true, force: true }); }
});
