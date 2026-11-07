// WORKFLOW BUILDER (owner, 18 Oct 2026): the canvas's geometry and wiring rules, pure so they are tested alone.
// Blocks are workflow steps with a module (services/api/src/workflow-blocks.ts hands the list to the page); ports sit on
// the block's left (inputs) and right (outputs) edges, one row each; a wire is an entry of the step's `next` with the
// output port it leaves from. A pass-through port ("Anything") carries what came into its block.

export const SIZE = { w: 212, head: 58, row: 22, pad: 10, gapX: 96, gapY: 36, margin: 40, grid: 8 };

/** A step without a module is a plain block of its kind (as the API's specOf). */
export function specOf(step, byModule) {
  const b = step.module ? byModule[step.module] : undefined;
  if (b) return b;
  const k = step.kind;
  return byModule[k === "approval" ? "approval" : k === "decision" ? "decision" : k === "wait" ? "wait" : k === "end" ? "end" : "checklist"];
}

export function nodeHeight(spec) {
  const rows = Math.max(spec?.inputs.length ?? 0, spec?.outputs.length ?? 0, 1);
  return SIZE.head + rows * SIZE.row + SIZE.pad;
}

/** Where a port's dot is on the canvas. */
export function portPoint(pos, spec, side, key) {
  const list = side === "in" ? spec.inputs : spec.outputs;
  const i = Math.max(0, list.findIndex((p) => p.key === key));
  return { x: side === "in" ? pos.x : pos.x + SIZE.w, y: pos.y + SIZE.head + i * SIZE.row + SIZE.row / 2 };
}

/** A soft curve from an output to an input; it bends back round when the input is behind the output. */
export function wirePath(a, b) {
  const dx = Math.max(48, Math.abs(b.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

export const fits = (from, to) => from === to || from === "any" || to === "any";

/** Every wire, the implicit ones too: a step whose `next` is null goes on to the following step (unless it ends). */
export function wiresOf(steps) {
  const out = [];
  steps.forEach((s, i) => {
    if (Array.isArray(s.next)) for (const n of s.next) out.push({ from: s.id, port: n.port ?? null, to: n.to, in: n.in ?? null, label: n.label ?? null, when: n.when ?? null });
    else if (s.kind !== "end" && i + 1 < steps.length) out.push({ from: s.id, port: null, to: steps[i + 1].id, in: null, label: null, when: null });
  });
  return out;
}

/** What an output port carries: its own type, or for a pass-through port, what came into its block. */
export function outType(steps, byModule, stepId, portKey, seen = new Set()) {
  const s = steps.find((x) => x.id === stepId); if (!s) return "any";
  const spec = specOf(s, byModule); const port = spec.outputs.find((o) => o.key === portKey) ?? spec.outputs[0];
  if (port && port.type !== "any") return port.type;
  if (seen.has(stepId)) return "any";
  seen.add(stepId);
  for (const w of wiresOf(steps)) if (w.to === stepId) { const t = outType(steps, byModule, w.from, w.port, seen); if (t !== "any") return t; }
  return "any";
}

/** Can this output go into that input? `ok`, or why not and the blocks that would turn one into the other. */
export function canWire(steps, byModule, blocks, from, port, to, inKey) {
  if (from === to) return { ok: false, why: "A block cannot feed itself" };
  const target = steps.find((x) => x.id === to); if (!target) return { ok: false, why: "That block is gone" };
  const ins = specOf(target, byModule).inputs; const want = inKey ? ins.filter((i) => i.key === inKey) : ins;
  if (!ins.length) return { ok: false, why: "That block starts a run: nothing goes into it" };
  const t = outType(steps, byModule, from, port);
  if (want.some((i) => fits(t, i.type))) return { ok: true, type: t };
  const need = want.map((i) => i.type).filter((x) => x !== "any");
  return { ok: false, type: t, need, why: "The types do not match", adapters: blocks.filter((b) => b.module !== "handoff" && b.inputs.some((i) => fits(t, i.type)) && b.outputs.some((o) => o.type !== "any" && need.some((n) => fits(o.type, n)))).map((b) => b.module) };
}

/** The canvas edits explicit wires: an implicit "on to the next step" becomes a real wire from the first output. */
export function explicit(steps, byModule) {
  return steps.map((s, i) => {
    if (Array.isArray(s.next)) return s;
    const spec = specOf(s, byModule); const first = spec.outputs[0]?.key ?? null;
    return { ...s, next: s.kind !== "end" && i + 1 < steps.length ? [{ to: steps[i + 1].id, label: null, ...(first && s.module ? { port: first } : {}) }] : [] };
  });
}

/** Places for blocks that have none (an SOP turned into a workflow): columns by how far they are from a start. */
export function autoLayout(steps, byModule, force = false) {
  const need = steps.filter((s) => force || !s.pos); if (!need.length) return steps;
  const wires = wiresOf(steps); const depth = new Map();
  const incoming = (id) => wires.filter((w) => w.to === id && steps.findIndex((x) => x.id === w.from) < steps.findIndex((x) => x.id === id));
  for (const s of steps) { const d = Math.max(-1, ...incoming(s.id).map((w) => depth.get(w.from) ?? 0)) + 1; depth.set(s.id, d); }
  const cols = new Map(); const out = [];
  for (const s of steps) {
    if (!force && s.pos) { out.push(s); continue; }
    const d = depth.get(s.id) ?? 0; const y0 = cols.get(d) ?? SIZE.margin;
    out.push({ ...s, pos: { x: SIZE.margin + d * (SIZE.w + SIZE.gapX), y: y0 } });
    cols.set(d, y0 + nodeHeight(specOf(s, byModule)) + SIZE.gapY);
  }
  return out;
}

/** A free place to the right of a block (or at the end of the canvas) for a new block. */
export function freeSpot(steps, byModule, near) {
  const right = steps.reduce((m, s) => s.pos ? Math.max(m, s.pos.x + SIZE.w + SIZE.gapX) : m, SIZE.margin);
  const at = near?.pos ? { x: near.pos.x + SIZE.w + SIZE.gapX, y: near.pos.y } : { x: right, y: SIZE.margin };
  const busy = (p) => steps.some((s) => s.pos && Math.abs(s.pos.x - p.x) < SIZE.w && p.y < s.pos.y + nodeHeight(specOf(s, byModule)) + 12 && s.pos.y < p.y + 120);
  let y = at.y; while (busy({ x: at.x, y }) && y < 4000) y += 40;
  return { x: snap(at.x), y: snap(y) };
}

export const snap = (n) => Math.max(0, Math.round(n / SIZE.grid) * SIZE.grid);

/** How big the canvas must be to hold every block. */
export function extent(steps, byModule) {
  let w = 640, h = 360;
  for (const s of steps) if (s.pos) { w = Math.max(w, s.pos.x + SIZE.w + 160); h = Math.max(h, s.pos.y + nodeHeight(specOf(s, byModule)) + 120); }
  return { w, h };
}

/** A block's checklist: the lines of its SOP. */
export function checklistOf(detail) {
  return String(detail ?? "").split("\n").map((l) => l.replace(/^\s*(•|-|\*|\d+[.)])\s*/, "").trim()).filter(Boolean).slice(0, 40);
}
export function detailOf(lines) {
  const kept = lines.map((l) => l.trim()).filter(Boolean);
  return kept.length ? kept.map((l) => `• ${l}`).join("\n") : null;
}
