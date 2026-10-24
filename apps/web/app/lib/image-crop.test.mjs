// PEOPLE-CONTACTS: the cropper's maths. EXIF orientation is read from real JPEG structure (a minimal baseline JPEG
// with an APP1 segment added the way the browser probe adds it); the frame is always covered, whatever the angle.
import assert from 'node:assert/strict';
import test from 'node:test';
import { clampView, covers, exifOrientation, framePointToImage, minScale, orient, outputSize, spring, withOrientation, zoomAt } from './image-crop.mjs';

// SOI, a JFIF APP0, a comment, then start of scan: enough structure for the marker walk.
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xfe, 0x00, 0x04, 0x68, 0x69, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);

test('EXIF orientation: read when present, 1 otherwise', () => {
  assert.equal(exifOrientation(jpeg), 1, 'no EXIF');
  for (let o = 1; o <= 8; o++) assert.equal(exifOrientation(withOrientation(jpeg, o)), o, `orientation ${o}`);
  assert.equal(exifOrientation(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), 1, 'a PNG has none');
  assert.equal(exifOrientation(new Uint8Array(0)), 1, 'empty');
  const broken = withOrientation(jpeg, 6).slice(0, 20);
  assert.equal(exifOrientation(broken), 1, 'a cut-off file does not throw');
  // Little-endian (Intel) EXIF, as many phones write it.
  const ii = withOrientation(jpeg, 0);
  ii.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x08, 0x00], 12);
  assert.equal(exifOrientation(ii), 8, 'Intel byte order');
  assert.equal(exifOrientation(withOrientation(jpeg, 9)), 1, 'an impossible value is ignored');
});

test('orientation transforms land every corner inside the upright picture', () => {
  for (let o = 1; o <= 8; o++) {
    const { width, height, matrix: [a, b, c, d, e, f] } = orient(o, 40, 30);
    assert.deepEqual([width, height], o >= 5 ? [30, 40] : [40, 30], `size for ${o}`);
    for (const [x, y] of [[0, 0], [40, 0], [0, 30], [40, 30]]) {
      const X = a * x + c * y + e, Y = b * x + d * y + f;
      assert.ok(X >= 0 && X <= width && Y >= 0 && Y <= height, `corner ${x},${y} for orientation ${o}`);
    }
  }
  // 6 = turn clockwise: the sensor's top-left becomes the top-right.
  const [a, b, c, d, e, f] = orient(6, 40, 30).matrix; assert.deepEqual([a * 0 + c * 0 + e, b * 0 + d * 0 + f], [30, 0]);
});

test('the frame stays covered: least scale, panning and turning', () => {
  const frame = { w: 300, h: 300 }, image = { w: 1200, h: 800 };
  assert.equal(minScale(frame, image, 0), 300 / 800, 'the short side fills the frame');
  assert.ok(Math.abs(minScale(frame, image, 45) - (300 * Math.SQRT2) / 800) < 1e-9, 'turned 45°: the diagonal');
  const small = clampView({ x: 0, y: 0, scale: 0.1, angle: 0 }, frame, image);
  assert.equal(small.scale, 300 / 800, 'zoomed out too far comes back');
  const far = clampView({ x: 5000, y: -5000, scale: 300 / 800, angle: 0 }, frame, image);
  assert.deepEqual([Math.round(far.x), Math.round(far.y)], [75, 0], 'dragged too far stops at the edge');
  assert.equal(clampView({ x: 0, y: 0, scale: 100, angle: 0 }, frame, image, 8).scale, (300 / 800) * 8, 'zoom has a ceiling');
  for (const angle of [-45, -17, 0, 13, 90, 180, 270, 31]) {
    for (const [x, y, scale] of [[900, 40, 0.2], [-300, 600, 1], [12, -7, 0.6]]) {
      const v = clampView({ x, y, scale, angle }, frame, image);
      assert.ok(covers(v, frame, image), `covered at ${angle}° from ${x},${y}`);
      for (const p of [{ x: -150, y: -150 }, { x: 150, y: -150 }, { x: -150, y: 150 }, { x: 150, y: 150 }]) {
        const q = framePointToImage(v, image, p);
        assert.ok(q.x >= -0.01 && q.x <= image.w + 0.01 && q.y >= -0.01 && q.y <= image.h + 0.01, `frame corner inside the picture at ${angle}°`);
      }
    }
  }
  assert.equal(covers({ x: 0, y: 0, scale: 0.2, angle: 0 }, frame, image), false);
});

test('zooming keeps the point under the fingers still', () => {
  const view = { x: 20, y: -10, scale: 0.5, angle: 30 }, image = { w: 1000, h: 1000 }, at = { x: 60, y: 40 };
  const before = framePointToImage(view, image, at), after = framePointToImage(zoomAt(view, 1.7, at), image, at);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
});

test('saved size: sharp, never blown up past what the picture has', () => {
  assert.deepEqual(outputSize({ w: 300, h: 300 }, { x: 0, y: 0, scale: 0.25, angle: 0 }, 1), { width: 1024, height: 1024 }, 'a big photo gives the full size');
  assert.deepEqual(outputSize({ w: 300, h: 300 }, { x: 0, y: 0, scale: 2, angle: 0 }, 1), { width: 256, height: 256 }, 'a tiny crop stays small');
  assert.deepEqual(outputSize({ w: 400, h: 100 }, { x: 0, y: 0, scale: 0.1, angle: 0 }, 4, 1600), { width: 1600, height: 400 }, 'a wide logo');
});

test('the spring settles without overshoot', () => {
  let s = { value: 0, velocity: 0 }; let max = 0;
  for (let i = 0; i < 90; i++) { s = spring(s.value, 100, s.velocity, 1 / 60); max = Math.max(max, s.value); }
  assert.ok(Math.abs(s.value - 100) < 0.5, 'arrives'); assert.ok(max <= 100.0001, 'never past the target');
});
