// UX-SIMPLE: the chat command readers (who and when, leave days, reminder moments, amounts, requests, catch-up).
import test from "node:test";
import assert from "node:assert/strict";
import { amountOf, chatDigest, leaveRange, remindAt, requestIntent, whoWhen } from "./chat-commands.mjs";

const today = "2026-10-28"; // a Wednesday
const members = [{ id: "p1", username: "rila", name: "Rila Shah" }, { id: "me", username: "kedab", name: "Kedab Mifos" }];

test("whoWhen reads the person and the day and keeps the rest as the title", () => {
  const r = whoWhen("send the deck @rila by fri", { members, today, viewer: "me" });
  assert.equal(r.text, "Send the deck"); assert.equal(r.person?.id, "p1"); assert.equal(r.self, false); assert.equal(r.dueOn, "2026-10-30");
  const mine = whoWhen("book the drone tomorrow", { members, today, viewer: "me" });
  assert.equal(mine.text, "Book the drone"); assert.equal(mine.person, null); assert.equal(mine.self, true); assert.equal(mine.dueOn, "2026-10-29");
  assert.equal(whoWhen("@nobody fix it", { members, today }).person, null);
});

test("leaveRange reads one day, a range, a half day and the kind", () => {
  assert.deepEqual(leaveRange("sick tomorrow", today), { from: "2026-10-29", to: "2026-10-29", half: null, kind: "sick", reason: "" });
  const r = leaveRange("3 nov to 5 nov family function", today);
  assert.equal(r?.from, "2026-11-03"); assert.equal(r?.to, "2026-11-05"); assert.equal(r?.reason, "family function");
  assert.equal(leaveRange("second half fri", today)?.half, "second");
  assert.equal(leaveRange("someday soon", today), null);
});

test("remindAt reads in-N, a day with a time, a time alone and refuses the past", () => {
  const now = new Date(2026, 9, 28, 9, 0, 0);
  const a = remindAt("in 2h call Neha", now); assert.equal(a?.at.getHours(), 11); assert.equal(a?.text, "call Neha");
  const b = remindAt("tomorrow 10am send the GST file", now); assert.equal(b?.at.getDate(), 29); assert.equal(b?.at.getHours(), 10); assert.equal(b?.text, "send the GST file");
  const c = remindAt("8am stand-up", now); assert.equal(c?.at.getDate(), 29); // 8 am today has passed
  const d = remindAt("fri the review", now); assert.equal(d?.at.getDate(), 30); assert.equal(d?.at.getHours(), 10);
  assert.equal(remindAt("the review", now), null);
  assert.equal(remindAt("in 0m x", now), null);
});

test("amountOf reads rupees, commas and k", () => {
  assert.deepEqual(amountOf("₹450 cab to the site"), { amount: 450, what: "Cab to the site" });
  assert.deepEqual(amountOf("1,250.50 lunch with the client"), { amount: 1250.5, what: "Lunch with the client" });
  assert.equal(amountOf("1.2k printing")?.amount, 1200);
  assert.equal(amountOf("lunch"), null);
});

test("requestIntent offers asks and by-day lines, never chatter or questions", () => {
  assert.deepEqual(requestIntent("please send the brochure by Friday", today), { title: "Send the brochure", dueOn: "2026-10-30" });
  assert.equal(requestIntent("Share the reel cut by tomorrow", today)?.dueOn, "2026-10-29");
  assert.equal(requestIntent("thanks a lot", today), null);
  assert.equal(requestIntent("did you send it?", today), null);
  assert.equal(requestIntent("@rila send the deck", today), null);
  assert.equal(requestIntent("can you check the invoice?", today)?.title, "Check the invoice");
});

test("chatDigest counts, ranks people and keeps the hanging questions", () => {
  const m = (authorId, name, body, createdAt, attachments = []) => ({ authorId, name, body, createdAt, attachments });
  const d = chatDigest([m("a", "Asha", "Shoot is at 4", "2026-10-28T05:00:00Z"), m("b", "Neel", "Who brings the drone?", "2026-10-28T06:00:00Z"),
    m("a", "Asha", "Here is the list", "2026-10-28T04:00:00Z", [{ task: "t1" }, { id: "f" }])], { viewer: "me", since: "2026-10-28T00:00:00Z" });
  assert.equal(d.count, 3); assert.equal(d.people[0].name, "Asha"); assert.equal(d.questions.length, 1); assert.equal(d.tasks, 1); assert.equal(d.files, 1);
  assert.equal(d.latest.at(-1)?.name, "Neel");
});
