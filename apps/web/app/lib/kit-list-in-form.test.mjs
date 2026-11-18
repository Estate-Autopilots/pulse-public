// BUGFIX #14 (walk, 14 Nov 2026): a kit list opens in place, so inside a page's form (My desk → Thank a colleague) the
// form's descendant rules (".form label { display: grid }", ".form input { border… }") restyled the list's search field.
// Inside the floating layer the kit's own rules must outrank a page's one-class-plus-element rules.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const kit = readFileSync(new URL("../kit/kit.module.css", import.meta.url), "utf8");
const rule = (selector) => {
  const at = kit.split("}").find((block) => block.split("{")[0].split(",").map((s) => s.trim()).includes(selector));
  return at ? at.slice(at.indexOf("{") + 1) : null;
};

test("the list's search field keeps its one-row look inside any form", () => {
  const box = rule(".layer .lbSearch");
  assert.ok(box, "a layer-scoped rule for the search row exists");
  assert.match(box, /display:\s*flex/);
  const input = rule(".layer .lbSearch input");
  assert.ok(input, "a layer-scoped rule for the search input exists");
  for (const d of [/border:\s*0/, /min-height:\s*0/, /padding:\s*0/, /background:\s*transparent/]) assert.match(input, d);
});

test("the page form that met it still styles only its own fields", () => {
  const form = readFileSync(new URL("../me/my-pulse.module.css", import.meta.url), "utf8");
  // If this page rule ever changes, the kit rule above still protects every other form; this pins the case seen.
  assert.match(form, /\.form label \{ display: grid;/);
});
