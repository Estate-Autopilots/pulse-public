import assert from "node:assert/strict";
import test from "node:test";
import { groupLabel, milestone, providerLabel, standingLine, standingPercent } from "./training.mjs";
import { ownCsp, trainingFile } from "../api/proxy.mjs";

test("groups read in plain words, the team word from the company's vocabulary", () => {
  assert.equal(groupLabel("side", "channel_partner"), "Channel partners and dealers");
  assert.equal(groupLabel("role", "pod_head", "Squad"), "Squad heads");
  assert.equal(groupLabel("role", "leadership"), "Leadership");
});

test("video progress is kept at milestones only, never going back", () => {
  assert.equal(milestone(10, 100), null);
  assert.equal(milestone(26, 100), 25);
  assert.equal(milestone(26, 100, 25), null);
  assert.equal(milestone(89.6, 100, 50), 90);
  assert.equal(milestone(100, 100, 90), 100);
  assert.equal(milestone(5, 0), null);
  assert.equal(milestone(Number.NaN, 100), null);
});

test("a person's standing reads as one line and a share", () => {
  const s = { videos: 3, watched: 1, percent: 40, questions: 4, best: 50, tries: 2, passed: false, done: false, lastAt: null };
  assert.equal(standingLine(s), "1 of 3 videos watched, quiz not passed yet (best 50 %)");
  assert.equal(standingPercent(s), 25);
  assert.equal(standingLine({ ...s, watched: 3, passed: true, done: true }), "Done");
  assert.equal(standingPercent({ ...s, watched: 3, passed: true }), 100);
  assert.equal(standingLine(null), "Not started");
  assert.equal(providerLabel("drive"), "Google Drive");
});

test("an uploaded training video streams through the proxy with its own policy", () => {
  assert.equal(trainingFile(["training", "videos", "0f4c2d6e-aaaa-4bbb-8ccc-dddddddddddd", "file"]), true);
  assert.equal(trainingFile(["training", "videos", "x"]), false);
  assert.equal(trainingFile(["training", "courses", "x", "file"]), false);
  assert.equal(ownCsp(["training", "videos", "x", "file"]), true);
});
