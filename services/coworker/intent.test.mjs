// AGENT-MEMORY (8 Nov 2026): the bugs seen in the 7 Nov demo, as tests. "Can you remember that?" made a task; "I have
// noted that every quotation …" was not kept; out of budget it went silent. Typed rules read the message before any model
// call, and the AI employee answers in words. Synthetic names and values only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { aboutOf, earlierNote, forgotText, isStanding, memoryIntent, recallText, rememberedText, topicOf } from "./intent.mjs";
import { Employee, RULES, rulesText, aboutText, companyText, conversationText } from "./runner.mjs";

test("remember / note / keep in mind / from now on are read before the model, and a to-do is not a note", () => {
  assert.deepEqual(memoryIntent("Can you remember that?"), { kind: "note", body: "", ref: true });
  assert.deepEqual(memoryIntent("@pip.test please remember this"), { kind: "note", body: "", ref: true });
  assert.deepEqual(memoryIntent("Remember that Bevit prefers calls after 6 pm"), { kind: "note", body: "Bevit prefers calls after 6 pm", ref: false });
  assert.deepEqual(memoryIntent("Keep in mind: the Pune client pays by cheque"), { kind: "note", body: "The Pune client pays by cheque", ref: false });
  assert.deepEqual(memoryIntent("Note: Kazuk is away on Friday"), { kind: "note", body: "Kazuk is away on Friday", ref: false });
  assert.deepEqual(memoryIntent("I have noted that every quotation should mention 50% advance with the order."),
    { kind: "rule", body: "Every quotation should mention 50% advance with the order.", ref: false });
  assert.deepEqual(memoryIntent("From now on, send quotations as a PDF"), { kind: "rule", body: "Send quotations as a PDF", ref: false });
  assert.equal(memoryIntent("Always copy Kazuk on quotations").kind, "rule");
  assert.equal(memoryIntent("Never offer a discount above 10%").kind, "rule");
  assert.equal(memoryIntent("Every quotation must include transport charges").kind, "rule");
  assert.deepEqual(memoryIntent("undo"), { kind: "undo" });
  assert.deepEqual(memoryIntent("Forget that."), { kind: "undo" });
  // Not memory: a to-do, a question about memory, an ordinary request, a question about a rule.
  assert.equal(memoryIntent("Remember to send the invoice tomorrow"), null);
  assert.equal(memoryIntent("Can you remember what I said yesterday?"), null);
  assert.equal(memoryIntent("Make a quote for the Live Demo client"), null);
  assert.equal(memoryIntent("Should every quotation include GST?"), null);
  assert.equal(memoryIntent("Notes from the call are attached"), null);
  assert.ok(isStanding("every quote should carry the site address") && !isStanding("Bevit likes tea"));
});

test("'remember that' keeps what the same person said just before; whom and what it is about", () => {
  const recent = [{ author: "Kazuk (test)", body: "Bevit reviews quotes only after lunch" }, { author: "Pip", body: "Noted.", mine: true },
    { author: "Asha (test)", body: "Hi" }, { author: "Kazuk (test)", body: "Can you remember that?" }];
  assert.equal(earlierNote(recent, "Kazuk (test)", "Can you remember that?"), "Bevit reviews quotes only after lunch");
  assert.equal(earlierNote([{ author: "Kazuk (test)", body: "Can you remember that?" }], "Kazuk (test)", "Can you remember that?"), "");
  const people = [{ name: "Bevit Shah (test)", username: "bevit.test" }, { name: "Asha Rao (test)", username: "asha.test" }];
  assert.deepEqual(aboutOf("Bevit reviews quotes only after lunch", people), { username: "bevit.test", name: "Bevit Shah (test)" });
  assert.deepEqual(aboutOf("@asha.test wants drafts by 5", people), { username: "asha.test", name: "Asha Rao (test)" });
  assert.deepEqual(aboutOf("I prefer WhatsApp to calls", people, { name: "Kazuk (test)" }), { self: true, name: "Kazuk (test)" });
  assert.equal(aboutOf("The office closes at 7", people, { name: "Kazuk (test)" }), null);
  assert.equal(topicOf("The office closes at 7"), "general");
  assert.equal(topicOf("Quotes go out before noon"), "quotations");
});

test("the confirmation says where it was kept, and how to undo it", () => {
  assert.equal(rememberedText({ kind: "note", about: { name: "Bevit Shah (test)" } }, "Bevit reviews quotes only after lunch", "https://x.example/k"),
    'Saved to my notes about Bevit Shah (test): "Bevit reviews quotes only after lunch". Reply "undo" to remove it. You can see or change it here: https://x.example/k');
  assert.match(rememberedText({ kind: "rule", scope: "quotation", include: "50% advance with the order" }, "Every quotation should mention 50% advance with the order", ""),
    /^Saved as a standing rule for quotations: ".+"\. I'll follow it from now on, and every quotation I draft will include "50% advance with the order"\. Reply "undo"/);
  assert.match(rememberedText({ kind: "note", about: { name: "Rila (test)" }, downgraded: true, canSetRules: "Kazuk (test)" }, "Always send me drafts first", ""),
    /^Saved to my notes about Rila \(test\): .+ Only Kazuk \(test\) or an admin can make it a rule for everyone/);
  assert.match(RULES, /never a task/);
});

test("its rules are instructions in every prompt; its notes about the person only with them", () => {
  const t = rulesText([{ body: "Every quotation should mention 50% advance with the order", scope: "quotation", include: "50% advance with the order", setBy: "Kazuk (test)", setOn: "7 Nov" }]);
  assert.match(t, /follow every one, every time/);
  assert.match(t, /- \[Quotations\] Every quotation should mention 50% advance with the order \(set by Kazuk \(test\), 7 Nov\)/);
  assert.equal(rulesText([]), "");
  assert.match(aboutText(["Reviews quotes only after lunch"], "Bevit Shah (test)"), /^How Bevit Shah \(test\) works .+\n- Reviews quotes only after lunch$/);
});

/** An AI employee against a fake Pulse: every call is recorded; the model must never be called on the memory path. */
function harness({ ctx, dispatch, me = {}, memory, notes }) {
  const calls = [], posted = [];
  let modelCalls = 0;
  const e = new Employee("http://pulse.invalid", { username: "pip.test" }, { callModel: async () => { modelCalls += 1; return { text: '{"action": "propose_task", "task": {"title": "Remember that"}}', tokens: 900, seconds: 1 }; } });
  e.key = "pak_test"; e.me = { name: "Pip (test)", title: "Quotation agent (AI)", manager: "Kazuk (test)", provider: "claude", tools: ["chats", "tasks", "billing"], usedToday: 0, dailyBudget: 300000, ...me };
  e.plan = async () => ({ chain: [], cfg: {}, usable: [{ id: "server:claude", kind: "server", provider: "claude", label: "Claude subscription" }], down: [] });
  e.call = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith("/dispatch")) return dispatch ?? { status: "dispatched", runId: "run-1", context: structuredClone(ctx) };
    if (path.startsWith("/api/v0/agent/chats/") && path.endsWith("/messages")) { posted.push(body.body); return { id: "m" }; }
    if (path.startsWith("/api/v0/agent/colleagues")) return { people: [{ name: "Bevit Shah (test)", username: "bevit.test" }] };
    if (path === "/api/v0/agent/runs/run-1/remember") return body.kind === "rule"
      ? { kind: "rule", id: "r1", scope: "quotation", include: "50% advance with the order", link: "https://x.example/people/ai/pip?tab=ai&section=knowledge" }
      : { kind: "note", id: "n1", about: { name: "Bevit Shah (test)" }, link: "https://x.example/people/ai/pip?tab=ai&section=knowledge" };
    if (path === "/api/v0/agent/runs/run-1/remember/undo") return { undone: true, kind: "note", body: "Bevit reviews quotes only after lunch" };
    if (path === "/api/v0/agent/runs/run-1/memory") return memory ?? { direct: true, count: 2, items: [{ body: "Prefers site visit reports by email", private: true }, { body: "Owns the launch checklist (test)", private: false, by: "Kazuk (test)" }], link: "https://x.example/people/pip?tab=ai&s=knowledge" };
    if (path === "/api/v0/agent/runs/run-1/memory/forget") return { forgotten: 3, kept: 1, person: "Kazuk (test)" };
    if (path.startsWith("/api/v0/agent/notes")) return notes ?? {};
    if (path === "/api/v0/agent/events/claim") return { events: [{ event: { id: "e-9" }, leaseToken: "lease-9" }] };
    if (path.endsWith("/budget-reply")) return { status: "told" };
    return {};
  };
  return { e, calls, posted, models: () => modelCalls, run: () => e.handle({ id: "11111111-1111-4111-8111-111111111111" }, "lease") };
}
const dm = (body, over = {}) => ({ mode: "own", kind: "chat.message", now: "Sunday 8 Nov 2026, 11:00", timeZone: "Asia/Kolkata",
  message: { id: "m2", channelId: "c1", body, author: "Kazuk (test)", authorId: "p-kazuk", channelKind: "direct" },
  recent: [{ author: "Kazuk (test)", body: "Bevit reviews quotes only after lunch" }, { author: "Kazuk (test)", body }], memory: [], ...over });

test("bug 1: 'Can you remember that?' saves a note about Bevit and says so; no task, no model call", async () => {
  const h = harness({ ctx: dm("Can you remember that?") });
  await h.run();
  assert.equal(h.models(), 0, "decided by the typed rule");
  const saved = h.calls.find((c) => c.path === "/api/v0/agent/runs/run-1/remember");
  assert.deepEqual(saved.body, { kind: "note", body: "Bevit reviews quotes only after lunch", aboutSelf: false, aboutUsername: "bevit.test", topic: null });
  assert.ok(!h.calls.some((c) => /propose-task|task-act|chief-act/.test(c.path)), "never a task");
  assert.match(h.posted[0], /^Saved to my notes about Bevit Shah \(test\): "Bevit reviews quotes only after lunch"\. Reply "undo" to remove it\./);
  assert.deepEqual(h.calls.find((c) => c.path === "/api/v0/agent/runs/run-1").body, { state: "done", tokens: 0, seconds: 0 });
  const u = harness({ ctx: dm("undo") });
  await u.run();
  assert.match(u.posted[0], /^Done: I removed that note \("Bevit reviews quotes only after lunch"\)\./);
});

test("bug 2: 'I have noted that every quotation …' is kept as a rule, worded from what Pulse kept", async () => {
  const h = harness({ ctx: dm("I have noted that every quotation should mention 50% advance with the order") });
  await h.run();
  assert.equal(h.models(), 0);
  assert.equal(h.calls.find((c) => c.path === "/api/v0/agent/runs/run-1/remember").body.kind, "rule");
  assert.match(h.posted[0], /^Saved as a standing rule for quotations: .+every quotation I draft will include "50% advance with the order"/);
});

test("a client's message, a task and an ordinary request go to the model as before", async () => {
  const c = harness({ ctx: dm("Remember that we need it by Monday", { message: { ...dm("x").message, body: "Remember that we need it by Monday", client: true } }) });
  await c.run();
  assert.ok(!c.calls.some((x) => x.path.endsWith("/remember")), "a client never sets notes this way");
  const o = harness({ ctx: dm("Make a quote for the Live Demo client") });
  await o.run();
  assert.equal(o.models() > 0, true);
});

test("bug 3: refused for budget, the person hears it (Pulse words it); out of budget, waiting messages are each told", async () => {
  const h = harness({ ctx: dm("hi"), dispatch: { status: "refused", reason: "budget_spent" } });
  await h.run();
  assert.ok(h.calls.some((c) => c.path === "/api/v0/agent/events/11111111-1111-4111-8111-111111111111/budget-reply"), "answered in words, not silence");
  assert.equal(h.models(), 0);
  const o = harness({ ctx: dm("hi"), me: { provider: "stub", budgetLevel: "out" } });
  o.e.me = { ...o.e.me };
  o.e.call = ((inner) => async (m, p, b) => (p === "/api/v0/agent/me" ? o.e.me : inner(m, p, b)))(o.e.call);
  const told = await o.e.tick();
  assert.equal(told, 1);
  assert.deepEqual(o.calls.find((c) => c.path.endsWith("/budget-reply")).body, { leaseToken: "lease-9" });
  assert.ok(!o.calls.some((c) => c.path.endsWith("/dispatch")), "nothing is dispatched while out of budget");
});

// AGENT-MEMORY (2090, owner P4.1): people see and forget what it remembers about them; what a run is given comes from Pulse.
test("'what do you remember about me' and 'forget everything about me' are read before the model; a recall is not a note", () => {
  for (const t of ["What do you remember about me?", "what do you know about me", "Can you tell me what you remember about me?", "show me my notes", "@pip.test what have you noted about me?"])
    assert.deepEqual(memoryIntent(t), { kind: "recall" }, t);
  for (const t of ["Forget everything about me", "please forget all about me.", "Delete everything you know about me", "clear my notes", "forget me"])
    assert.deepEqual(memoryIntent(t), { kind: "forget_all" }, t);
  assert.deepEqual(memoryIntent("forget that"), { kind: "undo" }, "the newest note only");
  assert.equal(memoryIntent("What do you remember about the Pune client?"), null, "a question about something else goes to the model");
  assert.equal(memoryIntent("Remember what I said about the Pune client?"), null);
});

test("the recall lists notes only in a direct chat, says who wrote a manager's note, and the forget answer counts", () => {
  const r = recallText({ direct: true, count: 2, items: [{ body: "Prefers site visit reports by email", private: true }, { body: "Owns the launch checklist (test)", by: "Kazuk (test)" }] }, "https://x.example/k");
  assert.match(r, /^Here's what I remember about you \(only you see the private ones\):\n- Prefers site visit reports by email\n- Owns the launch checklist \(test\) \(written by Kazuk \(test\)\)\nSay "forget everything about me"/);
  assert.match(r, /here: https:\/\/x\.example\/k$/);
  assert.match(recallText({ direct: false, count: 3, items: [] }), /^I keep 3 notes about you\. Ask me in our direct chat/);
  assert.match(recallText({ direct: true, count: 0, items: [] }), /^I don't keep any notes about you yet/);
  assert.equal(forgotText({ forgotten: 3, kept: 1 }), "Done. I've forgotten 3 things I remembered about you. 1 note your manager wrote stays; ask them to change it.");
  assert.equal(forgotText({ forgotten: 0, kept: 0 }), "I had nothing of my own to forget about you.");
});

test("'what do you remember about me?' is answered from Pulse with no model call; 'forget everything about me' too", async () => {
  const h = harness({ ctx: dm("What do you remember about me?") });
  await h.run();
  assert.equal(h.models(), 0);
  assert.ok(h.calls.some((c) => c.method === "GET" && c.path === "/api/v0/agent/runs/run-1/memory"));
  assert.match(h.posted[0], /^Here's what I remember about you/);
  assert.ok(!h.calls.some((c) => c.path.endsWith("/remember")), "a recall keeps nothing");
  const f = harness({ ctx: dm("Forget everything about me") });
  await f.run();
  assert.equal(f.models(), 0);
  assert.ok(f.calls.some((c) => c.method === "POST" && c.path === "/api/v0/agent/runs/run-1/memory/forget"));
  assert.match(f.posted[0], /^Done\. I've forgotten 3 things/);
});

test("each run asks Pulse for its memory by the run (never by a person the model names) and gets the levels in its prompt", async () => {
  const notes = { rules: [], person: "Kazuk (test)", about: ["Owns the launch checklist (test)"], private: ["Prefers site visit reports by email"],
    conversation: [{ who: "Ashby Rook (test client)", body: "Prefers calls after 6 pm" }], company: ["Our office is closed on Sundays."] };
  let prompt = "";
  const h = harness({ ctx: dm("What should I send today?"), notes });
  h.e.opts.callModel = async (rt, p) => { prompt += typeof p === "string" ? p : JSON.stringify(p); return { text: "Send the site visit report by email.", tokens: 50, seconds: 1 }; };
  await h.run();
  const ask = h.calls.find((c) => c.path.startsWith("/api/v0/agent/notes"));
  assert.equal(ask.path, "/api/v0/agent/notes?run=run-1");
  assert.match(prompt, /How Kazuk \(test\) works[^]*- Prefers site visit reports by email[^]*- Owns the launch checklist \(test\)/);
  assert.match(prompt, /What your company has told you[^]*- Our office is closed on Sundays\./);
  assert.match(prompt, /What you keep from this conversation[^]*- Ashby Rook \(test client\): Prefers calls after 6 pm/);
  assert.equal(companyText([]), "");
  assert.equal(conversationText([]), "");
});
