// R45 through the real API on a disposable synthetic tenant (tests/core/test_drive_extract.py): an audience member reads
// a capture's exact text and facts with provenance; someone outside the audience, an unknown root or a malformed id gets
// 404; a file gone from Drive is held without text; a damaged payload is reported as corrupt without text; the admin's
// Connected sources card shows counts only. Mock evidence: no Google Drive is involved.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const { TEST_ADMIN_EMAIL, TEST_OTHER_EMAIL, TEST_SOURCE, TEST_TEXT } = process.env;
let checks = 0;

const get = async (url, email, expected) => {
  checks++;
  const r = await app.inject({ url, headers: email ? { 'cf-access-authenticated-user-email': email } : {} });
  assert.equal(r.statusCode, expected, `${url}: ${r.body.slice(0, 300)}`);
  return r;
};
const text = (file) => `/api/v0/drive-text/${TEST_SOURCE}/${file}`;

const ok = (await get(text('doc'), TEST_ADMIN_EMAIL, 200)).json();
assert.equal(ok.state, 'readable');
assert.equal(ok.text.body, TEST_TEXT);
assert.equal(ok.text.codec, 'zlib');
assert.deepEqual(ok.facts.body.tables[0].rows[0], ['Deliverable', 'Owner', 'Due']);
assert.equal(ok.provenance.name, 'Brief.docx');
assert.match(ok.provenance.originalSha256, /^[0-9a-f]{64}$/);
assert.deepEqual(ok.gaps, []);

await get(text('doc'), TEST_OTHER_EMAIL, 404);                       // not in the audience: as if nothing were there
await get(text('doc'), null, 401);
await get(`/api/v0/drive-text/${randomUUID()}/doc`, TEST_ADMIN_EMAIL, 404);
await get(`/api/v0/drive-text/not-a-root/doc`, TEST_ADMIN_EMAIL, 404);
await get(`/api/v0/drive-text/${TEST_SOURCE}/bad%20id`, TEST_ADMIN_EMAIL, 404);

const held = (await get(text('gone'), TEST_ADMIN_EMAIL, 200)).json();
assert.deepEqual(held, { state: 'held', reason: 'source_removed' });

const bad = (await get(text('bad'), TEST_ADMIN_EMAIL, 200)).json();
assert.equal(bad.state, 'corrupt');
assert.equal(bad.text, undefined);
assert.ok(!JSON.stringify(bad).includes('damaged'));

checks++;
const settings = await app.inject({ url: '/api/v0/settings', headers: { 'cf-access-authenticated-user-email': TEST_ADMIN_EMAIL } });
assert.equal(settings.statusCode, 200, settings.body.slice(0, 300));
assert.ok(!settings.body.includes('Brief.docx') && !settings.body.includes('Deliverable'));
delete process.env.PULSE_DRIVE_EXTRACT;
const off = (await app.inject({ url: '/api/v0/settings', headers: { 'cf-access-authenticated-user-email': TEST_ADMIN_EMAIL } })).json()
  .sources.find((s) => s.key === 'drive-text');
assert.equal(off.state, 'planned');
assert.match(off.detail, /^Off\./);
process.env.PULSE_DRIVE_EXTRACT = '1';
checks++;
const on = (await app.inject({ url: '/api/v0/settings', headers: { 'cf-access-authenticated-user-email': TEST_ADMIN_EMAIL } })).json()
  .sources.find((s) => s.key === 'drive-text');
assert.equal(on.state, 'attention');
assert.equal(on.detail, '3 documents captured. 1 held until someone reviews a change in Drive.');

await writeFile(process.env.PULSE_R45_REPORT, JSON.stringify({ checks, provider: 'none' }, null, 2));
await app.close();
await pool.end();
