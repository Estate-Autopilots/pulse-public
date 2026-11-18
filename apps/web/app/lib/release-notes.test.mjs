// RELEASE-COMMS: the release notes' words, links, times and the "was updated" note (synthetic values only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { audienceHeading, noteGroups, releasedAtText, safeHref, shareFor, updateNote, UPDATE_EVERY_MS, whatsAppLink } from "./release-notes.mjs";

test("headings: the person's own part is 'For you', the rest say who they are for in the company's words", () => {
  assert.equal(audienceHeading("owner", "owner"), "For you");
  assert.equal(audienceHeading("everyone", "everyone"), "For everyone");
  assert.equal(audienceHeading("managers", "owner"), "For managers and team leads");
  assert.equal(audienceHeading("managers", "owner", { team: "Squad" }), "For managers and squad leads");
  assert.equal(audienceHeading("clients", "owner", { clients: "Customers" }), "For customers");
  assert.equal(audienceHeading("hr", "owner"), "For HR");
});

test("groups: the main audience first, empty parts left out, plain strings and {text, href} both read", () => {
  const groups = noteGroups({ everyone: ["Tasks load faster", { text: "  " }], salespeople: [{ text: "Quotes", href: "/erp" }], owner: [] }, "salespeople");
  assert.deepEqual(groups.map((g) => [g.audience, g.heading]), [["salespeople", "For you"], ["everyone", "For everyone"]]);
  assert.deepEqual(groups[0].lines, [{ text: "Quotes", href: "/erp" }]);
  assert.deepEqual(groups[1].lines, [{ text: "Tasks load faster", href: null }]);
});

test("a note links only inside the app", () => {
  assert.equal(safeHref("/billing?tab=open"), "/billing?tab=open");
  for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "/a b", 7, null]) assert.equal(safeHref(bad), null, String(bad));
});

test("release time reads in India time", () => {
  assert.equal(releasedAtText("2026-11-07T10:35:00Z"), "7 Nov 2026, 4:05 pm IST");
  assert.equal(releasedAtText("not a date"), "");
});

test("share card: the main audience's, else the next one the person has; WhatsApp gets the text", () => {
  const share = { everyone: { text: "Hi all", imageUrl: "/api/v0/whats-new/3/card/everyone?v=abc123" } };
  assert.deepEqual(shareFor(share, ["owner", "everyone"]), { audience: "everyone", text: "Hi all", imageUrl: "/api/v0/whats-new/3/card/everyone?v=abc123" });
  assert.equal(shareFor({}, ["owner"]), null);
  assert.equal(whatsAppLink("New in Vitals OS: tasks & more?"), "https://wa.me/?text=New%20in%20Vitals%20OS%3A%20tasks%20%26%20more%3F");
});

test("the update note: a first visit only remembers; a newer release shows it once", () => {
  assert.deepEqual(updateNote(null, 12), { show: false, remember: "12" });
  assert.deepEqual(updateNote("garbage", 12), { show: false, remember: "12" });
  assert.deepEqual(updateNote("12", 12), { show: false, remember: null });
  assert.deepEqual(updateNote("11", 12), { show: true, remember: null });
  assert.deepEqual(updateNote("11", null), { show: false, remember: null });
  // DOREVE-FIX: at most once a day, however many releases there were.
  const now = Date.parse("2026-11-17T10:00:00Z");
  assert.deepEqual(updateNote("11", 12, String(now - 3600 * 1000), now), { show: false, remember: null }, "shown an hour ago: not again");
  assert.deepEqual(updateNote("11", 12, String(now - UPDATE_EVERY_MS - 1), now), { show: true, remember: null }, "shown yesterday: once more");
  assert.deepEqual(updateNote("11", 12, "garbage", now), { show: true, remember: null });
});
