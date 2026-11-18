// GAP-FOUNDER-VIEW: the pure parts of "All my companies" (order, people in two companies) and the Google Calendar sync.
import assert from "node:assert/strict";
import test from "node:test";
import { focusFor, norm, orderCards, sharedPeople } from "../dist/founder.js";
import { calendarSwitch, eventFor, eventId, syncPlan } from "../dist/calendar.js";

const W = [
  { key: "ac", name: "Atlas Crest / Sales X-Ray", weight: 30, sort: 0 },
  { key: "vitals", name: "Vitals", weight: 25, sort: 1 },
  { key: "ea", name: "Estate Autopilots", weight: 22, sort: 2 },
  { key: "nayagrowth", name: "NayaGrowth", weight: 4, sort: 5 },
];

test("a Focus company names an organisation by its name, the start of it, or its handle", () => {
  assert.equal(norm("NayaGrowth Private Ltd."), "nayagrowth private ltd");
  assert.equal(focusFor({ name: "Vitals Technologies", handle: "vt" }, W)?.key, "vitals");
  assert.equal(focusFor({ name: "Atlas Crest", handle: null }, W)?.key, "ac");
  assert.equal(focusFor({ name: "NayaGrowth Private Limited", handle: null }, W)?.key, "nayagrowth");
  assert.equal(focusFor({ name: "Something Else", handle: "ea" }, W)?.key, "ea");
  // "Vital Signs" is not "Vitals"; a blank name matches nothing.
  assert.equal(focusFor({ name: "Vital Signs", handle: null }, W), null);
  assert.equal(focusFor({ name: "", handle: null }, W), null);
});

test("cards follow the Focus weights, then the rest by name", () => {
  const cards = [{ name: "Zeta Labs", handle: null }, { name: "Estate Autopilots", handle: "ea" }, { name: "Atlas Crest", handle: "ac" }, { name: "Alpha Works", handle: null }, { name: "Vitals Technologies", handle: null }];
  const out = orderCards(cards, W);
  assert.deepEqual(out.map((c) => c.name), ["Atlas Crest", "Vitals Technologies", "Estate Autopilots", "Alpha Works", "Zeta Labs"]);
  assert.deepEqual(out.map((c) => c.weight), [30, 25, 22, null, null]);
  assert.deepEqual(orderCards(cards, []).map((c) => c.name), ["Alpha Works", "Atlas Crest", "Estate Autopilots", "Vitals Technologies", "Zeta Labs"]);
});

test("people in two of the founder's companies are named with their role in each, matched by their one @handle", () => {
  const per = new Map([
    ["a", { company: "Northstar", people: [{ handle: "diya", id: "da", name: "Diya Nair", role: "Head of sales", kind: "staff" }, { handle: "rifob", id: "ra", name: "Rifob", role: "Editor", kind: "staff" }] }],
    ["b", { company: "Kite Studio", people: [{ handle: "diya", id: "db", name: "Diya Nair", role: "Adviser", kind: "staff" }] }],
    ["c", { company: "Maple", people: [{ handle: "rifob", id: "rc", name: "Rifob", role: null, kind: "client" }, { handle: "diya", id: "dc", name: "Diya Nair", role: null, kind: "staff" }] }],
  ]);
  const s = sharedPeople(per);
  assert.deepEqual(s.get("a")?.map((p) => [p.id, p.elsewhere.map((e) => `${e.role}@${e.company}`)]), [["da", ["Adviser@Kite Studio", "null@Maple"]], ["ra", ["null@Maple"]]]);
  assert.deepEqual(s.get("b")?.map((p) => p.id), ["db"]);
  // Nobody shared: an empty list; at most `max` per company.
  assert.deepEqual(sharedPeople(new Map([["x", { company: "X", people: [{ handle: "solo", id: "s", name: "Solo", role: null, kind: "staff" }] }]])).get("x"), []);
  assert.equal(sharedPeople(per, 1).get("a")?.length, 1);
});

test("Google Calendar stays off until the server switch and the Google client are both there", () => {
  const before = { ...process.env };
  try {
    delete process.env.PULSE_GOOGLE_CALENDAR;
    assert.deepEqual(calendarSwitch(), { on: false, reason: "off" });
    process.env.PULSE_GOOGLE_CALENDAR = "1"; delete process.env.PULSE_GOOGLE_CLIENT_ID;
    assert.deepEqual(calendarSwitch(), { on: false, reason: "no_client" });
  } finally { process.env = before; }
});

test("each Pulse item is one event with a stable id; a sync adds, changes and removes only what moved", () => {
  const org = "11111111-1111-1111-1111-111111111111", me = "22222222-2222-2222-2222-222222222222";
  const id = eventId(org, me, "task", "t1");
  assert.match(id, /^[a-v0-9]{5,1024}$/); assert.equal(id, eventId(org, me, "task", "t1")); assert.notEqual(id, eventId(org, me, "appointment", "t1"));
  const task = { source: "task", id: "t1", title: "Call the bank", start: "2026-11-10T05:00:00.000Z", minutes: 30, project: "Loans", timeZone: "Asia/Kolkata" };
  const meet = { source: "appointment", id: "m1", title: "Meeting: Lotus Interiors", start: "2026-11-10T08:30:00.000Z", minutes: 50, place: "Office", timeZone: "Asia/Kolkata" };
  const e = eventFor(task, "https://pulse.example");
  assert.equal(e.end.dateTime, "2026-11-10T05:30:00.000Z"); assert.equal(e.source.url, "https://pulse.example/tasks/t1"); assert.match(e.description, /Loans/);
  assert.equal(eventFor(meet, "https://pulse.example").location, "Office");
  const first = syncPlan(org, me, [task, meet], [], "https://pulse.example", { tasks: true, meetings: true });
  assert.deepEqual(first.put.map((p) => [p.item.id, p.isNew]), [["t1", true], ["m1", true]]); assert.equal(first.remove.length, 0);
  const pushed = first.put.map((p) => ({ source: p.item.source, source_id: p.item.id, event_id: p.eventId, fingerprint: p.fingerprint }));
  // Nothing moved: nothing to do. The task moved: changed in place. The meeting is gone (or meetings switched off): removed.
  assert.deepEqual(syncPlan(org, me, [task, meet], pushed, "https://pulse.example", { tasks: true, meetings: true }), { put: [], remove: [] });
  const moved = syncPlan(org, me, [{ ...task, start: "2026-11-10T06:00:00.000Z" }], pushed, "https://pulse.example", { tasks: true, meetings: true });
  assert.deepEqual(moved.put.map((p) => [p.item.id, p.isNew, p.eventId]), [["t1", false, pushed[0].event_id]]);
  assert.deepEqual(moved.remove.map((p) => p.source_id), ["m1"]);
  assert.deepEqual(syncPlan(org, me, [task, meet], pushed, "https://pulse.example", { tasks: true, meetings: false }).remove.map((p) => p.source_id), ["m1"]);
});
