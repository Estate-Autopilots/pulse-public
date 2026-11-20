// REPLAY-FIXES #3: starting a chat opens at once (lib/chat-open.mjs), and the Chats app uses it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existingDirect, withDirect } from "./chat-open.mjs";

const list = { viewer: "me", people: [], channels: [
  { id: "c1", kind: "direct", peerId: "p1", name: "Kazuk" },
  { id: "g1", kind: "custom", peerId: null, name: "Sales" },
  { id: "m1", kind: "direct", peerId: "p9", name: "Mod", moderationOnly: true },
] };

test("a direct chat already in the list is found, so it opens without asking the server", () => {
  assert.equal(existingDirect(list, "p1"), "c1");
  assert.equal(existingDirect(list, "p2"), null);
  assert.equal(existingDirect(list, "p9"), null, "a moderation-only row is not the person's chat");
  assert.equal(existingDirect(null, "p1"), null);
});

test("a new chat stands in the list as soon as the server names it, first, and only once", () => {
  const next = withDirect(list, "c2", { id: "p2", name: "Opinem", agent: false, photoAt: "2026-11-01T00:00:00Z", username: "opinem" });
  assert.equal(next.channels.length, 4);
  assert.deepEqual(next.channels[0], { id: "c2", name: "Opinem", kind: "direct", description: "", address: null, unread: 0, members: 2, lastAt: null,
    peerId: "p2", peerAgent: false, peerPhotoAt: "2026-11-01T00:00:00Z", peerUsername: "opinem" });
  assert.equal(list.channels.length, 3, "the cached list is not changed in place");
  assert.equal(withDirect(next, "c2", { id: "p2", name: "Opinem" }), next, "already there: unchanged");
  assert.equal(withDirect(null, "c2", { id: "p2" }), null);
});

test("the Chats app opens an existing chat at once, ignores taps while one opens, and re-reads the list after opening", () => {
  const app = readFileSync(new URL("../chats/app.tsx", import.meta.url), "utf8");
  const direct = app.slice(app.indexOf("async function direct("), app.indexOf("async function searchMessages("));
  assert.match(direct, /if \(opening\) return;/);
  assert.match(direct, /existingDirect\(cachedList\(\), p\.id\)/);
  assert.match(direct, /saveList\(withDirect\(/);
  assert.ok(direct.indexOf("choose(d.id)") < direct.indexOf("refreshList()"), "the chat opens before the list is read again");
  assert.doesNotMatch(direct, /await refreshList\(\)/, "opening never waits for the whole list");
  assert.match(app, /data-opening=\{opening === p\.id \|\| undefined\}/);
});
