// AI-EMP (24 Oct 2026): what production's AI employees did wrong, as tests. A reply always goes out (a fallback engine
// says so in one line; every engine failing is said plainly and retried, three times at most), its approver writing
// to it gets an answer and not a card about that answer, a burst of messages gets one answer, the answer is never the
// raw JSON nor the same words twice, and a stale "out of quota" note is checked again. Fake values only.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { degradedNote, Employee, quotaWait, readAnswer, RULES } from "./runner.mjs";

test("a stale quota note is checked again; a fresh one is kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-")), file = join(dir, "quota.json"), now = Date.parse("2026-10-24T16:00:00Z");
  try {
    await writeFile(file, JSON.stringify({ codex: { until: "2026-10-27T06:34:00Z", text: "try again at Oct 27th", at: "2026-10-23T10:20:00Z" } }));
    assert.equal(await quotaWait("codex", now, file), null, "noted 30 hours ago: tried again");
    await writeFile(file, JSON.stringify({ codex: { until: "2026-10-27T06:34:00Z", text: "try again at Oct 27th", at: "2026-10-24T15:00:00Z" } }));
    assert.equal((await quotaWait("codex", now, file))?.toISOString(), "2026-10-27T06:34:00.000Z", "noted an hour ago: still waits");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an answer is read generously and never posted as raw JSON", () => {
  assert.equal(readAnswer('{"reply": "Hi Asha"}').said, "Hi Asha");
  assert.equal(readAnswer('```json\n{"action": "reply", "message": "Hi Asha"}\n```').said, "Hi Asha");
  assert.equal(readAnswer('{"answer": "Hi"}').said, "Hi");
  assert.equal(readAnswer('{"action": "reply", "message": "Hi Asha, the reel is du').said, "Hi Asha, the reel is du", "cut short");
  assert.equal(readAnswer("Hi Asha, the reel is due Friday.").said, "Hi Asha, the reel is due Friday.", "plain words");
  assert.equal(readAnswer('{"action": "none"}').said, "");
  assert.equal(readAnswer('{"foo": 1').said, "", "broken JSON with nothing to say");
  assert.equal(readAnswer("").said, "");
});

const claude = { id: "server:claude", kind: "server", provider: "claude", label: "Claude subscription" };
const codex = { id: "server:codex", kind: "server", provider: "codex", label: "Codex subscription" };
test("a fallback engine says so in one short line; the preferred one does not", () => {
  const fmt = () => "24 Oct, 4:30 pm IST";
  assert.equal(degradedNote({ chain: [claude, codex], down: [{ engine: claude, until: 1, why: "out of quota" }] }, { engine: codex }, fmt),
    "(Answered with the Codex subscription: the Claude subscription is out of quota until 24 Oct, 4:30 pm IST.)");
  assert.equal(degradedNote({ chain: [claude, codex], down: [] }, { engine: codex }), "(Answered with the Codex subscription: the Claude subscription is not answering right now.)");
  assert.equal(degradedNote({ chain: [claude, codex], down: [] }, { engine: claude }), "");
});

/** An AI employee against a fake Pulse: records every call; the model and the engine plan are given. */
function harness({ ctx, answers, usable = [claude, codex], down = [] }) {
  const calls = [], posted = [];
  const e = new Employee("http://pulse.invalid", { username: "ops.chief.test" }, { callModel: async (rt) => { const a = answers.shift(); if (a instanceof Error) throw a; return { text: a, tokens: 900, tokensIn: 800, tokensOut: 100, seconds: 1.2, engine: rt.provider }; } });
  e.key = "pak_test"; e.me = { name: "Ops Chief (test)", title: "COO (AI)", manager: "Asha Kireteso (test)", provider: "claude", tools: ["chats", "tasks", "memory"], usedToday: 0, dailyBudget: 300000 };
  e.plan = async () => ({ chain: [claude, codex], cfg: {}, usable, down });
  e.call = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith("/dispatch")) return { status: "dispatched", runId: "run-1", context: structuredClone(ctx) };
    if (path.startsWith("/api/v0/agent/chats/") && path.endsWith("/messages")) { posted.push(body.body); return { id: "m" }; }
    if (path.startsWith("/api/v0/agent/directory")) return { people: [{ name: "Ishaan Rao (test)", username: "ishaan.test", role: "Video Editor" }] };
    if (path === "/api/v0/agent/runs/run-1") return { usedToday: 900, dailyBudget: 300000 };
    return {};
  };
  return { e, calls, posted, run: () => e.handle({ id: "11111111-1111-4111-8111-111111111111" }, "lease") };
}
const dm = (over = {}) => ({ mode: "own", kind: "chat.message", askerIsApprover: true, approver: "Asha Kireteso (test)", now: "Saturday 24 Oct 2026, 21:30", timeZone: "Asia/Kolkata",
  message: { id: "m1", channelId: "c1", body: "?", author: "Asha Kireteso (test)", channelKind: "direct" }, recent: [], memory: [], ...over });

test("its approver writing to it is answered directly, never with a card about the answer", async () => {
  const h = harness({ ctx: dm(), answers: ['{"action": "reply", "message": "Hi Asha, tell me what needs doing and I will draft it as a task.", "why": "greeting"}'] });
  await h.run();
  assert.deepEqual(h.posted, ["Hi Asha, tell me what needs doing and I will draft it as a task."]);
  assert.ok(!h.calls.some((c) => c.path.endsWith("/propose")), "no proposal to the person who wrote");
  const parts = h.e.chatParts(dm({ people: [{ name: "Ishaan Rao (test)", username: "ishaan.test" }] })).map((p) => p.text).join("\n\n");
  assert.match(parts, /approves your work, so answer them directly/);
  assert.doesNotMatch(parts, /^Ask first/m);
  assert.match(parts, /It is Saturday 24 Oct 2026, 21:30 \(Asia\/Kolkata\)/);
  assert.ok(parts.includes(RULES));
  assert.match(parts, /"action": "propose_task"/, "it can still propose a task to its approver");
});

test("asking first in a group still proposes to its approver", async () => {
  const ctx = dm({ mode: "approve", kind: "chat.group", askerIsApprover: false, message: { id: "m1", channelId: "c1", body: "Any update on the reel?", author: "Rila (test)", channelKind: "custom", channelName: "Skyline (test)" } });
  const h = harness({ ctx, answers: ['{"action": "propose", "message": "Hi Rila, the reel is with Ishaan; I will confirm the time today.", "why": "status"}'] });
  await h.run();
  assert.deepEqual(h.posted, []);
  assert.equal(h.calls.find((c) => c.path.endsWith("/propose")).body.body, "Hi Rila, the reel is with Ishaan; I will confirm the time today.");
});

test("a burst of messages gets one answer: an older one is folded into the newest at no cost", async () => {
  const h = harness({ ctx: dm({ newer: true }), answers: [] });
  await h.run();
  assert.deepEqual(h.posted, []);
  assert.deepEqual(h.calls.find((c) => c.path === "/api/v0/agent/runs/run-1").body, { state: "done", tokens: 0, seconds: 0 });
});

test("the preferred engine failing: the next answers silently; the run records the fallback (AI-AUTONOMY)", async () => {
  const h = harness({ ctx: dm(), answers: [new Error("claude failed: overloaded"), '{"action": "reply", "message": "Hi Asha, here is the plan."}'] });
  await h.run();
  assert.deepEqual(h.posted, ["Hi Asha, here is the plan."], "no engine noise in the reply");
  assert.match(h.calls.find((c) => c.path.endsWith("/engine")).body.fallbackFrom, /Claude subscription: claude failed/);
});

test("an engine with no answer (or only JSON) does not leave a direct message unanswered", async () => {
  const h = harness({ ctx: dm(), answers: ['{"action": "none"}', '{"action": "reply", "message": "Hi Asha."}'] });
  await h.run();
  assert.match(h.posted[0], /^Hi Asha\./);
});

test("every engine failing: one honest line, a retry in five minutes (not a quota), and after three tries it says it gave up", async () => {
  const h = harness({ ctx: dm(), answers: [new Error("timeout"), new Error("codex failed: 500")] });
  await h.run();
  assert.equal(h.posted.length, 1);
  assert.match(h.posted[0], /^Sorry, I couldn't answer just now \(codex failed: 500\)\. I'll try again in about five minutes\.$/);
  const rq = h.calls.find((c) => c.path.endsWith("/requeue"));
  assert.equal(rq.body.reason, "model_error");
  h.posted.length = 0; h.e.opts.callModel = async () => { throw new Error("timeout"); };
  await h.run(); assert.deepEqual(h.posted, [], "the second try says nothing new");
  await h.run();
  assert.match(h.posted[0], /^I couldn't answer this after three tries \(timeout\)\. Asha Kireteso \(test\) can see what went wrong on my profile/);
  assert.equal(h.calls.filter((c) => c.path === "/api/v0/agent/runs/run-1").at(-1).body.errorCode, "model_error");
});

test("it does not post the same words twice in a row", async () => {
  const ctx = dm({ message: { id: "m2", channelId: "c1", body: "How do I hand work to you?", author: "Asha Kireteso (test)", channelKind: "direct" },
    recent: [{ author: "Ops Chief (test)", mine: true, body: "Use the handoff option below this chat." }] });
  const h = harness({ ctx, answers: ['{"action": "reply", "message": "Use the handoff option below this chat."}'] });
  await h.run();
  assert.match(h.posted[0], /^I said that just above and it did not help/);
});
