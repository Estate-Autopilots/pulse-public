// TASK-MERGE (Pip): suggestions stand on structure only, need a high score, and a dismissal is never shown again.
import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_MIN, SUGGEST_MIN, chatSuggestions, doneWhenSuggestion, pickSuggestions, qualifies, relevance, suggestionKey } from "./pip-suggest.mjs";

const T1 = "0b7c5a3e-1111-4a2b-9c3d-000000000001";
const sure = { kind: "chat-task", subject: T1, basis: "task", confidence: 0.92 };

test("words are never structure: a title or message keyword does not qualify, however sure", () => {
  for (const basis of ["words", "title", "keyword", "model", undefined]) assert.equal(qualifies({ ...sure, basis, confidence: 0.99 }).ok, false, String(basis));
  assert.equal(qualifies({ ...sure, basis: "words", confidence: 0.99 }).why, "not structure");
});

test("structure qualifies only at a high score", () => {
  assert.equal(qualifies(sure).ok, true);
  assert.equal(qualifies({ ...sure, confidence: SUGGEST_MIN - 0.01 }).ok, false);
  assert.equal(qualifies({ ...sure, confidence: SUGGEST_MIN - 0.01 }).why, "not sure enough");
  assert.equal(qualifies({ ...sure, subject: "" }).ok, false);
  assert.equal(qualifies({ ...sure, confidence: Number.NaN }).ok, false);
});

test("a dismissed suggestion (this kind, this subject) never comes back; another subject still can", () => {
  const dismissed = new Set([suggestionKey("chat-task", T1)]);
  assert.deepEqual(qualifies(sure, { dismissed }), { ok: false, score: 0, why: "dismissed" });
  assert.equal(qualifies({ ...sure, subject: "other-task-id" }, { dismissed }).ok, true);
  assert.equal(qualifies({ ...sure, kind: "chat-link" }, { dismissed }).ok, true, "per kind and subject");
});

test("a kind a person keeps dismissing scores down for them", () => {
  assert.equal(relevance(null), 1);
  assert.equal(relevance({ accepted: 5, dismissed: 0 }), 1);
  assert.ok(relevance({ accepted: 0, dismissed: 1 }) < 1);
  assert.equal(relevance({ accepted: 0, dismissed: 4 }), 0.5);
  assert.equal(qualifies(sure, { kinds: { "chat-task": { dismissed: 1 } } }).ok, false, "0.92 x 0.8 is below the bar");
  assert.equal(qualifies(sure, { kinds: { "chat-task": { accepted: 12, dismissed: 1 } } }).ok, true, "accepted often: still shown");
  assert.equal(qualifies(sure, { kinds: { "chat-link": { dismissed: 9 } } }).ok, true, "only that kind");
});

test("nothing opens by itself unless auto-open is on, the suggestion allows it and the score is near certain", () => {
  const direct = chatSuggestions({ body: "", attachments: [{ name: "Any title", task: T1 }] }, { directed: true, direct: true });
  assert.equal(direct[0].confidence >= AUTO_MIN, true);
  assert.equal(pickSuggestions(direct).auto, null, "off by default");
  assert.equal(pickSuggestions(direct, { autoOpen: true }).auto?.subject, T1);
  assert.equal(pickSuggestions(direct, { autoOpen: true, kinds: { "chat-task": { dismissed: 1 } } }).auto, null, "a dismissal of the kind stops it");
  const group = chatSuggestions({ body: "", attachments: [{ name: "Any title", task: T1 }] }, { directed: true });
  assert.equal(pickSuggestions(group, { autoOpen: true }).auto, null, "a group mention is a chip at most");
  assert.equal(pickSuggestions(group).chips.length, 1);
});

test("chat: the task's title and the message's words are never read", () => {
  const ctx = { origin: "https://pulse.example.test", directed: true };
  // The words that used to open Settings → Organisation, My profile or Leave beside the chat.
  for (const body of ["Please update your profile in My profile", "One Pulse for every company: check Settings → Organisation", "apply for leave on Friday", "Add the office Wi-Fi in Office presence"])
    assert.deepEqual(chatSuggestions({ body, attachments: [] }, ctx), [], body);
  const withTask = chatSuggestions({ body: "Achievement A10: one Pulse for every company", attachments: [{ name: "Update company settings and payroll", task: T1 }] }, ctx);
  assert.deepEqual(withTask.map((s) => [s.kind, s.href, s.basis]), [["chat-task", `/tasks/${T1}`, "task"]]);
});

test("chat: a link to a page in this Pulse is structure; other sites and the chat itself are not", () => {
  const ctx = { origin: "https://pulse.example.test", directed: true };
  const s = chatSuggestions({ body: "see https://pulse.example.test/docs/abc-123, thanks", attachments: [] }, ctx);
  assert.deepEqual(s.map((x) => [x.kind, x.href]), [["chat-link", "/docs/abc-123"]]);
  assert.deepEqual(chatSuggestions({ body: "https://example.org/tasks/1", attachments: [] }, ctx), []);
  assert.deepEqual(chatSuggestions({ body: "https://pulse.example.test/chats/xyz", attachments: [] }, ctx), []);
  // A message to a whole group is never sure enough.
  assert.deepEqual(pickSuggestions(chatSuggestions({ body: "https://pulse.example.test/docs/abc-123", attachments: [] }, { origin: ctx.origin })).chips, []);
});

test("chat: a document file sent to the reader may be offered beside the chat", () => {
  const s = chatSuggestions({ body: "", attachments: [{ id: "f-1", name: "Plan.pdf", mime: "application/pdf" }, { id: "f-2", name: "photo.jpg", mime: "image/jpeg" }] }, { directed: true });
  assert.deepEqual(s.map((x) => [x.kind, x.subject]), [["chat-file", "f-1"]]);
  assert.equal(pickSuggestions(s).chips.length, 1);
});

test("Done when: only on a place the creator picked or wrote out in full", () => {
  const sig = [{ event: "office.network.saved" }];
  assert.equal(doneWhenSuggestion("t", { source: "creator" }, sig)?.basis, "picked");
  assert.equal(doneWhenSuggestion("t", { source: "notes" }, sig)?.basis, "written-place");
  assert.equal(doneWhenSuggestion("t", { source: "guess" }, sig), null);
  assert.equal(doneWhenSuggestion("t", null, sig), null);
  assert.equal(doneWhenSuggestion("t", { source: "creator" }, []), null);
  assert.equal(qualifies(doneWhenSuggestion("t", { source: "notes" }, sig), { kinds: { "done-when": { dismissed: 2 } } }).ok, false, "dismissing proposals makes Pip quieter");
});
