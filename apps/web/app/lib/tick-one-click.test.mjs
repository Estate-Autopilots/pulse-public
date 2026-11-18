// DITASU-2 (orchestrator decision under the owner's delegation, 17 Nov 2026; AC card 7): ticking a task's circle completes
// it in ONE click, right where you clicked, with Undo there (no "Mark … done?" question in Pip's corner). Ditasu's replays:
// one circle clicked 7 times in 19 s, 11 tasks two clicks each, the question 0.9 of the screen away from the pointer.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { tickOnce } from "./tick-once.mjs";
import { placeUndo } from "./undo-place.mjs";

const here = new URL("../", import.meta.url);
const src = (path) => readFileSync(new URL(path, here), "utf8");

test("one click finishes; a double click on the same circle counts once; another circle is its own click", () => {
  const tick = tickOnce(400); const ran = [];
  assert.equal(tick("a", () => ran.push("a1"), 1000), true);
  assert.equal(tick("a", () => ran.push("a2"), 1200), false, "the second click of a double click");
  assert.equal(tick("b", () => ran.push("b1"), 1250), true);
  assert.equal(tick("a", () => ran.push("a3"), 1700), true, "a later click is a new click");
  assert.deepEqual(ran, ["a1", "b1", "a3"]);
});

test("the Undo pill sits beside the circle, inside the window, on a laptop and on a 363px phone", () => {
  const pill = { width: 260, height: 36 };
  // A circle in the table's first column on a laptop: to its right, centred on it.
  assert.deepEqual(placeUndo({ left: 300, right: 322, top: 400, height: 22 }, pill, { width: 1440, height: 900 }), { left: 332, top: 393 });
  // A circle near the right edge: on its left.
  assert.deepEqual(placeUndo({ left: 1300, right: 1322, top: 400, height: 22 }, pill, { width: 1440, height: 900 }), { left: 1030, top: 393 });
  // A 363px phone, circle at the left: to its right, never past the edge.
  const phone = placeUndo({ left: 16, right: 44, top: 300, height: 28 }, pill, { width: 363, height: 740 });
  assert.ok(phone.left >= 8 && phone.left + pill.width <= 363 - 8, JSON.stringify(phone));
  // Too wide for either side: under the circle, inside the window.
  const narrow = placeUndo({ left: 150, right: 178, top: 300, height: 28 }, { width: 330, height: 36 }, { width: 363, height: 740 });
  assert.ok(narrow.left >= 8 && narrow.left + 330 <= 363 - 8 && narrow.top > 300, JSON.stringify(narrow));
  // At the bottom of the window it stays on screen.
  assert.ok(placeUndo({ left: 300, right: 322, top: 890, height: 22 }, pill, { width: 1440, height: 900 }).top <= 900 - 8 - 36);
  // No anchor (a keyboard shortcut): low in the middle.
  assert.deepEqual(placeUndo(null, pill, { width: 1440, height: 900 }), { left: 590, top: 768 });
});

// Every place a task is ticked done: list rows, the table, boards, My work, the projects tree, the task page, My day.
const CIRCLES = ["tasks/client.tsx", "tasks/views/table.tsx", "tasks/board.tsx", "tasks/my-work.tsx", "tasks/projects-tree.tsx", "tasks/focus.tsx", "my-day/my-day.tsx", "tasks/spine.tsx"];

test("no screen asks first any more, and every one offers Undo beside the circle", () => {
  assert.equal(existsSync(new URL("tasks/confirm-done.tsx", here)), false, "the two-click circle (EST-997) is gone");
  for (const file of CIRCLES) {
    const s = src(file);
    assert.doesNotMatch(s, /confirm-done|useArmedTask|armedClass|Click its circle again/, `${file} still asks before finishing`);
    assert.match(s, /celebrate\([^;]*\(\) => \{|undoHere\(/, `${file}: a finished task can be undone`);
    assert.match(s, /origin/, `${file}: the Undo is placed by the element that was clicked`);
  }
  // celebrate() puts an Undo beside the circle (kit/undo-here.tsx), not in Pip's corner.
  const c = src("tasks/client.tsx");
  assert.match(c, /if \(undo\) \{ undoHere\(/);
  // The one-click tick runs at once: no question, no notice of its own.
  const t = src("tasks/tick-done.tsx");
  assert.doesNotMatch(t, /notify\(|Mark done\?/);
  // The pill is mounted once for the whole app.
  assert.match(src("layout.tsx"), /<UndoHereLayer\/>/);
  // My day's Undo has its own action on the API.
  assert.match(readFileSync(new URL("../../../services/api/src/my-day.ts", here), "utf8"), /action === 'reopen'/);
});

test("the task page's Mark done is one click unless proof or open subtasks need the dialog first", () => {
  const s = src("tasks/focus.tsx");
  assert.match(s, /const markDone = \(\) => \{ if \(needsDialog\) setOpen\("done"\); else void move\("done"\); \};/);
  assert.match(s, /needsDialog = \(!!t\.requiresProof && !d\.proof\.length\) \|\| d\.children\.some/);
  assert.doesNotMatch(s, /run: \(\) => setOpen\("done"\)/);
});

test("over a row, the Undo is a banner on that row: it starts at the circle and never covers half a title", async () => {
  const { bannerOver } = await import("./undo-place.mjs");
  // My day on a laptop: a 66px row from x 350 to 1030, the circle at x 366.
  const b = bannerOver({ left: 366, top: 437, height: 24 }, { left: 350, right: 1030, top: 416, height: 66 }, { width: 1440, height: 900 });
  assert.deepEqual(b, { left: 351, top: 419, width: 678, height: 60 }, "the whole row, edge to edge");
  // A 363px phone: inside the window.
  const p = bannerOver({ left: 40, top: 500, height: 22 }, { left: 22, right: 342, top: 482, height: 60 }, { width: 363, height: 844 });
  assert.deepEqual(p, { left: 23, top: 485, width: 318, height: 54 }, "a phone: the whole row, inside the window");
  // A 40px table row: the banner fits inside it.
  const r = bannerOver({ left: 300, top: 410, height: 20 }, { left: 290, right: 1400, top: 400, height: 40 }, { width: 1440, height: 900 });
  assert.equal(r.height, 36); assert.equal(r.top, 402);
});
