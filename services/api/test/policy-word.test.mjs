// R41: Word policies without a provider: the .docx checks, the reader text, the provider adapter's signatures, its
// saved-file fetch (no other origin, no redirect, no oversize file), the off/on/trial gate and the round-trip verdict.
// Synthetic files and throwaway secrets only; the database side is tests/core/test_policy_word.py.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { checkDocx, docxFeatures, docxMarkdown, DocxError, readZip, writeZip } from '../dist/policy-docx.js';
import { editorConfig, fetchSaved, savedFileUrl, signedCallback, signJwt, verifyJwt, wordEditor } from '../dist/policy-word.js';
import { fidelityReceipt } from '../dist/docx-fidelity.js';
import { FIXTURE_MARKDOWN, policyDocx } from './policy-docx-fixture.mjs';

const SECRET = 'synthetic-editor-secret-0123456789abcdef', OTHER = 'another-synthetic-secret-0123456789abcdef';
const refuses = (bytes, pattern) => assert.throws(() => checkDocx(bytes), (e) => e instanceof DocxError && pattern.test(e.message), String(pattern));
const replace = (bytes, name, fn) => { const z = readZip(bytes), files = {}; for (const n of z.names) files[n] = n === name ? fn(z.text(n)) : z.text(n); return writeZip(files); };

test('a Word file becomes the reader text: headings, bold, nested and numbered lists, a table with a merged cell', () => {
  assert.equal(docxMarkdown(checkDocx(policyDocx())), FIXTURE_MARKDOWN);
  // Tracked deletions are not text; a paragraph that starts like Markdown stays a paragraph.
  const tricky = replace(policyDocx(), 'word/document.xml', (x) => x.replace('<w:body>', '<w:body><w:p><w:r><w:t>1. Not a list</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p><w:p><w:r><w:t># not a heading | pipe *star*</w:t></w:r></w:p>'));
  assert.ok(docxMarkdown(checkDocx(tricky)).startsWith('1\\. Not a list\n\n\\# not a heading \\| pipe \\*star\\*\n\n# Synthetic leave policy'));
});

test('only a plain Word document is opened: old/protected files, macros, templates, DTDs, damage and size are refused', () => {
  refuses(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]), /old Word \(\.doc\) or password-protected/);
  refuses(Buffer.from('%PDF-1.7 synthetic'), /not a Word document/);
  refuses(replace(policyDocx(), 'word/styles.xml', (x) => x).subarray(0, 400), /damaged/);
  refuses(writeZip({ ...Object.fromEntries(readZip(policyDocx()).names.map((n) => [n, readZip(policyDocx()).text(n)])), 'word/vbaProject.bin': Buffer.from('synthetic') }), /macros/);
  refuses(replace(policyDocx(), '[Content_Types].xml', (x) => x.replace('document.main+xml', 'template.main+xml')), /template/);
  refuses(replace(policyDocx(), '[Content_Types].xml', (x) => x.replace('officedocument.wordprocessingml.document.main+xml', 'ms-word.document.macroEnabled.main+xml')), /macros/);
  refuses(replace(policyDocx(), 'word/document.xml', (x) => x.replace('<w:document', '<!DOCTYPE w [<!ENTITY a "aaaa">]><w:document')), /document type definition/);
  refuses(replace(policyDocx(), 'word/document.xml', (x) => x.replace('</w:body>', '</w:bod>')), /damaged/);
  refuses(Buffer.concat([policyDocx(), Buffer.alloc(5 * 1024 * 1024)]), /at most 5 MB/);
  // An encrypted entry, a wrong checksum and an entry that inflates past what it declares.
  const enc = Buffer.from(policyDocx()); const cd = enc.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); enc.writeUInt16LE(1, cd + 8); refuses(enc, /password-protected/);
  const crc = Buffer.from(policyDocx()); crc.writeUInt32LE(0, crc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16); refuses(crc, /damaged/);
  const bomb = writeZip({ '[Content_Types].xml': 'x' }); const big = deflateRawSync(Buffer.alloc(3_000_000, 32));
  const forged = Buffer.concat([bomb.subarray(0, 30 + 19), big]); forged.writeUInt32LE(big.length, 18); forged.writeUInt32LE(10, 22);
  const dir = Buffer.from(bomb.subarray(bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])))); dir.writeUInt32LE(big.length, 20); dir.writeUInt32LE(10, 24); dir.writeUInt32LE(forged.length, dir.length - 6);
  assert.throws(() => readZip(Buffer.concat([forged, dir])).text('[Content_Types].xml'), /damaged/);
});

test('signatures: HS256 with the shared secret only; alg none, another key, tampering and expiry are refused', () => {
  const t = signJwt({ key: 'k', status: 2, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  assert.equal(verifyJwt(t, SECRET).key, 'k');
  assert.equal(verifyJwt(t, OTHER), null);
  const [, body, sig] = t.split('.');
  assert.equal(verifyJwt(`${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${body}.`, SECRET), null);
  assert.equal(verifyJwt(`${Buffer.from('{"alg":"HS512","typ":"JWT"}').toString('base64url')}.${body}.${sig}`, SECRET), null);
  assert.equal(verifyJwt(`${t.split('.')[0]}.${Buffer.from('{"key":"other","status":2}').toString('base64url')}.${sig}`, SECRET), null);
  assert.equal(verifyJwt(signJwt({ key: 'k', exp: Math.floor(Date.now() / 1000) - 3600 }, SECRET), SECRET), null);
  assert.equal(verifyJwt('not.a.token', SECRET), null);
  assert.equal(verifyJwt(12, SECRET), null);
});

test('a callback is what the provider signed: body token, or Authorization with claims under payload; never unsigned fields', () => {
  const claims = { key: 'pulse-k', status: 2, url: 'https://docs.example.test/cache/out.docx' };
  assert.deepEqual(signedCallback({ token: signJwt(claims, SECRET), key: 'forged', url: 'https://evil.example.test/x' }, undefined, SECRET), claims);
  assert.deepEqual(signedCallback({ key: 'forged' }, `Bearer ${signJwt({ payload: claims }, SECRET)}`, SECRET), claims);
  assert.equal(signedCallback({ key: 'pulse-k', status: 2, url: claims.url }, undefined, SECRET), null, 'unsigned');
  assert.equal(signedCallback({ token: signJwt(claims, OTHER) }, `Bearer ${signJwt({ payload: claims }, SECRET)}`, SECRET), null, 'a bad body token is not rescued by the header');
  assert.equal(signedCallback({}, `Basic ${signJwt(claims, SECRET)}`, SECRET), null);
});

test('the saved file is fetched only from the editor service origin: no other host, port, scheme or credentials', () => {
  const server = new URL('https://docs.example.test');
  assert.equal(savedFileUrl('https://docs.example.test/cache/files/k/output.docx?md5=x&expires=1', server)?.pathname, '/cache/files/k/output.docx');
  assert.equal(savedFileUrl('https://DOCS.example.test:443/cache/a.docx', server)?.host, 'docs.example.test');
  for (const bad of ['https://docs.example.test.evil.test/a', 'https://docs.example.test@evil.test/a', 'https://user:pw@docs.example.test/a', 'http://docs.example.test/a',
    'https://docs.example.test:8443/a', 'https://127.0.0.1/a', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', 'javascript:alert(1)', '//docs.example.test/a', '', 7, null])
    assert.equal(savedFileUrl(bad, server), null, String(bad));
});

test('fetching a saved file: redirects are refused and nothing past 5 MB is read', async (t) => {
  let hits = 0;
  const srv = createServer((req, res) => {
    hits++;
    if (req.url === '/ok') { res.end(policyDocx()); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
    if (req.url === '/declared') { res.writeHead(200, { 'content-length': String(6 * 1024 * 1024) }); res.end(); return; }
    res.writeHead(200); for (let i = 0; i < 7; i++) res.write(Buffer.alloc(1024 * 1024)); res.end();
  });
  await new Promise((done) => srv.listen(0, '127.0.0.1', done)); t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  assert.deepEqual(await fetchSaved(new URL(base + '/ok')), policyDocx());
  await assert.rejects(fetchSaved(new URL(base + '/redirect')));
  await assert.rejects(fetchSaved(new URL(base + '/declared')), /at most 5 MB/);
  await assert.rejects(fetchSaved(new URL(base + '/stream')), /at most 5 MB/);
  assert.equal(hits, 4, 'the redirect target was never requested');
});

test('the gate: off by default; on only with an https service, a private secret file; "trial" until a passing receipt', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'r41-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const secret = join(dir, 'secret'); await writeFile(secret, SECRET + '\n'); await chmod(secret, 0o600);
  const env = { PULSE_POLICY_EDITOR: 'onlyoffice', PULSE_POLICY_EDITOR_URL: 'https://docs.example.test', PULSE_POLICY_EDITOR_PULSE_URL: 'https://pulse.example.test', PULSE_POLICY_EDITOR_SECRET_FILE: secret };
  assert.deepEqual((await wordEditor({})).status, { enabled: false, provider: 'onlyoffice', reason: 'off', label: 'Word (.docx) editing is off until an editor service is approved and connected.', fidelitySignedOff: false, maxBytes: 5242880 });
  const on = await wordEditor(env);
  assert.equal(on.status.enabled, true); assert.equal(on.status.fidelitySignedOff, false); assert.match(on.status.label, /trial/);
  assert.equal(JSON.stringify(on.status).includes(SECRET), false, 'the status never carries the secret');
  assert.equal((await wordEditor({ ...env, PULSE_POLICY_EDITOR_URL: 'http://docs.example.test' })).status.reason, 'server');
  assert.equal((await wordEditor({ ...env, PULSE_POLICY_EDITOR_URL: 'https://u:p@docs.example.test' })).status.reason, 'server');
  assert.equal((await wordEditor({ ...env, PULSE_POLICY_EDITOR_PULSE_URL: '', PULSE_PUBLIC_URL: '' })).status.reason, 'pulse_url');
  assert.equal((await wordEditor({ ...env, PULSE_POLICY_EDITOR_SECRET_FILE: join(dir, 'missing') })).status.reason, 'secret_missing');
  await chmod(secret, 0o644); assert.equal((await wordEditor(env)).status.reason, 'secret_exposed'); await chmod(secret, 0o600);
  const weak = join(dir, 'weak'); await writeFile(weak, 'short'); await chmod(weak, 0o600);
  assert.equal((await wordEditor({ ...env, PULSE_POLICY_EDITOR_SECRET_FILE: weak })).status.reason, 'secret_weak');
  const receipt = join(dir, 'receipt.json');
  await writeFile(receipt, JSON.stringify({ tool: 'pulse-docx-fidelity/1', verdict: 'cannot_pass' }));
  assert.equal((await wordEditor({ ...env, PULSE_POLICY_EDITOR_FIDELITY_RECEIPT: receipt })).status.fidelitySignedOff, false);
  await writeFile(receipt, JSON.stringify({ tool: 'pulse-docx-fidelity/1', verdict: 'pass' }));
  const signed = await wordEditor({ ...env, PULSE_POLICY_EDITOR_FIDELITY_RECEIPT: receipt });
  assert.equal(signed.status.fidelitySignedOff, true); assert.equal(signed.status.label, 'Word editing is on.');
});

test('the editor configuration is signed whole for one document and never carries the secret', () => {
  const c = editorConfig({ key: 'pulse-abc', title: 'Leave.docx', fileUrl: 'https://pulse.example.test/api/policy-editor/T/file', callbackUrl: 'https://pulse.example.test/api/policy-editor/T/callback',
    person: '00000000-0000-4000-8000-000000000001', name: 'Synthetic HR', expiresAt: new Date(Date.now() + 3600e3).toISOString() }, SECRET);
  const claims = verifyJwt(c.token, SECRET);
  assert.equal(claims.document.key, 'pulse-abc'); assert.equal(claims.document.url, c.document.url); assert.equal(claims.editorConfig.callbackUrl, c.editorConfig.callbackUrl);
  assert.ok(claims.exp > Date.now() / 1000);
  assert.equal(JSON.stringify(c).includes(SECRET), false);
});

test('round-trip verdict: generator output cannot pass; Word → editor → Word passes only when nothing changed', () => {
  const gen = fidelityReceipt([{ role: 'word', name: 'a.docx', bytes: policyDocx() }, { role: 'browser', name: 'b.docx', bytes: policyDocx() }, { role: 'back', name: 'c.docx', bytes: policyDocx() }]);
  assert.equal(gen.verdict, 'cannot_pass');
  assert.ok(gen.reasons.some((r) => /generator output cannot pass/.test(r)));
  assert.ok(gen.comparisons.every((c) => Object.values(c.categories).every((k) => k.ok)), 'identical files compare equal, yet cannot pass');
  assert.equal(fidelityReceipt([{ role: 'word', name: 'a.docx', bytes: policyDocx({ application: 'Microsoft Office Word' }) }]).verdict, 'cannot_pass', 'one leg is not a round trip');
  const word = policyDocx({ application: 'Microsoft Office Word' }), back = policyDocx({ application: 'Microsoft Office Word', extra: { 'docProps/core.xml': '<x/>' } });
  const legs = (browser) => [{ role: 'word', name: 'a.docx', bytes: word }, { role: 'browser', name: 'b.docx', bytes: browser }, { role: 'back', name: 'c.docx', bytes: back }];
  assert.equal(fidelityReceipt(legs(policyDocx({ application: 'ONLYOFFICE/9.0.0' }))).verdict, 'pass');
  assert.equal(fidelityReceipt(legs(word)).verdict, 'cannot_pass', 'the editor leg must be saved by the editor');
  const changed = (options) => {
    const r = fidelityReceipt(legs(policyDocx({ application: 'ONLYOFFICE/9.0.0', ...options })));
    assert.equal(r.verdict, 'fail');
    return Object.entries(r.comparisons.find((c) => c.to === 'browser').categories).filter(([, v]) => !v.ok).map(([k]) => k);
  };
  assert.deepEqual(changed({ header: false }), ['headersFooters']);
  assert.deepEqual(changed({ merged: false }), ['tables']);
  assert.deepEqual(changed({ font: 'Times New Roman' }), ['fonts']);
  assert.deepEqual(changed({ numbered: 'bullet' }), ['lists']);
  assert.deepEqual(changed({ pageBreak: false }), ['pageBreaks']);
  assert.deepEqual(changed({ text: 'how leave really works' }), ['text']);
  const f = docxFeatures(checkDocx(word));
  assert.deepEqual([f.headers.length, f.footers.length, f.pageNumbers, f.tables[0].rows, f.tables[0].merged, f.breaks.page, f.fonts.body, f.fonts.headings],
    [1, 1, 1, [2, 2, 2], 1, 1, 'Aptos', 'Aptos Display']);
  assert.deepEqual(f.lists, ['bullet@0', 'bullet@1', 'bullet@0', 'decimal@0', 'decimal@0']);
});
