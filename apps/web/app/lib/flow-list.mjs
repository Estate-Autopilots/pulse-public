// FLOW-D (owner, 21 Oct 2026: "creating is hard"): a process as a vertical flow, like an automation list. Steps run top
// to bottom; steps side by side run at the same time; after a Decide each way has its own steps. The order lives in the
// wires that open a step ("Starts after", or a required need of an older step), so the list and the Map are one
// definition. Pure, so it is tested alone (flow-list.test.mjs).
import { moduleOf } from "./flow-canvas.mjs";

/** Does this wire decide when its step opens? A block step waits on "in"; an older step on a required need. */
export function isGate(def, byKey, w) {
  const b = def.steps.find((s) => s.id === w.to.step); if (!b || !def.steps.some((s) => s.id === w.from.step)) return false;
  if (b.block) return w.to.port === "in";
  const need = (byKey[b.module]?.needs ?? []).find((n) => n.key === w.to.port);
  return !!need && need.required !== false;
}
export const gates = (def, byKey) => def.wires.filter((w) => isGate(def, byKey, w));

/** How deep each step sits: the longest chain of steps before it (loops are cut). */
export function ranks(def, byKey) {
  const ins = new Map(def.steps.map((s) => [s.id, []]));
  for (const w of gates(def, byKey)) ins.get(w.to.step)?.push(w.from.step);
  const rank = new Map(), busy = new Set();
  const of = (id) => {
    if (rank.has(id)) return rank.get(id);
    if (busy.has(id)) return 0;
    busy.add(id); let r = 0;
    for (const p of ins.get(id) ?? []) r = Math.max(r, of(p) + 1);
    busy.delete(id); rank.set(id, r); return r;
  };
  for (const s of def.steps) of(s.id);
  return rank;
}

/** The list: each stage (in order, then steps without one) with its rows; a row's steps run side by side. */
export function rows(def, byKey) {
  const rank = ranks(def, byKey), order = new Map(def.steps.map((s, i) => [s.id, i]));
  const known = new Set(def.stages.map((g) => g.key));
  const groups = [...def.stages.map((g) => ({ key: g.key, label: g.label, steps: def.steps.filter((s) => s.stage === g.key) })),
    { key: "", label: def.stages.length ? "Not in a stage" : "Steps", steps: def.steps.filter((s) => !s.stage || !known.has(s.stage)) }];
  return groups.filter((g) => g.key || g.steps.length).map((g) => {
    const byRank = new Map();
    for (const s of g.steps) { const r = rank.get(s.id) ?? 0; byRank.set(r, [...(byRank.get(r) ?? []), s]); }
    return { key: g.key, label: g.label, rows: [...byRank.entries()].sort((a, z) => a[0] - z[0]).map(([, list]) => list.sort((a, z) => order.get(a.id) - order.get(z.id))) };
  });
}

/** Which way of a Decide a step hangs off ("Yes", "Otherwise"), if any. */
export function wayOf(def, byKey, id) {
  for (const w of gates(def, byKey)) {
    if (w.to.step !== id) continue;
    const d = def.steps.find((s) => s.id === w.from.step);
    if (d && (d.block === "decide" || d.module === "decision")) return { decide: d.id, port: w.from.port, label: moduleOf(d, byKey).makes.find((p) => p.key === w.from.port)?.label ?? w.from.port };
  }
  return null;
}

/** The steps before a step (all of them, by the wires that open it). */
export function before(def, byKey, id) {
  const ins = new Map(); for (const w of gates(def, byKey)) ins.set(w.to.step, [...(ins.get(w.to.step) ?? []), w.from.step]);
  const seen = new Set(), todo = [...(ins.get(id) ?? [])];
  while (todo.length) { const x = todo.pop(); if (seen.has(x)) continue; seen.add(x); todo.push(...(ins.get(x) ?? [])); }
  seen.delete(id); return seen;
}

const same = (a, b) => a.from.step === b.from.step && a.from.port === b.from.port && a.to.step === b.to.step && a.to.port === b.to.port;
const add = (list, w) => (list.some((x) => same(x, w)) ? list : [...list, w]);
const outOf = (step, byKey) => moduleOf(step, byKey).makes[0]?.key ?? null;
const opens = (step) => !!step.block && step.block !== "start";

/** A new step after `aId` (on one way of a Decide when `port` is given): it waits for that step, and what waited for it
 *  waits for the new one instead (a block step's "Starts after"; an older step's typed needs are left as they are). */
export function insertAfter(def, byKey, aId, step, port = null) {
  const a = def.steps.find((s) => s.id === aId); if (!a) return { ...def, steps: [...def.steps, step] };
  const out = port ?? outOf(a, byKey), next = outOf(step, byKey);
  let wires = def.wires.map((w) => {
    if (w.from.step !== aId || (port && w.from.port !== port) || !isGate(def, byKey, w) || !next) return w;
    const b = def.steps.find((s) => s.id === w.to.step);
    return b?.block ? { ...w, from: { step: step.id, port: next } } : w;
  });
  wires = wires.filter((w, i) => wires.findIndex((x) => same(x, w)) === i);
  if (out && opens(step)) wires = add(wires, { from: { step: aId, port: out }, to: { step: step.id, port: "in" } });
  return { ...def, steps: [...def.steps, { ...step, stage: step.stage ?? a.stage ?? null }], wires };
}

/** A new step beside `aId`: it waits for what that step waits for, and what waits for that step waits for it too. */
export function addBeside(def, byKey, aId, step) {
  const a = def.steps.find((s) => s.id === aId); if (!a) return { ...def, steps: [...def.steps, step] };
  const next = outOf(step, byKey); let wires = def.wires;
  for (const w of gates(def, byKey)) {
    if (w.to.step === aId && opens(step)) wires = add(wires, { from: w.from, to: { step: step.id, port: "in" } });
    if (w.from.step === aId && next) { const b = def.steps.find((s) => s.id === w.to.step); if (b?.block) wires = add(wires, { from: { step: step.id, port: next }, to: w.to }); }
  }
  return { ...def, steps: [...def.steps, { ...step, stage: step.stage ?? a.stage ?? null }], wires };
}

/** The steps a stage ends with (none of its own steps comes after them); an empty stage: the last steps before it. */
export function stageEnds(def, byKey, stageKey) {
  const list = rows(def, byKey); const i = list.findIndex((g) => g.key === (stageKey ?? ""));
  for (let j = i; j >= 0; j--) { const g = list[j]; if (g.rows.length) return g.rows[g.rows.length - 1]; }
  return [];
}

/** A new step at the end of a stage: after the steps it ends with; later steps that waited for those wait for it. */
export function appendTo(def, byKey, stageKey, step) {
  const ends = stageEnds(def, byKey, stageKey), endIds = new Set(ends.map((s) => s.id));
  const next = outOf(step, byKey); const mine = new Set(def.steps.filter((s) => (s.stage ?? "") === (stageKey ?? "")).map((s) => s.id));
  let wires = def.wires;
  if (next && ends.length) {
    wires = wires.map((w) => (endIds.has(w.from.step) && !mine.has(w.to.step) && isGate(def, byKey, w) && def.steps.find((s) => s.id === w.to.step)?.block ? { ...w, from: { step: step.id, port: next } } : w));
    wires = wires.filter((w, i) => wires.findIndex((x) => same(x, w)) === i);
  }
  if (opens(step)) for (const e of ends) {
    const m = moduleOf(e, byKey).makes;
    // After a Decide, either way: the new step waits on both (the way not taken does not hold it up).
    for (const p of e.block === "decide" || e.module === "decision" ? m : m.slice(0, 1)) wires = add(wires, { from: { step: e.id, port: p.key }, to: { step: step.id, port: "in" } });
  }
  return { ...def, steps: [...def.steps, { ...step, stage: stageKey || null }], wires };
}

/** Take a step out: what waited for it waits for what came before it instead, so the order holds. */
export function removeStep(def, byKey, id) {
  const g = gates(def, byKey), ins = g.filter((w) => w.to.step === id), outs = g.filter((w) => w.from.step === id);
  let wires = def.wires.filter((w) => w.from.step !== id && w.to.step !== id);
  for (const i of ins) for (const o of outs) wires = add(wires, { from: i.from, to: o.to });
  return { ...def, steps: def.steps.filter((s) => s.id !== id), wires };
}

/** Move a step up or down the list: it trades places with the step it waits for (up) or the one waiting for it (down),
 *  when they are one after the other. */
export function swap(def, byKey, id, dir) {
  const g = gates(def, byKey);
  const other = dir === "up" ? g.find((w) => w.to.step === id)?.from.step : g.find((w) => w.from.step === id)?.to.step;
  if (!other) return def;
  const [a, b] = dir === "up" ? [other, id] : [id, other];          // a comes first, then b: after the swap b, then a
  const A = def.steps.find((s) => s.id === a), B = def.steps.find((s) => s.id === b);
  if (!A?.block || !B?.block || A.block === "decide" || B.block === "decide" || B.block === "start" || A.block === "start") return def;
  const aOut = outOf(A, byKey), bOut = outOf(B, byKey); if (!aOut || !bOut) return def;
  const rewired = def.wires.map((w) => {
    if (!isGate(def, byKey, w)) return w;
    if (w.from.step === a && w.to.step === b) return { from: { step: b, port: bOut }, to: { step: a, port: "in" } };
    if (w.to.step === a) return { ...w, to: { step: b, port: "in" } };                  // what opened a opens b
    if (w.from.step === b) return { ...w, from: { step: a, port: aOut } };               // what b opened, a opens
    return w;
  });
  return { ...def, wires: rewired.filter((w, i) => rewired.findIndex((x) => same(x, w)) === i) };
}

/** A new step before `id`: it waits for what that step waited for, and that step waits for it. */
export function insertBefore(def, byKey, id, step) {
  const z = def.steps.find((s) => s.id === id); if (!z) return { ...def, steps: [...def.steps, step] };
  const next = outOf(step, byKey), ins = gates(def, byKey).filter((w) => w.to.step === id);
  let wires = def.wires;
  if (z.block && next) {
    wires = wires.filter((w) => !ins.some((x) => same(x, w)));
    if (opens(step)) for (const w of ins) wires = add(wires, { from: w.from, to: { step: step.id, port: "in" } });
    wires = add(wires, { from: { step: step.id, port: next }, to: { step: id, port: "in" } });
  }
  return { ...def, steps: [...def.steps, { ...step, stage: step.stage ?? z.stage ?? null }], wires };
}

/** A new step after a whole row (the steps side by side): it waits for all of them; what waited for them waits for it. */
export function insertAfterRow(def, byKey, ids, step) {
  if (ids.length === 1) return insertAfter(def, byKey, ids[0], step);
  const set = new Set(ids), next = outOf(step, byKey); let wires = def.wires;
  if (next) { wires = wires.map((w) => (set.has(w.from.step) && !set.has(w.to.step) && isGate(def, byKey, w) && def.steps.find((s) => s.id === w.to.step)?.block ? { ...w, from: { step: step.id, port: next } } : w));
    wires = wires.filter((w, i) => wires.findIndex((x) => same(x, w)) === i); }
  if (opens(step)) for (const id of ids) { const e = def.steps.find((s) => s.id === id); if (!e) continue; const m = moduleOf(e, byKey).makes;
    for (const p of e.block === "decide" || e.module === "decision" ? m : m.slice(0, 1)) wires = add(wires, { from: { step: id, port: p.key }, to: { step: step.id, port: "in" } }); }
  const first = def.steps.find((s) => s.id === ids[0]);
  return { ...def, steps: [...def.steps, { ...step, stage: step.stage ?? first?.stage ?? null }], wires };
}
