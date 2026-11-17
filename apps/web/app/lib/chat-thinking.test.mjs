// BUGFIX #26 (owner, 7 Nov 2026): the top-bar chat said nothing while an AI employee worked on an answer. Chats and the
// top-bar chat now share one rule (aiThinking) and both draw "<name> is working on an answer" with the moving dots.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { aiThinking, thinkingLine } from "./chat-format.mjs";

const ask = (state, extra = {}) => ({ agentAsk: { state, reason: null, agent: "Accounts Assistant (AI)", ...extra } });

test("an AI employee answering shows by its whole name; done, failed, paused or out of quota does not", () => {
  assert.deepEqual(aiThinking([ask("queued")]), ["Accounts Assistant"]);
  assert.deepEqual(aiThinking([ask("dispatching"), ask("leased")]), ["Accounts Assistant"]);
  assert.deepEqual(aiThinking([ask("queued", { agent: "Project Coordinator" }), ask("leased")]), ["Project Coordinator", "Accounts Assistant"]);
  assert.deepEqual(aiThinking([ask("done")]), []);
  assert.deepEqual(aiThinking([ask("failed")]), []);
  assert.deepEqual(aiThinking([ask("queued", { reason: "paused" })]), []);
  assert.deepEqual(aiThinking([ask("queued", { runtimeState: "out_of_quota" })]), []);
  assert.deepEqual(aiThinking([{ body: "hi" }, null, undefined]), []);
  assert.deepEqual(aiThinking(null), []);
  // Only the latest 20 messages count: an old unanswered question does not keep the dots on for ever.
  assert.deepEqual(aiThinking([ask("queued"), ...Array.from({ length: 20 }, () => ({ body: "later" }))]), []);
});

test("the line reads as a sentence", () => {
  assert.equal(thinkingLine(["Accounts Assistant"]), "Accounts Assistant is working on an answer");
  assert.equal(thinkingLine(["A", "B"]), "A and B are working on an answer");
  assert.equal(thinkingLine([]), "");
  assert.equal(thinkingLine(null), "");
});

test("Chats and the top-bar chat both draw the line from the shared rule", () => {
  const dock = readFileSync(new URL("../chats/dock.tsx", import.meta.url), "utf8");
  const chats = readFileSync(new URL("../chats/conversation.tsx", import.meta.url), "utf8");
  assert.match(dock, /aiThinking\(msgs\)/, "the top-bar chat works out who is answering");
  assert.match(dock, /data-dock-thinking/, "the top-bar chat shows the line");
  assert.match(dock, /answering \? 3000 : 15000/, "it looks for the reply every 3 s while an answer is coming");
  assert.match(chats, /aiThinking\(messages\)/, "Chats uses the same rule");
});
