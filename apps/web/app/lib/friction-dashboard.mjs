// BUGKIT-TELEMETRY (owner, 6 Nov 2026): small pure helpers for Insights → App friction, the replay player and the
// heatmap (insights/friction.tsx, insights/heatmap.tsx, telemetry/replay/player.tsx). No DOM, no network.

/** 320 ms, 1.4 s, 2 min, 3.5 h; a dash for nothing measured. */
export function duration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "–";
  const n = Number(ms);
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`;
  if (n < 3_600_000) return `${Math.round(n / 60_000)} min`;
  return `${(n / 3_600_000).toFixed(1)} h`;
}

/** The share of `part` in `whole`, whole percent (0 when there is no whole). */
export const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** rrweb events from several chunks as one list in time order, without exact repeats (a chunk sent twice). */
export function mergeEvents(chunks) {
  const seen = new Set();
  const out = [];
  for (const list of chunks) for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e.timestamp !== "number" || typeof e.type !== "number") continue;
    const key = `${e.timestamp}:${e.type}:${JSON.stringify(e.data ?? null).length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

/** For a still frame: the events from the last full snapshot's meta event (type 4) on, and the offset (ms from the first
 *  of them) just after that snapshot. Null when there is no full snapshot (type 2). */
export function lastFrame(events) {
  let snap = -1;
  for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === 2) { snap = i; break; }
  if (snap < 0) return null;
  let start = snap;
  for (let i = snap; i >= 0; i--) if (events[i]?.type === 4) { start = i; break; }
  const list = events.slice(start);
  return { events: list, offset: Math.max(0, events[snap].timestamp - list[0].timestamp) + 50 };
}

/** Where ?t=<epoch ms> sits in a replay that starts at `first` and ends at `last` (ms from the start, clamped). */
export function seekOffset(t, first, last) {
  const n = Number(t);
  if (!Number.isFinite(n) || !Number.isFinite(first)) return 0;
  return Math.max(0, Math.min(Math.max(0, last - first), n - first - 3000));
}

/** The colour and name of a heatmap point. */
export const HEAT = { rage: { colour: "#e5484d", label: "Rage clicks" }, dead: { colour: "#f5a524", label: "Dead clicks" }, click: { colour: "#3e63dd", label: "Clicks" } };

/** The scale that fits a w×h frame inside a box, never above 1. */
export const fit = (w, h, boxW, boxH = Infinity) => (w > 0 && h > 0 && boxW > 0 ? Math.min(1, boxW / w, boxH / h) : 1);
