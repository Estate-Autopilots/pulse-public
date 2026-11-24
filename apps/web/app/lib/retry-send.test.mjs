// REPLAY-FIXES #2: an approval answer is not lost when the connection drops (lib/retry-send.mjs, chats/conversation.tsx).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sendWithRetry } from "./retry-send.mjs";

const fast = { sleep: async () => {} };
const script = (...answers) => { const calls = []; return { calls, send: async (path, body) => { calls.push([path, body]); const a = answers.shift(); if (a instanceof Error) throw a; return a; } }; };

test("a dropped connection or a busy server is tried again by itself, and the answer goes", async () => {
  const s = script(new Error("Failed to fetch"), { ok: false, status: 503, data: {} }, { ok: true, status: 200, data: { state: "sent" } });
  assert.deepEqual(await sendWithRetry(s.send, "chats/proposals/x/decide", { action: "send" }, fast), { ok: true, data: { state: "sent" } });
  assert.equal(s.calls.length, 3);
});

test("it waits for the connection to come back before trying", async () => {
  let up = false, waited = 0;
  const s = script({ ok: true, status: 200, data: {} });
  await sendWithRetry(s.send, "p", {}, { ...fast, online: () => up, waitOnline: async () => { waited++; up = true; } });
  assert.equal(waited, 1); assert.equal(s.calls.length, 1);
});

test("still not through after every try: Not sent, to retry by hand", async () => {
  const s = script(new Error("x"), new Error("x"), { ok: false, status: 502, data: {} }, { ok: false, status: 429, data: {} });
  const r = await sendWithRetry(s.send, "p", {}, fast);
  assert.deepEqual(r, { ok: false, retry: true, error: "Not sent. Check your connection." });
  assert.equal(s.calls.length, 4, "the first try and three more");
});

test("a refusal is said at once in the server's words, never retried", async () => {
  const s = script({ ok: false, status: 403, data: { error: "Only its approver decides" } });
  assert.deepEqual(await sendWithRetry(s.send, "p", {}, fast), { ok: false, retry: false, error: "Only its approver decides" });
  assert.equal(s.calls.length, 1);
});

test("the approval and hand-off buttons use it and offer Tap to retry; Pip's log keeps what could not go", () => {
  const src = readFileSync(new URL("../chats/conversation.tsx", import.meta.url), "utf8");
  assert.equal((src.match(/sendWithRetry\(postJson, `chats\/(proposals|handoffs)\/\$\{[^}]+\}\/decide`/g) ?? []).length, 2);
  assert.ok((src.match(/Tap to retry/g) ?? []).length >= 2);
  const intent = readFileSync(new URL("../chats/workspace/intent.tsx", import.meta.url), "utf8");
  assert.match(intent, /window\.addEventListener\("online", flushDecisions\)/);
});
