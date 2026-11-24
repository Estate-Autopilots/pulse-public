// AI-FIX-5 (BC-172): an AI employee's runs say what they were about, and only a failed run its manager may retry offers it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canRetry, runAbout } from "./ai-runs.mjs";

const queue = readFileSync(new URL("../people/ai/[id]/queue.tsx", import.meta.url), "utf8");
const history = readFileSync(new URL("../people/ai/[id]/parts.tsx", import.meta.url), "utf8");

test("Work & queue reads the run history (what was asked, retry) and offers Try again on a failed run", () => {
  assert.match(queue, /\/api\/v0\/agents\/\$\{encodeURIComponent\(id\)\}\/runs\?limit=/, "the latest runs come from agent_runs_page, not the profile's list");
  assert.match(queue, /canRetry\(r\) \? <button[^>]*onClick=\{\(\) => void retry\(r\.id\)\}/, "a failed run its manager may retry has a button");
  assert.match(queue, /"Try again"/);
  assert.match(queue, /post\(`agents\/\$\{id\}\/runs\/\$\{run\}\/retry`/, "the same retry History uses");
  for (const [name, src] of [["queue.tsx", queue], ["parts.tsx", history]]) {
    assert.doesNotMatch(src, /"A question"/, `${name}: a run with no text says what it was about`);
    assert.match(src, /runAbout\(r\.kind, !!r\.channelName\)/, name);
  }
});

test("a run with no text of its own says what it was about, never 'A question'", () => {
  assert.equal(runAbout("task.assigned"), "A task");
  assert.equal(runAbout("task.mention"), "A task");
  assert.equal(runAbout("consult.answer"), "A colleague’s answer");
  assert.equal(runAbout("call.missed"), "A missed call");
  assert.equal(runAbout("call.recorded"), "A recorded call");
  assert.equal(runAbout("client.silent"), "A client who went quiet");
  assert.equal(runAbout("chat.message"), "A message in a chat");
  assert.equal(runAbout("chat.group", true), "A message", "the conversation's name follows");
  for (const k of ["chat.message", "chat.mention", "chat.reply", "chat.group", "consult.answer", "call.missed", "call.recorded", "client.silent", "task.assigned", "task.mention", "x.new"])
    for (const where of [true, false]) assert.doesNotMatch(runAbout(k, where), /question/i, k);
});

test("Try again only on a failed run its viewer may retry", () => {
  assert.equal(canRetry({ state: "error", retry: true }), true);
  assert.equal(canRetry({ state: "error", retry: false }), false, "not theirs to change");
  assert.equal(canRetry({ state: "error" }), false, "the profile's own list has no retry flag");
  assert.equal(canRetry({ state: "done", retry: true }), false);
});
