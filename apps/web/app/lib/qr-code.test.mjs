// AI-AGENTS-3: the Telegram QR scans. What qr-code.mjs draws (the SVG path) is painted into pixels as a screen shows it,
// then read back by jsQR (Apache-2.0, a decoder independent of the encoder): a phone's camera gets the same link.
import { test } from "node:test";
import assert from "node:assert/strict";
import jsQR from "jsqr";
import { QUIET, qrModules, qrPath } from "./qr-code.mjs";

const RECT = /M(\d+) (\d+)h(\d+)v1h-\d+z/g;

/** Paint an SVG path of "M x y h w v 1 h -w z" rectangles into an RGBA image, `scale` pixels per module. */
function paint(d, n, scale) {
  const px = n * scale, img = new Uint8ClampedArray(px * px * 4).fill(255);
  for (const [, x, y, w] of d.matchAll(RECT)) {
    for (let yy = Number(y) * scale; yy < (Number(y) + 1) * scale; yy++) {
      for (let xx = Number(x) * scale; xx < (Number(x) + Number(w)) * scale; xx++) {
        const i = (yy * px + xx) * 4; img[i] = img[i + 1] = img[i + 2] = 0;
      }
    }
  }
  return { img, px };
}

const LINKS = [
  // the shape of a real link: t.me/<bot>?start=<one-time code> (synthetic bot name and codes)
  "https://t.me/VitalsOSTestBot?start=ag_synthetic_code_0001",
  "https://t.me/ExampleCompanyBot?start=EXMP0001234",
];

for (const link of LINKS) {
  test(`a phone reads the QR for ${link.slice(0, 32)}…`, () => {
    const { d, n } = qrPath(link);
    assert.equal(n, qrModules(link).size + QUIET * 2, "the square has the 4-module margin on every side");
    for (const scale of [3, 6]) {
      const { img, px } = paint(d, n, scale);
      const read = jsQR(img, px, px);
      assert.ok(read, `the decoder finds a QR code (${scale} px a module)`);
      assert.equal(read.data, link, "and reads back the exact link");
    }
  });
}

test("the path covers exactly the dark modules", () => {
  const link = LINKS[0], m = qrModules(link), { d } = qrPath(link);
  let fromPath = 0; for (const [, , , w] of d.matchAll(RECT)) fromPath += Number(w);
  let dark = 0; for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.dark(x, y)) dark++;
  assert.equal(fromPath, dark);
});

test("a blank picture is not read as a link", () => {
  assert.equal(jsQR(new Uint8ClampedArray(120 * 120 * 4).fill(255), 120, 120), null);
});
