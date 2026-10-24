// EA-AI: the runner's shared subscription quota memory and the test runtime's task proposals.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quotaNote, quotaWait, stubAssignee, stubModel } from "./runner.mjs";

test("a subscription out of quota waits until its reset, for every employee on it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-")), file = join(dir, "quota.json");
  try {
    const until = new Date(Date.now() + 3600000);
    assert.equal(await quotaWait("claude", Date.now(), file), null);
    await quotaNote("claude", until, "weekly limit, resets Oct 24, 11am (UTC)", file);
    assert.equal((await quotaWait("claude", Date.now(), file))?.toISOString(), until.toISOString());
    assert.equal(await quotaWait("claude", until.getTime() + 1, file), null, "back after the reset");
    assert.equal(await quotaWait("codex", Date.now(), file), null, "another plan is not affected");
    await quotaNote("stub", until, "x", file);
    assert.equal(await quotaWait("stub", Date.now(), file), null, "only this server's subscriptions");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const people = [{ name: "Ishaan Rao", username: "ishaan.rao", role: "Video Editor" }, { name: "Asha Kireteso", username: "asha.kireteso", role: "HR executive" }];
test("the test runtime finds who a request names: @username, name, then role", () => {
  assert.equal(stubAssignee("give this to @asha.kireteso", people)?.username, "asha.kireteso");
  assert.equal(stubAssignee("assign the brief to Ishaan please", people)?.username, "ishaan.rao");
  assert.equal(stubAssignee("assign the brief to the editor", people)?.username, "ishaan.rao");
  assert.equal(stubAssignee("assign the brief to the accountant", people), null);
});

test("asked to give work, the test runtime proposes a task (never creates one)", async () => {
  const prompt = `The message to act on, from Savuzo Roberatano: Please assign the Skyline walkthrough brief to the editor\n\nPeople you may give work to (JSON): ${JSON.stringify(people)}\n\nAnswer with JSON only: {"action": "propose" | "none"}`;
  const j = JSON.parse(await stubModel(prompt));
  assert.equal(j.action, "propose_task");
  assert.equal(j.task.assignee, "ishaan.rao");
  assert.equal(j.task.title, "Skyline walkthrough brief");
});
