import assert from "node:assert/strict";
import test from "node:test";
import { eventElement } from "./key-target.mjs";

test("a key from an element is that element; from the document, the window or text it is null (BC-249)", () => {
  const field = { tagName: "INPUT", closest: (s) => (s.includes("input") ? field : null) };
  assert.equal(eventElement(field), field);
  // What Android WebView sent on /dashboard: the document, which has no closest().
  const doc = { nodeType: 9, body: {} };
  assert.equal(eventElement(doc), null);
  assert.equal(eventElement({ nodeType: 3, data: "text" }), null);
  assert.equal(eventElement(null), null);
  assert.equal(eventElement(undefined), null);
  // The shortcut's own question no longer throws: no element, so not typing.
  assert.equal(!!eventElement(doc)?.closest("input"), false);
});
