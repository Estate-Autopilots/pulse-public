// SOP-WORKFLOW: where every step of an SOP or workflow sits in its picture. Swimlanes are the roles (or people) who own
// the steps, in the order they first act; columns follow the flow, so a step sits right of everything that leads to
// it; steps of one phase stay together and phases follow each other. A connection that changes lane is a handoff; one
// that goes back (an approval's "send back") is drawn as a loop over the top. Pure, so the library cards, the SOP page
// and the builder draw the same picture.

export const SIZE = { node: { w: 208, h: 82 }, gapX: 64, gapY: 18, lanePad: 16, rail: 168, top: 44, end: 40 };

/** The connections: explicit `next`, else on to the following step; an end step stops. */
export function flowEdges(steps) {
  const ids = new Set(steps.map((s) => s.id));
  const out = [];
  steps.forEach((s, i) => {
    if (Array.isArray(s.next)) for (const x of s.next) { if (ids.has(x.to) && x.to !== s.id) out.push({ from: s.id, to: x.to, label: x.label ?? null }); }
    else if (s.kind !== "end" && i + 1 < steps.length) out.push({ from: s.id, to: steps[i + 1].id, label: null });
  });
  return out;
}

const laneKey = (s, by, names) => {
  if (by === "person" && s.personId) return { key: `p:${s.personId}`, label: names?.[s.personId] ?? "Someone" };
  if (s.role) return { key: `r:${s.role.toLowerCase()}`, label: s.role };
  if (s.personId) return { key: `p:${s.personId}`, label: names?.[s.personId] ?? "Someone" };
  return { key: "none", label: "No owner yet" };
};

/** The picture: lanes, placed nodes, edge paths, phase bands and the canvas size. */
export function layoutFlow(steps, { by = "role", names = {} } = {}) {
  const { node: N, gapX, gapY, lanePad, rail, top, end } = SIZE;
  const index = new Map(steps.map((s, i) => [s.id, i]));
  const edges = flowEdges(steps);
  // Lanes in order of first appearance.
  const lanes = []; const laneOf = new Map();
  for (const s of steps) { const l = laneKey(s, by, names); if (!lanes.some((x) => x.key === l.key)) lanes.push({ ...l, steps: 0 }); laneOf.set(s.id, l.key); lanes.find((x) => x.key === l.key).steps++; }
  // Columns: after every forward predecessor; a phase starts after the previous phase ends.
  const col = new Map(); const phaseEnd = new Map(); let lastPhase = null, phaseFloor = 0;
  for (const s of steps) {
    const ph = s.phase ?? null;
    if (ph !== lastPhase) { if (lastPhase !== null || col.size) phaseFloor = Math.max(phaseFloor, ...[...col.values()].map((c) => c + 1)); lastPhase = ph; }
    let c = phaseFloor;
    for (const e of edges) if (e.to === s.id && index.get(e.from) < index.get(s.id) && col.has(e.from)) c = Math.max(c, col.get(e.from) + 1);
    col.set(s.id, c); if (ph) phaseEnd.set(ph, Math.max(phaseEnd.get(ph) ?? 0, c));
  }
  // Two steps in one lane and column stack inside the lane.
  const slot = new Map(); const depth = new Map();
  for (const s of steps) { const k = `${laneOf.get(s.id)}|${col.get(s.id)}`; const n = depth.get(k) ?? 0; slot.set(s.id, n); depth.set(k, n + 1); }
  let y = top;
  for (const l of lanes) {
    const rows = Math.max(1, ...steps.filter((s) => laneOf.get(s.id) === l.key).map((s) => (slot.get(s.id) ?? 0) + 1));
    l.y = y; l.h = lanePad * 2 + rows * N.h + (rows - 1) * gapY; y += l.h;
  }
  const laneY = new Map(lanes.map((l) => [l.key, l.y]));
  const nodes = steps.map((s) => ({ id: s.id, lane: laneOf.get(s.id), col: col.get(s.id), x: rail + 24 + col.get(s.id) * (N.w + gapX), y: laneY.get(laneOf.get(s.id)) + lanePad + slot.get(s.id) * (N.h + gapY), w: N.w, h: N.h }));
  const at = new Map(nodes.map((n) => [n.id, n]));
  const cols = Math.max(0, ...nodes.map((n) => n.col)) + 1;
  const width = rail + 24 + cols * (N.w + gapX) - gapX + end, height = y + 20;
  const paths = edges.map((e) => {
    const a = at.get(e.from), b = at.get(e.to);
    const back = index.get(e.to) <= index.get(e.from);
    const handoff = a.lane !== b.lane && a.lane !== "none" && b.lane !== "none";
    let d, lx, ly;
    if (back) {
      // Over the top of both steps: up from the source, left, down into the target.
      const peak = Math.min(a.y, b.y) - 22 - (Math.abs(a.col - b.col) % 3) * 6;
      const sx = a.x + a.w / 2, tx = b.x + b.w / 2;
      d = `M${sx} ${a.y}V${peak + 8}Q${sx} ${peak} ${sx - 8} ${peak}H${tx + 8}Q${tx} ${peak} ${tx} ${peak + 8}V${b.y}`; lx = (sx + tx) / 2; ly = peak;
    } else {
      const sx = a.x + a.w, sy = a.y + a.h / 2, tx = b.x, ty = b.y + b.h / 2;
      if (Math.abs(sy - ty) < 1) { d = `M${sx} ${sy}H${tx}`; lx = (sx + tx) / 2; ly = sy; }
      else { const mx = sx + Math.min(gapX / 2, (tx - sx) / 2); const r = Math.min(10, Math.abs(ty - sy) / 2, Math.max(2, (tx - sx) / 4)); const dir = ty > sy ? 1 : -1;
        d = `M${sx} ${sy}H${mx - r}Q${mx} ${sy} ${mx} ${sy + dir * r}V${ty - dir * r}Q${mx} ${ty} ${mx + r} ${ty}H${tx}`; lx = mx; ly = (sy + ty) / 2; }
    }
    return { ...e, d, back, handoff, lx, ly };
  });
  // Phase bands across the columns their steps use.
  const phases = [];
  for (const s of steps) if (s.phase) {
    const n = at.get(s.id); const p = phases.find((x) => x.label === s.phase);
    if (p) { p.x0 = Math.min(p.x0, n.x); p.x1 = Math.max(p.x1, n.x + n.w); } else phases.push({ label: s.phase, x0: n.x, x1: n.x + n.w });
  }
  return { lanes, nodes, edges: paths, phases, width: Math.max(width, rail + 360), height, cols };
}

/** One line about the flow: "12 steps · 4 roles · 5 handoffs · 2 approvals". */
export function flowSummary(steps) {
  const L = layoutFlow(steps);
  const handoffs = L.edges.filter((e) => e.handoff).length, checks = steps.filter((s) => s.kind === "approval" || s.kind === "decision").length;
  const roles = L.lanes.filter((l) => l.key !== "none").length;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return [plural(steps.length, "step"), roles ? plural(roles, "role") : null, handoffs ? plural(handoffs, "handoff") : null, checks ? plural(checks, "check") : null].filter(Boolean).join(" · ");
}

/** "2 h", "1.5 d", "45 min": a step's time in words (hours in, from minutes or SLA hours). */
export function hoursText(h) {
  if (h == null || !Number.isFinite(h)) return null;
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 24) return `${Math.round(h * 10) / 10} h`.replace(".0 h", " h");
  return `${Math.round((h / 24) * 10) / 10} d`.replace(".0 d", " d");
}
