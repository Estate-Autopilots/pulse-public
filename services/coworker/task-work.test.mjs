// AI-TASKS (25 Oct 2026): an AI employee works a task like a colleague: it is told what woke it, plans, comments, writes
// files, asks colleagues, makes sub-tasks, drafts a client card and moves the task, all sent to Pulse in one step; the
// test runtime walks the loop (ask → wait → answer → done, returned → fixed → done). Fake names only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fitPrompt } from "./budget.mjs";
import { Employee } from "./runner.mjs";
import { causeText, onlyAllowed, readTaskAnswer, taskStub, taskWorkParts } from "./task-work.mjs";

const task = (over = {}) => ({ v: 2, cause: "assigned", now: "Sunday 25 Oct 2026, 12:00", timeZone: "Asia/Kolkata",
  task: { id: "22222222-2222-4222-8222-222222222222", title: "Write the weekly client update for Sunrise (sim)", notes: "Cover Reel 2 and the drone shots.", status: "in_progress",
    priority: "high", dueOn: "2026-10-27", givenBy: "Tara Kapoor (test)", reviewer: "Tara Kapoor (test)", manager: "Kedab Mifos (test)", project: "Sunrise launch (sim)", client: "Sunrise Builders (sim)" },
  work: { plan: [], runs: 1 }, thread: [], history: [], subtasks: [], files: [], asks: [], groups: [], recent: [], memory: [], ...over });

test("what woke it is said in words", () => {
  assert.match(causeText(task()), /Tara Kapoor \(test\) just gave you this task/);
  assert.match(causeText(task({ cause: "returned", history: [{ kind: "returned", by: "Tara Kapoor (test)", note: "Add the RERA number" }] })), /returned this task to you with this note: "Add the RERA number"/);
  assert.match(causeText(task({ cause: "comment", thread: [{ author: "Neel (test)", body: "Clips by Tue 6 pm", new: true, mine: false }] })), /Neel \(test\): "Clips by Tue 6 pm"/);
  assert.match(causeText(task({ cause: "direct", asks: [{ to: "Neel (test)", answered: true, answer: "Thursday 5 pm" }] })), /Neel \(test\): "Thursday 5 pm"/);
  assert.match(causeText(task({ cause: "daily" })), /daily look/);
});

test("the prompt keeps the task, the rules and the ask when it is trimmed; the groups and the thread go first", () => {
  const big = "x".repeat(600);
  const parts = taskWorkParts(task({ groups: [{ name: "Sunrise (sim)", withClient: true, messages: Array.from({ length: 40 }, () => ({ at: "25 Oct 10:00", author: "Anil (sim)", side: "client", body: big })) }],
    thread: Array.from({ length: 25 }, () => ({ at: "25 Oct 11:00", author: "Tara Kapoor (test)", body: big, new: true })), colleagues: [{ name: "Neel (test)", username: "neel.test", role: "Video editor" }] }), { intro: "You are Mira (test).", web: false });
  const fit = fitPrompt(parts, 8000);
  assert.ok(!fit.over, "fits");
  assert.match(fit.prompt, /^Task: Write the weekly client update/m);
  assert.match(fit.prompt, /Never send anything to a client yourself/);
  assert.match(fit.prompt, /Answer with JSON only/);
  assert.match(fit.prompt, /You cannot open files, links or the web/);
  assert.ok(fit.trimmed.includes("g0"), "the group's messages are trimmed first");
  assert.match(taskWorkParts(task(), { web: true }).map((p) => p.text).join("\n"), /You may search the web/);
});

test("the answer is read generously: plain words become a comment, unknown statuses wait, secrets never travel", () => {
  assert.deepEqual(readTaskAnswer("I drafted the update below.").comment, "I drafted the update below.");
  assert.equal(readTaskAnswer('{"status":"blocked","comment":"Need the RERA number"}').status, "waiting");
  assert.equal(readTaskAnswer('{"status":"done","continue":true}').continue, false, "continue only while working");
  const a = readTaskAnswer('```json\n{"plan":["Read","Write"],"files":[{"name":"Update.md","text":"# Update"},{"name":"Empty","text":""}],"subtasks":[{"title":"Share the floor plans","assignee":"@neel.test","dueOn":"2026-10-28"},{"title":"No one"}],"messages":[{"to":"@neel.test","text":"When are the clips ready?"}],"post":{"channel":"c1","text":"Hi Anil (sim)"},"status":"working","continue":true,"remember":["Anil prefers Marathi captions"]}\n```');
  assert.deepEqual(a.plan, [{ label: "Read", done: false }, { label: "Write", done: false }]);
  assert.equal(a.files.length, 1);
  assert.deepEqual(a.subtasks, [{ title: "Share the floor plans", assignee: "neel.test", dueOn: "2026-10-28", notes: "" }]);
  assert.deepEqual(a.messages, [{ to: "neel.test", text: "When are the clips ready?" }]);
  assert.equal(a.post.text, "Hi Anil (sim)");
  assert.equal(a.continue, true);
  assert.deepEqual(a.remember, ["Anil prefers Marathi captions"]);
  assert.equal(readTaskAnswer('{"comment":"key pak_0123abcd_0123456789abcdef0123456789"}').comment, "", "a secret is never posted");
});

test("follow-ups are read apart from sub-tasks, and a test install keeps them to listed colleagues", () => {
  const a = readTaskAnswer('{"subtasks":[{"title":"Share the floor plans","assignee":"neel.test"}],"followups":[{"title":"Send the Diwali plan","assignee":"@kedab.test","dueOn":"2026-10-27"},{"title":"No one"}],"status":"done"}');
  assert.deepEqual(a.followups, [{ title: "Send the Diwali plan", assignee: "kedab.test", dueOn: "2026-10-27", notes: "" }]);
  assert.equal(a.subtasks.length, 1);
  assert.deepEqual(onlyAllowed(a, ["neel.test"]).followups, []);
});

test("a test install reaches only the listed colleagues", () => {
  const a = onlyAllowed({ comment: "@neel.test and @real.person, please check.", subtasks: [{ title: "A", assignee: "real.person" }, { title: "B", assignee: "neel.test" }], messages: [{ to: "real.person", text: "Hi" }] }, ["neel.test"]);
  assert.equal(a.comment, "@neel.test and real.person, please check.");
  assert.deepEqual(a.subtasks.map((s) => s.title), ["B"]);
  assert.deepEqual(a.messages, []);
});

test("the test runtime walks the loop: ask and wait, then done with a file; returned, then fixed", () => {
  const prompt = (ctx) => taskWorkParts(ctx, {}).map((p) => p.text).join("\n\n");
  const ask = JSON.parse(taskStub(prompt(task({ task: { ...task().task, notes: "Ask @neel.test for the delivery date." } }))));
  assert.equal(ask.status, "waiting"); assert.match(ask.comment, /^@neel\.test /);
  const after = JSON.parse(taskStub(prompt(task({ cause: "comment", task: { ...task().task, notes: "Ask @neel.test for the delivery date." },
    thread: [{ at: "25 Oct 12:10", author: "Neel (test)", body: "Thursday 5 pm", new: true }], asks: [{ to: "Neel (test)", username: "neel.test", via: "comment", askedAt: "25 Oct 12:00", answered: true, answer: "Thursday 5 pm" }] }))));
  assert.equal(after.status, "done"); assert.equal(after.files.length, 1);
  const back = JSON.parse(taskStub(prompt(task({ cause: "returned", history: [{ kind: "returned", by: "Tara Kapoor (test)", note: "Shorter please" }] }))));
  assert.equal(back.status, "done"); assert.match(back.files[0].name, /^Revised /);
});

/** An AI employee against a fake Pulse on a task look: everything it did reaches task-act in one call. */
test("a task look sends its whole answer to task-act once, with colleagues limited by askOnly", async () => {
  const calls = [];
  const answer = JSON.stringify({ plan: [{ label: "Draft", done: true }], comment: "Draft attached. @neel.test can you confirm Thursday?", files: [{ name: "Update.md", text: "# Update" }], status: "waiting", waitingOn: "@neel.test", remember: ["Sunrise wants weekly updates on Mondays"] });
  const e = new Employee("http://pulse.invalid", { username: "mira.test" }, { askOnly: ["neel.test"], callModel: async (rt, prompt) => { calls.push({ model: rt, prompt }); return { text: answer, tokens: 5000, tokensIn: 4000, tokensOut: 1000, seconds: 3 }; } });
  e.key = "pak_test"; e.me = { name: "Mira (test)", title: "Content writer (AI)", manager: "Kedab Mifos (test)", provider: "claude", tools: ["chats", "tasks", "memory"], usedToday: 0, dailyBudget: 300000 };
  e.plan = async () => ({ chain: [{ id: "server:claude", kind: "server", provider: "claude", label: "Claude subscription" }], cfg: {}, usable: [{ id: "server:claude", kind: "server", provider: "claude", label: "Claude subscription" }], down: [] });
  e.call = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith("/dispatch")) return { status: "dispatched", runId: "run-9", context: task() };
    if (path === "/api/v0/agent/colleagues") return { people: [{ name: "Neel (test)", username: "neel.test" }, { name: "Real Person", username: "real.person" }] };
    if (path === "/api/v0/agent/conversations") return { conversations: [{ id: "c1", name: "Sunrise (sim)", withClient: true }] };
    if (path.endsWith("/task-act")) return { status: "blocked", phase: "waiting", files: 1, subtasks: [], messages: 0, cards: 0, skipped: [] };
    if (path === "/api/v0/agent/runs/run-9") return { usedToday: 5000, dailyBudget: 300000 };
    return {};
  };
  await e.handle({ id: "33333333-3333-4333-8333-333333333333" }, "lease");
  const acts = calls.filter((c) => c.path?.endsWith("/task-act"));
  assert.equal(acts.length, 1);
  assert.equal(acts[0].body.status, "waiting"); assert.equal(acts[0].body.files[0].name, "Update.md"); assert.ok(acts[0].body.clientId);
  assert.equal(acts[0].body.remember, undefined, "notes go to memory, not to the task");
  const prompt = calls.find((c) => c.prompt)?.prompt ?? "";
  assert.match(prompt, /neel\.test/); assert.doesNotMatch(prompt, /real\.person/, "askOnly keeps real people out of a test install's prompt");
  assert.ok(calls.some((c) => c.path === "/api/v0/agent/memory" && /Mondays/.test(c.body.body)), "it keeps what it learned");
  assert.ok(calls.some((c) => c.path === "/api/v0/agent/runs/run-9" && c.body.state === "done"), "the run is settled");
});
