// CHAT-GROUPS (owner report EA #4): the Groups tab by category, a group's look, the company's setting in words, and the
// company switch guard (USER-INSIGHT L2: Chats crashed after switching company).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN, COLOURS, ICONS, creatorsLine, groupLook, groupSections, inCategory, listFits, listWhole, sectionOpen, watchMoving } from "./chat-groups.mjs";

const cats = [...BUILTIN, { id: "c-vendors1", name: "Vendors", icon: "truck", colour: "amber", builtin: false }];
const ch = (id, category, extra = {}) => ({ id, name: id, kind: "custom", category, unread: 0, lastAt: "2026-11-22T10:00:00Z", ...extra });

test("the built-in categories and the pickers match the server's lists", () => {
  assert.deepEqual(BUILTIN.map((c) => c.id), ["announcements", "projects", "teams", "clients", "bugs"]);
  assert.equal(ICONS.length, 16); assert.ok(ICONS.includes("bug") && ICONS.includes("megaphone"));
  assert.deepEqual(COLOURS, ["slate", "blue", "green", "amber", "red", "violet", "teal", "pink"]);
});

test("groups fall into their category's section, in the company's order, empty ones left out, the rest last", () => {
  const list = [ch("bugs", "bugs", { unread: 2 }), ch("orchid", "projects"), ch("loose", null), ch("pod", "teams", { kind: "pod" }), ch("dm", null, { kind: "direct" }), ch("paper", "c-vendors1", { markedUnread: "x" })];
  const s = groupSections(list, cats);
  assert.deepEqual(s.map((x) => x.id), ["projects", "teams", "bugs", "c-vendors1", "other"]);
  assert.deepEqual(s.map((x) => x.channels.map((c) => c.id)), [["orchid"], ["pod"], ["bugs"], ["paper"], ["loose"]]);
  assert.equal(s.find((x) => x.id === "bugs").unread, 1);
  assert.equal(s.find((x) => x.id === "c-vendors1").unread, 1);
  assert.equal(s.at(-1).name, "Other groups");
  // A category the company took away: its groups go with the rest, nothing is lost.
  assert.deepEqual(groupSections([ch("paper", "c-gone0000")], BUILTIN).map((x) => x.id), ["other"]);
  // Muted and archived chats do not raise a section's count; the list keeps the order it was given (pinned, latest).
  const quiet = groupSections([ch("a", "teams", { unread: 3, mutedUntil: "2999-01-01T00:00:00Z" }), ch("b", "teams", { unread: 1, archivedAt: "2026-11-01" }), ch("c", "teams")], cats);
  assert.equal(quiet[0].unread, 0); assert.deepEqual(quiet[0].channels.map((c) => c.id), ["a", "b", "c"]);
});

test("one category's groups, and All", () => {
  const list = [ch("a", "teams"), ch("b", "projects"), ch("c", null), ch("d", null, { kind: "direct" })];
  assert.deepEqual(inCategory(list, "teams").map((c) => c.id), ["a"]);
  assert.deepEqual(inCategory(list, "other").map((c) => c.id), ["c"]);
  assert.deepEqual(inCategory(list, "all").map((c) => c.id), ["a", "b", "c"]);
});

test("a group's look: its own icon and colour, else its category's, else a calm default", () => {
  assert.deepEqual(groupLook(ch("x", "bugs", { icon: "megaphone", colour: "teal" }), cats), { icon: "megaphone", colour: "teal" });
  assert.deepEqual(groupLook(ch("x", "bugs"), cats), { icon: "bug", colour: "red" });
  assert.deepEqual(groupLook(ch("x", null), cats), { icon: "hash", colour: "slate" });
  assert.deepEqual(groupLook(ch("x", "c-vendors1", { icon: "not-an-icon" }), cats), { icon: "truck", colour: "amber" });
});

test("sections remember being folded, per category", () => {
  const folded = new Set(["teams"]);
  assert.equal(sectionOpen("teams", folded, false), false);
  assert.equal(sectionOpen("projects", folded, false), true);
  // Searching opens every section (a match is never hidden).
  assert.equal(sectionOpen("teams", folded, true), true);
});

test("the company's setting in plain words", () => {
  assert.equal(creatorsLine("everyone", true), "Everyone here can make groups.");
  assert.equal(creatorsLine("managers", false), "Managers and leadership make groups here. Ask for one and a manager approves it.");
  assert.equal(creatorsLine("leaders", false), "Leadership makes groups here. Ask for one and leadership approves it.");
  assert.equal(creatorsLine("leaders", true), "Only leadership can make groups here, and you can.");
});

test("a list from another company never replaces this page's (the company switch, L2)", () => {
  assert.equal(listFits("me-in-ea", { viewer: "me-in-ea" }), true);
  assert.equal(listFits("me-in-ea", { viewer: "me-in-vitals" }), false);
  assert.equal(listFits(null, { viewer: "anyone" }), true);           // no viewer on the page yet: as before
  assert.equal(listFits("me", null), true);
});

// VITALS-SWEEP (23 Nov 2026, Kazuk: Chats crashed "e is not iterable" on 21 and 23 Nov, "reading 'filter'" on 21 Nov,
// each one second after his 45 KB chat list took 7-15 s): a list whose body broke off mid-download reached the page as
// {} and replaced the real one; the list then had no conversations to sort and the screen broke.
test("a half-read or empty chat list never replaces the one on screen, nor comes back from the saved copy", () => {
  const whole = { viewer: "me", channels: [], people: [] };
  assert.equal(listWhole(whole), true);
  assert.equal(listWhole({ viewer: "me", channels: [ch("a", null)], people: [{ id: "p" }] }), true);
  assert.equal(listWhole({}), false);                                  // the body broke off: get() answered {}
  assert.equal(listWhole(null), false);
  assert.equal(listWhole({ viewer: "me", people: [] }), false);        // no conversations
  assert.equal(listWhole({ viewer: "me", channels: [], people: {} }), false);
  assert.equal(listWhole({ viewer: "me", channels: { a: 1 }, people: [] }), false);
});

test("the page knows the tab is moving to another company until the move is called off", () => {
  const target = new EventTarget();
  const moving = watchMoving(target);
  assert.equal(moving.now(), false);
  target.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: { name: "Vitals Technology" } }));
  assert.equal(moving.now(), true);
  target.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: null }));      // the move did not happen
  assert.equal(moving.now(), false);
  moving.stop();
  target.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: { name: "x" } }));
  assert.equal(moving.now(), false);
});
