// CONTRACTS-PRO: the photo of a signature is cleaned (paper, shadow, ruled line and specks removed), cropped and traced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSignature, signatureSvg, traceLoops, tracePaths } from "./signature-clean.mjs";

/** A synthetic photo: paper lit unevenly (180 → 245), a blue pen stroke, a ruled line and a few specks. */
function photo(w = 320, h = 140) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, paper = 180 + (65 * x) / w;
    let r = paper, g = paper, b = paper - 6;
    if (y >= 118 && y <= 119) { r = paper - 45; g = paper - 45; b = paper - 30; } // the ruled line, across the page
    const sy = 60 + 28 * Math.sin(x / 22);
    if (x > 40 && x < 270 && Math.abs(y - sy) < 3.2) { r = 30; g = 40; b = 120; } // the stroke
    if ((x === 10 && y === 10) || (x === 300 && y === 20) || (x === 150 && y === 130)) { r = 40; g = 40; b = 40; } // specks
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

test("the ink is kept, the paper, ruled line and specks go, and it is cropped", () => {
  const c = cleanSignature(photo());
  assert.equal(c.found, true);
  assert.ok(c.width < 320 && c.width > 220, `width ${c.width}`);
  assert.ok(c.height < 100, `height ${c.height}: the ruled line at y=118 must not stretch the crop`);
  const ink = c.mask.reduce((s, v) => s + v, 0);
  assert.ok(ink > 1000, `ink pixels ${ink}`);
  assert.ok(c.ink[2] > c.ink[0], "a blue pen stays blue");
});

test("an empty page finds no signature", () => {
  const w = 120, h = 60, data = new Uint8ClampedArray(w * h * 4).fill(235);
  assert.equal(cleanSignature({ data, width: w, height: h }).found, false);
});

test("outlines: a square with a hole is two closed loops; paths are smooth closed curves", () => {
  const w = 10, h = 10, m = new Uint8Array(w * h);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) m[y * w + x] = (x >= 4 && x < 6 && y >= 4 && y < 6) ? 0 : 1;
  const loops = traceLoops(m, w, h);
  assert.equal(loops.length, 2);
  const paths = tracePaths(m, w, h);
  assert.equal(paths.length, 2);
  for (const d of paths) assert.match(d, /^M[\d.]+ [\d.]+(Q[\d. ]+)+Z$/);
  assert.match(signatureSvg(paths, w, h), /fill-rule="evenodd"/);
});

test("diagonal pixels that touch at a corner stay two loops", () => {
  const w = 4, h = 4, m = new Uint8Array(w * h);
  m[1 * w + 1] = 1; m[2 * w + 2] = 1;
  assert.equal(traceLoops(m, w, h).length, 2);
});

test("a real stroke traces to a few smooth paths", () => {
  const c = cleanSignature(photo());
  const paths = tracePaths(c.mask, c.width, c.height);
  assert.ok(paths.length >= 1 && paths.length <= 6, `paths ${paths.length}`);
});
