// TOKENS-TELEMETRY (owner, 17 Nov 2026: "Telemetry is becoming stupider. The flows, graphs and data that can be visualised
// and collected properly are not there."): the pure half of GET /api/v0/telemetry/story. telemetry-story.ts reads rows
// from the database; these functions shape them for charts (journey map, funnels, speed and struggle over time) and
// write the "what got better / what got worse" digest. Pure, so they are tested on their own (telemetry-story.test.mjs).

/** One page view of a session, in order (nav.load or nav.route), as telemetry-story.ts reads it. */
export type View = { s: string; page: string };
export type Journey = { nodes: { name: string; step: number; page: string; views: number }[]; links: { source: string; target: string; value: number }[]; sessions: number };

/** Pages a person opens, cut to the template (/tasks/:id) and without the query's noise (tab= kept: it is a place). */
export function placeOf(page: string): string {
  const [path, query = ""] = String(page ?? "").split("?");
  const tab = new URLSearchParams(query).get("tab");
  const p = (path || "/").replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, "/:id").replace(/\/\d+(?=\/|$)/g, "/:id");
  return tab && /^[a-z-]{2,30}$/.test(tab) ? `${p}?tab=${tab}` : p;
}

/** The journey map: each session's first `steps` places (a place opened twice in a row counts once), step by step, the
 *  `top` most common places per step (the rest "Other"), and "Left" where sessions ended. Acyclic by construction (a
 *  node is a place at a step), so a Sankey can draw it. */
export function journeys(views: View[], { steps = 4, top = 6 } = {}): Journey {
  const bySession = new Map<string, string[]>();
  for (const v of views) {
    const list = bySession.get(v.s) ?? [];
    const place = placeOf(v.page);
    if (list[list.length - 1] !== place) list.push(place);
    bySession.set(v.s, list);
  }
  const paths = [...bySession.values()].filter((p) => p.length).map((p) => p.slice(0, steps));
  const keep: Set<string>[] = [];
  for (let i = 0; i < steps; i++) {
    const n = new Map<string, number>();
    for (const p of paths) if (p[i]) n.set(p[i], (n.get(p[i]) ?? 0) + 1);
    keep.push(new Set([...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top).map(([k]) => k)));
  }
  const label = (i: number, place: string) => `${i + 1} · ${keep[i].has(place) ? place : "Other"}`;
  const nodes = new Map<string, { name: string; step: number; page: string; views: number }>();
  const links = new Map<string, { source: string; target: string; value: number }>();
  const node = (name: string, step: number, page: string) => { const x = nodes.get(name) ?? { name, step, page, views: 0 }; x.views += 1; nodes.set(name, x); };
  for (const p of paths) {
    for (let i = 0; i < p.length; i++) {
      const here = label(i, p[i]);
      node(here, i, keep[i].has(p[i]) ? p[i] : "Other");
      const next = i + 1 < p.length ? label(i + 1, p[i + 1]) : i + 1 < steps ? `${i + 2} · Left` : null;
      if (!next) continue;
      if (next.endsWith("· Left")) node(next, i + 1, "Left");
      const k = `${here}→${next}`;
      const l = links.get(k) ?? { source: here, target: next, value: 0 };
      l.value += 1; links.set(k, l);
    }
  }
  return { nodes: [...nodes.values()].sort((a, b) => a.step - b.step || b.views - a.views), links: [...links.values()].sort((a, b) => b.value - a.value), sessions: paths.length };
}

/** A step of a funnel: matches one telemetry row of a session. */
export type Step = { label: string; kind: string; name?: RegExp; page?: RegExp; ok?: boolean };
export type Row = { s: string; t: number; kind: string; name: string; page: string; status: number | null };
/** The key jobs: what a person does, in order, within one session (each step within 30 minutes of the one before). */
export const FUNNELS: { key: string; label: string; steps: Step[] }[] = [
  { key: "task", label: "Create a task", steps: [
    { label: "Opened New task", kind: "ui.dialog.open", name: /^New task$/ },
    { label: "Task saved", kind: "api", name: /^POST \/api\/v0\/work\/tasks$/, ok: true }] },
  { key: "document", label: "Quote or invoice", steps: [
    { label: "Opened Billing", kind: "nav", page: /^\/erp(\/new|\/documents)?(\?|$)/ },
    { label: "Draft made", kind: "api", name: /^POST \/api\/v0\/erp\/documents$/, ok: true },
    { label: "Saved", kind: "api", name: /^POST \/api\/v0\/erp\/documents\/:id$/, ok: true }] },
  { key: "checkin", label: "Check in", steps: [
    { label: "Opened attendance", kind: "any", name: /^(Today.s attendance|\/me\?tab=attendance)$/ },
    { label: "Checked in", kind: "api", name: /^POST \/api\/v0\/attendance\/check-in$/, ok: true }] },
];
const matches = (st: Step, r: Row) => {
  const kindOk = st.kind === "any" ? true : st.kind === "nav" ? r.kind === "nav.load" || r.kind === "nav.route" : r.kind === st.kind;
  if (!kindOk) return false;
  if (st.name && !st.name.test(st.kind === "nav" ? r.page : r.name) && !(st.kind === "any" && st.name.test(r.page))) return false;
  if (st.page && !st.page.test(r.kind.startsWith("nav.") ? r.name : r.page)) return false;
  if (st.ok && !(r.status !== null && r.status < 400)) return false;
  return true;
};
/** Sessions that reached each step in order (rows of one session sorted by time). */
export function funnel(rows: Row[], steps: Step[], windowMs = 30 * 60000) {
  const reached = steps.map(() => 0);
  const bySession = new Map<string, Row[]>();
  for (const r of rows) { const l = bySession.get(r.s) ?? []; l.push(r); bySession.set(r.s, l); }
  for (const list of bySession.values()) {
    list.sort((a, b) => a.t - b.t);
    let i = 0, last = -Infinity;
    for (const r of list) {
      if (i >= steps.length) break;
      if (matches(steps[i], r) && (i === 0 || r.t - last <= windowMs)) { reached[i] += 1; last = r.t; i += 1; }
    }
  }
  return steps.map((s, i) => ({ label: s.label, sessions: reached[i], kept: i === 0 || !reached[0] ? null : Math.round((reached[i] / reached[0]) * 100) }));
}

/** One figure for the digest: yesterday against the seven days before (per day, or a percentile). */
export type Figure = { key: string; label: string; unit: "ms" | "count" | "tokens"; now: number | null; before: number | null; lowerIsBetter: boolean; n?: number };
export type DigestLine = Figure & { change: number | null; verdict: "better" | "worse" | "same" | "new" };
/** Better or worse only when the change is real: at least 15% and, for times, 150 ms; enough samples (n >= 5). */
export function digest(figures: Figure[]): DigestLine[] {
  return figures.map((f) => {
    if (f.now === null || f.before === null) return { ...f, change: null, verdict: f.now !== null && f.before === null ? "new" : "same" };
    const change = f.before === 0 ? (f.now === 0 ? 0 : 100) : Math.round(((f.now - f.before) / f.before) * 100);
    const big = Math.abs(change) >= 15 && (f.unit !== "ms" || Math.abs(f.now - f.before) >= 150) && (f.n === undefined || f.n >= 5);
    const up = f.now > f.before;
    return { ...f, change, verdict: !big ? "same" : up === f.lowerIsBetter ? "worse" : "better" };
  });
}
