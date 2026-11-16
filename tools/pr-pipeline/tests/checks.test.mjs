// PR-PIPELINE: the colour maths and the summary of the visual checks (node --test tools/pr-pipeline/tests/checks.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, over, parseColor, summarise } from '../checks.mjs';

test('WCAG contrast of black on white is 21, of equal colours 1', () => {
  assert.equal(Math.round(contrast([0, 0, 0, 1], [255, 255, 255, 1])), 21);
  assert.equal(contrast([10, 20, 30, 1], [10, 20, 30, 1]), 1);
  assert.ok(Math.abs(contrast(parseColor('rgb(119, 119, 119)'), [255, 255, 255, 1]) - 4.48) < 0.02);
});

test('a translucent colour is blended over its background', () => {
  assert.deepEqual(over([255, 255, 255, 0.5], [0, 0, 0, 1]).map(Math.round), [128, 128, 128, 1]);
});

test('summarise flags low contrast, tiny text and text outside the safe margin', () => {
  const W = 1080, H = 1350;
  const ok = { text: 'Big', color: [255, 255, 255, 1], bg: [0, 0, 0, 1], fontPx: 60, box: [100, 100, 600, 200] };
  const s = summarise({ runs: [ok], overflow: [] }, { W, H });
  assert.ok(s.contrast.ok && s.legible360.ok && s.cropSafe.ok);
  const grey = { ...ok, color: [90, 90, 90, 1] };
  const tiny = { ...ok, fontPx: 20 };
  const edge = { ...ok, box: [10, 100, 600, 200] };
  const bad = summarise({ runs: [grey, tiny, edge], overflow: ['taller than its area by 12px'] }, { W, H });
  assert.ok(!bad.contrast.ok && !bad.legible360.ok && !bad.cropSafe.ok);
});
