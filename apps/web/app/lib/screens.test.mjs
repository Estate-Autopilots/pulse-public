import test from "node:test";
import assert from "node:assert/strict";
import { hiddenRedirect, hiddenRename, underBase } from "./screens.mjs";

// EST-1420: synthetic paths and ids only.
const bases = ["/map", "/people", "/stewardship/person"];

test("a page is hidden at its base and below it, never at a look-alike", () => {
  assert.equal(underBase("/map", bases), true);
  assert.equal(underBase("/map/money?x=1", bases), true);
  assert.equal(underBase("/mapping", bases), false);
  assert.equal(underBase("/stewardship/person/7", bases), true);
  assert.equal(underBase("/stewardship/project/7", bases), false);
  assert.equal(underBase("/dashboard", undefined), false);
});

test("hidden bases become null renames, which take entries off every menu", () => {
  assert.deepEqual(hiddenRename(["/map", "/sops"]), { "/map": null, "/sops": null });
  assert.deepEqual(hiddenRename(undefined), {});
});

test("a direct link goes to /hidden; one's own profile and /hidden itself never do", () => {
  assert.equal(hiddenRedirect("/map", bases, "p1"), "/hidden");
  assert.equal(hiddenRedirect("/people/p2", bases, "p1"), "/hidden");
  assert.equal(hiddenRedirect("/people/p1", bases, "p1"), null);
  assert.equal(hiddenRedirect("/people/p1/work", bases, "p1"), null);
  assert.equal(hiddenRedirect("/hidden", bases, "p1"), null);
  assert.equal(hiddenRedirect("/dashboard", bases, "p1"), null);
  assert.equal(hiddenRedirect("", bases, "p1"), null);
});
