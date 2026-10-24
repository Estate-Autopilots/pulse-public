import { test } from "node:test";
import assert from "node:assert/strict";
import { downNotice, engineChain, firstBack, Health, pickEngines, tierRuntime } from "./engines.mjs";
import { budgetsFor, dayLevel, fitPrompt, relevantMemory, watchCodex } from "./budget.mjs";

const C1 = "11111111-1111-4111-8111-111111111111", C2 = "22222222-2222-4222-8222-222222222222";
const cfg = { agent: [], org: [], connections: [
  { id: C1, kind: "api", provider: "openrouter", name: "OpenRouter (test)", model: "test/model-a", state: "connected" },
  { id: C2, kind: "subscription", provider: "claude", name: "Org Claude (test)", model: null, state: "expired" }] };
const me = { provider: "claude", model: "claude-opus-5-5", effort: "high" };

test("default chain: preferred, this server's two plans, the organisation's live connections, keys held, then local", () => {
  const ids = engineChain(me, cfg, { env: { OPENAI_API_KEY: "test-token" }, local: true }).map((e) => e.id);
  assert.deepEqual(ids, ["server:claude", "server:codex", `connection:${C1}`, "env:openai", "local:ollama"]);
  assert.deepEqual(engineChain({ provider: "codex" }, cfg).map((e) => e.id).slice(0, 2), ["server:codex", "server:claude"]);
  assert.equal(engineChain({ provider: "claude", aiConnectionId: C1 }, cfg)[0].id, `connection:${C1}`);
});

test("its own chain wins, then the organisation's; unknown or missing engines are left out", () => {
  assert.deepEqual(engineChain(me, { ...cfg, org: ["server:codex"], agent: [`connection:${C1}`, "server:claude", "bogus"] }).map((e) => e.id), [`connection:${C1}`, "server:claude"]);
  assert.deepEqual(engineChain(me, { ...cfg, org: ["server:codex", "env:anthropic"] }).map((e) => e.id), ["server:codex"]);
  assert.deepEqual(engineChain({ provider: "stub" }, cfg).map((e) => e.id), ["stub"]);
});

test("health: a plan out of quota, a 429 seen here and a refused connection are skipped; the notice says until when", () => {
  let now = Date.parse("2026-10-24T10:00:00Z");
  const h = new Health(() => now), chain = engineChain(me, cfg, { env: { OPENROUTER_API_KEY: "test-token" } });
  const quota = { claude: new Date("2026-10-24T11:00:00Z") };
  h.mark(`connection:${C1}`, "2026-10-24T10:30:00Z", "rate-limited (429)");
  const p = pickEngines(chain, h, quota);
  assert.deepEqual(p.usable.map((e) => e.id), ["server:codex", "env:openrouter"]);
  assert.deepEqual(p.down.map((d) => d.engine.id), ["server:claude", `connection:${C1}`]);
  assert.equal(firstBack(p.down), Date.parse("2026-10-24T10:30:00Z"));
  assert.match(downNotice(p.down, (ms) => new Date(ms).toISOString().slice(11, 16)), /Claude subscription: out of quota until 11:00; OpenRouter \(test\) \(API key\): rate-limited \(429\) until 10:30/);
  now = Date.parse("2026-10-24T10:31:00Z");
  assert.deepEqual(pickEngines(chain, h, quota).usable.map((e) => e.id), ["server:codex", `connection:${C1}`, "env:openrouter"], "the connection is back once its time has passed");
});

test("tiers: chat replies run fast and cheap, work runs strong", () => {
  const [claude, codex] = engineChain(me, cfg);
  assert.deepEqual([tierRuntime(claude, me, "fast").model, tierRuntime(claude, me, "fast").effort], ["sonnet", "low"]);
  assert.deepEqual([tierRuntime(claude, me, "strong").model, tierRuntime(claude, me, "strong").effort], ["claude-opus-5-5", "high"]);
  assert.equal(tierRuntime(codex, me, "strong").model, undefined);
  assert.equal(tierRuntime(claude, { ...me, model: "gpt-6-luna" }, "strong").model, "opus", "a non-Claude model name never reaches Claude Code");
  const key = engineChain(me, { org: ["env:anthropic"] }, { env: { ANTHROPIC_API_KEY: "test-token" } })[0];
  const rt = tierRuntime(key, me, "fast");
  assert.equal(rt.connection.style, "anthropic"); assert.equal(rt.connection.secret, "test-token"); assert.equal(rt.model, "claude-haiku-4-5");
});

test("budgets: defaults, organisation overrides within range", () => {
  assert.deepEqual(budgetsFor({}).chat, { in: 30000, out: 4000, tier: "fast" });
  assert.deepEqual(budgetsFor({ task: { in: 120000, out: 9, tier: "fast" } }).task, { in: 120000, out: 40000, tier: "fast" });
});

test("the prompt is fitted: the oldest chat goes first, then notes; what must stay stays", () => {
  const big = "x".repeat(40000);
  const f = fitPrompt([{ key: "intro", text: "You are Luna." }, { key: "recent", text: big, drop: 1 }, { key: "memory", text: "y".repeat(8000), drop: 2 }, { key: "ask", text: "Reply now." }], 3000);
  assert.ok(!f.over && f.tokens <= 3000, `${f.tokens}`);
  assert.ok(f.prompt.startsWith("You are Luna.") && f.prompt.endsWith("Reply now."));
  assert.deepEqual(f.trimmed, ["recent"]);
  assert.ok(fitPrompt([{ key: "task", text: big }], 1000).over, "a part that must stay can leave it over budget");
});

test("only the notes that matter, and where the day stands", () => {
  assert.deepEqual(relevantMemory(["Skyline brochure is due Friday", "Lunch at one", "Skyline client prefers WhatsApp"], "When is the Skyline brochure due?", 2),
    ["Skyline brochure is due Friday", "Skyline client prefers WhatsApp"]);
  assert.equal(dayLevel({ usedToday: 50, dailyBudget: 100 }).level, "ok");
  assert.equal(dayLevel({ usedToday: 85, dailyBudget: 100 }).level, "soft");
  assert.deepEqual(dayLevel({ usedToday: 10, dailyBudget: 100, orgUsedToday: 1000, orgDaily: 900 }), { level: "hard", who: "organisation", share: 111 });
});

test("a Codex run that loops or writes on and on is stopped", () => {
  const w = watchCodex({ maxCommands: 4 });
  const cmd = (c) => JSON.stringify({ type: "item.started", item: { type: "command_execution", command: c } });
  assert.equal(w(cmd("ls")), null); assert.equal(w(cmd("cat a")), null); assert.equal(w(cmd("ls")), null);
  assert.match(w(cmd("ls")), /same command 3 times/);
  const w2 = watchCodex({ maxCommands: 2 });
  w2(cmd("a")); w2(cmd("b"));
  assert.match(w2(cmd("c")), /more than 2 commands/);
  const w3 = watchCodex({ outTokens: 10 });
  assert.match(w3(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "z".repeat(200) } })), /output budget/);
  assert.equal(w3("not json"), null);
});
