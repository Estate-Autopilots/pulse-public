// TOKENS-2: the model router (router.mjs). Requests are shaped like production's (synthetic words).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, patternFor, playbookPart, routeFor, shapeOf, taskTypeOf, wantsMore } from "./router.mjs";

const chat = (body, extra = {}) => ({ kind: "chat.direct", message: { body, ...extra } });
const task = (title, { cause = "assigned", notes = "", thread = [] } = {}) => ({ task: { title, notes }, cause, thread });

test("a chat is classed by what it asks: small, lookup, action or heavy", () => {
  const cls = (b, o) => classify(chat(b), o).cls;
  assert.equal(cls("thanks!", { simple: true }), "small");
  assert.equal(cls("ok noted"), "small");
  assert.equal(cls("Who is on leave today?"), "lookup");
  assert.equal(cls("status of the Jote quotation"), "action", "a quotation ask goes to the quotation tools");
  assert.equal(cls("What is pending with Kazuk this week?"), "lookup");
  assert.equal(cls("Create a task for Ravi to call the vendor tomorrow"), "action");
  assert.equal(cls("Make a quote for 2 x 3 kW solar systems with installation"), "action");
  assert.equal(cls("रवि को कल vendor को call करने का task बनाओ"), "action");
  assert.equal(cls("आज कौन छुट्टी पर है"), "lookup");
  assert.equal(cls("Analyse last month's expenses against the budget and tell me where we overspent"), "heavy");
  assert.equal(cls("Reconcile the October bank statement with our invoices"), "heavy");
  assert.equal(cls("Draft a service agreement for the new client"), "heavy");
  assert.equal(cls("please check", { simple: false }), "lookup");
  assert.equal(classify(chat("see attached", { files: [{ id: "f1" }] })).cls, "heavy", "files to read");
  assert.equal(cls("x".repeat(800)), "heavy", "a long ask");
});

test("a task is classed by its own words; a quiet reminder is small; something new is read from the new lines", () => {
  assert.deepEqual(classify(task("Follow up on the site photos", { cause: "daily" }), { quiet: true }), { cls: "small", why: "a reminder on a quiet task" });
  assert.equal(classify(task("Send the brochure to the client")).cls, "action");
  assert.equal(classify(task("Prepare the GST working for October")).cls, "heavy");
  assert.equal(classify(task("Monthly report", { notes: "Analyse sales by region" })).cls, "heavy");
  const asked = task("Send the brochure", { cause: "comment", thread: [{ body: "Sent it last week", mine: true }, { body: "When will it be ready?", new: true }] });
  assert.equal(classify(asked).cls, "lookup");
  const work = task("Send the brochure", { cause: "comment", thread: [{ body: "Please also compare the two vendors' prices", new: true }] });
  assert.equal(classify(work).cls, "heavy");
});

test("the kind of work is named as the database names it", () => {
  assert.equal(taskTypeOf(task("x", { cause: "daily" })), "task.daily");
  assert.equal(taskTypeOf(task("x", { cause: "weird" })), "task.look");
  assert.equal(taskTypeOf(chat("Make a quotation for Mifos")), "chat.quote");
  assert.equal(taskTypeOf(chat("Has the invoice been paid?")), "chat.money");
  assert.equal(taskTypeOf(chat("hi")), "chat.short");
  assert.equal(taskTypeOf(chat("Who in the team knows how to set up the projector in the big room?")), "chat.ask");
});

test("the route: the class's tier, the company's override, what was learned, a pattern, the day's budget", () => {
  const t = (ctx, cfg, o) => routeFor(ctx, cfg, { legacy: "strong", ...o }).tier;
  assert.equal(t(task("Send the brochure")), "fast", "routine task work no longer runs on the strong tier");
  assert.equal(t(task("Prepare the GST working for October")), "strong");
  assert.equal(t(chat("hello"), {}, { simple: true }), "small");
  assert.equal(t(chat("Who is on leave today?")), "fast");
  // The company's own: off (the old tiers), or another tier for a class.
  assert.deepEqual(routeFor(task("Send the brochure"), { router: { mode: "off" } }, { legacy: "strong" }).cls, null);
  assert.equal(t(task("Send the brochure"), { router: { mode: "off" } }), "strong");
  assert.equal(t(task("Send the brochure"), { router: { tiers: { action: "strong" } } }), "strong");
  assert.equal(t(chat("Analyse the sales"), { router: { tiers: { heavy: "fast" } } }), "fast");
  // Learned: a class that often needed more starts a tier up (not above strong); the company's own setting wins.
  assert.equal(t(chat("Who is on leave today?"), { router: { learned: { lookup: 40 } } }), "strong");
  assert.equal(t(chat("Who is on leave today?"), { router: { learned: { lookup: 20 } } }), "fast");
  assert.equal(t(chat("Who is on leave today?"), { router: { learned: { lookup: 40 }, tiers: { lookup: "small" } } }), "small");
  // An approved pattern for this kind of work: its tier when cheaper, and its steps in the prompt.
  const p = { key: "pattern:task.assigned:abc", taskType: "task.assigned", tools: ["list_tasks", "add_comment"], tier: "small", avgTokens: 20000 };
  const r = routeFor(task("Prepare the GST working for October"), { patterns: [p] }, { legacy: "strong" });
  assert.equal(r.tier, "small"); assert.equal(r.pattern.key, p.key); assert.match(r.why, /approved way/);
  assert.equal(patternFor(task("x", { cause: "daily" }), [p]), null, "only for its own kind of work");
  assert.match(playbookPart(p).text, /list_tasks → add_comment/);
  // Near the end of today's budget, never above fast; a company budget tier of fast is the highest.
  assert.equal(t(chat("Analyse the sales"), {}, { soft: true }), "fast");
  assert.equal(t(chat("Analyse the sales"), {}, { cap: "fast" }), "fast");
  assert.equal(t(chat("hello"), { router: { mode: "off" } }, { legacy: "small", soft: true }), "small");
});

test("an answer that hands the work up, and the answer's shape (what it did, not what it said)", () => {
  assert.equal(wantsMore('{"action":"escalate","why":"needs a careful reconciliation"}'), true);
  assert.equal(wantsMore('{"action": "reply", "message": "Use action escalate if needed"}'), false);
  assert.equal(shapeOf(true, { comment: "Reminder sent", status: "waiting" }), "task:comment+status=waiting");
  assert.equal(shapeOf(true, {}), null);
  assert.equal(shapeOf(false, { action: "reply", said: "Ravi and Meera are on leave today." }), "chat:reply:short");
  assert.equal(shapeOf(false, { action: "propose_task", said: "x".repeat(300) }), "chat:propose_task:medium");
});
