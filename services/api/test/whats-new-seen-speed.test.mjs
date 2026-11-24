// SPEED-5 (owner, 18 Nov 2026): POST /api/v0/whats-new/seen read the person's whole "new" state twice (release notes,
// what they have seen, the pages they can open, their switch: ~26 queries, p50 157 ms on production) to answer with the
// state after marking. The state after is now the state before with the rows just recorded as seen (release_seen only
// ever gains them), so it is read once. Same answer: unseenOf over the same notes, access and switch, with those keys.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { seenKey, unseenOf } from "../dist/new-dots-access.js";

const src = readFileSync(new URL("../src/new-dots.ts", import.meta.url), "utf8");

test("seen reads the state's parts once and builds the state after from them", () => {
  const route = src.slice(src.indexOf("app.post<{ Body: { path?: string; anchor?: string; all?: boolean } }>('/api/v0/whats-new/seen'"), src.indexOf("app.post<{ Body: { on: boolean } }>"));
  assert.equal((route.match(/partsOf\(c, v\)/g) ?? []).length, 1);
  assert.doesNotMatch(route, /stateOf\(c, v\)/);
  assert.match(route, /const after = cleared\.length \? stateFrom\(parts, seenRows\(cleared, all \|\| !!anchor\)\) : before;/);
  // markSeen records exactly seenRows(...): the same rows the state after counts as seen
  assert.match(src, /async function markSeen\(c: PoolClient, v: Viewer, items: readonly DotItem\[\], reached = false\) \{\n  const rows = seenRows\(items, reached\);/);
});

test("the state after equals unseenOf over what was seen before plus the rows just recorded", () => {
  const now = Date.parse("2099-01-10T10:00:00Z"), at = "2099-01-09T10:00:00Z";
  const items = [{ note: 7, route: "/tasks", anchor: "", opened: false, text: "a", headline: "h", releasedAt: at },
    { note: 7, route: "/tasks", anchor: "board", opened: false, text: "b", headline: "h", releasedAt: at },
    { note: 8, route: "/chats", anchor: "", opened: false, text: "c", headline: "h", releasedAt: at }];
  const access = { role: "person", side: "staff", hidden: [], modulesOff: [], company: null, personal: false, salesSeat: false, platformAdmin: false };
  const seen = new Set([seenKey("8", "/chats")]);                       // as the database gives them (note_id::text)
  // opening /tasks records the page (anchor ""): the board change stays, now "opened"
  const marked = new Set([...seen, seenKey(7, "/tasks", "")]);
  const after = unseenOf(items, marked, access, now);
  assert.deepEqual(after.map((i) => [i.note, i.route, i.anchor, i.opened]), [[7, "/tasks", "board", true]]);
});
