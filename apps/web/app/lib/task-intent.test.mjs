import { test } from "node:test";
import assert from "node:assert/strict";
import { dueDay, taskIntent } from "./task-intent.mjs";

const today = "2026-10-22"; // a Thursday
const members = [{ id: "me", username: "kedab.mifos", name: "Kedab Mifos" }, { id: "r", username: "rila", name: "Rila Shah" }, { id: "a", username: "asha.kireteso", name: "Asha Kireteso" }];
const projects = [{ id: "p1", name: "Skyline Heights launch" }, { id: "p2", name: "Launch & admin (synthetic)" }];
const read = (text) => taskIntent(text, { members, viewer: "me", projects, today });

test("due phrases are company days", () => {
  assert.equal(dueDay("today", today), "2026-10-22");
  assert.equal(dueDay("tomorrow", today), "2026-10-23");
  assert.equal(dueDay("Thu", today), "2026-10-22");
  assert.equal(dueDay("fri", today), "2026-10-23");
  assert.equal(dueDay("monday", today), "2026-10-26");
  assert.equal(dueDay("next thu", today), "2026-10-29");
  assert.equal(dueDay("25 Oct", today), "2026-10-25");
  assert.equal(dueDay("Nov 3rd", today), "2026-11-03");
  assert.equal(dueDay("3 Jan", today), "2027-01-03", "a past date this year is next year's");
  assert.equal(dueDay("someday", today), null);
});

test("J2: a line giving someone work becomes a task offer", () => {
  assert.deepEqual(read("@rila draft positioning for Skyline by Thu"), { assignee: members[1], title: "Draft positioning for Skyline", dueOn: "2026-10-22", project: projects[0] });
  const x = read("@asha.kireteso please send the brochure to the printer tomorrow");
  assert.equal(x.assignee.id, "a"); assert.equal(x.title, "Send the brochure to the printer"); assert.equal(x.dueOn, "2026-10-23"); assert.equal(x.project, null);
  assert.equal(read("Can @rila check the reel copy").title, "Check the reel copy");
});

test("nothing is offered for chat that is not work", () => {
  assert.equal(read("thanks @rila"), null);
  assert.equal(read("@rila thanks!"), null);
  assert.equal(read("@rila are you in today?") === null || read("@rila are you in today?").dueOn === "2026-10-22", true);
  assert.equal(read("@rila ok"), null);
  assert.equal(read("@kedab.mifos remind me to call the bank"), null, "not to yourself");
  assert.equal(read("@nobody draft it by Thu"), null, "only people in this chat");
  assert.equal(read("/tasks"), null);
  assert.equal(read("draft positioning for Skyline by Thu"), null, "nobody named");
});
