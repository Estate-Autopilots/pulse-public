import assert from "node:assert/strict";
import test from "node:test";
import { currentIsoWeek, normalizePersonalWeek } from "../my-week/normalize-personal-week.mjs";

const zero = { target: null, delivered: { drafts: 0, finals: 0 }, claimed: { drafts: 0, finals: 0 }, gap: null, placeholder: false };

test("normalizes the keyed EST-236 weekly report into typed progress and own tasks", () => {
  const result = normalizePersonalWeek({
    week: "2026-W41",
    types: {
      model_video: {
        target: 4,
        delivered: { drafts: 1, finals: 2 },
        claimed: { drafts: 0, finals: 1 },
        gap: 1,
        placeholder: true,
      },
      vov: { target: null, delivered: { drafts: 0, finals: 0 }, gap: null, placeholder: false },
      founder_video: zero,
      testimonial: zero,
      walkthrough: zero,
      other: zero,
    },
    openTasks: [{
      id: "f525820a-13c3-4e34-9d3a-825703ab064a",
      title: "Export the synthetic client cut",
      status: "in_progress",
      dueAt: null,
      assigneeName: "Synthetic coworker",
      assets: [{ id: "469bd1a4-8bfa-45e2-993f-d71e39e484ad", url: null }],
    }],
  });

  assert.equal(result.week, "2026-W41");
  assert.deepEqual(result.types[0], {
    type: "model_video",
    label: "Model video",
    target: 4,
    delivered: 3,
    drafts: 1,
    finals: 2,
    claimed: { drafts: 0, finals: 1 },
    gap: 1,
    placeholder: true,
  });
  assert.equal(result.types.find(type => type.type === "vov").target, null);
  assert.equal(result.types.find(type => type.type === "vov").gap, null);
  assert.equal(result.totalDeliveries, 3);
  assert.equal(result.drafts, 1);
  assert.equal(result.finals, 2);
  assert.equal(result.openTasks[0].assets[0].url, null);
  assert.equal(JSON.stringify(result).includes("Synthetic coworker"), false);
});

test("unconfigured creative types have no invented target, delivery count, or gap", () => {
  const result = normalizePersonalWeek({ week: "2026-W41", types: {} });
  assert.equal(result.types.length, 6);
  assert.ok(result.types.every(type => type.target === null && type.delivered === null && type.gap === null));
  assert.equal(result.totalDeliveries, undefined);
});

test("uses the Asia/Kolkata date and ISO week year for the default week", () => {
  assert.equal(currentIsoWeek(new Date("2026-10-06T12:00:00.000Z")), "2026-W41");
  assert.equal(currentIsoWeek(new Date("2026-12-31T20:00:00.000Z")), "2026-W53");
  assert.equal(currentIsoWeek(new Date("2027-01-04T12:00:00.000Z")), "2027-W01");
});
