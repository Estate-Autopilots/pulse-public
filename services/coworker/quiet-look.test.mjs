// TOKENS-TELEMETRY: a quiet daily look (nothing new on the task since the last look) is a reminder: its prompt leaves out
// the colleagues, conversations and other groups' chat that only new work needs, and keeps the newest thread lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { quietLook, SAVED_EST, tierFor } from "./thrift.mjs";
import { taskWorkParts } from "./task-work.mjs";
import { estimate } from "./budget.mjs";

const colleague = (i) => ({ name: `Colleague ${i} (test)`, username: `c${i}.test`, role: "Account manager", pod: "Pod 1", side: "staff", busy: i % 3, open: i % 5 });
const conv = (i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `Client group ${i} (test)`, withClient: i % 2 === 0 });
const msg = (i) => ({ at: "16 Nov 10:00", author: "Tara (test)", body: `Update ${i}: the shoot moved to Friday, the brochure needs two more photos and the client asked about the brief again.` });
const ctx = (cause, fresh) => ({
  cause, task: { title: "Collect the site photos (test)", status: "in_progress", givenBy: "Tara (test)", reviewer: "Tara (test)", notes: "Photos of the site for the brochure." },
  work: { plan: [{ label: "Ask for the photos", done: true }, { label: "Put them in the brief", done: false }] },
  thread: Array.from({ length: 14 }, (_, i) => ({ at: "15 Nov 10:00", author: i % 2 ? "You" : "Tara (test)", mine: i % 2 === 1, body: msg(i).body, new: fresh && i === 12 })),
  asks: [{ to: "Tara (test)", username: "tara.test", via: "comment", askedAt: "15 Nov", answered: false }],
  groups: [{ name: "Client group 1 (test)", withClient: true, messages: Array.from({ length: 20 }, (_, i) => ({ ...msg(i), mine: false, side: "client" })) }],
  colleagues: Array.from({ length: 60 }, (_, i) => colleague(i)), conversations: Array.from({ length: 40 }, (_, i) => conv(i)),
});
const size = (parts) => parts.reduce((n, p) => n + estimate(p.text), 0);

test("a daily look with nothing new is quiet; a fresh comment, another cause or a chat is not", () => {
  assert.equal(quietLook(ctx("daily", false)), true);
  assert.equal(quietLook(ctx("daily", true)), false);
  assert.equal(quietLook(ctx("comment", false)), false);
  assert.equal(quietLook({ message: { body: "hi" } }), false);
  assert.ok(SAVED_EST["chat.screen_direct"] > 0);
});

test("a quiet look's prompt drops colleagues, conversations and groups and keeps the newest thread lines", () => {
  const loud = taskWorkParts(ctx("daily", true), { intro: "You are Mira (test)." });
  const quiet = taskWorkParts(ctx("daily", false), { intro: "You are Mira (test)." });
  const keys = (ps) => ps.map((p) => p.key);
  assert.ok(keys(loud).includes("people") && keys(loud).includes("convs") && keys(loud).includes("g0"));
  assert.ok(!keys(quiet).includes("people") && !keys(quiet).includes("convs") && !keys(quiet).includes("g0"));
  assert.ok(keys(quiet).includes("asks") && keys(quiet).includes("plan") && keys(quiet).includes("task"), "whom it waits for, its plan and the task stay");
  const thread = quiet.find((p) => p.key === "thread").text;
  assert.equal(thread.split("\n").length - 1, 6, "the newest six lines of the thread");
  assert.ok(size(quiet) < size(loud) / 2, `${size(quiet)} vs ${size(loud)} tokens`);
});

test("a quiet daily look runs on the fast tier; new work keeps the strong one", () => {
  assert.equal(tierFor(ctx("daily", false), "strong"), "fast");
  assert.equal(tierFor(ctx("daily", true), "strong"), "strong");
  assert.equal(tierFor(ctx("assigned", false), "strong"), "strong");
  assert.equal(tierFor(ctx("daily", false), "small"), "small");
});
