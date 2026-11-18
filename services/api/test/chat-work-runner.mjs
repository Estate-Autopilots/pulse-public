// CHAT-WORK acceptance over HTTP (a running API and its database; dev or a scratch install, synthetic people only):
// J2 a task given in chat and answered on its card; J3 a file becomes a task with the file on it; J4 /tasks /projects
// /steps; J7 an AI employee added like a person, put in a group, given a task in chat, doing it through its runtime
// (the stub, or Claude/Codex with CHAT_WORK_REAL=1), reporting in the chat, approved by its manager, with its history
// and memory on its profile; and an out-of-quota plan shown as such with the work kept.
//
//   API=http://127.0.0.1:3263 ADMIN=admin@… LEADER=kedab.mifos@synthetic.invalid MEMBER=asha.kireteso@synthetic.invalid \
//   OTHER=neha.soniba@synthetic.invalid CONNECT="services/coworker/connect.sh <env> <role> EA" node services/api/test/chat-work-runner.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Employee } from "../../coworker/runner.mjs";

const API = process.env.API ?? "http://127.0.0.1:3263";
const [ADMIN, LEADER, MEMBER, OTHER] = [process.env.ADMIN, process.env.LEADER, process.env.MEMBER, process.env.OTHER];
const REAL = process.env.CHAT_WORK_REAL === "1";
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; }; const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };
const call = async (who, path, body) => {
  const r = await fetch(API + path, { method: body ? "POST" : "GET", headers: { "cf-access-authenticated-user-email": who, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d };
};
const me = async (who) => { const d = (await call(who, "/api/v0/me")).d; return d.person ?? d.personId ?? d.viewer?.person ?? d.id; };
const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
const leader = await me(LEADER), member = await me(MEMBER), other = await me(OTHER);

// J2: a task given in a group is answered on its card.
const group = (await call(LEADER, "/api/v0/chats/groups", { name: `CHAT-WORK E2E ${stamp}`, memberIds: [member, other] })).d.id; ok(group, "a group");
const sent = (await call(LEADER, `/api/v0/chats/${group}/messages`, { body: `@${(await call(MEMBER, "/api/v0/me")).d.username ?? "asha.kireteso"} draft the launch checklist by Fri`, clientId: crypto.randomUUID() })).d;
const made = await call(LEADER, "/api/v0/work/tasks", { title: "Draft the launch checklist", assigneeId: member, chatChannelId: group, chatMessageId: sent.id, chatFollow: true });
eq(made.s, 200, "task made from the message");
const card = (await call(MEMBER, `/api/v0/chats/task-cards?ids=${made.d.id}`)).d.tasks[0];
eq(card.handshakes.find((h) => h.channelId === group)?.state, "waiting", "it waits for her answer here");
eq((await call(OTHER, `/api/v0/chats/tasks/${made.d.id}/respond`, { channelId: group, answer: "accept" })).s, 403, "only she answers");
eq((await call(MEMBER, `/api/v0/chats/tasks/${made.d.id}/respond`, { channelId: group, answer: "ask", note: "Which launch?" })).d.state, "question");
eq((await call(MEMBER, `/api/v0/chats/tasks/${made.d.id}/respond`, { channelId: group, answer: "accept" })).d.state, "accepted");
eq((await call(MEMBER, `/api/v0/chats/tasks/${made.d.id}/respond`, { channelId: group, answer: "decline" })).s, 400, "a yes is final");
const lines = (await call(LEADER, `/api/v0/chats/${group}/messages?flat=1`)).d.messages.map((m) => `${m.kind}:${m.body}`);
ok(lines.some((l) => l.includes("Which launch?")), "her question is a message"); ok(lines.some((l) => l.startsWith("event:took")), "her yes is a line");

// J3: a file in the chat becomes a task with the file on it.
const file = (await call(LEADER, `/api/v0/chats/${group}/files`, { name: "brochure.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.4 synthetic brochure").toString("base64") })).d;
const fm = (await call(LEADER, `/api/v0/chats/${group}/messages`, { body: "", attachments: [file], clientId: crypto.randomUUID() })).d;
const ft = await call(LEADER, "/api/v0/work/tasks", { title: "Print the brochure", assigneeId: member, chatChannelId: group, chatMessageId: fm.id, chatFollow: true });
eq(ft.s, 200); eq(ft.d.filed?.[0], "brochure.pdf", "the file is on the task");

// J4: the group's work.
for (const kind of ["tasks", "projects", "steps"]) { const w = await call(LEADER, `/api/v0/chats/${group}/work?kind=${kind}`); eq(w.s, 200, kind); ok(Array.isArray(w.d[kind]), kind); }
ok((await call(LEADER, `/api/v0/chats/${group}/work?kind=tasks`)).d.tasks.some((t) => t.id === made.d.id), "/tasks lists it");
eq((await call(LEADER, `/api/v0/chats/${group}/work?kind=nope`)).s, 400);

// J7: an AI employee, added like a person.
const username = `mira.${stamp}`.slice(0, 40);
const add = await call(ADMIN, "/api/v0/agents", { name: `Mira ${stamp}`, title: "Content writer", ownerId: leader, lane: "thinking", username, provider: REAL ? (process.env.PROVIDER ?? "claude") : "claude",
  model: REAL ? (process.env.MODEL ?? "claude-opus-5-5") : "claude-opus-5-5", effort: "medium", tools: ["chats", "tasks", "memory"], dailyTokenBudget: "200000", department: "Creative" });
eq(add.s, 200, "added"); const ai = add.d.id; ok(/-AI-\d{3,}$/.test(add.d.employeeId), "an AI employee ID");
eq((await call(MEMBER, "/api/v0/agents", { name: "x", title: "y", ownerId: leader, lane: "quick" })).s, 403, "only admins add one");
const detail = (await call(LEADER, `/api/v0/agents/${ai}/detail`)).d;
eq(detail.canManage, true, "its manager manages it"); eq(detail.settings.provider, REAL ? (process.env.PROVIDER ?? "claude") : "claude"); eq(detail.settings.department, "Creative");
eq((await call(MEMBER, `/api/v0/agents/${ai}/settings`, { effort: "high" })).s, 403, "not someone else's");
eq((await call(LEADER, `/api/v0/agents/${ai}/memory`, { body: "Captions: short, no hashtags, one emoji at most." })).s, 200, "its manager teaches it");
eq((await call(LEADER, `/api/v0/chats/${group}/agents`, { agentId: ai, add: true })).s, 200, "into the group");
const cfgDir = mkdtempSync(join(tmpdir(), "cw-runtime-")), cfg = join(cfgDir, "runtime.json");
execFileSync("bash", ["-c", `${process.env.CONNECT} ${username} ${cfg}`], { stdio: "inherit", env: { ...process.env, PULSE_URL: API } });
const employee = new Employee(API, JSON.parse(readFileSync(cfg, "utf8")).agents[0], { stub: !REAL });

// The leader gives it a task in the group, in one line.
const ask = (await call(LEADER, `/api/v0/chats/${group}/messages`, { body: `@${username} draft three Instagram captions for the launch by Fri`, clientId: crypto.randomUUID() })).d;
const at = await call(LEADER, "/api/v0/work/tasks", { title: "Draft three Instagram captions for the launch", assigneeId: ai, chatChannelId: group, chatMessageId: ask.id, chatFollow: true });
eq(at.s, 200, "given to the AI employee"); eq(at.d.assigned, true, "at once, no request");
eq((await call(MEMBER, "/api/v0/work/tasks", { title: "Not mine to give", assigneeId: ai })).s >= 400, true, "only a leader or its manager gives it work");
let c1 = (await call(LEADER, `/api/v0/chats/task-cards?ids=${at.d.id}`)).d.tasks[0];
eq(c1.assigneeAgent, true); eq(c1.agentWork?.state, "queued", "queued for its runtime");
await employee.tick();
const after = (await call(LEADER, `/api/v0/chats/task-cards?ids=${at.d.id}`)).d.tasks[0];
if (REAL && after.agentWork?.reason === "out_of_quota") {
  console.log(`J7 real runtime: out of quota until ${after.agentWork.runtimeUntil}; the task waits (queued). Re-run after the reset.`);
  eq(after.agentWork.state, "queued", "kept, not lost");
} else {
  eq(after.status, "in_review", "done goes to its manager's review"); eq(after.canApprove, true, "the leader approves from the card");
  const said = (await call(LEADER, `/api/v0/chats/${group}/messages?flat=1`)).d.messages.filter((m) => m.byAgent);
  ok(said.some((m) => m.attachments?.some((a) => a.task === at.d.id)), "it reported in the chat with the task's card");
  eq((await call(LEADER, `/api/v0/tasks/${at.d.id}/accept`, { quality: "good" })).s, 200, "approved");
  const prof = (await call(LEADER, `/api/v0/agents/${ai}/detail`)).d;
  ok(prof.tasks.some((t) => t.id === at.d.id), "the task is on its profile"); ok(prof.runs.some((r) => r.taskId === at.d.id && r.state === "done"), "its run is in its history");
  ok(prof.memory.some((m) => m.source === "agent"), "what it learned is in its memory"); eq(prof.runtime.state, "ready");
  // A plan out of quota: shown with its reset time; the work waits and is not lost.
  if (!REAL) {
    const t2 = (await call(LEADER, "/api/v0/work/tasks", { title: "Write the launch email", assigneeId: ai, chatChannelId: group })).d.id;
    const { QuotaError } = await import("../../coworker/runtime.mjs");
    const until = new Date(Date.now() + 2 * 86400000);
    const quota = new Employee(API, JSON.parse(readFileSync(cfg, "utf8")).agents[0], { stub: true, stubModel: async () => { throw new QuotaError(until, "You've hit your weekly limit"); } });
    await quota.tick();
    const q = (await call(LEADER, `/api/v0/chats/task-cards?ids=${t2}`)).d.tasks[0];
    eq(q.agentWork.state, "queued", "the work waits"); eq(q.agentWork.reason, "out_of_quota"); ok(q.agentWork.runtimeUntil, "until when");
    eq((await call(LEADER, `/api/v0/agents/${ai}/detail`)).d.runtime.state, "out_of_quota", "its profile says so");
  }
}
console.log(`CHAT-WORK runner: ${checks} checks passed (group ${group}, AI employee @${username})`);
