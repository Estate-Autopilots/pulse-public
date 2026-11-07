import assert from "node:assert/strict";
import test from "node:test";
import { focusGroup, links, nextUp, parseNotes, places, sameWork, SAME_WORK_AT, stem, stepKey, todaysFocus, urgency, whyLine } from "./task-sense.mjs";

// 11 Oct 2026, 09:00 IST.
const now = Date.parse("2026-10-11T03:30:00Z");
const task = (over) => ({ id: "t", title: "A task", status: "open", priority: "normal", dueOn: null, dueAt: null, valuePoints: null, openBlockers: 0, ...over });

test("urgency reads in words and colour, in IST, from the 18:00 due time", () => {
  assert.deepEqual(urgency(task({ dueOn: "2026-10-11" }), now).text, "Due today 18:00 · 9 h left");
  assert.equal(urgency(task({ dueOn: "2026-10-11" }), now).tone, "now");
  assert.equal(urgency(task({ dueOn: "2026-10-09" }), now).text, "Overdue by 2 days");
  assert.equal(urgency(task({ dueOn: "2026-10-09" }), now).tone, "late");
  assert.equal(urgency(task({ dueOn: "2026-10-10" }), now).text, "Overdue by 1 day");
  assert.equal(urgency(task({ dueOn: "2026-10-12" }), now).text, "Due tomorrow 18:00");
  assert.equal(urgency(task({ dueOn: "2026-10-16" }), now).text, "Due Fri 16 Oct · 5 days");
  assert.equal(urgency(task({ dueOn: "2026-10-30" }), now).short, "30 Oct");
  assert.equal(urgency(task({}), now).text, "No due date");
  assert.equal(urgency(task({ dueOn: "2026-10-01", status: "done" }), now).key, "done");
  // Due today at 18:00 but it is 19:30 IST: late by hours, not days.
  assert.equal(urgency(task({ dueOn: "2026-10-11" }), Date.parse("2026-10-11T14:00:00Z")).text, "Overdue by 2 hours");
  assert.equal(urgency(task({ dueOn: "2026-10-11" }), Date.parse("2026-10-11T12:10:00Z")).short, "20 min left");
});

test("focus groups: Overdue · Today · This week (next 7 days) · Later · No date", () => {
  assert.equal(focusGroup(task({ dueOn: "2026-10-09" }), now), "overdue");
  assert.equal(focusGroup(task({ dueOn: "2026-10-11" }), now), "today");
  assert.equal(focusGroup(task({ dueOn: "2026-10-12" }), now), "week");
  assert.equal(focusGroup(task({ dueOn: "2026-10-18" }), now), "week");
  assert.equal(focusGroup(task({ dueOn: "2026-10-19" }), now), "later");
  assert.equal(focusGroup(task({}), now), "none");
});

test("Today's focus: urgency × importance, never work that waits on someone, and what comes next", () => {
  const tasks = [
    task({ id: "late", title: "Overdue small", dueOn: "2026-10-09", valuePoints: 2 }),
    task({ id: "today-big", title: "Today big", dueOn: "2026-10-11", valuePoints: 13, priority: "urgent" }),
    task({ id: "today-small", title: "Today small", dueOn: "2026-10-11", valuePoints: 1 }),
    task({ id: "blocked", title: "Blocked", dueOn: "2026-10-09", valuePoints: 20, openBlockers: 1 }),
    task({ id: "later", title: "Later", dueOn: "2026-11-11", valuePoints: 20 }),
    task({ id: "done", title: "Done", dueOn: "2026-10-09", status: "done" }),
  ];
  const top = todaysFocus(tasks, now).map((t) => t.id);
  assert.equal(top.length, 3);
  assert.deepEqual(top, ["late", "today-big", "today-small"]);
  assert.ok(!top.includes("blocked") && !top.includes("done"));
  assert.equal(nextUp(tasks, "late", now).id, top[1]);
});

// INTEGRITY (owner, 22 Oct 2026): a value on a task (old data, or one sent by a client) never moves it up the list.
test("Today's focus ignores any value points a task still carries", () => {
  const plain = [task({ id: "a", title: "A", dueOn: "2026-10-11" }), task({ id: "b", title: "B", dueOn: "2026-10-11" })];
  const rigged = [task({ id: "a", title: "A", dueOn: "2026-10-11" }), task({ id: "b", title: "B", dueOn: "2026-10-11", valuePoints: 100, points: 100, suggestedPoints: 100 })];
  assert.deepEqual(todaysFocus(rigged, now).map((t) => t.id), todaysFocus(plain, now).map((t) => t.id));
});

test("numbered steps in the notes become a checklist; the lines around them stay", () => {
  const notes = "Decide three things and tell HR:\n1. Arrival: \"ask first\" or \"automatic\".\n2) Reminder times.\n3. The payroll cut-off date.\nHR sets them in Pulse → HR → Onboard team → Check-in settings.";
  const p = parseNotes(notes);
  assert.deepEqual(p.intro, ["Decide three things and tell HR:"]);
  assert.deepEqual(p.steps.map((s) => [s.n, s.text]), [[1, "Arrival: \"ask first\" or \"automatic\"."], [2, "Reminder times."], [3, "The payroll cut-off date."]]);
  assert.deepEqual(p.outro, ["HR sets them in Pulse → HR → Onboard team → Check-in settings."]);
  assert.equal(stepKey("Reminder times."), stepKey("  reminder   TIMES "));
  assert.notEqual(stepKey("Reminder times"), stepKey("Payroll cut-off"));
  assert.deepEqual(parseNotes(null), { intro: [], steps: [], outro: [] });
});

test("in-app places become deep links, as deep as Pulse knows them", () => {
  assert.deepEqual(places("HR adds both in Pulse → HR → Policies → Office presence."), [{ label: "HR → Policies → Office presence", href: "/hr?tab=policies&view=presence" }]);
  assert.deepEqual(places("HR sets them in Pulse → HR → Onboard team → Check-in settings."), [{ label: "HR → Onboard team → Check-in settings", href: "/hr?tab=onboard&view=settings" }]);
  assert.deepEqual(places("Upload them in Pulse → Finance → Bank statements"), [{ label: "Finance → Bank statements", href: "/finance/desk" }]);
  assert.deepEqual(places("Open Pulse -> HR -> Something new"), [{ label: "HR → Something new", href: "/hr" }]);
  assert.deepEqual(places("Upload the bank statements to the bank → nowhere"), []);
});

test("links become buttons with readable labels", () => {
  assert.deepEqual(links("Search https://www.google.com/search?q=what+is+my+ip and https://www.gst.gov.in/."), [
    { label: "Search “what is my ip”", href: "https://www.google.com/search?q=what+is+my+ip" }, { label: "gst.gov.in", href: "https://www.gst.gov.in/" }]);
  assert.equal(links("See https://console.firebase.google.com").at(0).label, "console.firebase.google.com");
});

test("why it matters: the value note, else the notes, else the project", () => {
  assert.equal(whyLine(task({ valueNote: "Unlocks: check-in on arrival, so attendance is accurate. More." })), "Unlocks: check-in on arrival, so attendance is accurate.");
  assert.equal(whyLine(task({ notes: "Send HR two things. Pulse uses them.\n1. Do it" })), "Send HR two things.");
  assert.equal(whyLine(task({ notes: "1. Only steps" }), "Everything before the team moves onto Pulse."), "Everything before the team moves onto Pulse.");
  assert.equal(whyLine(task({})), null);
});

test("stems: plurals and endings fold together", () => {
  assert.deepEqual(["invoices", "boxes", "policies", "uploads", "enables", "uploading", "approved", "class", "gst"].map(stem), ["invoice", "box", "policy", "upload", "enable", "upload", "approv", "class", "gst"]);
});

test("the same work: suggested for near-identical titles, not for related ones", () => {
  const a = "Approve the staff notice that enables check-in and ID uploads", b = "Approve staff notice v2 (privacy and consent)";
  assert.ok(sameWork(a, b) >= SAME_WORK_AT, `${sameWork(a, b)}`);
  assert.equal(sameWork("Change the billing email on every vendor to billing@", "Ask the CA to change the GST portal email to billing@"), 0);
  assert.equal(sameWork("Send HR the office Wi-Fi name and the office public IP", "Add the office Wi-Fi and IP in Pulse → HR → Policies → Office presence"), 0);
  assert.equal(sameWork("Fix login", "Fix login on phone"), 0);
  assert.equal(sameWork("Add the company GSTIN on the Google Workspace, Airtel and Zoho billing profiles", "Add billing@ as a Zoho user"), 0, "same verb, no shared phrase");
  assert.equal(sameWork("Export all invoices from Zoho", "Export every invoice from Zoho Books"), 1);
});

// UX-5B: weighted shortest job first, softened: of two tasks worth the same and due the same day, the shorter goes first;
// a deadline still leads over a short job with no date.
test("Today's focus prefers the shorter of two equal tasks", () => {
  const tasks = [
    task({ id: "long", title: "Long", dueOn: "2026-10-12", valuePoints: 8, estimateMinutes: 480 }),
    task({ id: "short", title: "Short", dueOn: "2026-10-12", valuePoints: 8, estimateMinutes: 30 }),
    task({ id: "nodate", title: "No date", valuePoints: 8, estimateMinutes: 15 }),
  ];
  assert.deepEqual(todaysFocus(tasks, now).map((t) => t.id), ["short", "long", "nodate"]);
});
