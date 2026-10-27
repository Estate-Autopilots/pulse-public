// AI-AUTONOMY (owner, 27 Oct 2026): an AI employee answers colleagues and leadership itself; only genuinely risky
// actions (a client, money, deleting data, legal or HR, above its cost limit) wait for a person, per its risk policy.
// Synthetic names and amounts only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { amounts, decide, DEFAULT_POLICY, holdWhy, policyOf, risksOf } from "./risk-policy.mjs";
import { Employee } from "./runner.mjs";

test("the default policy: colleagues on its own, the risky kinds ask first, deleting always asks", () => {
  assert.deepEqual({ ...DEFAULT_POLICY }, { internal: "send", clients: "ask", money: "ask", delete: "ask", legalHr: "ask", costLimit: 25000 });
  assert.equal(policyOf({ delete: "send" }).delete, "ask", "deleting data is never on its own");
  assert.equal(policyOf({ clients: "send", clientsAllowed: false }).clients, "ask", "clients only once the organisation allows it");
  assert.equal(policyOf({ clients: "send", clientsAllowed: true }).clients, "send");
});

test("amounts are read in rupees: ₹, Rs, INR, k, lakh, crore", () => {
  assert.deepEqual(amounts("₹45,000 now and Rs 2 lakh later, 30k INR, INR 1.5 cr"), [45000, 200000, 30000, 15000000]);
  assert.deepEqual(amounts("the 3 reels are due on 12 Nov"), []);
});

test("risks: a commitment is risky, a mention is not", () => {
  assert.deepEqual(risksOf("Hi Kazuk, the Skyline reel goes out at 6 pm today."), []);
  assert.deepEqual(risksOf("The invoice is with finance; Meera will share it."), [], "mentioning an invoice commits nothing");
  assert.deepEqual(risksOf("We will refund you the full amount."), ["money"]);
  assert.deepEqual(risksOf("I'll give you a 10% discount on the next shoot."), ["money"]);
  assert.deepEqual(risksOf("We have deleted your account data as asked."), ["delete"]);
  assert.deepEqual(risksOf("Please draft the warning letter for him."), ["legal_hr"]);
  assert.deepEqual(risksOf("Our budget this month is ₹80,000."), [], "an internal budget mention is not a commitment");
  assert.deepEqual(risksOf("We will pay ₹80,000 by Friday.").sort(), ["cost", "money"]);
  assert.deepEqual(risksOf("Here is the plan.", ["Money", "nonsense", "legal"]).sort(), ["legal_hr", "money"], "the model's own list, known names only");
  assert.deepEqual(risksOf("Sure, see you at 4.", [], { clientFacing: true }), ["client"]);
});

test("decide: leadership one to one always gets the answer; colleagues unless risky; clients ask by default", () => {
  assert.deepEqual(decide({}, ["money"], { to: "leader" }).send, true, "the leader is the one who would approve");
  assert.deepEqual(decide({}, [], { to: "colleague" }), { send: true, risks: [], hold: [] });
  assert.deepEqual(decide({}, ["money"], { to: "colleague" }).hold, ["money"]);
  assert.deepEqual(decide({ money: "send" }, ["money"], { to: "colleague" }).send, true);
  assert.deepEqual(decide({ money: "send" }, ["money", "cost"], { to: "colleague" }).hold, ["cost"], "above the cost limit asks whatever money says");
  assert.deepEqual(decide({}, ["client"], { to: "client" }).hold, ["client"]);
  assert.deepEqual(decide({ clients: "send", clientsAllowed: true }, ["client"], { to: "client" }).send, true);
  assert.deepEqual(decide({ internal: "ask" }, [], { to: "colleague" }).hold, ["internal"]);
  assert.equal(holdWhy(["money", "cost"]), "Asks first: a money commitment, an amount above its cost limit.");
});

const claude = { id: "server:claude", kind: "server", provider: "claude", label: "Claude subscription" };
const codex = { id: "server:codex", kind: "server", provider: "codex", label: "Codex subscription" };
function harness({ ctx, answers }) {
  const calls = [], posted = [];
  const e = new Employee("http://pulse.invalid", { username: "ops.chief.test" }, { callModel: async (rt) => { const a = answers.shift(); if (a instanceof Error) throw a; return { text: a, tokens: 900, tokensIn: 800, tokensOut: 100, seconds: 1.2, engine: rt.provider }; } });
  e.key = "pak_test"; e.me = { name: "Operations Chief (test)", title: "COO (AI)", manager: "Asha Kireteso (test)", provider: "claude", tools: ["chats", "memory"], usedToday: 0, dailyBudget: 300000 };
  e.plan = async () => ({ chain: [claude, codex], cfg: {}, usable: [claude, codex], down: [{ engine: claude, until: Date.now() + 3600000, why: "out of quota" }] });
  e.call = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith("/dispatch")) return { status: "dispatched", runId: "run-1", context: structuredClone(ctx) };
    if (path.startsWith("/api/v0/agent/chats/") && path.endsWith("/messages")) { posted.push(body.body); return { id: "m" }; }
    if (path === "/api/v0/agent/runs/run-1") return { usedToday: 900, dailyBudget: 300000 };
    return {};
  };
  return { e, calls, posted, run: () => e.handle({ id: "22222222-2222-4222-8222-222222222222" }, "lease") };
}
// What Pulse hands over after 1230: a leader's direct message is "own" whatever the settings said.
const dm = (over = {}) => ({ mode: "own", kind: "chat.message", askerIsApprover: false, askerIsLeader: true, clientFacing: false, policy: { ...DEFAULT_POLICY, clientsAllowed: false },
  approver: "Asha Kireteso (test)", now: "Tuesday 27 Oct 2026, 18:10", timeZone: "Asia/Kolkata",
  message: { id: "m1", channelId: "c1", body: "hi", author: "Kabir Mifos (test, CEO)", channelKind: "direct" }, recent: [], memory: [], ...over });

test("a leader says hi in a direct message: it answers him itself, no card, no engine noise (production 27 Oct)", async () => {
  const h = harness({ ctx: dm(), answers: [new Error("claude failed: weekly limit"), '{"action": "reply", "message": "Hi Kabir, two delivery risks today: the Skyline reel and the Orbit invoice follow-up. Want the short list?", "why": "greeting", "risk": []}'] });
  await h.run();
  assert.deepEqual(h.posted, ["Hi Kabir, two delivery risks today: the Skyline reel and the Orbit invoice follow-up. Want the short list?"]);
  assert.ok(!h.calls.some((c) => c.path.endsWith("/propose")), "no card for the approver");
  assert.ok(!h.posted.join(" ").includes("Answered with"), "the fallback engine is silent");
  assert.match(h.calls.find((c) => c.path.endsWith("/engine")).body.fallbackFrom, /Claude subscription/, "the run still records it");
  const parts = h.e.chatParts(dm()).map((p) => p.text).join("\n\n");
  assert.match(parts, /never ask anyone to approve an ordinary reply/);
  assert.match(parts, /"risk": \[\]/);
});

test("a colleague's direct message: a plain answer goes out; a money commitment waits for its approver with a holding line", async () => {
  const colleague = dm({ askerIsLeader: false, message: { id: "m2", channelId: "c2", body: "Can we refund Orbit for the late reel?", author: "Ishaan Rao (test)", channelKind: "direct" } });
  const plain = harness({ ctx: colleague, answers: ['{"action": "reply", "message": "The reel was 2 days late; Meera owns the Orbit account, so I have asked her to decide.", "risk": []}'] });
  await plain.run();
  assert.equal(plain.posted.length, 1);
  assert.ok(!plain.calls.some((c) => c.path.endsWith("/propose")));
  const risky = harness({ ctx: colleague, answers: ['{"action": "reply", "message": "Yes, we will refund Orbit ₹40,000 for the late reel.", "why": "late delivery", "risk": ["money"]}'] });
  await risky.run();
  const card = risky.calls.find((c) => c.path.endsWith("/propose"));
  assert.equal(card.body.body, "Yes, we will refund Orbit ₹40,000 for the late reel.");
  assert.match(card.body.why, /^Asks first: a money commitment, an amount above its cost limit\./);
  assert.equal(risky.posted.length, 1);
  assert.match(risky.posted[0], /^I've drafted this and asked Asha Kireteso \(test\) to confirm it first/);
});

test("a client conversation still asks first (Pulse hands it over as approve)", async () => {
  const h = harness({ ctx: dm({ mode: "approve", kind: "chat.group", askerIsLeader: false, clientFacing: true,
    message: { id: "m3", channelId: "c3", body: "Can you do it for 30k?", author: "Client (test)", channelKind: "custom", channelName: "Orbit Homes (test)" } }),
    answers: ['{"action": "propose", "message": "Thanks, let me confirm the price with our team today.", "why": "price question"}'] });
  await h.run();
  assert.deepEqual(h.posted, []);
  assert.ok(h.calls.some((c) => c.path.endsWith("/propose")));
});
