// DOREVE-FIX (owner, 17 Nov 2026): "Our telemetry is weak: paths are just page A → page B; we need the full path like a
// video, and we don't analyse the patterns we should." The pure half of GET /api/v0/telemetry/day: one person's day as
// plain steps, the moments they struggled (found automatically), and what was slow for them. Nothing here reads the
// database; telemetry-day.ts passes the rows in. Every rule below was seen in Datup Velupenubo's real sessions
// (Atlas Crest, 4-17 Nov 2026): a circle ticked on a parent task refused 9 times, a page that painted at once and
// then ignored clicks for 23-54 s, the same circle clicked again and again, a 54-second /my-day.

/** One telemetry row as telemetry-day.ts reads it (client rows of one person, oldest first). */
export type DayRow = {
  at: string; sessionId: string | null; kind: string; name: string | null; page: string | null; durationMs: number | null; value: number | null;
  status: number | null; requestId: string | null; platform: string | null; detail: Record<string, unknown> | null;
};
export type Tone = "ok" | "slow" | "fail";
export type Step = { at: string; sessionId: string | null; kind: string; label: string; page: string | null; ms: number | null; tone: Tone; requestId: string | null };
export type StruggleKind = "refused" | "dead_start" | "early_clicks" | "repeat" | "slow" | "freeze" | "error" | "rage" | "dead_click" | "gave_up";
export type Struggle = { at: string; sessionId: string | null; kind: StruggleKind; title: string; detail: string; page: string | null; ms: number | null; requestId: string | null };
export type Slow = { name: string; n: number; p50: number; p90: number; max: number };
export type Day = { steps: Step[]; struggles: Struggle[]; slowPages: Slow[]; slowActions: Slow[];
  totals: { sessions: number; loads: number; moves: number; actions: number; failed: number; struggles: number; activeMs: number } };

/** Thresholds (ms). A click or move is "slow" at SLOW_MS; a page is "dead" when its code started DEAD_MS after the load. */
export const SLOW_MS = 3000;
export const DEAD_MS = 5000;
export const FREEZE_MS = 1000;
export const REPEAT_N = 3, REPEAT_WINDOW_MS = 20_000;
const STEP_KINDS = new Set(["nav.load", "nav.route", "ui.click", "ui.submit", "ui.dialog.open", "ui.early", "ui.rage", "ui.dead", "ui.toast.error", "ui.form.abandon", "nav.backloop", "ui.stuck"]);
// Calls that answer "nothing here" on purpose or are background polls: their 4xx is not a person being refused.
const QUIET_FAIL = /^GET \/api\/v0\/(briefs\/tick|calls|companion|presence|freshness|notices|work\/changed|whats-new)/;

/** What the page was doing when it froze, in plain words (the collector's busy: the action in flight). */
const BUSY: Record<string, string> = { "ui.click": "Right after a click", "ui.submit": "Right after a form was sent", "ui.key": "Right after a key was pressed", "nav.route": "While a page was opening", load: "While the page was loading", idle: "Nothing was being clicked" };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);
const t = (r: { at: string }) => Date.parse(r.at);
const bg = (r: DayRow) => !!r.detail && ("bg" in r.detail);
/** A call's name without the API's prefix ("POST /api/v0/tasks/:id/move" → "POST tasks/:id/move"). */
export const call = (name: string | null) => (name ?? "A call").replace(/^(\w+) \/api\/v\d+\//, "$1 ");
// A number and its unit never break apart on a narrow screen (a no-break space).
export const secs = (ms: number | null) => (ms === null ? "" : ms < 1000 ? `${Math.round(ms)}\u00a0ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}\u00a0s`);

/** What a click was on, in plain words: the collector's name ("button Mark done", "link /tasks") or, when the element has
 *  no words, what its place says ("a task's circle"). */
export function what(row: Pick<DayRow, "name" | "detail">): string {
  const name = (row.name ?? "").trim(), sel = str(row.detail?.sel) ?? "";
  const words = name.replace(/^(button|link|input|select|textarea|label|tab|menuitem|a|summary)\s*/i, "").trim();
  if (/button\.check$|checkCol>button/.test(sel)) return words && !/^Mark .* done$|^Confirm/.test(words) ? words : "a task's circle";
  if (/^link\s+\//i.test(name)) return `the ${words.replace(/^\//, "").split(/[/?]/)[0] || "home"} link`;
  // A control named "A person: A person" (its label and its value the same) says it once.
  const once = /^(.+): \1$/.exec(words)?.[1] ?? words;
  if (once) return `“${once.length > 48 ? `${once.slice(0, 47)}…` : once}”`;
  if (/stripBtn/.test(sel)) return "the menu";
  const last = sel.split(">").pop()?.split(".").slice(1).join(" ") ?? "";
  return last ? `a ${last.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}` : "something without a label";
}

function stepOf(r: DayRow): Step | null {
  if (!STEP_KINDS.has(r.kind) && !(r.kind === "api" && (r.status ?? 200) >= 400 && !QUIET_FAIL.test(r.name ?? "")) && !(r.kind.startsWith("error.") && r.kind !== "error.stream")
    && !(r.kind === "perf.longtask" && (r.durationMs ?? 0) >= FREEZE_MS)) return null;
  const ms = r.durationMs, fail = num(r.detail?.fail);
  let label: string, tone: Tone = "ok";
  switch (r.kind) {
    case "nav.load": label = `Opened ${r.name ?? r.page ?? "a page"}`; break;
    case "nav.route": label = `Went to ${r.name ?? r.page ?? "a page"}${str(r.detail?.from) ? ` from ${str(r.detail?.from)}` : ""}`; break;
    case "ui.click": label = `Clicked ${what(r)}`; break;
    case "ui.submit": label = `Sent a form${str(r.detail?.via) ? ` (${str(r.detail?.via)?.replace(/^button\s*/i, "")})` : ""}`; break;
    case "ui.dialog.open": label = `A window opened: ${r.name ?? ""}`.trim(); break;
    case "ui.early": label = `Clicked ${num(r.value) ?? 1} time(s) before the page was ready`; tone = "fail"; break;
    case "ui.rage": label = `Clicked ${what(r)} many times fast`; tone = "fail"; break;
    case "ui.dead": label = `Clicked ${what(r)}; nothing happened`; tone = "fail"; break;
    case "ui.toast.error": label = `Saw an error: ${r.name ?? ""}`.trim(); tone = "fail"; break;
    case "ui.form.abandon": label = `Left a form unfinished${r.name ? ` (${r.name})` : ""}`; tone = "slow"; break;
    case "nav.backloop": label = "Went back and forth between pages"; tone = "slow"; break;
    case "ui.stuck": label = "Sat on a form with errors"; tone = "slow"; break;
    case "perf.longtask": label = `The page froze for ${secs(ms)}`; tone = "slow"; break;
    case "api": label = `${call(r.name)} refused (${r.status})`; tone = "fail"; break;
    default: label = `Error: ${r.name ?? r.kind}`; tone = "fail";
  }
  if (fail !== null) { label += fail ? " · refused" : " · no answer"; tone = "fail"; }
  else if (tone === "ok" && ms !== null && ms >= SLOW_MS && !bg(r) && r.kind !== "ui.dialog.open") tone = "slow";
  return { at: r.at, sessionId: r.sessionId, kind: r.kind, label, page: r.page, ms: r.kind === "ui.dialog.open" ? null : ms, tone, requestId: r.requestId };
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : 0; };
function slowest(groups: Map<string, number[]>, top = 8): Slow[] {
  return [...groups].map(([name, xs]) => ({ name, n: xs.length, p50: pct(xs, 0.5), p90: pct(xs, 0.9), max: Math.max(...xs) }))
    .sort((a, b) => b.p90 - a.p90 || b.n - a.n).slice(0, top);
}

/** The day: steps, struggles, slowness and totals from one person's client rows (oldest first, one day). */
export function buildDay(rows: DayRow[]): Day {
  const steps: Step[] = [], struggles: Struggle[] = [];
  const pages = new Map<string, number[]>(), actions = new Map<string, number[]>();
  const sessions = new Set<string>();
  let loads = 0, moves = 0, acts = 0, failed = 0, activeMs = 0;
  const add = (s: Struggle) => { if (!struggles.some((x) => x.kind === s.kind && x.sessionId === s.sessionId && Math.abs(t(x) - t(s)) < 2000)) struggles.push(s); };
  const bySession = new Map<string, DayRow[]>();
  for (const r of rows) { const k = r.sessionId ?? "-"; if (!bySession.has(k)) bySession.set(k, []); bySession.get(k)!.push(r); }

  for (const r of rows) {
    if (r.sessionId) sessions.add(r.sessionId);
    const s = stepOf(r); if (s) steps.push(s);
    const ms = r.durationMs;
    if (r.kind === "nav.leave") activeMs += num(r.detail?.act) ?? 0;
    if ((r.kind === "nav.load" || r.kind === "nav.route") && ms !== null && !bg(r)) { (r.kind === "nav.load" ? loads++ : moves++); const k = r.name ?? r.page ?? "?"; pages.set(k, [...(pages.get(k) ?? []), ms]); }
    if ((r.kind === "ui.click" || r.kind === "ui.submit") && ms !== null && !bg(r)) { acts++; const k = `${what(r)} on ${r.page ?? "?"}`; actions.set(k, [...(actions.get(k) ?? []), ms]); }
    if (r.kind === "api" && (r.status ?? 200) >= 400 && !QUIET_FAIL.test(r.name ?? "")) failed++;

    // 1. Refused: an action whose call was refused (detail.fail since DOREVE-FIX; before it, a failed call made during
    //    the action, joined by session and time).
    if ((r.kind === "ui.click" || r.kind === "ui.submit") && num(r.detail?.fail) !== null)
      add({ at: r.at, sessionId: r.sessionId, kind: "refused", title: `Clicked ${what(r)}; it was refused`, detail: `${call(str(r.detail?.failed))} answered ${num(r.detail?.fail) || "nothing"}`, page: r.page, ms, requestId: r.requestId });
    if (r.kind === "api" && (r.status ?? 200) >= 400 && (str(r.detail?.during) === "ui.click" || str(r.detail?.during) === "ui.submit") && !QUIET_FAIL.test(r.name ?? "")) {
      const own = bySession.get(r.sessionId ?? "-") ?? [];
      const click = [...own].reverse().find((x) => (x.kind === "ui.click" || x.kind === "ui.submit") && t(x) <= t(r) + 50 && t(r) - t(x) < 10_000);
      add({ at: click?.at ?? r.at, sessionId: r.sessionId, kind: "refused", title: `${click ? `Clicked ${what(click)}` : "An action"}; it was refused`,
        detail: `${call(r.name)} answered ${r.status}`, page: r.page, ms: click?.durationMs ?? ms, requestId: r.requestId });
    }
    // 2. A page that painted but did nothing: the load timed out waiting, or the app's first call came DEAD_MS later.
    if (r.kind === "nav.load" && !bg(r)) {
      const own = bySession.get(r.sessionId ?? "-") ?? [];
      const firstCall = own.find((x) => x.kind === "api" && t(x) >= t(r) - 2000);
      const gap = firstCall ? t(firstCall) - t(r) : null;
      const paint = num(r.detail?.paint), lcp = own.find((x) => x.kind === "vital.lcp" && Math.abs(t(x) - t(r)) < 2000)?.durationMs ?? null;
      if ((gap !== null && gap >= DEAD_MS) || (str(r.detail?.cut) === "timeout" && (ms ?? 0) >= DEAD_MS))
        add({ at: r.at, sessionId: r.sessionId, kind: "dead_start", title: `${r.name ?? "A page"} looked ready but did not respond for ${secs(gap ?? ms)}`,
          detail: `It appeared in ${secs(lcp ?? paint)}, but clicks did nothing for ${secs(gap ?? ms)}`, page: r.page, ms: gap ?? ms, requestId: r.requestId });
    }
    if (r.kind === "ui.early" && (ms ?? 0) >= 1000)
      add({ at: r.at, sessionId: r.sessionId, kind: "early_clicks", title: `Clicked ${num(r.value) ?? 1} time(s) while ${r.page ?? "the page"} was still starting`, detail: `The first click waited ${secs(ms)}`, page: r.page, ms, requestId: null });
    // 3. Slow: an action or move that took SLOW_MS or more in front of the person.
    if ((r.kind === "ui.click" || r.kind === "ui.submit" || r.kind === "nav.route") && (ms ?? 0) >= SLOW_MS && !bg(r))
      add({ at: r.at, sessionId: r.sessionId, kind: "slow", title: r.kind === "nav.route" ? `Waited ${secs(ms)} for ${r.name ?? "a page"}` : `Waited ${secs(ms)} after clicking ${what(r)}`,
        detail: str(r.detail?.pending) ? `Still loading: ${str(r.detail?.pending)}` : str(r.detail?.wait) ? `Waiting on: ${str(r.detail?.wait)}` : "", page: r.page, ms, requestId: r.requestId });
    // 4. A freeze: the page's main thread busy for FREEZE_MS or more.
    if (r.kind === "perf.longtask" && (ms ?? 0) >= FREEZE_MS)
      add({ at: r.at, sessionId: r.sessionId, kind: "freeze", title: `${r.page ?? "The page"} froze for ${secs(ms)}`, detail: BUSY[str(r.detail?.busy) ?? ""] ?? "", page: r.page, ms, requestId: null });
    if (r.kind === "ui.rage") add({ at: r.at, sessionId: r.sessionId, kind: "rage", title: `Clicked ${what(r)} many times fast`, detail: "", page: r.page, ms: null, requestId: null });
    if (r.kind === "ui.dead") add({ at: r.at, sessionId: r.sessionId, kind: "dead_click", title: `Clicked ${what(r)} and nothing happened`, detail: "", page: r.page, ms: null, requestId: null });
    if (r.kind === "ui.toast.error") add({ at: r.at, sessionId: r.sessionId, kind: "error", title: `Saw an error${r.name ? `: ${r.name}` : ""}`, detail: "", page: r.page, ms: null, requestId: null });
    if (r.kind === "error.js" || r.kind === "error.promise" || r.kind === "error.screen")
      add({ at: r.at, sessionId: r.sessionId, kind: "error", title: `The page hit an error${str(r.detail?.component) ? ` in ${str(r.detail?.component)}` : ""}`, detail: r.name ?? "", page: r.page, ms: null, requestId: r.requestId });
    if (r.kind === "ui.form.abandon") add({ at: r.at, sessionId: r.sessionId, kind: "gave_up", title: `Left ${r.name ?? "a form"} unfinished`, detail: "", page: r.page, ms: null, requestId: null });
  }
  // 5. The same thing clicked REPEAT_N times or more within REPEAT_WINDOW_MS, without leaving the page, and without any of
  //    those clicks being answered (a change the server took): ticking eleven different tasks in a row is work, not a
  //    struggle. Where the click's place is known (fx/fy), only clicks on the same spot count as the same thing.
  const near = (a: DayRow, b: DayRow) => { const ax = num(a.detail?.fx), ay = num(a.detail?.fy), bx = num(b.detail?.fx), by = num(b.detail?.fy);
    return ax === null || ay === null || bx === null || by === null || (ax === 0 && ay === 0) || (bx === 0 && by === 0) || (Math.abs(ax - bx) < 0.02 && Math.abs(ay - by) < 0.02); };
  for (const own of bySession.values()) {
    const clicks = own.filter((r) => r.kind === "ui.click");
    const answered = (c: DayRow) => num(c.detail?.fail) === null && own.some((r) => r.kind === "api" && (r.status ?? 0) >= 200 && (r.status ?? 0) < 400 && !/^GET /.test(r.name ?? "")
      && str(r.detail?.during) === "ui.click" && t(r) >= t(c) - 50 && t(r) - t(c) < 3000);
    for (let i = 0; i < clicks.length; i++) {
      const key = `${what(clicks[i])}|${clicks[i].page}`;
      const run = [clicks[i]];
      for (let j = i + 1; j < clicks.length && t(clicks[j]) - t(clicks[i]) <= REPEAT_WINDOW_MS; j++) if (`${what(clicks[j])}|${clicks[j].page}` === key && near(clicks[i], clicks[j])) run.push(clicks[j]);
      if (run.some(answered)) continue;
      const moved = own.some((r) => r.kind === "nav.route" && t(r) > t(clicks[i]) && t(r) < t(run[run.length - 1]));
      if (run.length >= REPEAT_N && !moved && !struggles.some((s) => s.kind === "repeat" && s.sessionId === clicks[i].sessionId && t(s) <= t(clicks[i]) && t(clicks[i]) - t(s) <= REPEAT_WINDOW_MS)) {
        const span = t(run[run.length - 1]) - t(run[0]);
        add({ at: run[0].at, sessionId: run[0].sessionId, kind: "repeat", title: `Clicked ${what(run[0])} ${run.length} times in ${secs(span)}`, detail: "The same thing again and again: it may not have answered", page: run[0].page, ms: span, requestId: null });
      }
    }
  }
  struggles.sort((a, b) => t(a) - t(b));
  return { steps, struggles, slowPages: slowest(pages), slowActions: slowest(actions),
    totals: { sessions: sessions.size, loads, moves, actions: acts, failed, struggles: struggles.length, activeMs } };
}
