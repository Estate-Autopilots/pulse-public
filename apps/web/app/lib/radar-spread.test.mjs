import { test } from "node:test";
import assert from "node:assert/strict";
import { closestPair, spreadDots } from "./radar-spread.mjs";

// Twelve sectors, fourteen tools on the adopt ring (r 26-80): the case that crowded the centre.
const span = (Math.PI * 2) / 12;
const crowd = Array.from({ length: 14 }, (_, i) => { const a0 = -Math.PI / 2 + (i % 4) * span; const a = a0 + span / 2, r = 30 + (i % 3);
  return { id: i, x: 300 + Math.cos(a) * r, y: 300 + Math.sin(a) * r, a0, a1: a0 + span, rMin: 26, rMax: 80 }; });

test("crowded centre dots end at least a dot apart", () => {
  assert.ok(closestPair(crowd) < 5);
  const out = spreadDots(crowd);
  assert.ok(closestPair(out) >= 17, `closest ${closestPair(out)}`);
});

test("each dot stays in its ring band and its sector", () => {
  for (const d of spreadDots(crowd)) {
    const r = Math.hypot(d.x - 300, d.y - 300); assert.ok(r >= 26 - 0.01 && r <= 80 + 0.01, `r ${r}`);
    let a = Math.atan2(d.y - 300, d.x - 300); while (a < d.a0 - Math.PI) a += Math.PI * 2; while (a > d.a0 + Math.PI) a -= Math.PI * 2;
    assert.ok(a >= d.a0 - 1e-9 && a <= d.a1 + 1e-9);
  }
});

test("deterministic and keeps extra fields; dots already apart do not move", () => {
  assert.deepEqual(spreadDots(crowd), spreadDots(crowd));
  assert.equal(spreadDots(crowd)[3].id, 3);
  const apart = [{ x: 300, y: 200, a0: -Math.PI, a1: 0, rMin: 90, rMax: 110 }, { x: 400, y: 300, a0: -Math.PI / 2, a1: Math.PI / 2, rMin: 90, rMax: 110 }];
  assert.deepEqual(spreadDots(apart).map((d) => [Math.round(d.x), Math.round(d.y)]), [[300, 200], [400, 300]]);
});
