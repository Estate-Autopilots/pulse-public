// R44 through the real API on a disposable synthetic tenant (tests/core/test_drive_changes.py): Google's channel
// notification hook answers 404 while the feed is off and for any channel id/token/state that is not a live channel of
// this organisation, 204 for a live one (its empty body tolerated whatever the content type); the admin's Connected
// sources card reports the approved root without tokens. Mock evidence: no Google channel is involved.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const { TEST_CHANNEL, TEST_TOKEN, TEST_ADMIN_EMAIL } = process.env;
let checks = 0;

const live = { 'x-goog-channel-id': TEST_CHANNEL, 'x-goog-channel-token': TEST_TOKEN, 'x-goog-resource-state': 'change', 'x-goog-message-number': '7' };
const hook = async (headers, expected, payload) => {
  checks++;
  const r = await app.inject({ method: 'POST', url: '/api/v0/drive-changes/hook', headers, ...(payload === undefined ? {} : { payload }) });
  assert.equal(r.statusCode, expected, `hook ${JSON.stringify({ ...headers, 'x-goog-channel-token': '…' })}: ${r.body.slice(0, 200)}`);
  assert.ok(!r.body.includes(TEST_TOKEN));
  return r;
};
const card = async () => {
  checks++;
  const r = await app.inject({ url: '/api/v0/settings', headers: { 'cf-access-authenticated-user-email': TEST_ADMIN_EMAIL } });
  assert.equal(r.statusCode, 200, r.body.slice(0, 300));
  assert.ok(!r.body.includes(TEST_TOKEN) && !r.body.includes('SyntheticPageToken') && !r.body.includes('collector@synthetic'));
  return r.json().sources.find((s) => s.key === 'drive-changes');
};

delete process.env.PULSE_DRIVE_CHANGES;
await hook(live, 404);
const off = await card();
assert.equal(off.state, 'planned');
assert.match(off.detail, /^Off\./);

process.env.PULSE_DRIVE_CHANGES = '1';
await hook({ ...live, 'x-goog-channel-token': 'x'.repeat(43) }, 404);
await hook({ ...live, 'x-goog-channel-id': randomUUID() }, 404);
await hook({ ...live, 'x-goog-channel-id': 'not-a-channel' }, 404);
await hook({ ...live, 'x-goog-resource-state': 'exists' }, 404);
await hook({ 'x-goog-resource-state': 'change' }, 404);
await hook({ ...live, 'x-goog-resource-state': 'sync' }, 204);
await hook({ ...live, 'content-type': 'application/json' }, 204, '');
await hook({ ...live, 'content-type': 'text/plain' }, 204, 'ignored');
await hook(live, 204);

const on = await card();
assert.equal(on.state, 'connected');
assert.match(on.detail, /^1 approved root, all up to date\. 0 files tracked\.$/);

await writeFile(process.env.PULSE_R44_REPORT, JSON.stringify({ checks, hook: 'mock', provider: 'none' }, null, 2));
await app.close();
await pool.end();
