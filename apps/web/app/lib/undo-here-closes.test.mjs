// WL-RESCUE-2 (Sakobe, Willow Lane, 18 Nov 2026: "that's everything for today jatach nahi bro"): the "Done · Undo" banner
// that opens over the clicked row always closes: resting the pointer on it pauses it only for a while, and a click
// anywhere else closes it at once.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { UNDO_HOLD_MAX, undoLeft } from "./undo-place.mjs";

const pill = readFileSync(new URL("../kit/undo-here.tsx", import.meta.url), "utf8");

test("not held: the pill's own time; held: paused, but never longer than the cap", () => {
  assert.equal(undoLeft(6500, 0, false), 6500);
  assert.equal(undoLeft(6500, 3000, false), 6500, "the pointer left: a full stretch again");
  assert.equal(undoLeft(6500, 0, true), 6500 + UNDO_HOLD_MAX, "held from the start: paused up to the cap");
  assert.equal(undoLeft(6500, 12000, true), 6500 + UNDO_HOLD_MAX - 12000);
  assert.equal(undoLeft(6500, 60000, true), 0, "a pointer resting on it for a minute does not keep it");
  assert.equal(undoLeft(6500, 15000, false), 1500, "left late: only what is left of the cap");
});

test("the pill uses the cap and closes on a click elsewhere", () => {
  assert.match(pill, /undoLeft\(/, "the timer comes from undoLeft");
  assert.match(pill, /addEventListener\("pointerdown"/, "a click outside the pill closes it");
});
