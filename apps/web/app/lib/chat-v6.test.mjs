// CHAT-V6: the emoji picker's set and its search.
import assert from "node:assert/strict";
import test from "node:test";
import { EMOJI_GROUPS, emojiName, searchEmoji } from "./emoji-data.mjs";

test("every category has emoji, each once, each with words", () => {
  assert.ok(EMOJI_GROUPS.length >= 8);
  for (const g of EMOJI_GROUPS) {
    assert.ok(g.items.length >= 20, g.key);
    assert.equal(new Set(g.items.map((x) => x.e)).size, g.items.length, `${g.key} has a repeat`);
    for (const it of g.items) { assert.ok(it.e && !/\s/.test(it.e), `${g.key}: "${it.e}"`); assert.ok(it.words.length > 1, it.e); }
  }
});

test("search finds by any word's start, whole words and first words first", () => {
  assert.deepEqual(searchEmoji("thumb").slice(0, 2), ["👍", "👎"]);
  assert.equal(searchEmoji("heart")[0], "❤️");
  assert.ok(searchEmoji("party").includes("🥳") && searchEmoji("party").includes("🎉"));
  assert.ok(searchEmoji("chai").includes("☕"));
  assert.ok(searchEmoji("namaste").includes("🙏"));
  assert.ok(searchEmoji("diwali").includes("🪔"));
  assert.ok(searchEmoji("red heart").includes("❤️"));
  assert.deepEqual(searchEmoji("zzqx"), []);
  assert.deepEqual(searchEmoji("  "), []);
});

test("an emoji's name is its first word", () => {
  assert.equal(emojiName("👍"), "thumbs");
  assert.equal(emojiName("🙏"), "folded");
  assert.equal(emojiName("not an emoji"), "");
});
