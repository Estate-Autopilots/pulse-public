// SIM-CLIENTS (25 Oct 2026): an AI employee asks a colleague before it answers someone, acts on the colleague's answer,
// says what a colleague told it to say, and proposes the task a revision needs. Against a fake Pulse; fake people only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Employee, RULES } from "./runner.mjs";

const claude = { id: "server:claude", kind: "server", provider: "claude", label: "Claude subscription" };
function harness({ ctx, answers }) {
  const calls = [], prompts = [];
  const e = new Employee("http://pulse.invalid", { username: "coordinator.test" }, { callModel: async (rt, prompt) => { prompts.push(prompt); return { text: answers.shift(), tokens: 900, tokensIn: 800, tokensOut: 100, seconds: 1.1 }; } });
  e.key = "pak_test"; e.me = { name: "Project Coordinator (test)", title: "Coordinator (AI)", manager: "Tara Kapoor (test)", provider: "claude", tools: ["chats", "tasks", "memory"], usedToday: 0, dailyBudget: 300000 };
  e.plan = async () => ({ chain: [claude], cfg: {}, usable: [claude], down: [] });
  e.call = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith("/dispatch")) return { status: "dispatched", runId: "run-1", context: structuredClone(ctx) };
    if (path.startsWith("/api/v0/agent/colleagues")) return { people: [{ name: "Ishaan Rao (test)", username: "ishaan.test", role: "Video editor", inThisChat: true }, { name: "Kedab Mifos (test)", username: "kedab.test", role: "Head of delivery", leader: true }] };
    if (path.startsWith("/api/v0/agent/directory")) return { people: [{ name: "Ishaan Rao (test)", username: "ishaan.test", role: "Video editor" }] };
    if (path === "/api/v0/agent/conversations") return { conversations: [{ id: "c-client", name: "Sunrise Builders (test)", withClient: true }] };
    if (path.endsWith("/consult")) return { id: "q1", chatId: "dm-ishaan", to: "Ishaan Rao (test)" };
    if (path.endsWith("/relay")) return { consult: "q1", proposal: "p1" };
    if (path.endsWith("/post-to")) return { proposal: "p2", posted: false };
    if (path === "/api/v0/agent/runs/run-1") return { usedToday: 900, dailyBudget: 300000 };
    return {};
  };
  return { e, calls, prompts, run: () => e.handle({ id: "11111111-1111-4111-8111-111111111111" }, "lease") };
}
const group = (over = {}) => ({ mode: "approve", kind: "chat.group", approver: "Tara Kapoor (test)", now: "Sunday 25 Oct 2026, 10:00", timeZone: "Asia/Kolkata",
  message: { id: "m1", channelId: "c-client", body: "When will the drone shots from Saturday be ready?", author: "Anil Sunrise (test)", channelKind: "custom", channelName: "Sunrise Builders (test)" },
  recent: [], memory: [], ...over });
const paths = (calls) => calls.map((c) => c.path);

test("the prompt offers asking a colleague first, and forbids promising to check without doing it", async () => {
  const h = harness({ ctx: group(), answers: [JSON.stringify({ action: "none" })] });
  await h.run();
  assert.match(h.prompts[0], /"action": "consult"/);
  assert.match(h.prompts[0], /ishaan\.test/);
  assert.match(RULES, /Never say you passed something on, checked with someone, or will come back later unless you do it/);
});

test("a client question that needs the editor: it asks the editor and posts nothing in the client group", async () => {
  const h = harness({ ctx: group(), answers: [JSON.stringify({ action: "consult", consult: { to: "@ishaan.test", question: "Anil asks when Saturday's drone shots will be ready. When can we share them?" }, message: "Let me check" })] });
  await h.run();
  const c = h.calls.find((x) => x.path === "/api/v0/agent/runs/run-1/consult");
  assert.equal(c.body.to, "ishaan.test");
  assert.match(c.body.question, /drone shots/);
  assert.ok(!paths(h.calls).some((p) => p.endsWith("/propose") || p.includes("/chats/")), "no card, no post in the client group (it asks first)");
  assert.ok(paths(h.calls).includes("/api/v0/agent/runs/run-1"), "the run closes");
});

const answer = (over = {}) => ({ mode: "own", kind: "consult.answer", approver: "Tara Kapoor (test)", now: "Sunday 25 Oct 2026, 11:00",
  message: { id: "m9", channelId: "dm-ishaan", body: "Tuesday evening, 6 pm. Colour grading is left.", author: "Ishaan Rao (test)", channelKind: "direct" },
  recent: [], memory: [], consult: { id: "q1", question: "When can we share Saturday's drone shots?", colleague: "Ishaan Rao (test)", asker: "Anil Sunrise (test)",
    sourceChannelId: "c-client", sourceChannelName: "Sunrise Builders (test)", sourceMessage: "When will the drone shots be ready?", clientFacing: true, approver: "Tara Kapoor (test)", sourceRecent: [] }, ...over });

test("the colleague's answer becomes the reply to the client (a card), and the colleague hears what happened", async () => {
  const h = harness({ ctx: answer(), answers: [JSON.stringify({ action: "relay", message: "Hi Anil, the drone shots will be ready on Tuesday by 6 pm; colour grading is the last step.", why: "Ishaan gave the time." })] });
  await h.run();
  assert.match(h.prompts[0], /You asked Ishaan Rao \(test\)/);
  assert.match(h.prompts[0], /a client conversation; Tara Kapoor \(test\) approves/);
  const r = h.calls.find((x) => x.path === "/api/v0/agent/runs/run-1/relay");
  assert.equal(r.body.consultId, "q1");
  assert.match(r.body.body, /Tuesday by 6 pm/);
  const thanks = h.calls.find((x) => x.path === "/api/v0/agent/chats/dm-ishaan/messages");
  assert.match(thanks.body.body, /Tara Kapoor \(test\) approves it before it goes to “Sunrise Builders \(test\)”/);
});

test("a follow-up question goes back to the colleague, not to the client", async () => {
  const h = harness({ ctx: answer({ message: { id: "m9", channelId: "dm-ishaan", body: "Which shots, the tower ones?", author: "Ishaan Rao (test)", channelKind: "direct" } }),
    answers: [JSON.stringify({ action: "reply", message: "Yes, the tower flyover from Saturday." })] });
  await h.run();
  assert.ok(!paths(h.calls).some((p) => p.endsWith("/relay")));
  assert.equal(h.calls.find((x) => x.path === "/api/v0/agent/chats/dm-ishaan/messages").body.body, "Yes, the tower flyover from Saturday.");
});

test("a revision: the reply and the editor's task are both proposed", async () => {
  const h = harness({ ctx: group({ message: { id: "m2", channelId: "c-client", body: "Reel 2: more upbeat music and a bigger logo please", author: "Anil Sunrise (test)", channelKind: "custom", channelName: "Sunrise Builders (test)" } }),
    answers: [JSON.stringify({ action: "propose", message: "Noted, Anil: upbeat music and a bigger logo on Reel 2.", why: "ack", task: { title: "Revise Reel 2: upbeat music, bigger logo", assignee: "ishaan.test", dueOn: "2026-10-26", notes: "Client ask" } })] });
  await h.run();
  assert.ok(paths(h.calls).includes("/api/v0/agent/runs/run-1/propose"));
  const t = h.calls.find((x) => x.path === "/api/v0/agent/runs/run-1/propose-task");
  assert.equal(t.body.assignee, "ishaan.test");
  assert.equal(t.body.dueOn, "2026-10-26");
});

test("told by a colleague to tell the client something: it goes to that conversation (a card, with a client)", async () => {
  const h = harness({ ctx: { mode: "own", kind: "chat.message", askerIsApprover: true, approver: "Tara Kapoor (test)", now: "Sunday 25 Oct 2026, 12:00",
    message: { id: "m3", channelId: "dm-tara", body: "Tell Anil the reels go live on Friday at 10 am", author: "Tara Kapoor (test)", channelKind: "direct" }, recent: [], memory: [] },
  answers: [JSON.stringify({ action: "post_to", channel: "c-client", message: "Hi Anil, the reels go live on Friday at 10 am.", why: "Tara asked." })] });
  await h.run();
  assert.match(h.prompts[0], /"action": "post_to"/);
  const p = h.calls.find((x) => x.path === "/api/v0/agent/runs/run-1/post-to");
  assert.equal(p.body.channelId, "c-client");
  assert.ok(!h.calls.some((x) => x.path === "/api/v0/agent/chats/dm-tara/messages"), "the card is the answer; no extra line");
});

test("a test install can limit whom its AI employees ask (askOnly)", async () => {
  const h = harness({ ctx: group(), answers: [JSON.stringify({ action: "none" })] });
  await h.run();
  assert.match(h.prompts[0], /kedab\.test/);
  const g = harness({ ctx: group(), answers: [JSON.stringify({ action: "none" })] });
  g.e.opts.askOnly = ["ishaan.test"];
  await g.run();
  assert.doesNotMatch(g.prompts[0], /kedab\.test/);
  assert.match(g.prompts[0], /ishaan\.test/);
});
