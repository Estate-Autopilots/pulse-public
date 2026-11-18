// GROWTH-LOOP: the pure helpers behind the investor numbers, the "What is Vitals" funnel, offers and catalogue import.
import assert from "node:assert/strict";
import test from "node:test";
import { investorWeeks } from "../dist/pulse-hq.js";

test("investor numbers cover 4 to 52 weeks, 12 when not said", () => {
  assert.equal(investorWeeks(undefined), 12);
  assert.equal(investorWeeks("12"), 12);
  assert.equal(investorWeeks("1"), 4);
  assert.equal(investorWeeks("400"), 52);
  assert.equal(investorWeeks("abc"), 12);
  assert.equal(investorWeeks("-3"), 12);
  assert.equal(investorWeeks("26.4"), 26);
});

test("the funnel keeps only a hash of the browser's id, and a clean @handle", async () => {
  const { growthVisitor, growthVia, GROWTH_EVENTS, GROWTH_SOURCES } = await import("../dist/growth.js");
  const h = growthVisitor("synthetic-browser-0001");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(growthVisitor("synthetic-browser-0001"), h);
  assert.equal(growthVisitor("short"), null);
  assert.equal(growthVisitor("has spaces in it, not an id"), null);
  assert.equal(growthVisitor(12345678901234567), null);
  assert.equal(growthVia("@EstateAutopilots"), "estateautopilots");
  assert.equal(growthVia("x"), null);
  assert.equal(growthVia("<script>"), null);
  assert.deepEqual([...GROWTH_EVENTS], ["viewed", "clicked", "dismissed"]);
  assert.deepEqual([...GROWTH_SOURCES], ["chat", "quote", "contract", "portal"]);
});
