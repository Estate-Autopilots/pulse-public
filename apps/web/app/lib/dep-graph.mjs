// BLOCKERS-MAP (7 Nov 2026): the dependency map's graph sense, kept free of React so node --test checks it.
// An edge runs from the work that blocks (from) to the work that waits on it (to): left to right on the map.

/** @typedef {{ key: string, state: "done" | "active" | "blocked" | "open", minutes?: number, dueOn?: string | null }} GNode */
/** @typedef {{ id: string, from: string, to: string, done?: boolean, type?: string }} GEdge */

/** Everything upstream of `key` (what it waits on, all the way back), not counting `key` itself. */
export function upstream(edges, key) {
  const into = new Map();
  for (const e of edges) into.set(e.to, [...(into.get(e.to) ?? []), e.from]);
  const seen = new Set(); const stack = [key];
  while (stack.length) for (const b of into.get(stack.pop()) ?? []) if (!seen.has(b) && b !== key) { seen.add(b); stack.push(b); }
  return seen;
}

/** Everything downstream of `key` (what waits on it, all the way forward), not counting `key` itself. */
export function downstream(edges, key) {
  return upstream(edges.map((e) => ({ ...e, from: e.to, to: e.from })), key);
}

/** The nodes and edges to show when focused on `key`: "up" = what is blocking it, "down" = what it unblocks, "both". */
export function focusSet(edges, key, mode = "up") {
  const keep = new Set([key]);
  if (mode !== "down") for (const k of upstream(edges, key)) keep.add(k);
  if (mode !== "up") for (const k of downstream(edges, key)) keep.add(k);
  return keep;
}

/** The critical path: the longest chain of unfinished work through unfinished links (each step weighs its minutes, or
 *  one hour when it has no estimate; ties go to the chain that ends soonest). Returns the node keys in order (blocker
 *  first) and the ids of the edges on it. A loop, which the database refuses, is ignored rather than followed. */
export function criticalPath(nodes, edges) {
  const open = new Set(nodes.filter((n) => n.state !== "done").map((n) => n.key));
  const weight = new Map(nodes.map((n) => [n.key, Math.max(1, Number(n.minutes) || 60)]));
  const live = edges.filter((e) => !e.done && open.has(e.from) && open.has(e.to));
  const into = new Map(); const inDeg = new Map([...open].map((k) => [k, 0]));
  for (const e of live) { into.set(e.to, [...(into.get(e.to) ?? []), e]); inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1); }
  // Topological order (Kahn), so every node is scored after everything it waits on.
  const order = []; const deg = new Map(inDeg); const queue = [...open].filter((k) => deg.get(k) === 0);
  const outs = new Map(); for (const e of live) outs.set(e.from, [...(outs.get(e.from) ?? []), e.to]);
  while (queue.length) { const k = queue.shift(); order.push(k); for (const t of outs.get(k) ?? []) { deg.set(t, (deg.get(t) ?? 0) - 1); if (deg.get(t) === 0) queue.push(t); } }
  const best = new Map();
  for (const k of order) {
    let prev = null; let w = 0;
    for (const e of into.get(k) ?? []) { const b = best.get(e.from); if (b && b.w > w) { w = b.w; prev = e; } }
    best.set(k, { w: w + (weight.get(k) ?? 60), prev });
  }
  let end = null; let top = -1;
  for (const [k, b] of best) if (b.w > top) { top = b.w; end = k; }
  const path = []; const ids = [];
  for (let at = end; at; ) { path.unshift(at); const p = best.get(at)?.prev; if (!p) break; ids.unshift(p.id); at = p.from; }
  return path.length > 1 ? { nodes: path, edges: ids } : { nodes: [], edges: [] };
}

/** Work that can start now: not finished, not started, and nothing unfinished in front of it. */
export function readyNow(nodes, edges) {
  const waiting = new Set(edges.filter((e) => !e.done && e.type !== "feeds").map((e) => e.to));
  return nodes.filter((n) => n.state === "open" && !waiting.has(n.key)).map((n) => n.key);
}

/** How many unfinished pieces of work each node still waits on (directly). */
export function waitingCounts(edges) {
  const m = new Map();
  for (const e of edges) if (!e.done && e.type !== "feeds") m.set(e.to, (m.get(e.to) ?? 0) + 1);
  return m;
}
