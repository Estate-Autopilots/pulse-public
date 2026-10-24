// PULSE-HQ follow-up (owner, 24 Oct 2026): Stack Intelligence's radar crowded its centre (the adopt ring is small and
// every category meets there). Pushes overlapping dots apart, each kept inside its own ring band and its category's
// sector. Deterministic: the same tools always land in the same places. Centre of the radar: (cx, cy).

/** @param {{ x: number, y: number, a0: number, a1: number, rMin: number, rMax: number }[]} dots */
export function spreadDots(dots, { gap = 21, rounds = 90, cx = 300, cy = 300 } = {}) {
  const p = dots.map((d) => ({ ...d }));
  const clamp = (d) => {
    const dx = d.x - cx, dy = d.y - cy, r = Math.min(d.rMax, Math.max(d.rMin, Math.hypot(dx, dy)));
    const pad = Math.min((d.a1 - d.a0) / 2, Math.asin(Math.min(1, 10 / Math.max(r, 10))));
    let a = Math.atan2(dy, dx);
    while (a < d.a0 - Math.PI) a += Math.PI * 2;
    while (a > d.a0 + Math.PI) a -= Math.PI * 2;
    a = Math.min(d.a1 - pad, Math.max(d.a0 + pad, a));
    d.x = cx + Math.cos(a) * r; d.y = cy + Math.sin(a) * r;
  };
  for (let k = 0; k < rounds; k++) {
    let moved = false;
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
      const dx = p[j].x - p[i].x, dy = p[j].y - p[i].y, dist = Math.hypot(dx, dy);
      if (dist >= gap) continue;
      const ux = dist ? dx / dist : Math.cos(i + j), uy = dist ? dy / dist : Math.sin(i + j), push = (gap - dist) / 2;
      p[i].x -= ux * push; p[i].y -= uy * push; p[j].x += ux * push; p[j].y += uy * push; moved = true;
    }
    p.forEach(clamp);
    if (!moved) break;
  }
  return p;
}

/** The smallest distance between any two dots (for tests and checks). */
export function closestPair(dots) {
  let min = Infinity;
  for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) min = Math.min(min, Math.hypot(dots[j].x - dots[i].x, dots[j].y - dots[i].y));
  return min;
}
