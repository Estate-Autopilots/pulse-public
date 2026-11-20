import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheFits, chipName, counts, hasSwitch, hueOf, newsSince, rebase, scopeChannels, scopeTotals, switchSeats, toCache, unreadMap, validScope } from "./chat-across.mjs";

// Synthetic companies: Lotus Test Interiors (current), Kite Test Studio, a guest seat in Brook Test Media that shares a
// chat with Kite, and Fern Test Labs (locked: this sign-in has not proved the person).
const ch = (id, over = {}) => ({ id, name: `Chat ${id}`, kind: "custom", unread: 0, mentions: 0, lastAt: "2026-11-18T10:00:00Z", archivedAt: null, mutedUntil: null, markedUnread: null, photoAt: "2026-11-01T00:00:00Z", peerId: null, peerPhotoAt: null, ...over });
const seat = (org, over = {}) => ({ org, name: org, handle: null, kind: "staff", current: false, personal: false, purpose: "work", mark: null, viewer: `p-${org}`, state: "ok", guest: false,
  unreadChats: 0, unreadMessages: 0, mentions: 0, more: 0, channels: [], shared: [], ...over });
const current = [ch("l1", { unread: 2 }), ch("l2"), ch("l3", { unread: 4, mutedUntil: "2099-01-01T00:00:00Z" })];
const seats = [
  seat("lotus", { name: "Lotus Test Interiors", current: true, state: "current", mark: "/m/lotus" }),
  seat("kite", { name: "Kite Test Studio Private Limited", channels: [ch("k1", { unread: 1 }), ch("k2", { archivedAt: "2026-11-01T00:00:00Z", unread: 3 })], shared: [{ ref: "b1", hostOrg: "brook" }] }),
  seat("brook", { name: "Brook Test Media", kind: "partner", guest: true, channels: [ch("b1", { unread: 5, withOrg: "Brook Test Media" })] }),
  seat("fern", { name: "Fern Test Labs", state: "locked", viewer: null }),
];

test("the switch lists my companies (not guest seats) by name, personal space last, from two companies up", () => {
  assert.deepEqual(switchSeats(seats).map((s) => s.org), ["fern", "kite", "lotus"]);
  // The order does not move when this tab moves to another company.
  const moved = seats.map((s) => ({ ...s, current: s.org === "kite" }));
  assert.deepEqual(switchSeats(moved).map((s) => s.org), ["fern", "kite", "lotus"]);
  assert.equal(switchSeats([seat("me", { name: "Aaron", personal: true }), ...seats]).at(-1).org, "me");
  // Colours: my companies never share one; the same company keeps its colour wherever this tab is.
  const hues = ["fern", "kite", "lotus", "brook"].map((o) => hueOf(o, seats));
  assert.equal(new Set(hues).size, 4, "four companies, four colours");
  assert.equal(hueOf("kite", seats), hueOf("kite", moved));
  assert.equal(hueOf("elsewhere", seats, "Elm Test Co"), hueOf("x", null, "Elm Test Co"), "a company not in the read: its name's colour");
  // The sidebar's colour (ui-shell orgHue) when no other company of mine is close to it.
  let side = 7; for (const c of "Fern Test Labs") side = (side * 31 + c.codePointAt(0)) % 360;
  assert.equal(hueOf("fern", seats), side, "the first company keeps the sidebar's colour");
  assert.equal(hasSwitch(seats), true);
  assert.equal(hasSwitch([seats[0], seats[2]]), false, "one company and a guest seat: no switch");
});

test("the scope: All, or the company this tab is in (picking another company moves the tab there)", () => {
  assert.equal(validScope("all", seats), "all");
  assert.equal(validScope(null, seats), "all", "nothing kept: All");
  assert.equal(validScope("one", seats), "lotus", "one company: the one the page is in");
  assert.equal(validScope("kite", seats), "lotus", "an older kept company id: the one the page is in");
  assert.equal(validScope("one", seats.map((s) => ({ ...s, current: s.org === "kite" }))), "kite");
  assert.equal(validScope("all", [seats[0]]), "current", "a single company keeps the page's own list");
});

test("All tags every chat with its company; another company's chats draw no photo there", () => {
  const all = scopeChannels(current, seats, "all");
  assert.deepEqual(all.map((c) => [c.id, c.org, !!c.remote]), [["l1", "lotus", false], ["l2", "lotus", false], ["l3", "lotus", false], ["k1", "kite", true], ["k2", "kite", true], ["b1", "brook", true]]);
  const k1 = all.find((c) => c.id === "k1");
  assert.equal(k1.photoAt, null); assert.equal(k1.here, "p-kite"); assert.equal(k1.orgName, "Kite Test Studio Private Limited");
  assert.equal(all.find((c) => c.id === "l1").photoAt, "2026-11-01T00:00:00Z", "the current company's photos load as before");
  assert.equal(scopeChannels(current, seats, "current"), current, "the page's own list, untouched");
});

test("a company shows its own chats and the chats another company shares with it (CONNECT: in both)", () => {
  assert.deepEqual(scopeChannels(current, seats, "kite").map((c) => c.id), ["k1", "k2", "b1"]);
  assert.deepEqual(scopeChannels(current, seats, "lotus").map((c) => c.id), ["l1", "l2", "l3"]);
});

test("unread badges: per company and summed in All, each chat once; muted and archived chats do not count", () => {
  const t = scopeTotals(current, seats);
  assert.equal(t.lotus, 1, "l1 (l3 is muted)");
  assert.equal(t.kite, 2, "k1 and the shared b1 (k2 is archived)");
  assert.equal(t.fern, 0);
  assert.equal(t.all, 3, "l1, k1, b1");
  assert.equal(counts(ch("x", { markedUnread: "2026-11-18T00:00:00Z" })), true);
});

test("news from another company: only chats whose unread went up, never the current company's", () => {
  const before = unreadMap(seats);
  assert.equal(before.has("l1"), false);
  const later = seats.map((s) => s.org === "kite" ? { ...s, channels: [ch("k1", { unread: 2, previewAuthor: "Asha Kireteso" }), s.channels[1]] } : s);
  assert.deepEqual(newsSince(before, later).map((c) => [c.id, c.orgName]), [["k1", "Kite Test Studio Private Limited"]]);
  assert.deepEqual(newsSince(null, later), [], "the first read says nothing");
});

test("a kept read: only for this account, and still whole after a switch", () => {
  const kept = toCache({ generatedAt: "x", seats, more: 0 }, current);
  assert.equal(cacheFits(kept, "p-kite"), true);
  assert.equal(cacheFits(kept, "someone-else"), false, "another person's read on a shared browser is never shown");
  const there = rebase(kept, "p-kite");
  assert.equal(there.seats.find((s) => s.org === "kite").state, "current");
  const lotus = there.seats.find((s) => s.org === "lotus");
  assert.equal(lotus.state, "ok"); assert.deepEqual(lotus.channels.map((c) => c.id), ["l1", "l2", "l3"]);
});

test("chip names stay short", () => {
  assert.equal(chipName("Kite Test Studio Private Limited"), "Kite Test Studio");
  assert.equal(chipName("Lotus Test Interiors Pvt Ltd"), "Lotus Test Interiors");
  assert.equal(chipName("An Extremely Long Test Company Name Here"), "An Extremely Long Te…");
  assert.equal(chipName(""), "Company");
});
