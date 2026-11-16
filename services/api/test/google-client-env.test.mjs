import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { googleClient, googleConfigured } from '../dist/google-client.js';

// ONBOARD: production's container gets the install's Google client secret from its root-only env file.
test('the install client secret comes from PULSE_GOOGLE_CLIENT_SECRET or the secret file; the value wins', () => {
 const previous = { ...process.env }, base = mkdtempSync((process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir()) + '/google-env-');
 try {
  for (const key of ['PULSE_GOOGLE_CLIENT_ID', 'PULSE_GOOGLE_CLIENT_SECRET', 'PULSE_GOOGLE_CLIENT_SECRET_FILE']) delete process.env[key];
  assert.equal(googleConfigured(), false); assert.equal(googleClient(), null);
  process.env.PULSE_GOOGLE_CLIENT_SECRET = 'synthetic-env-secret';
  assert.equal(googleConfigured(), false, 'a secret without a client id is not a client');
  process.env.PULSE_GOOGLE_CLIENT_ID = 'synthetic-web-client';
  assert.deepEqual(googleClient(), { company: 'install', clientId: 'synthetic-web-client', clientSecret: 'synthetic-env-secret' });
  writeFileSync(base + '/secret', 'synthetic-file-secret\n');
  process.env.PULSE_GOOGLE_CLIENT_SECRET_FILE = base + '/secret';
  assert.equal(googleClient().clientSecret, 'synthetic-env-secret');
  process.env.PULSE_GOOGLE_CLIENT_SECRET = '  ';
  assert.equal(googleClient().clientSecret, 'synthetic-file-secret');
  delete process.env.PULSE_GOOGLE_CLIENT_SECRET_FILE;
  assert.equal(googleConfigured(), false, 'a blank value is no secret');
 } finally { process.env = previous; rmSync(base, { recursive: true, force: true }); }
});
