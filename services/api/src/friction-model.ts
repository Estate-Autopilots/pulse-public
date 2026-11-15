// BUGKIT-TELEMETRY (owner, 6 Nov 2026): the pure half of Insights → App friction (friction.ts): the funnels and how a
// session moves through one, the share lost at each step, heatmap points, and the bug task a friction alert becomes.
// Nothing here touches the database.

export type FunnelEvent = { kind: string; name: string | null; page: string | null };
/** One step: any of `kinds`, and (when given) a name or page matching the pattern (case-insensitive; the same source is
 *  used in SQL as a prefilter, so keep it to plain alternations). */
export type FunnelStep = { label: string; kinds: string[]; name?: string; page?: string };
export type Funnel = { key: string; label: string; steps: FunnelStep[] };

export const FUNNELS: Funnel[] = [
  { key: "checkin", label: "Sign in → check in", steps: [
    { label: "Opened Pulse", kinds: ["app.session", "nav.load", "nav.route"], page: "^/login" },
    { label: "Checked in", kinds: ["ui.click", "ui.submit"], name: "check.?in" },
  ] },
  { key: "task", label: "New task → done", steps: [
    { label: "Started a new task", kinds: ["ui.click", "ui.dialog.open"], name: "new task|task" },
    { label: "Saved it", kinds: ["ui.submit", "ui.click"], name: "create|save|add task" },
    { label: "Marked it done", kinds: ["ui.click", "ui.submit"], name: "done|complete" },
  ] },
];
// "Opened Pulse": a fresh session (app.session) counts on its own; a page view counts only on a sign-in page.
const ALWAYS = new Set(["app.session"]);

const re = (source: string | undefined) => (source ? new RegExp(source, "i") : null);

/** Whether one event is this step. */
export function matchStep(step: FunnelStep, e: FunnelEvent): boolean {
  if (!step.kinds.includes(e.kind)) return false;
  if (ALWAYS.has(e.kind)) return true;
  const name = re(step.name), page = re(step.page);
  if (name && !name.test(e.name ?? "")) return false;
  if (page && !page.test(e.page ?? "") && !page.test(e.name ?? "")) return false;
  return true;
}

/** How many steps a session reached, in order (events oldest first). */
export function reached(steps: FunnelStep[], events: FunnelEvent[]): number {
  let i = 0;
  for (const e of events) { if (i < steps.length && matchStep(steps[i], e)) i++; if (i === steps.length) break; }
  return i;
}

export type FunnelResult = { key: string; label: string; steps: { label: string; sessions: number; dropPct: number | null }[] };

/** Each funnel's sessions per step and the share lost since the step before. */
export function funnelCounts(funnels: Funnel[], sessions: Map<string, FunnelEvent[]>): FunnelResult[] {
  return funnels.map((f) => {
    const counts = f.steps.map(() => 0);
    for (const events of sessions.values()) { const n = reached(f.steps, events); for (let i = 0; i < n; i++) counts[i]++; }
    return { key: f.key, label: f.label, steps: f.steps.map((s, i) => ({ label: s.label, sessions: counts[i], dropPct: i === 0 ? null : dropPct(counts[i - 1], counts[i]) })) };
  });
}

/** The share lost between two steps, in whole percent (null when nobody reached the first). */
export function dropPct(before: number, after: number): number | null {
  if (!before) return null;
  return Math.round(Math.max(0, before - after) / before * 100);
}

/** Every kind and pattern the funnels need, for a SQL prefilter: kinds, and a name/page regex. */
export function funnelPrefilter(funnels: Funnel[] = FUNNELS): { kinds: string[]; pattern: string } {
  const kinds = [...new Set(funnels.flatMap((f) => f.steps.flatMap((s) => s.kinds)))];
  const parts = [...new Set(funnels.flatMap((f) => f.steps.flatMap((s) => [s.name, s.page]).filter((x): x is string => !!x)))];
  return { kinds, pattern: parts.map((p) => `(${p})`).join("|") };
}

export type HeatPoint = { fx: number; fy: number; kind: "click" | "rage" | "dead" };
/** Rows of {kind, fx, fy} as heatmap points: fractions of the viewport, 0 to 1, three decimals; anything else dropped. */
export function heatPoints(rows: { kind: string; fx: unknown; fy: unknown }[], max = 2000): HeatPoint[] {
  const out: HeatPoint[] = [];
  for (const r of rows) {
    if (out.length >= max) break;
    if (r.fx === null || r.fx === undefined || r.fx === "" || r.fy === null || r.fy === undefined || r.fy === "") continue;
    const fx = Number(r.fx), fy = Number(r.fy);
    if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx < 0 || fx > 1 || fy < 0 || fy > 1) continue;
    const kind = r.kind === "ui.rage" ? "rage" : r.kind === "ui.dead" ? "dead" : r.kind === "ui.click" ? "click" : null;
    if (kind) out.push({ fx: Math.round(fx * 1000) / 1000, fy: Math.round(fy * 1000) / 1000, kind });
  }
  return out;
}

export const ALERT_WORDS: Record<string, string> = {
  rage: "Rage clicks (3 or more fast clicks on one spot)", dead: "Dead clicks (nothing happened)", error: "Script errors",
  abandon: "Forms started and left", stuck: "Idle on a form with errors", back: "Going back and forth",
};
export type AlertRow = { id: string; kind: string; route: string; target: string; label: string | null; hits: number; people: number; sample_session: string | null };

/** The Pulse task a friction alert becomes. */
export function alertTask(a: AlertRow, projectId: string | null) {
  const what = ALERT_WORDS[a.kind] ?? a.kind;
  const where = a.label || a.target ? ` (${(a.label || a.target).slice(0, 60)})` : "";
  const notes = [
    `Pulse noticed people getting stuck before anyone reported it: ${what.toLowerCase()} on ${a.route}${where}.`,
    `${a.hits} times, by ${a.people} ${a.people === 1 ? "person" : "people"}, in the last 7 days.`,
    `Details: /insights?tab=friction&alert=${a.id}`,
    ...(a.sample_session ? [`Watch a replay: /telemetry/replay/${a.sample_session}`] : []),
  ].join("\n");
  return { title: `Friction: ${what.split(" (")[0].toLowerCase()} on ${a.route}`.slice(0, 140), notes, priority: "normal", ...(projectId ? { projectId } : {}) };
}

/** "/hr?tab" → "hr": the feature a screen belongs to (its first path segment). */
export const featureOf = (page: string | null | undefined) => (page ?? "").split("?")[0].split("/").filter(Boolean)[0] ?? "home";
