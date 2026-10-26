// LAYOUT-SWEEP: an organisation's uploaded logo is a picture, never a document that runs or loads anything.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { brandBytesOk, safeSvg } from "../dist/brand.js";

const ea = (name) => readFileSync(new URL(`../../../packages/design-system/brand/org/estate-autopilots/${name}`, import.meta.url));

test("the official EA logo files pass as they are", () => {
  for (const name of ["ea-mark.svg", "ea-logo.svg", "ea-logo-on-dark.svg", "ea-logo-mono.svg"]) assert.equal(brandBytesOk(ea(name), "image/svg+xml"), true, name);
  assert.equal(brandBytesOk(ea("ea-logo-96.png"), "image/png"), true);
});

test("an SVG that scripts, embeds or links elsewhere is refused", () => {
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><path id="a" d="M0 0h10v10z"/></defs><use href="#a" fill="#fbc701"/></svg>';
  assert.equal(safeSvg(ok), true);
  for (const bad of [
    '<svg><script>alert(1)</script></svg>', '<svg onload="alert(1)"><rect/></svg>', '<svg><foreignObject><div/></foreignObject></svg>',
    '<svg><image href="https://example.com/x.png"/></svg>', '<svg><a href="javascript:alert(1)"><rect/></a></svg>', '<svg><rect style="fill:url(https://x/y)"/></svg>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>', '<html><svg/></html>',
  ]) assert.equal(safeSvg(bad), false, bad);
});

test("bytes must match the declared picture type", () => {
  assert.equal(brandBytesOk(ea("ea-logo-96.png"), "image/jpeg"), false);
  assert.equal(brandBytesOk(Buffer.from("not a png"), "image/png"), false);
  assert.equal(brandBytesOk(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), "image/jpeg"), true);
  assert.equal(brandBytesOk(Buffer.from("RIFF\0\0\0\0WEBPVP8 "), "image/webp"), true);
  assert.equal(brandBytesOk(ea("ea-logo.svg"), "image/gif"), false);
});
