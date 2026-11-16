"use client";
// GOALS-2 (owner, 8 Nov 2026: "everything has to be visualised so it feels good"): each kind of goal draws itself.
//   money     ₹ actual vs target, a pace marker, the pace chart (actual, the straight line to the target, today's
//             forecast) and the months as tiles;
//   clients   client logos stacking up into empty slots;
//   count     a ring;
//   milestone a checklist.
// Rings fill from 0 and lines draw themselves once, on mount; numbers count up (kit CountUp). Under
// prefers-reduced-motion nothing moves (goals.module.css and the kit). Plain SVG, no chart library; the shapes follow
// the concepts Codex drew for this lane (reports/goals-2/concepts), not any library's code.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Flame } from "lucide-react";
import { Avatar } from "../ui";
import { HelpHint } from "../kit";
import { CountUp } from "../kit/count-up";
import { HEALTH_HELP, amountWords, health, headline, monthBars, paceLine, percent, rupees, shortDate, streak, valueNow, type ScreenGoal } from "../lib/goals.mjs";
import css from "./goals.module.css";

/** True after the first paint, so a ring or bar can move from 0 to its value. */
function useShown() {
  const [shown, setShown] = useState(false);
  useEffect(() => { const f = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(f); }, []);
  return shown;
}

export function Ring({ value, size = 56, stroke = 7, label, children, tone }: { value: number; size?: number; stroke?: number; label: string; children?: ReactNode; tone?: string }) {
  const shown = useShown();
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, value));
  return <span className={css.ring} style={{ width: size, height: size }} role="img" aria-label={label} data-tone={tone}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className={css.ringTrack} />
      <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className={css.ringFill} strokeDasharray={c} strokeDashoffset={shown ? c * (1 - p) : c}
        transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
    {children ? <span className={css.ringText}>{children}</span> : null}
  </span>;
}

/** A bar from 0 to the target with the value now, and a tick where the value should be today. */
export function PaceBar({ value, expected, tone, label, big }: { value: number; expected?: number | null; tone?: string; label: string; big?: boolean }) {
  const shown = useShown();
  const v = Math.max(0, Math.min(1, value));
  return <span className={css.paceBar} data-big={big ? "" : undefined} data-tone={tone} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}>
    <i style={{ width: shown ? `${v * 100}%` : 0 }} />
    {expected !== null && expected !== undefined && expected > 0 && expected < 1 ? <b style={{ left: `${expected * 100}%` }} title="Where it should be today" /> : null}
  </span>;
}

const HUES = [262, 200, 150, 28, 340, 180, 45, 300];
const hue = (s: string) => HUES[[...s].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % HUES.length];
/** Client logos (their first letter on a colour fixed by the name) filling slots up to the target. */
export function ClientSlots({ goal, max = 10, small }: { goal: ScreenGoal; max?: number; small?: boolean }) {
  const target = Math.max(1, Math.round(goal.measure?.target ?? 0)), now = Math.max(0, Math.round(valueNow(goal)));
  const named = goal.auto?.items ?? [];
  const slots = Math.min(max, Math.max(target, now));
  const names = named.map((x) => x.name).join(", ");
  return <span className={css.slots} data-small={small ? "" : undefined} role="img" aria-label={`${now} of ${target} clients${names ? `: ${names}` : ""}`}>
    {Array.from({ length: slots }, (_, i) => {
      const it = named[i];
      if (i < now) return <span key={i} className={css.logo} style={{ "--h": hue(it?.name ?? String(i)), animationDelay: `${i * 60}ms` } as CSSProperties} title={it?.name}>
        {it ? it.name.replace(/^the\s+/i, "").charAt(0).toUpperCase() : <Check size={small ? 11 : 14} aria-hidden="true" />}</span>;
      return <span key={i} className={css.slotEmpty} />;
    })}
    {Math.max(target, now) > slots ? <span className={css.slotMore}>+{Math.max(target, now) - slots}</span> : null}
  </span>;
}

export function StepBoxes({ goal, small }: { goal: ScreenGoal; small?: boolean }) {
  const done = goal.steps.filter((s) => s.done).length;
  return <span className={css.stepBoxes} data-small={small ? "" : undefined} role="img" aria-label={`${done} of ${goal.steps.length} steps done`}>
    {goal.steps.slice(0, small ? 6 : 12).map((s, i) => <span key={s.id} data-done={s.done ? "" : undefined} style={{ animationDelay: `${i * 50}ms` }}>{s.done ? <Check size={small ? 10 : 12} strokeWidth={3} aria-hidden="true" /> : null}</span>)}
  </span>;
}

/** A small picture of a goal for the list: a ring, a money bar, logos or a checklist. */
export function MiniVisual({ goal, today }: { goal: ScreenGoal; today: string }) {
  const p = goal.progress.progress, tone = health(goal, today).key;
  if (goal.kind === "milestone" && goal.steps.length) return <StepBoxes goal={goal} small />;
  if (goal.kind === "clients" && goal.measure) return <ClientSlots goal={goal} max={6} small />;
  if (goal.kind === "money" && goal.measure) {
    // Always the last four months up to this one (or the target month), so one month of data is one bar of four,
    // not a solid block; an empty month is a faint stub.
    const got = new Map(monthBars(goal).map((b) => [b.key, b.value]));
    const end = goal.targetOn && goal.targetOn < today ? goal.targetOn : today;
    const keys = [3, 2, 1, 0].map((k) => { const d = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 1 - k, 1)); return d.toISOString().slice(0, 7); });
    const top = Math.max(1, ...keys.map((k) => got.get(k) ?? 0));
    return <span className={css.miniBars} role="img" aria-label={`${rupees(valueNow(goal))} so far`}>
      {keys.map((k, i) => { const v = got.get(k) ?? 0;
        return <i key={k} style={{ height: `${v > 0 ? Math.max(14, (v / top) * 100) : 8}%`, animationDelay: `${i * 70}ms` }} data-last={i === 3 && v > 0 ? "" : undefined} data-empty={v > 0 ? undefined : ""} />; })}
    </span>;
  }
  return <Ring value={p} size={48} stroke={6} label={`${percent(p)}% done`} tone={tone}><span className={css.ringPct}>{percent(p)}%</span></Ring>;
}

const HEALTH_TONE: Record<string, string> = { on: "good", hit: "good", done: "good", risk: "warn", behind: "bad", start: "muted", none: "muted" };
export function HealthChip({ goal, today, help = true }: { goal: ScreenGoal; today: string; help?: boolean }) {
  const h = health(goal, today);
  if (h.key === "none" && goal.status === "active") return <span className={css.chip} data-tone="muted">No date</span>;
  return <span className={css.healthWrap}>
    <span className={css.chip} data-tone={HEALTH_TONE[h.key]}><span className={css.dot} aria-hidden="true" />{h.label}</span>
    {help && goal.status === "active" ? <HelpHint label="How on track, at risk and behind are worked out" title="How health is worked out">
      <ul className={css.helpList}>{HEALTH_HELP.map((l) => <li key={l}>{l}</li>)}</ul>
      {h.gap !== null && h.gap > 0 ? <p className={css.helpNow}>This goal is {Math.round(h.gap * 100)} points behind where it should be today.</p> : null}
    </HelpHint> : null}
  </span>;
}

export function StreakChip({ goal, today }: { goal: ScreenGoal; today: string }) {
  const n = streak(goal, today);
  if (n < 2) return null;
  return <span className={css.chip} data-tone="streak"><Flame size={13} aria-hidden="true" />{n} weeks in a row</span>;
}

/** The big number: "₹16.4 L of ₹25 L", counting up once. */
export function BigNumber({ goal, size = "lg" }: { goal: ScreenGoal; size?: "lg" | "md" | "sm" }) {
  const h = headline(goal);
  return <span className={css.bigNumber} data-size={size}><b><CountUp text={h.now} /></b> <span>{h.of}</span></span>;
}

const MON = new Intl.DateTimeFormat("en-IN", { month: "short", timeZone: "UTC" });
const DAY_MS = 86400000;
const t = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
/** The pace chart: what has come in (filled line), the straight line from the start to the target (dashed) and where
 *  today's speed ends up (dotted), with ₹ on the left and months along the bottom. */
export function PaceChart({ goal, today }: { goal: ScreenGoal; today: string }) {
  // The chart is drawn at its real width (measured), so its words stay ~11.5 px on a phone instead of shrinking with
  // a fixed 640-wide drawing scaled down to 300 px.
  const box = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = box.current; if (!el || typeof ResizeObserver === "undefined") return;
    const seen = new ResizeObserver((entries) => { const w = Math.round(entries[0]?.contentRect.width ?? 0); if (w > 0) setWidth(w); });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const line = paceLine(goal, today);
  if (!line) return null;
  const narrow = width < 480;
  const W = Math.max(280, width), H = narrow ? 200 : 220, L = narrow ? 46 : 52, R = narrow ? 54 : 70, T = 14, B = 26;
  const x0 = t(line.from), x1 = Math.max(t(line.to), x0 + DAY_MS);
  const top = Math.max(line.target, line.start, ...line.actual.map((p) => p.value), ...line.forecast.map((p) => p.value)) * 1.12 || 1;
  const X = (d: string) => L + ((Math.min(Math.max(t(d), x0), x1) - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v: number) => T + (1 - Math.max(0, v) / top) * (H - T - B);
  const path = (pts: { on: string; value: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.on).toFixed(1)},${Y(p.value).toFixed(1)}`).join(" ");
  const actual = path(line.actual), last = line.actual[line.actual.length - 1];
  const area = `${actual} L${X(last.on).toFixed(1)},${Y(0)} L${X(line.actual[0].on).toFixed(1)},${Y(0)} Z`;
  const ticks = (narrow ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((k) => k * top);
  const months: { x: number; label: string }[] = [];
  for (let d = new Date(x0); d.getTime() <= x1; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    if (first >= x0) months.push({ x: L + ((first - x0) / (x1 - x0)) * (W - L - R), label: MON.format(new Date(first)) });
  }
  const fmt = (v: number) => goal.kind === "money" ? rupees(v) : amountWords(goal, Math.round(v));
  const end = line.forecast[1];
  return <figure className={css.chart} ref={box}>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${fmt(valueNow(goal))} so far; the target is ${fmt(line.target)} by ${shortDate(line.to, today)}${end ? `; at this pace ${fmt(end.value)}` : ""}`}>
      {ticks.map((v) => <g key={v} className={css.chartGrid}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} /><text x={L - 8} y={Y(v) + 4} textAnchor="end">{fmt(v)}</text></g>)}
      {months.map((m) => <text key={m.x} className={css.chartMonth} x={m.x} y={H - 6} textAnchor="middle">{m.label}</text>)}
      <path d={area} className={css.chartArea} />
      <line className={css.chartPace} x1={X(line.from)} y1={Y(line.start)} x2={X(line.to)} y2={Y(line.target)} />
      {end ? <line className={css.chartForecast} x1={X(line.forecast[0].on)} y1={Y(line.forecast[0].value)} x2={X(end.on)} y2={Y(end.value)} /> : null}
      <path d={actual} className={css.chartLine} pathLength={1} />
      <circle cx={X(last.on)} cy={Y(last.value)} r={5} className={css.chartDot} />
      <g className={css.chartTag}><text x={X(line.to) + 8} y={Y(line.target) + 4}>{fmt(line.target)}</text></g>
      {end ? <g className={css.chartTagAccent}><text x={X(end.on) + 8} y={Y(end.value) + (Math.abs(Y(end.value) - Y(line.target)) < 14 ? -10 : 4)}>{fmt(end.value)}</text></g> : null}
    </svg>
    <figcaption className={css.legend}>
      <span><i data-k="actual" />{goal.kind === "money" ? "Money so far" : "So far"}</span>
      <span><i data-k="pace" />Straight line to the target</span>
      {end ? <span><i data-k="forecast" />At today&apos;s speed</span> : null}
    </figcaption>
  </figure>;
}

/** Money per month as tiles: the month, the ₹ and a bar against what each month needs. */
export function MonthTiles({ goal, today }: { goal: ScreenGoal; today: string }) {
  const bars = monthBars(goal);
  if (!bars.length || !goal.measure || !goal.targetOn) return null;
  const months = Math.max(1, Math.round((t(goal.targetOn) - t(goal.startsOn)) / (30.4 * DAY_MS)));
  const need = Math.max(1, (goal.measure.target - goal.measure.start) / months);
  return <div className={css.months} role="list" aria-label="Each month">
    {bars.slice(-6).map((b) => <div key={b.key} className={css.monthTile} role="listitem">
      <span>{b.label}</span>
      <b><CountUp text={amountWords(goal, b.value)} />{b.key === today.slice(0, 7) ? <small> so far</small> : null}</b>
      <PaceBar value={b.value / need} label={`${b.label}: ${amountWords(goal, b.value)} of the ${amountWords(goal, need)} a month needs`} />
    </div>)}
  </div>;
}

/** The owner as a face and a name. */
export function Owner({ goal, size = 22 }: { goal: ScreenGoal; size?: number }) {
  if (!goal.owner || !goal.ownerId) return null;
  return <span className={css.owner}><Avatar name={goal.owner} id={goal.ownerId} photoAt={goal.ownerPhotoAt ?? null} size={size} />{goal.owner}</span>;
}
