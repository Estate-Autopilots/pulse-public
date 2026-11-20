import assert from "node:assert/strict";
import test from "node:test";
import { dueFrom, extractActions, isAction, titleFrom, whoFrom } from "../dist/meeting-actions.js";
import { startInput } from "../dist/meetings.js";

// Synthetic colleagues (example names only).
const people = [{ id: "p-asha", name: "Asha Synthetic" }, { id: "p-ravi", name: "Ravi Example" }, { id: "p-me", name: "Meera Testcase" }];
const today = "2026-11-06"; // a Friday

test("days in a line become due dates, relative to today", () => {
  assert.equal(dueFrom("send it today", today), "2026-11-06");
  assert.equal(dueFrom("call them tomorrow", today), "2026-11-07");
  assert.equal(dueFrom("by Monday please", today), "2026-11-09");
  assert.equal(dueFrom("by Friday", today), "2026-11-13");
  assert.equal(dueFrom("next week", today), "2026-11-09");
  assert.equal(dueFrom("by the end of the month", today), "2026-11-30");
  assert.equal(dueFrom("in 3 days", today), "2026-11-09");
  assert.equal(dueFrom("before 12 Nov", today), "2026-11-12");
  assert.equal(dueFrom("on Jan 5th", today), "2027-01-05");
  assert.equal(dueFrom("on 3 Nov", today), "2027-11-03");
  assert.equal(dueFrom("no day here", today), null);
});

test("the colleague named in a line does it; I is the person who recorded", () => {
  assert.equal(whoFrom("Asha will send the brochure", people, "p-me"), "p-asha");
  assert.equal(whoFrom("ravi example to call the bank", people, "p-me"), "p-ravi");
  assert.equal(whoFrom("I will share the deck", people, "p-me"), "p-me");
  assert.equal(whoFrom("We should share the deck", people, "p-me"), null);
  // A first name two colleagues share names nobody.
  assert.equal(whoFrom("Asha will call", [...people, { id: "p-asha2", name: "Asha Other" }], null), null);
});

test("only lines with something to do are action items", () => {
  assert.equal(isAction("Action: book the site visit", people), true);
  assert.equal(isAction("Asha will send the brochure by Monday.", people), true);
  assert.equal(isAction("Please share the price list", people), true);
  assert.equal(isAction("We need to fix the landing page", people), true);
  assert.equal(isAction("The weather will be fine.", people), false);
  assert.equal(isAction("Can Ravi call the bank?", people), false);
  assert.equal(isAction("Good meeting", people), false);
});

test("titles lose the marker, the speaker and the trailing day", () => {
  assert.equal(titleFrom("Asha will send the brochure by Monday.", people), "Send the brochure");
  assert.equal(titleFrom("Action: book the site visit tomorrow", people), "Book the site visit");
  assert.equal(titleFrom("- Ravi: call the bank before 12 Nov", people), "Call the bank");
  assert.equal(titleFrom("I'll share the deck", people), "Share the deck");
});

test("a transcript gives its action items in order, each once, with who and when", () => {
  const text = `Good morning everyone. We looked at the synthetic launch numbers.
Asha will send the brochure to the client by Monday. The weather will be fine.
Action: book the site visit tomorrow
I'll share the deck. Asha will send the brochure to the client by Monday.
Can Ravi call the bank?`;
  const a = extractActions(text, { today, people, me: "p-me" });
  assert.deepEqual(a.map((x) => [x.title, x.assigneeId, x.dueOn]), [
    ["Send the brochure to the client", "p-asha", "2026-11-09"],
    ["Book the site visit", null, "2026-11-07"],
    ["Share the deck", "p-me", null],
  ]);
  assert.match(a[0].quote, /^Asha will send/);
  assert.equal(extractActions("", { today, people, me: null }).length, 0);
  assert.equal(extractActions(Array.from({ length: 40 }, (_, i) => `Action: synthetic step ${i}`).join("\n"), { today, people, me: null }).length, 20);
});

test("a recording starts only with the consent notice confirmed; notes need none", () => {
  assert.throws(() => startInput({ title: "Synthetic review" }), /Tell everyone present/);
  assert.throws(() => startInput({ title: "Synthetic review", consent: "yes" }), /Tell everyone present/);
  const ok = startInput({ title: "  Synthetic\u0007 review ", consent: true, mime: "audio/webm;codecs=opus", attendees: ["0f4c2d6e-aaaa-4bbb-8ccc-dddddddddddd"] });
  assert.equal(ok.title, "Synthetic  review");
  assert.equal(ok.kind, "recording"); assert.equal(ok.consent, true); assert.equal(ok.mime, "audio/webm");
  assert.match(ok.consentText, /told this meeting is recorded/);
  assert.equal(startInput({ kind: "notes" }).consent, false);
  assert.equal(startInput({ kind: "notes" }).title, "Meeting");
  assert.throws(() => startInput({ kind: "notes", projectId: "x" }), /valid project/);
});
