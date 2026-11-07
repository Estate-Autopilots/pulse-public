// PRESENCE-2: envelope encryption for ID files and bank details. Throwaway keys generated per test; synthetic files.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentKeyError, documentContext, loadKeyring, open, parseKeyring, requireKeyring, rewrap, seal } from '../dist/document-keys.js';

const key = () => randomBytes(32).toString('base64');
const line = (id, k) => `${id} ${k}\n`;
const ORG = '00000000-0000-4000-8000-000000000001', PERSON = '00000000-0000-4000-8000-000000000002';
const ctx = documentContext(ORG, PERSON, 'aadhaar');
const PDF = Buffer.from('%PDF-1.4\n% synthetic masked aadhaar\n');
const encodings = (k) => { const b = Buffer.from(k, 'base64'); return [k, b.toString('hex'), b.toString('base64url')]; };

test('keyring: one "<id> <base64 key>" per line, the last seals new files, anything malformed rejects the whole file', () => {
  const a = key(), b = key();
  const ring = parseKeyring(`# Pulse document master keys\n${line('doc-2026-10', a)}\n${line('doc-2027-01', b)}`);
  assert.equal(ring.active, 'doc-2027-01');
  assert.deepEqual([...ring.keys.keys()], ['doc-2026-10', 'doc-2027-01']);
  assert.equal(parseKeyring(''), null, 'an empty keyring is no keyring');
  assert.equal(parseKeyring(line('doc-1', a) + line('doc-1', b)), null, 'a repeated ID is refused');
  assert.equal(parseKeyring(line('doc-1', randomBytes(16).toString('base64'))), null, 'a 128-bit key is refused');
  assert.equal(parseKeyring(line('doc 1', a)), null, 'an ID with spaces is refused');
  assert.equal(parseKeyring(`doc-1 ${a} extra\n`), null, 'trailing words are refused');
  assert.equal(parseKeyring(line('../x', a)), null, 'an ID is a plain name');
  assert.equal(parseKeyring(`doc-1 ${a}\r\n`).active, 'doc-1', 'Windows line endings are fine');
});

test('the keyring file: missing, world-readable or malformed is refused with a reason and nothing else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-doc-keys-')); const file = join(dir, 'document-master.key'); const old = process.env.PULSE_DOCUMENT_KEY_FILE;
  try {
    assert.deepEqual(await loadKeyring(file), { ok: false, reason: 'missing' });
    const k = key();
    await writeFile(file, line('doc-1', k), { mode: 0o644 }); await chmod(file, 0o644);
    assert.deepEqual(await loadKeyring(file), { ok: false, reason: 'exposed' }, 'a key everyone on the machine can read is not used');
    await chmod(file, 0o640);
    assert.equal((await loadKeyring(file)).ok, true, 'root:eaops 0640, as installed');
    await writeFile(file, 'not a keyring\n');
    assert.deepEqual(await loadKeyring(file), { ok: false, reason: 'invalid' });
    process.env.PULSE_DOCUMENT_KEY_FILE = join(dir, 'absent.key');
    await assert.rejects(requireKeyring('upload'), (e) => {
      assert.ok(e instanceof DocumentKeyError); assert.equal(e.statusCode, 503); assert.equal(e.expose, true);
      assert.match(e.message, /ID files can’t be uploaded yet: the document encryption key isn’t installed/);
      assert.match(e.message, /Nothing was saved\. HR: ask the Pulse administrator/);
      return true;
    });
    await assert.rejects(requireKeyring('bank'), /Bank details can’t be saved yet/);
    await assert.rejects(requireKeyring('open'), /This file can’t be opened/);
    // READY: a key file that is there but malformed says so (AC's had a bare key without its ID and read "isn’t installed").
    process.env.PULSE_DOCUMENT_KEY_FILE = file;
    await assert.rejects(requireKeyring('pay'), (e) => { assert.match(e.message, /installed but not in the right format/); assert.doesNotMatch(e.message, /isn’t installed/); assert.equal(e.reason, 'invalid'); return true; });
  } finally {
    if (old === undefined) delete process.env.PULSE_DOCUMENT_KEY_FILE; else process.env.PULSE_DOCUMENT_KEY_FILE = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test('sealing: a fresh data key per file, wrapped by the master key; bound to whose file it is', () => {
  const k = key(); const ring = parseKeyring(line('doc-1', k));
  const one = seal(ring, PDF, ctx), two = seal(ring, PDF, ctx);
  assert.equal(one.keyId, 'doc-1');
  assert.equal(one.data.length, PDF.length + 29, 'version, IV and tag add 29 bytes');
  assert.ok(!one.data.equals(two.data) && !one.dataKey.equals(two.dataKey), 'the same file sealed twice looks different');
  assert.deepEqual(open(ring, one, ctx), PDF);
  for (const blob of [one.data, one.dataKey]) {
    assert.equal(blob.indexOf(Buffer.from(k, 'base64')), -1, 'no master key bytes in what is stored');
    assert.equal(blob.indexOf(PDF.subarray(0, 12)), -1, 'no plaintext in what is stored');
    for (const text of encodings(k)) assert.ok(!blob.toString('latin1').includes(text));
  }
  assert.throws(() => open(ring, one, documentContext(ORG, '00000000-0000-4000-8000-000000000003', 'aadhaar')), DocumentKeyError, 'moved onto another person, it does not open');
  assert.throws(() => open(ring, one, documentContext(ORG, PERSON, 'pan')), DocumentKeyError, 'nor as another kind of document');
  const tampered = Buffer.from(one.data); tampered[20] ^= 1;
  assert.throws(() => open(ring, { ...one, data: tampered }, ctx), /does not match its encryption key/);
  assert.throws(() => open(parseKeyring(line('doc-1', key())), one, ctx), /does not match its encryption key/, 'another key under the same ID does not open it');
});

test('rotation: new files use the new key, older ones still open, and re-wrapping retires the old key', () => {
  const k1 = key(), k2 = key();
  const before = parseKeyring(line('doc-2026-10', k1));
  const old = seal(before, PDF, ctx);
  const rotated = parseKeyring(line('doc-2026-10', k1) + line('doc-2027-01', k2));
  assert.deepEqual(open(rotated, old, ctx), PDF, 'an older file opens with its own key ID');
  const fresh = seal(rotated, Buffer.from('%PDF-1.4\n% newer\n'), ctx);
  assert.equal(fresh.keyId, 'doc-2027-01', 'new files use the newest key');
  const moved = rewrap(rotated, old.keyId, old.dataKey, ctx);
  assert.equal(moved.keyId, 'doc-2027-01');
  const retired = parseKeyring(line('doc-2027-01', k2));
  assert.deepEqual(open(retired, { ...old, ...moved }, ctx), PDF, 'after re-wrapping, the old key can leave the keyring; the file itself never changed');
  assert.throws(() => open(retired, old, ctx), (e) => {
    assert.ok(e instanceof DocumentKeyError); assert.equal(e.reason, 'unknown-key');
    assert.match(e.message, /document key “doc-2026-10”, which this Pulse server’s keyring no longer lists/);
    for (const text of [...encodings(k1), ...encodings(k2)]) assert.ok(!e.message.includes(text), 'the refusal names the key ID, never the key');
    return true;
  });
});
