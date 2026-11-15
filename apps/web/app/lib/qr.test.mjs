// The QR encoder for install links. The pinned matrices were checked with an independent decoder (jsQR 1.4.0) on
// 10 Oct 2026, together with versions 1-10 and a UTF-8 text; these hashes guard against regressions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { qrMatrix, qrSvg } from './qr.mjs';

const hash = (m) => createHash('sha256').update(m.map((r) => r.map((c) => (c ? 1 : 0)).join('')).join('\n')).digest('hex').slice(0, 16);

test('decoder-verified matrices stay the same', () => {
  assert.equal(hash(qrMatrix('https://pulse.estateautopilots.com/apps/android')), 'de1ea48c3cae0d82');
  assert.equal(hash(qrMatrix('HELLO')), '71bc9ab3ffcaa0d2');
  assert.equal(hash(qrMatrix('y'.repeat(200))), '9d9550d437781823');
});

test('structure: size by version, finder patterns, dark module, too long refused', () => {
  const m = qrMatrix('HELLO');
  assert.equal(m.length, 21);
  for (const [cx, cy] of [[3, 3], [17, 3], [3, 17]]) {
    assert.equal(m[cy][cx], true, 'finder centre'); assert.equal(m[cy][cx + 2], false, 'finder ring'); assert.equal(m[cy][cx + 3], true, 'finder edge');
  }
  assert.equal(m[21 - 8][8], true, 'the always-dark module');
  assert.equal(qrMatrix('x'.repeat(120)).length, 45, 'version 7');
  assert.throws(() => qrMatrix('z'.repeat(300)));
  assert.match(qrSvg('HELLO', 100, 'Install "Pulse"'), /^<svg[^>]+viewBox="0 0 29 29"[^>]+aria-label="Install &quot;Pulse&quot;"/);
});
