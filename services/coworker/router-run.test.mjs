// TOKENS-2: the model router inside a run (runner.mjs): the tier it starts on, the hand-up to a stronger tier, the trace it
// records, the company's "off", and an approved pattern. Fake values only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Employee } from "./runner.mjs";

const claude = { id: "server:claude", kind: "server", provider: "claude", label: "Claude subscription" };
const codex = { id: "server:codex", kind: "server", provider: "codex", label: "Codex subscription" };
const dm = (body) => ({ mode: "own", kind: "chat.message", askerIsApprover: true, approver: "Asha Kireteso (test)", now: "Tuesday 17 Nov 2026, 21:30", timeZone: "Asia/Kolkata",
  message: { id: "m1", channelId: "c1", body, author: "Asha Kireteso (test)", channelKind: "direct" }, recent: [], memory: [] });

function harness({ ctx, answers, cfg = {} }) {
  const calls = [], posted = [], models = [], prompts = [];
  const e = new Employee("http://pulse.invalid", { username: "ops.chief.test" }, { callModel: async (rt, prompt) => {
    models.push(rt.model ?? `${rt.provider}-default`); prompts.push(String(prompt));
    const a = answers.shift(); if (a instanceof Error) throw a;
    return { text: a, tokens: 900, tokensIn: 800, tokensOut: 100, seconds: 1.2, engine: rt.provider };
  } });
  e.key = "pak_test"; e.me = { name: "Ops Chief (test)", title: "COO (AI)", manager: "Asha Kireteso (test)", provider: "claude", tools: ["chats", "tasks", "memory"], usedToday: 0, dailyBudget: 300000 };
  e.plan = async () => ({ chain: [claude, codex], cfg, usable: [claude, codex], down: [] });
  e.call = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith("/dispatch")) return { status: "dispatched", runId: "run-1", context: structuredClone(ctx) };
    if (path.startsWith("/api/v0/agent/chats/") && path.endsWith("/messages")) { posted.push(body.body); return { id: "m" }; }
    if (path === "/api/v0/agent/runs/run-1") return { usedToday: 900, dailyBudget: 300000 };
    return {};
  };
  const engine = () => calls.find((c) => c.path === "/api/v0/agent/runs/run-1/engine")?.body;
  return { e, calls, posted, models, prompts, engine, run: () => e.handle({ id: "11111111-1111-4111-8111-111111111111" }, "lease") };
}

test("a lookup starts on the fast tier and, handed up, the strong tier answers; the run records both", async () => {
  const h = harness({ ctx: dm("Who is on leave today?"), answers: ['{"action":"escalate","why":"needs the leave register"}', '{"action":"reply","message":"Ravi is on leave today (test)."}'] });
  await h.run();
  assert.deepEqual(h.models, ["sonnet", "opus"]);
  assert.match(h.prompts[0], /"action":"escalate"/, "the cheaper tier is told it may hand the work up");
  assert.doesNotMatch(h.prompts[1], /"action":"escalate"/, "the strong tier is not");
  assert.deepEqual(h.posted, ["Ravi is on leave today (test)."]);
  const b = h.engine();
  assert.deepEqual([b.routeClass, b.tier, b.escalatedFrom, b.shape], ["lookup", "strong", "fast", "chat:reply:short"]);
  assert.match(b.routeWhy, /question/);
});

test("no answer from every engine on the small tier is tried once more on the fast tier", async () => {
  const h = harness({ ctx: dm("hi"), answers: ['{"action":"none"}', '{"action":"none"}', '{"action":"reply","message":"Hi Asha (test)."}'] });
  await h.run();
  assert.deepEqual(h.models, ["haiku", "codex-default", "sonnet"]);
  assert.deepEqual(h.posted, ["Hi Asha (test)."]);
  assert.deepEqual([h.engine().routeClass, h.engine().tier, h.engine().escalatedFrom], ["small", "fast", "small"]);
});

test("a company that turned the router off keeps the old tiers; nothing is handed up", async () => {
  const h = harness({ ctx: dm("Analyse last month's expenses against the budget"), cfg: { router: { mode: "off" } }, answers: ['{"action":"reply","message":"Here is the analysis (test)."}'] });
  await h.run();
  assert.deepEqual(h.models, ["sonnet"], "a chat ran fast before the router");
  assert.doesNotMatch(h.prompts[0], /"action":"escalate"/);
  assert.equal(h.engine().routeClass, undefined);
  const heavy = harness({ ctx: dm("Analyse last month's expenses against the budget"), answers: ['{"action":"reply","message":"Here is the analysis (test)."}'] });
  await heavy.run();
  assert.deepEqual(heavy.models, ["opus"], "with the router, heavy analysis goes to the strong tier");
});

test("an approved pattern: its steps are in the prompt, it runs on its tier, and its use is a decision with tokens saved", async () => {
  const p = { key: "pattern:chat.ask:0123456789", taskType: "chat.ask", title: "Same steps", tools: ["list_people", "list_leave"], shape: "chat:reply:short", avgTokens: 30000, tier: "small" };
  const h = harness({ ctx: dm("Who in the design team is away this whole week?"), cfg: { patterns: [p] }, answers: ['{"action":"reply","message":"Meera is away (test)."}'] });
  await h.run();
  assert.deepEqual(h.models, ["haiku"]);
  assert.match(h.prompts[0], /list_people → list_leave/);
  const d = h.calls.find((c) => c.path === "/api/v0/agent/decisions").body;
  assert.deepEqual([d.ruleKey, d.taskType, d.route, d.tokens, d.savedEst, d.dedupe], [p.key, "chat.ask", "rule", 900, 29100, "pattern:run-1"]);
});
