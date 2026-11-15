// R41 through the real API on a disposable synthetic tenant (tests/core/test_policy_word.py): Word upload and download,
// editor sessions, the editor service's signed file fetches and callbacks, and the refusals that matter — wrong or
// missing signatures, saved files from another origin or behind a redirect, files that are not plain Word documents,
// stale keys, unknown sessions and the editor switched off. The "editor service" is a loopback stand-in that serves
// saved files; a second server stands for anywhere else and must never be contacted. This is mock evidence: no
// ONLYOFFICE server, licence or real document is involved.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { signJwt, verifyJwt } from '../dist/policy-word.js';
import { FIXTURE_MARKDOWN, policyDocx } from './policy-docx-fixture.mjs';

const pool = new Pool(JSON.parse(process.env.TEST_API_CONFIG));
const app = createApp(pool, pool);
const emails = JSON.parse(process.env.TEST_EMAILS);
const SECRET = randomBytes(32).toString('base64url'), WRONG = randomBytes(32).toString('base64url');
const sha = (b) => createHash('sha256').update(b).digest('hex');
let checks = 0, evilHits = 0, providerHits = 0;

const files = new Map();
const listen = (srv) => new Promise((done) => srv.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${srv.address().port}`)));
const evil = createServer((_req, res) => { evilHits++; res.end(policyDocx({ text: 'injected text' })); });
const evilBase = await listen(evil);
const provider = createServer((req, res) => {
  providerHits++;
  if (req.url === '/redirect') { res.writeHead(302, { location: `${evilBase}/stolen.docx` }); res.end(); return; }
  const bytes = files.get(req.url.split('?')[0]);
  if (!bytes) { res.writeHead(404); res.end(); return; }
  res.end(bytes);
});
const providerBase = await listen(provider);

const call = async (path, { body, role = 'hr', expected = 200, headers = {} } = {}) => {
  checks++;
  const r = await app.inject({ url: '/api/v0/' + path, method: body === undefined ? 'GET' : 'POST', headers: { ...(role ? { 'cf-access-authenticated-user-email': emails[role] } : {}), ...headers }, ...(body === undefined ? {} : { payload: body }) });
  assert.equal(r.statusCode, expected, `${role ?? 'signed out'} ${path}: ${r.body.slice(0, 300)}`);
  return r;
};
const policies = async (role = 'hr') => (await call('hr/policies', { role })).json();
const leave = async () => (await policies()).rows.find((d) => d.kind === 'leave');
const upload = (bytes, version, revision, expected = 200, name = 'Leave policy.docx', role = 'hr') =>
  call('hr/policies/docx', { role, expected, body: { kind: 'leave', title: 'Synthetic leave', version, revision, name, data: bytes.toString('base64') } });
const fixture = policyDocx({ application: 'Microsoft Office Word' });
const FAKE = 'A'.repeat(43), NOBODY = '00000000-0000-4000-8000-000000000000';

// ------------------------------------------------------------------------------------------ off (the default)
for (const k of ['PULSE_POLICY_EDITOR', 'PULSE_POLICY_EDITOR_URL', 'PULSE_POLICY_EDITOR_PULSE_URL', 'PULSE_POLICY_EDITOR_SECRET_FILE', 'PULSE_POLICY_EDITOR_FIDELITY_RECEIPT']) delete process.env[k];
let list = await policies();
assert.deepEqual([list.word.enabled, list.word.reason], [false, 'off']);
assert.equal((await policies('member')).word, null, 'employees are not told about the editor');
assert.equal((await upload(fixture, 0, 1, 409)).json().error, 'Word (.docx) editing is off until an editor service is approved and connected.');
await call('hr/policies/word-session', { body: { documentId: NOBODY }, expected: 409 });
await call(`policy-editor/${FAKE}/file`, { role: null, expected: 404 });
await call(`policy-editor/${FAKE}/callback`, { role: null, body: { token: signJwt({ key: 'k', status: 1 }, SECRET) }, expected: 404 });
await upload(fixture, 0, 1, 403, 'Leave.docx', 'member');
await call('hr/policies/word-session', { role: 'member', body: { documentId: NOBODY }, expected: 403 });
await call(`hr/policies/${NOBODY}/docx`, { role: 'member', expected: 403 });

// ----------------------------------------------------------------------------------- on, as a trial (no receipt)
const secretFile = join(process.env.TEST_TMP, 'policy-editor.secret');
await writeFile(secretFile, SECRET + '\n'); await chmod(secretFile, 0o600);
Object.assign(process.env, { PULSE_POLICY_EDITOR: 'onlyoffice', PULSE_POLICY_EDITOR_URL: providerBase, PULSE_POLICY_EDITOR_PULSE_URL: 'http://127.0.0.1:9', PULSE_POLICY_EDITOR_SECRET_FILE: secretFile });
list = await policies();
assert.equal(list.word.enabled, true); assert.equal(list.word.fidelitySignedOff, false); assert.match(list.word.label, /trial/);
assert.equal(JSON.stringify(list).includes(SECRET), false);
await upload(fixture, 0, 1, 403, 'Leave.docx', 'member');
assert.match((await upload(Buffer.from('%PDF-1.7 synthetic'), 0, 1, 400)).json().error, /not a Word document/);
assert.match((await upload(fixture, 0, 1, 400, 'Leave.pdf')).json().error, /Word document/);
const up = (await upload(fixture, 0, 1)).json();
assert.deepEqual([up.version, up.revision, up.sha256], [1, 1, sha(fixture)]);
let doc = await leave();
assert.equal(doc.body, FIXTURE_MARKDOWN, 'the reader shows the Word file\'s text');
assert.deepEqual([doc.docx_sha256, doc.docx_name, doc.docx_source], [sha(fixture), 'Leave policy.docx', 'upload']);
const dl = await call(`hr/policies/${up.id}/docx`);
assert.deepEqual(dl.rawPayload, fixture, 'the download is the exact file');
assert.equal(dl.headers['x-pulse-sha256'], sha(fixture));
assert.match(dl.headers['content-disposition'], /^attachment; filename="Leave policy\.docx"$/);
await call(`hr/policies/${up.id}/docx`, { role: 'member', expected: 403 });

// ------------------------------------------------------------------------------------------------ a session
const open = async (documentId) => {
  const s = (await call('hr/policies/word-session', { body: { documentId } })).json();
  const claims = verifyJwt(s.config.token, SECRET);
  assert.ok(claims, 'the configuration is signed with the shared secret');
  assert.equal(claims.document.key, s.config.document.key); assert.equal(claims.document.url, s.config.document.url); assert.equal(claims.editorConfig.callbackUrl, s.config.editorConfig.callbackUrl);
  assert.equal(s.script, `${providerBase}/web-apps/apps/api/documents/api.js`);
  assert.equal(JSON.stringify(s).includes(SECRET), false, 'the secret never leaves the API');
  const token = s.config.document.url.match(/^http:\/\/127\.0\.0\.1:9\/api\/policy-editor\/([A-Za-z0-9_-]{43})\/file$/)[1];
  assert.equal(s.config.editorConfig.callbackUrl, `http://127.0.0.1:9/api/policy-editor/${token}/callback`);
  return { ...s, token, key: s.config.document.key };
};
let s = await open(up.id);
await call(`policy-editor/${s.token}/file`, { role: null, expected: 403 });
await call(`policy-editor/${s.token}/file`, { role: null, headers: { authorization: `Bearer ${signJwt({ payload: { url: 'x' } }, WRONG)}` }, expected: 403 });
assert.deepEqual((await call(`policy-editor/${s.token}/file`, { role: null, headers: { authorization: `Bearer ${signJwt({ payload: { url: 'x' } }, SECRET)}` } })).rawPayload, fixture);
await call(`policy-editor/${FAKE}/file`, { role: null, headers: { authorization: `Bearer ${signJwt({}, SECRET)}` }, expected: 404 });

const callback = (session, claims, { expected = 200, secret = SECRET, header = false } = {}) => call(`policy-editor/${session.token}/callback`, {
  role: null, expected,
  body: header ? { status: claims.status, key: 'unsigned-field-ignored' } : { token: signJwt(claims, secret) },
  headers: header ? { authorization: `Bearer ${signJwt({ payload: claims }, secret)}` } : {},
});
const edited = (text) => policyDocx({ application: 'ONLYOFFICE/9.0.0', text });
files.set('/cache/edit-1.docx', edited('how leave works in Pulse'));
files.set('/cache/not-word.docx', Buffer.from('%PDF-1.7 synthetic'));
await call(`policy-editor/${s.token}/callback`, { role: null, body: { key: s.key, status: 2, url: `${providerBase}/cache/edit-1.docx` }, expected: 403 });
await callback(s, { key: s.key, status: 2, url: `${providerBase}/cache/edit-1.docx` }, { secret: WRONG, expected: 403 });
assert.deepEqual((await callback(s, { key: s.key, status: 1, users: ['synthetic'] })).json(), { error: 0 });
for (const url of [`${evilBase}/edit-1.docx`, `http://127.0.0.1:1@${evilBase.slice(7)}/x`, 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', `${providerBase.replace('127.0.0.1', 'localhost')}/cache/edit-1.docx`])
  assert.deepEqual((await callback(s, { key: s.key, status: 2, url }, { expected: 400 })).json(), { error: 1 });
await callback(s, { key: s.key, status: 2, url: `${providerBase}/redirect` }, { expected: 502 });
await callback(s, { key: s.key, status: 2, url: `${providerBase}/cache/not-word.docx` }, { expected: 422 });
await callback(s, { key: 'pulse-another-document', status: 2, url: `${providerBase}/cache/edit-1.docx` }, { expected: 400 });
assert.equal(evilHits, 0, 'no saved file was fetched from anywhere but the editor service');
assert.equal((await leave()).revision, 1, 'nothing was saved by the refused callbacks');
// Saved while still open (Authorization form), then the session keeps saving.
assert.deepEqual((await callback(s, { key: s.key, status: 6, url: `${providerBase}/cache/edit-1.docx?md5=x&expires=1` }, { header: true })).json(), { error: 0 });
doc = await leave();
assert.deepEqual([doc.revision, doc.docx_sha256, doc.docx_source], [2, sha(files.get('/cache/edit-1.docx')), 'editor']);
assert.match(doc.body, /how leave works in Pulse/);
// HR uploads meanwhile: the session's key is now stale and cannot overwrite the newer draft.
files.set('/cache/edit-2.docx', edited('a stale edit'));
await upload(policyDocx({ application: 'Microsoft Office Word', text: 'how leave works, uploaded' }), 1, 2);
assert.deepEqual((await callback(s, { key: s.key, status: 2, url: `${providerBase}/cache/edit-2.docx` }, { expected: 409 })).json(), { error: 1 });
doc = await leave();
assert.equal(doc.revision, 3); assert.match(doc.body, /uploaded/); assert.doesNotMatch(doc.body, /stale edit/);
await callback({ token: FAKE }, { key: s.key, status: 1 }, { expected: 404 });

// Publish; a session opened on the draft before publishing is stale; one opened on the published version saves version 2.
s = await open(doc.id);
await call('hr/policies/publish', { body: { documentId: doc.id, revision: 3 } });
assert.equal((await callback(s, { key: s.key, status: 2, url: `${providerBase}/cache/edit-2.docx` }, { expected: 409 })).statusCode, 409);
const published = await call(`hr/policies/${doc.id}/docx`);
assert.equal(published.headers['x-pulse-sha256'], doc.docx_sha256, 'the published version keeps its exact file');
s = await open(doc.id);
files.set('/cache/edit-3.docx', edited('how leave works in version two'));
await callback(s, { key: s.key, status: 2, url: `${providerBase}/cache/edit-3.docx` });
const v2 = await leave();
assert.deepEqual([v2.version, v2.status, v2.revision, v2.docx_source], [2, 'draft', 1, 'editor']);
assert.equal((await call(`hr/policies/${doc.id}/docx`)).headers['x-pulse-sha256'], doc.docx_sha256);
assert.equal((await policies('member')).rows.find((d) => d.kind === 'leave').version, 1, 'employees still read version 1');

// --------------------------------------------------------------------------- switched off again: no lock-in
delete process.env.PULSE_POLICY_EDITOR;
await call(`policy-editor/${FAKE}/callback`, { role: null, body: { token: signJwt({ key: 'k', status: 1 }, SECRET) }, expected: 404 });
assert.equal((await call(`hr/policies/${v2.id}/docx`)).headers['x-pulse-sha256'], v2.docx_sha256, 'HR still downloads stored Word files');

provider.close(); evil.close(); await app.close(); await pool.end();
await writeFile(process.env.PULSE_R41_REPORT, JSON.stringify({ checks, evilHits, providerHits, source: 'loopback stand-in provider (mock), synthetic tenant' }));
console.log(`R41 runner: ${checks} API checks, provider stand-in hits ${providerHits}, other-origin hits ${evilHits}`);
