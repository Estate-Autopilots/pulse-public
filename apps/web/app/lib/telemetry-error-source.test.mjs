// ERROR-SWEEP (17 Nov 2026): a script error says where it came from; a browser extension's own error is not sent.
// Production: 36 "Cannot read properties of undefined (reading 'M_ID')" in a week, all one person, on Docs; M_ID is in no
// Pulse code or dependency (an extension), and nothing in the event could tell it apart from a Pulse bug.
import assert from "node:assert/strict";
import test from "node:test";
import { errorFrames, errorSource } from "./telemetry.mjs";

const SITE = "https://app.example.test";

test("an error thrown only by an extension's script is the extension's", () => {
  const stack = "TypeError: Cannot read properties of undefined (reading 'X_ID')\n    at a (chrome-extension://abcdefghijklmnop/content.js:1:200)\n    at b (chrome-extension://abcdefghijklmnop/content.js:3:9)";
  assert.deepEqual(errorSource(stack, undefined, SITE), { src: "ext" });
  assert.deepEqual(errorSource("", "moz-extension://1234-5678/inject.js", SITE), { src: "ext" });
});

test("Pulse's own code is the app's, with the screen's file when its chunk names one", () => {
  const stack = `TypeError: x is undefined\n    at r (${SITE}/_next/static/chunks/app/docs/%5Bid%5D/page-0a1b2c3d4e.js:1:900)\n    at chrome-extension://abcdefghijklmnop/hook.js:2:3`;
  assert.deepEqual(errorSource(stack, undefined, SITE), { src: "app", file: "app/docs/[id]/page" });
  assert.deepEqual(errorSource(`Error\n    at ${SITE}/_next/static/chunks/4821-77aa88bb99cc.js:1:2`, undefined, SITE), { src: "app" });
});

test("another site's script is other; nothing to read is nothing known", () => {
  assert.deepEqual(errorSource("Error\n    at https://cdn.other.test/lib.js:1:1", undefined, SITE), { src: "other" });
  assert.deepEqual(errorSource(undefined, undefined, SITE), {});
  assert.deepEqual(errorSource("Script error.", "", SITE), {});
});

test("a broken escape in a chunk name never throws", () => {
  assert.deepEqual(errorSource(`Error\n    at ${SITE}/_next/static/chunks/app/x%E0%A4/page-0a1b2c3d4e.js:1:1`, undefined, SITE), { src: "app" });
});

// PM-BUILD-4 (23 Nov 2026): Kazuk's Chats crash "e is not iterable" (USER-INSIGHT L2) came with {src: "app"} only:
// production scripts have hashed names, not app/… paths, so nothing said where to look. Now the top frames do.
test("a screen error carries its top frames in this site's scripts, as file:line:column", () => {
  const stack = "TypeError: e is not iterable\n" +
    "    at Ab (https://app.example.test/_next/static/chunks/133zy_5kzsldc.js:1:23456)\n" +
    "    at chrome-extension://abcdefghijklmnop/content.js:1:200\n" +
    "    at https://cdn.other.test/_next/static/chunks/zzzzzzzzzzzz.js:1:5\n" +
    "    at https://app.example.test/_next/static/chunks/0rsnkv4ymcg8f.js?dpl=abc:12:345\n" +
    "    at https://app.example.test/_next/static/chunks/app/chats/page-0a1b2c3d.js:1:99\n" +
    "    at https://app.example.test/_next/static/chunks/aaaaaaaaaaaa.js:1:1\n" +
    "    at https://app.example.test/_next/static/chunks/bbbbbbbbbbbb.js:1:2";
  assert.deepEqual(errorFrames(stack, SITE), ["133zy_5kzsldc.js:1:23456", "0rsnkv4ymcg8f.js:12:345", "page-0a1b2c3d.js:1:99", "aaaaaaaaaaaa.js:1:1"]);
  // Safari/Firefox form (fn@url:line:col)
  assert.deepEqual(errorFrames("Ab@https://app.example.test/_next/static/chunks/133zy_5kzsldc.js:1:777", SITE), ["133zy_5kzsldc.js:1:777"]);
  assert.deepEqual(errorFrames(undefined, SITE), []);
  assert.deepEqual(errorFrames("TypeError: x\n    at <anonymous>", SITE), []);
});
