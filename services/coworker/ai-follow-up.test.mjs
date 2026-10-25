// AI-EMP-2 (25 Oct 2026): work an AI employee starts itself (a quiet client, a missed call, a recorded call) always
// becomes a card for its approver; urgent cards say so; its runtime follows up its cards nobody decided; the rules cover
// language, money and two people asking opposite things. Against a fake Pulse; fake people only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Employee, OWN, RULES, stubModel } from "./runner.mjs";

const claude = { id: "server:claude", kind: "server", provider: "claude", label: "Claude subscription" };
function harness({ ctx, answers, opts = {} }) {
  const calls = [], prompts = [];
  const e = new Employee("http://pulse.invalid", { username: "coordinator.test" }, { ...opts, callModel: async (rt, prompt) => { prompts.push(prompt); return { text: answers.shift(), tokens: 900, tokensIn: 800, tokensOut: 100, seconds: 1.1 }; } });
  e.key = "pak_test"; e.me = { name: "Project Coordinator (test)", title: "Coordinator (AI)", manager: "Tara Kapoor (test)", provider: "claude", tools: ["chats", "tasks", "memory"], usedToday: 0, dailyBudget: 300000 };
  e.plan = async () => ({ chain: [claude], cfg: {}, usable: [claude], down: [] });
  e.call = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith("/dispatch")) return { status: "dispatched", runId: "run-1", context: structuredClone(ctx) };
    if (path.startsWith("/api/v0/agent/colleagues")) return { people: [{ name: "Ishaan Rao (test)", username: "ishaan.test", role: "Video editor" }] };
    if (path.startsWith("/api/v0/agent/directory")) return { people: [{ name: "Tara Kapoor (test)", username: "tara.test", role: "Account lead" }, { name: "Ishaan Rao (test)", username: "ishaan.test", role: "Video editor" }] };
    if (path === "/api/v0/agent/me") return e.me;
    if (path === "/api/v0/agent/events/claim") return { events: [] };
    if (path === "/api/v0/agent/follow-up") return { reminded: 1, escalated: 0, quiet: 0 };
    if (path.startsWith("/api/v0/agent/cards")) return { cards: opts.waiting ?? [] };
    if (path === "/api/v0/agent/runs/run-1") return { usedToday: 900, dailyBudget: 300000 };
    return {};
  };
  return { e, calls, prompts, run: () => e.handle({ id: "11111111-1111-4111-8111-111111111111" }, "lease") };
}
const paths = (calls) => calls.map((c) => c.path);
const base = (kind, own, over = {}) => ({ mode: "approve", kind, approver: "Tara Kapoor (test)", now: "Wednesday 28 Oct 2026, 11:00", timeZone: "Asia/Kolkata", workHours: true,
  message: { id: "m1", channelId: "c-client", body: "Anil, could you share the RERA number and the floor plans?", author: "Tara Kapoor (test)", channelKind: "custom", channelName: "Sunrise Builders (test)" },
  recent: [{ author: "Tara Kapoor (test)", at: "25 Oct 10:02", body: "Anil, could you share the RERA number and the floor plans?" }], memory: [], own, ...over });
const quiet = (over) => base("client.silent", { clients: ["Anil Sunrise (test)"], quietDays: 3, ourLast: { author: "Tara Kapoor (test)", body: "Anil, could you share the RERA number and the floor plans?", at: "Sunday 25 Oct, 10:02" },
  clientLast: { author: "Anil Sunrise (test)", body: "Sure, will send.", at: "Saturday 24 Oct, 18:40" }, followUpsSoFar: 0 }, over);
const missed = (over) => base("call.missed", { caller: "Anil Sunrise (test)", video: false, at: "Wednesday 28 Oct, 10:41", rang: ["Tara Kapoor (test)", "Ishaan Rao (test)"], missedToday: 1, workHours: true },
  { message: { id: "m2", channelId: "c-client", body: "Missed voice call", author: "Anil Sunrise (test)", channelKind: "custom", channelName: "Sunrise Builders (test)" }, ...over });

test("a quiet client: the follow-up is a card for the approver (propose-own), never a post, and nobody is asked", async () => {
  const h = harness({ ctx: quiet(), answers: [JSON.stringify({ action: "propose", message: "Hi Anil, a gentle nudge on the RERA number and floor plans: we need them to finish Reel 3's end card.", why: "Quiet 3 days while we wait." })] });
  await h.run();
  assert.match(h.prompts[0], /Anil Sunrise \(test\) has not written in "Sunrise Builders \(test\)" for 3 days/);
  assert.match(h.prompts[0], /\[25 Oct 10:02\] Tara Kapoor \(test\):/, "the conversation shows when each message was written");
  const card = h.calls.find((c) => c.path === "/api/v0/agent/runs/run-1/propose-own");
  assert.match(card.body.body, /RERA number/);
  assert.ok(!paths(h.calls).some((p) => p.includes("/chats/") || p.endsWith("/propose") || p.endsWith("/consult")), "no post, no ordinary card, no question to a colleague");
  assert.ok(!paths(h.calls).some((p) => p.startsWith("/api/v0/agent/colleagues")), "work it started itself does not consult");
  assert.ok(paths(h.calls).includes("/api/v0/agent/runs/run-1"), "the run closes");
});

test("a quiet client with nothing waiting on them: no card at all", async () => {
  const h = harness({ ctx: quiet(), answers: [JSON.stringify({ action: "none", why: "We owe them the next step." })] });
  await h.run();
  assert.ok(!paths(h.calls).some((p) => p.endsWith("/propose-own")));
  assert.ok(paths(h.calls).includes("/api/v0/agent/runs/run-1"));
});

test("a second follow-up offers a call instead of repeating the ask", async () => {
  const h = harness({ ctx: quiet({ own: { ...quiet().own, followUpsSoFar: 1 } }), answers: [JSON.stringify({ action: "none" })] });
  await h.run();
  assert.match(h.prompts[0], /We already followed up once since/);
  assert.match(h.prompts[0], /second follow-up: offer a short call/);
});

test("a missed client call: a call-back card and the call as a task, urgent when the model says so", async () => {
  const h = harness({ ctx: missed(), answers: [JSON.stringify({ action: "propose", message: "Hi Anil, sorry we missed your call. Tara will call you back today at 11:30; tell us if another time suits you.",
    why: "Missed call in working hours.", urgent: true, task: { title: "Call Anil Sunrise back", assignee: "tara.test", dueOn: "2026-10-28", notes: "11:30 today" } })] });
  await h.run();
  assert.match(h.prompts[0], /Anil Sunrise \(test\) called in "Sunrise Builders \(test\)" on Wednesday 28 Oct, 10:41; nobody answered/);
  assert.match(h.prompts[0], /a concrete time to call back/);
  assert.ok(h.calls.find((c) => c.path === "/api/v0/agent/runs/run-1/propose-own"));
  assert.ok(paths(h.calls).includes("/api/v0/agent/runs/run-1/urgent"));
  const t = h.calls.find((c) => c.path === "/api/v0/agent/runs/run-1/propose-task");
  assert.equal(t.body.assignee, "tara.test");
  assert.equal(t.body.dueOn, "2026-10-28");
});

test("a recorded client call: the recap is a card and up to six tasks are proposed", async () => {
  const ctx = base("call.recorded", { when: "Wednesday 28 Oct, 15:10", minutes: 12, people: [{ name: "Tara Kapoor (test)", side: "staff" }, { name: "Anil Sunrise (test)", side: "client" }],
    transcript: "Tara: so Reel 3 by Friday. Anil: yes, and send the floor plans deck. Tara: Ishaan will do the drone cut by Monday." },
    { message: { id: "m3", channelId: "c-client", body: "Call recording · 12:04", author: "Tara Kapoor (test)", channelKind: "custom", channelName: "Sunrise Builders (test)" } });
  const tasks = Array.from({ length: 8 }, (_, i) => ({ title: `Agreed item ${i + 1}`, assignee: "ishaan.test", dueOn: null, notes: "From the call" }));
  const h = harness({ ctx, answers: [JSON.stringify({ action: "propose", message: "Thanks for the call, Anil. Agreed: Reel 3 by Friday; drone cut by Monday.", why: "Recap of the call.", tasks })] });
  await h.run();
  assert.match(h.prompts[0], /Anil Sunrise \(test\) \(client\)/);
  assert.match(h.prompts[0], /only as said in the call/);
  assert.ok(h.calls.find((c) => c.path === "/api/v0/agent/runs/run-1/propose-own"));
  assert.equal(h.calls.filter((c) => c.path === "/api/v0/agent/runs/run-1/propose-task").length, 6, "six at most");
});

test("an urgent client message after hours: the card is marked urgent", async () => {
  const ctx = { mode: "approve", kind: "chat.group", approver: "Tara Kapoor (test)", now: "Tuesday 27 Oct 2026, 22:40", timeZone: "Asia/Kolkata",
    message: { id: "m4", channelId: "c-client", body: "URGENT the hoarding proof has the wrong phone number, printer starts at 7 am!!", author: "Anil Sunrise (test)", channelKind: "custom", channelName: "Sunrise Builders (test)" }, recent: [], memory: [] };
  const h = harness({ ctx, answers: [JSON.stringify({ action: "propose", message: "Anil, thanks for catching this. We are holding the print until the number is fixed.", why: "Time-critical before 7 am.", urgent: true })] });
  await h.run();
  assert.match(h.prompts[0], /"urgent": true when it is time-critical/);
  assert.match(h.prompts[0], /Working hours are 10:00-19:00, Mon Tue Wed Thu Fri Sat/);
  const order = paths(h.calls).filter((p) => p.endsWith("/propose") || p.endsWith("/urgent"));
  assert.deepEqual(order, ["/api/v0/agent/runs/run-1/propose", "/api/v0/agent/runs/run-1/urgent"]);
});

test("the rules: the person's language, no prices or invoice answers without the owner, opposite asks are named", () => {
  assert.match(RULES, /Hinglish in Latin letters gets Hinglish in Latin letters/);
  assert.match(RULES, /Never state, change or agree to a price, discount, quotation, invoice amount/);
  assert.match(RULES, /Do not admit or deny an invoice mistake/);
  assert.match(RULES, /two of them ask for opposite things, say so and ask them to agree/);
  assert.deepEqual([...OWN].sort(), ["call.missed", "call.recorded", "client.silent"]);
});

test("its runtime follows up its cards every five minutes, limited to the test install's people", async () => {
  const h = harness({ ctx: quiet(), answers: [], opts: { askOnly: ["tara.test", "kedab.test"] } });
  h.e.opts.ignoreQuota = true; h.e.sweptAt = Date.now(); h.e.expiredAt = Date.now(); h.e.mapAt = Date.now(); h.e.groupAt = Date.now();
  await h.e.tick();
  const f = h.calls.filter((c) => c.path === "/api/v0/agent/follow-up");
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].body.only, ["tara.test", "kedab.test"]);
  await h.e.tick();
  assert.equal(h.calls.filter((c) => c.path === "/api/v0/agent/follow-up").length, 1, "not again within five minutes");
});

test("the test runtime answers work it started itself plainly", async () => {
  const q = JSON.parse(await stubModel('Anil Sunrise (test) has not written in "Sunrise Builders (test)" for 3 days. The last message there is ours'));
  assert.equal(q.action, "propose");
  const m = JSON.parse(await stubModel('People you may give work to (JSON): [{"name":"Tara Kapoor (test)","username":"tara.test"}]\n\nAnil Sunrise (test) called in "Sunrise Builders (test)" on Wednesday 28 Oct, 10:41; nobody answered'));
  assert.equal(m.task.assignee, "tara.test");
});

test("a newer card replaces its waiting reply in that group, and the task it names (two people asked opposite things)", async () => {
  const ctx = { mode: "approve", kind: "chat.group", approver: "Tara Kapoor (test)", now: "Sunday 25 Oct 2026, 14:20", timeZone: "Asia/Kolkata",
    message: { id: "m5", channelId: "c-client", body: "Please keep the logo size as it is. A huge logo looks cheap.", author: "Ishita Rook (test)", channelKind: "custom", channelName: "Greenleaf (test)" }, recent: [], memory: [] };
  const waiting = [{ id: "11111111-aaaa-4aaa-8aaa-111111111111", kind: "reply", body: "Hi Neha, we will make the logo much larger." }, { id: "22222222-bbbb-4bbb-8bbb-222222222222", kind: "task", body: "Task: Enlarge the logo" },
    { id: "33333333-cccc-4ccc-8ccc-333333333333", kind: "task", body: "Task: Send the plan" }];
  const h = harness({ ctx, opts: { waiting }, answers: [JSON.stringify({ action: "propose", message: "Neha and Ishita, you asked for different logo sizes: could you agree on one?", why: "Opposite asks.",
    replaces: ["22222222-bbbb-4bbb-8bbb-222222222222", "not-a-card"] })] });
  await h.run();
  assert.match(h.prompts[0], /still waiting for Tara Kapoor \(test\)/);
  assert.match(h.prompts[0], /we will make the logo much larger/);
  const r = h.calls.find((c) => c.path === "/api/v0/agent/runs/run-1/replace");
  assert.deepEqual(r.body.ids.sort(), ["11111111-aaaa-4aaa-8aaa-111111111111", "22222222-bbbb-4bbb-8bbb-222222222222"], "the waiting reply and the named task; not the other task, nothing unknown");
});

test("a time-critical question to a colleague is marked urgent", async () => {
  const ctx = { mode: "approve", kind: "chat.group", approver: "Tara Kapoor (test)", now: "Sunday 25 Oct 2026, 22:40", timeZone: "Asia/Kolkata",
    message: { id: "m6", channelId: "c-client", body: "URGENT wrong number on the hoarding, printing at 7 am", author: "Anil Sunrise (test)", channelKind: "custom", channelName: "Sunrise Builders (test)" }, recent: [], memory: [] };
  const h = harness({ ctx, answers: [JSON.stringify({ action: "consult", consult: { to: "ishaan.test", question: "Can the hoarding file be fixed before 7 am?" }, urgent: true })] });
  h.e.call = ((orig) => async (method, path, body) => path.endsWith("/consult") ? (h.calls.push({ method, path, body }), { id: "q9", to: "Ishaan Rao (test)" }) : orig(method, path, body))(h.e.call);
  await h.run();
  assert.match(h.prompts[0], /"urgent": true only when it is time-critical/);
  const order = h.calls.map((c) => c.path).filter((p) => p.endsWith("/consult") || p.endsWith("/urgent"));
  assert.deepEqual(order, ["/api/v0/agent/runs/run-1/consult", "/api/v0/agent/runs/run-1/urgent"]);
});
