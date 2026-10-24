import { test } from "node:test";
import assert from "node:assert/strict";
import { answerJson, quotaUntil, QUOTA } from "./runtime.mjs";

const now = new Date("2026-10-22T04:00:00Z");
test("out of quota is told apart, with the plan's own reset time", () => {
  const claude = "You've hit your weekly limit · resets Oct 24, 11am (UTC)";
  const codex = "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 27th, 2026 6:34 AM.";
  assert.ok(QUOTA.test(claude)); assert.ok(QUOTA.test(codex)); assert.ok(!QUOTA.test("model not found"));
  assert.equal(quotaUntil(claude, now).toISOString(), "2026-10-24T11:00:00.000Z");
  assert.equal(quotaUntil(codex, now).toISOString(), "2026-10-27T06:34:00.000Z");
  assert.equal(quotaUntil("resets Jan 2, 3pm (UTC)", now).toISOString(), "2027-01-02T15:00:00.000Z", "a reset in January is next year's");
  assert.equal(quotaUntil("limit reached, try later", now), null);
});
test("the model's JSON answer, also inside a code fence or a sentence", () => {
  assert.deepEqual(answerJson('{"reply":"hi"}'), { reply: "hi" });
  assert.deepEqual(answerJson('```json\n{"status":"done","report":"ok"}\n```'), { status: "done", report: "ok" });
  assert.deepEqual(answerJson('Here you go: {"reply":"x"} thanks'), { reply: "x" });
  assert.equal(answerJson("plain words"), null);
});
