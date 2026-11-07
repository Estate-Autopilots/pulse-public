import { test } from "node:test";
import assert from "node:assert/strict";
import { byDay, callEntry, duration, missedCalls } from "./call-log.mjs";

const ME = "me", ASHA = "asha", NOW = Date.parse("2026-10-24T12:00:00Z");
const at = (h) => new Date(NOW - h * 3600000).toISOString();
const call = (id, { from = ASHA, ch = "dm-asha", kind = "direct", h = 1, mine = "missed", answered = null, video = false, name = null } = {}) => ({
  id, channelId: ch, channelKind: kind, channelName: name, video, state: "ended", endReason: answered ? "completed" : "missed", startedBy: from,
  createdAt: at(h), answeredAt: answered ? at(h - 0.01) : null, endedAt: answered ? at(h - 0.05) : at(h - 0.01),
  parties: [{ id: from, name: from === ME ? "Me" : "Asha Rao", state: "left", joinedAt: at(h) }, ...(from === ME ? [{ id: ASHA, name: "Asha Rao", state: mine, joinedAt: answered ? at(h) : null }] : [{ id: ME, name: "Me", state: mine, joinedAt: answered ? at(h) : null }])],
});

test("a call to me nobody answered is missed; my own and answered calls are not", () => {
  assert.equal(callEntry(call("a"), ME).missed, true);
  assert.equal(callEntry(call("b", { from: ME, mine: "missed" }), ME).missed, false);
  assert.equal(callEntry(call("c", { mine: "left", answered: true }), ME).missed, false);
  assert.equal(callEntry(call("d", { mine: "declined" }), ME).missed, false);
  const e = callEntry(call("a"), ME); assert.equal(e.title, "Asha Rao"); assert.equal(e.direction, "incoming");
});

test("needs you: newest missed call per conversation, cleared by calling back or a later answered call", () => {
  const recent = [call("old", { h: 5 }), call("new", { h: 2 }), call("grp", { ch: "pod", kind: "group", name: "Pod 1", h: 3 })];
  const m = missedCalls(recent, ME, NOW);
  assert.deepEqual(m.map((x) => x.id), ["new", "grp"]);
  assert.equal(m[0].count, 2); assert.equal(m[1].title, "Pod 1");
  assert.deepEqual(missedCalls([...recent, call("back", { from: ME, h: 1, mine: "missed" })], ME, NOW).map((x) => x.id), ["grp"]);
  assert.deepEqual(missedCalls([...recent, call("talk", { h: 0.5, mine: "left", answered: true, ch: "pod", kind: "group", name: "Pod 1" })], ME, NOW).map((x) => x.id), ["new"]);
  assert.deepEqual(missedCalls([call("stale", { h: 80 })], ME, NOW), []);
});

test("calls list groups by day and durations read like a clock", () => {
  const g = byDay([callEntry(call("a", { h: 1 }), ME), callEntry(call("b", { h: 2 }), ME), callEntry(call("c", { h: 30 }), ME)], NOW);
  assert.deepEqual(g.map((x) => [x.label, x.entries.length]), [["Today", 2], ["Yesterday", 1]]);
  assert.equal(duration(245), "4:05"); assert.equal(duration(3729), "1:02:09"); assert.equal(duration(null), null);
  assert.equal(callEntry(call("t", { mine: "left", answered: true }), ME).seconds, 144);
});
