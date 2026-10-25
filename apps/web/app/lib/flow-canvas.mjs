// FLOW-B: the process builder's geometry and wiring rules (FlowDef v2, ~/ea-research/flow/FLOW-OS.md), pure so they are
// tested alone. A step is a card: its Needs are dots on the left edge, its Makes on the right, one row each. Stages are
// columns ("bands") left to right; a step belongs to the band its `stage` names, and the band is as wide as its steps.
// A wire joins a Makes to a Needs; it fits when the kinds are the same or either end takes anything, and when it does
// not, the converters (modules that take the one kind and make the other) are offered.

export const NODE = { w: 240, head: 66, row: 24, pad: 12 };
export const BAND = { pad: 28, top: 64, gap: 28, minW: 300, gapX: 56, gapY: 28 };
export const KINDS = ["contact", "talk", "doc", "media", "answers", "money", "verdict", "slot", "list", "any"];

export const fits = (from, to) => from === to || from === "any" || to === "any";
export const snap = (n, grid = 8) => Math.round(n / grid) * grid;

/** The module a step places, or a placeholder that keeps the canvas drawing when a module is unknown. FLOW-D: a step
 *  with a block reads as its primitive (name, icon) and has the primitive's ports, as the API compiles them
 *  (services/api/src/flow/blocks.ts stepPorts): "Starts after", then what it uses (never holding it up); a Decide
 *  names its two ways. The primitives sit in `byKey` under "block:<key>". */
export const IN = { key: "in", label: "Starts after", kind: "any", many: true };
export function moduleOf(step, byKey) {
  const mm = byKey[step.module] ?? { key: step.module, name: step.module, icon: "Square", category: "Flow", summary: "", needs: [], makes: [], engine: "stub", settings: [], defaults: {}, pip: [] };
  const pr = step.block ? byKey[`block:${step.block}`] : null;
  if (!pr) return mm;
  const words = (x) => (typeof x === "string" ? x.trim().slice(0, 40) : "");
  const makes = step.block === "decide" ? [{ key: "yes", label: words(step.settings?.yes) || "Yes", kind: "verdict" }, { key: "no", label: words(step.settings?.no) || "Otherwise", kind: "verdict" }] : mm.makes;
  const needs = step.block === "start" ? [] : [IN, ...mm.needs.filter((n) => n.key !== "in").map((n) => ({ ...n, required: false }))];
  return { ...mm, name: pr.name, icon: pr.icon, summary: pr.summary, needs, makes, kindLabel: kindOf(step, pr)?.label ?? null };
}

/** The kind of a primitive a step is (its module, then the settings that tell kinds with one module apart). */
export function kindOf(step, pr) {
  const same = (pr?.kinds ?? []).filter((k) => k.module === step.module);
  if (same.length <= 1) return same[0] ?? null;
  const s = step.settings ?? {}, marks = (k) => Object.keys(k.settings ?? {}).filter((x) => !["hours", "every", "day", "at"].includes(x));
  const hit = same.filter((k) => marks(k).length).sort((a, z) => marks(z).length - marks(a).length)
    .find((k) => marks(k).every((x) => x === "rule" ? !!s.rule : JSON.stringify(s[x] ?? null) === JSON.stringify(k.settings[x])));
  return hit ?? same.find((k) => !marks(k).length) ?? same[0];
}

export function nodeHeight(mod) {
  return NODE.head + Math.max(mod?.needs?.length ?? 0, mod?.makes?.length ?? 0, 1) * NODE.row + NODE.pad;
}

/** Where a port's dot is, in canvas units. */
export function portPoint(step, mod, side, key) {
  const list = side === "needs" ? mod.needs : mod.makes;
  const i = Math.max(0, list.findIndex((p) => p.key === key));
  return { x: side === "needs" ? step.pos.x : step.pos.x + NODE.w, y: step.pos.y + NODE.head + i * NODE.row + NODE.row / 2 };
}

/** A soft curve from a Makes to a Needs; it loops round when the Needs is behind. */
export function wirePath(a, b) {
  const dx = Math.max(56, Math.abs(b.x - a.x) / 2);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

/** The middle of a wire (where its words and its converter offer sit). */
export function wireMid(a, b) {
  const dx = Math.max(56, Math.abs(b.x - a.x) / 2);
  // A cubic's point at t = 0.5.
  return { x: (a.x + 3 * (a.x + dx) + 3 * (b.x - dx) + b.x) / 8, y: (a.y + 3 * a.y + 3 * b.y + b.y) / 8 };
}

/** What a wire carries and whether it fits; when not, the converters that would. */
export function checkWire(def, byKey, modules, wire) {
  const from = def.steps.find((s) => s.id === wire.from.step), to = def.steps.find((s) => s.id === wire.to.step);
  if (!from || !to) return { ok: false, why: "One end of this wire is gone", fromKind: "any", toKind: "any", converters: [] };
  const out = moduleOf(from, byKey).makes.find((p) => p.key === wire.from.port), inn = moduleOf(to, byKey).needs.find((p) => p.key === wire.to.port);
  const fromKind = out?.kind ?? "any", toKind = inn?.kind ?? "any";
  if (!out || !inn) return { ok: false, why: "That port is no longer on the step", fromKind, toKind, converters: [] };
  if (fits(fromKind, toKind)) return { ok: true, why: null, fromKind, toKind, converters: [] };
  return { ok: false, why: `It makes ${article(fromKind)}; this needs ${article(toKind)}`, fromKind, toKind, converters: convertersFor(modules, fromKind, toKind) };
}

/** Modules that take `from` and make `to` (neither end "anything"): the converters a misfit wire offers. */
export function convertersFor(modules, from, to) {
  return modules.filter((m) => m.engine !== "retired" && m.needs.some((p) => p.kind === from || (p.kind === "any" && from !== "any")) && m.makes.some((p) => p.kind === to))
    .sort((a, z) => Number(!!z.converter) - Number(!!a.converter) || rankEngine(a.engine) - rankEngine(z.engine)).map((m) => m.key);
}
const rankEngine = (e) => ({ live: 0, partial: 1, stub: 2 })[e] ?? 3;
const AN = new Set(["answers", "any"]);
const WORD = { contact: "contact", talk: "talk", doc: "document", media: "media", answers: "answers", money: "money", verdict: "verdict", slot: "time slot", list: "list", any: "anything" };
export function article(kind) { const w = WORD[kind] ?? kind; return AN.has(kind) ? w : `${/^[aeiou]/.test(w) ? "an" : "a"} ${w}`; }

/** Can a wire start here and end there? The first Needs of the target that fits when no port is named. */
export function wireTo(def, byKey, from, to, inKey) {
  if (from.step === to) return { ok: false, why: "A step cannot feed itself" };
  const src = def.steps.find((s) => s.id === from.step), dst = def.steps.find((s) => s.id === to);
  if (!src || !dst) return { ok: false, why: "That step is gone" };
  const kind = moduleOf(src, byKey).makes.find((p) => p.key === from.port)?.kind ?? "any";
  const needs = moduleOf(dst, byKey).needs;
  if (!needs.length) return { ok: false, why: "That step starts things: it needs nothing" };
  const taken = new Set(def.wires.filter((w) => w.to.step === to).map((w) => w.to.port));
  const pool = inKey ? needs.filter((p) => p.key === inKey) : needs;
  const best = pool.find((p) => fits(kind, p.kind) && (p.many || !taken.has(p.key))) ?? pool.find((p) => fits(kind, p.kind)) ?? pool[0];
  if (def.wires.some((w) => w.from.step === from.step && w.from.port === from.port && w.to.step === to && w.to.port === best.key)) return { ok: false, why: "Those two are already joined" };
  return { ok: true, port: best.key, fits: fits(kind, best.kind), kind, need: best.kind };
}

/** Whether a step runs for the chosen variant values: every `when` condition must hold (a value not chosen holds). */
export function stepRuns(step, values) {
  return (step.when ?? []).every((c) => {
    const v = values?.[c.field];
    if (v === undefined || v === null || v === "") return true;
    const s = String(v), list = c.values ?? (c.value != null ? [String(c.value)] : []);
    switch (c.op) {
      case "eq": return s === String(c.value);
      case "ne": return s !== String(c.value);
      case "in": return list.includes(s);
      case "notin": return !list.includes(s);
      case "filled": return s !== "";
      case "empty": return s === "";
      default: return true;
    }
  });
}

/** Days a step is due after its anchor for a variant value (a number, or one per value), or null. */
export function dueDays(due, values) {
  if (!due) return null;
  if (typeof due.days === "number") return due.days;
  const field = due.field ?? Object.keys(values ?? {}).find((k) => due.days?.[values[k]] !== undefined);
  const v = field ? values?.[field] : undefined;
  return v !== undefined && due.days?.[v] !== undefined ? due.days[v] : null;
}

/** Places for steps without a usable one: stage by stage (left to right), and inside a stage by how deep a step sits
 *  in the wires between its own steps, stacked top to bottom. `force` lays every step out again (Tidy up). */
export function layout(def, byKey, force = false) {
  const steps = def.steps;
  const placed = (s) => s.pos && Number.isFinite(s.pos.x) && Number.isFinite(s.pos.y);
  const piled = steps.length > 1 && steps.every((s) => !placed(s) || (s.pos.x === steps[0].pos?.x && s.pos.y === steps[0].pos?.y));
  if (!force && !piled && steps.every(placed)) return def;
  const order = stageOrder(def);
  const depth = new Map();
  const index = new Map(steps.map((s, i) => [s.id, i]));
  for (const s of steps) {
    const ins = def.wires.filter((w) => w.to.step === s.id && (index.get(w.from.step) ?? 1e9) < index.get(s.id) && stageKey(def, steps[index.get(w.from.step)]) === stageKey(def, s));
    depth.set(s.id, Math.max(-1, ...ins.map((w) => depth.get(w.from.step) ?? 0)) + 1);
  }
  const out = new Map();
  let x = BAND.pad;
  for (const key of order) {
    const members = steps.filter((s) => stageKey(def, s) === key);
    const cols = new Map();
    let maxDepth = 0;
    for (const s of members) {
      if (!force && !piled && placed(s)) continue;
      const d = depth.get(s.id) ?? 0; maxDepth = Math.max(maxDepth, d);
      const y = cols.get(d) ?? BAND.top + 8;
      out.set(s.id, { x: snap(x + BAND.pad + d * (NODE.w + BAND.gapX)), y: snap(y) });
      cols.set(d, y + nodeHeight(moduleOf(s, byKey)) + BAND.gapY);
    }
    const width = members.length ? (maxDepth + 1) * NODE.w + maxDepth * BAND.gapX + BAND.pad * 2 : BAND.minW;
    x += Math.max(BAND.minW, width) + BAND.gap;
  }
  return { ...def, steps: steps.map((s) => out.has(s.id) ? { ...s, pos: out.get(s.id) } : s) };
}

const NONE = "";
function stageKey(def, s) { return s?.stage && def.stages.some((g) => g.key === s.stage) ? s.stage : NONE; }
function stageOrder(def) {
  const keys = def.stages.map((g) => g.key);
  return def.steps.some((s) => stageKey(def, s) === NONE) ? [NONE, ...keys] : keys;
}

/** The stage bands as drawn: one per stage in order, as wide as its steps (an empty stage keeps a place to drop into),
 *  all as tall as the tallest. Steps without a stage get a band of their own first, when there are any. */
export function bands(def, byKey) {
  if (!def.stages.length) return [];
  const rows = stageOrder(def).map((key) => {
    const members = def.steps.filter((s) => stageKey(def, s) === key && s.pos);
    const label = key === NONE ? "No stage" : def.stages.find((g) => g.key === key)?.label ?? key;
    if (!members.length) return { key, label, x: null, w: BAND.minW, steps: 0 };
    const x0 = Math.min(...members.map((s) => s.pos.x)) - BAND.pad, x1 = Math.max(...members.map((s) => s.pos.x + NODE.w)) + BAND.pad;
    return { key, label, x: x0, w: Math.max(BAND.minW, x1 - x0), steps: members.length };
  });
  // Empty bands sit right after the band before them.
  let edge = BAND.pad;
  for (const b of rows) { if (b.x === null) b.x = edge; edge = b.x + b.w + BAND.gap; }
  const ys = def.steps.filter((s) => s.pos).map((s) => s.pos.y), bottoms = def.steps.filter((s) => s.pos).map((s) => s.pos.y + nodeHeight(moduleOf(s, byKey)));
  const y = Math.min(0, ...ys.map((v) => v - BAND.top)), h = Math.max(420, ...bottoms.map((v) => v + BAND.pad + 40)) - y;
  return rows.map((b) => ({ ...b, y, h }));
}

/** The band under a point (by x), for a step dropped there. */
export function bandAt(list, x) {
  return list.find((b) => x >= b.x && x <= b.x + b.w)?.key ?? null;
}

/** The box that holds every step and band, for fit and the minimap. */
export function extent(def, byKey, bandList = bands(def, byKey)) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of def.steps) if (s.pos) { x0 = Math.min(x0, s.pos.x); y0 = Math.min(y0, s.pos.y); x1 = Math.max(x1, s.pos.x + NODE.w); y1 = Math.max(y1, s.pos.y + nodeHeight(moduleOf(s, byKey))); }
  for (const b of bandList) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 800, h: 480 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A zoom and offset that shows the whole box in a view of the given size (never closer than 1). */
export function fitView(box, view, margin = 40) {
  const k = Math.max(0.25, Math.min(1, (view.w - margin * 2) / box.w, (view.h - margin * 2) / box.h));
  return { k, x: (view.w - box.w * k) / 2 - box.x * k, y: Math.max(margin, (view.h - box.h * k) / 2) - box.y * k };
}

/** A free spot near a point for a new step (nudged down past any card there). */
export function freeSpot(def, byKey, at) {
  let y = snap(at.y);
  const busy = (yy) => def.steps.some((s) => s.pos && Math.abs(s.pos.x - at.x) < NODE.w - 20 && yy < s.pos.y + nodeHeight(moduleOf(s, byKey)) + 8 && s.pos.y < yy + 90);
  for (let i = 0; i < 80 && busy(y); i++) y += 24;
  return { x: snap(at.x), y };
}

/** A new step id not yet used in the definition. */
export function newId(def, base = "s") {
  const used = new Set(def.steps.map((s) => s.id));
  for (let i = def.steps.length + 1; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}
