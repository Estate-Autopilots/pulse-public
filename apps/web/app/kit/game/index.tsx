"use client";
// UX-GAMIFY (owner, 9 Nov 2026: "all new screens have bad UX and UI ... make it fun and game-like"): the game-feel kit.
// Every new or redone screen builds from these, so screens read as one product (COMMON.md, UI QUALITY GATE):
//   GamePage, PageHeader, StatTiles/StatTile (counts up, trend, sparkline), ProgressRing, DayRing, StreakChip,
//   LevelBadge, celebrate()/Milestone, EmptyState (Codex art), Skeleton, toast() with Undo, Stepper (check draws
//   itself), ListRow, SegmentedTabs (the kit's Segmented, with counts), StickyBar, FuelGauge, QuestList/Quest,
//   WeeklyRecap, Chip.
// Motion only for delight, and never when the system asks for less motion or the person switched "Fun effects" off
// (Settings → Appearance). Everything renders its final state on the server, so a screenshot or a screen reader always
// reads the real value. Patterns studied: canvas-confetti (ISC) for the burst (lib/motion.ts), Radix (MIT) for roles,
// the toast is UI-DIALOGS' (kit/dialogs.tsx); no code copied. Look: game.module.css. (A gallery on /kit comes with UX-GAMIFY's screens.)
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Check, ChevronRight, Flame, Minus, PartyPopper, type LucideIcon } from "lucide-react";
import { toast as appToast } from "../dialogs";
import { burst, funEffectsOn, onFunEffects, setFunEffects } from "../../lib/motion";
import { dayDone, levelOf, trendText, type Trend } from "../../lib/game.mjs";
import { CountUp } from "../count-up";
import { Segmented, SegmentedNav, type SegmentLink, type SegmentOption } from "../segmented";
import css from "./game.module.css";

export { css as gameCss };
export type Tone = "good" | "warn" | "bad";
export type Action = { label: string; href: string; icon?: LucideIcon } | { label: string; onClick: () => void; icon?: LucideIcon; busy?: boolean; disabled?: boolean };

/** Fun effects on or off for this person (Settings → Appearance), live. */
export function useFunEffects(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(onFunEffects, funEffectsOn, () => true);
  return [on, setFunEffects];
}

/** True after the first paint, so a ring, gauge or bar can move from 0 to its value (at once when delight is off). */
function useShown(): boolean {
  const [shown, setShown] = useState(false);
  // The CSS stops the movement itself when motion is reduced or Fun effects are off (game.module.css), so this only waits a frame.
  useEffect(() => { const f = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(f); }, []);
  return shown;
}

/** One button or link: `primary` is the one main action of the view. */
export function ActionButton({ action, primary, small }: { action: Action; primary?: boolean; small?: boolean }) {
  const Icon = action.icon;
  const cls = `${primary ? css.primary : css.quiet}${small ? ` ${css.small}` : ""}`;
  const inner = <>{Icon ? <Icon size={small ? 14 : 16} aria-hidden="true" /> : null}{action.label}</>;
  if ("href" in action) return <Link className={cls} href={action.href}>{inner}</Link>;
  return <button type="button" className={cls} onClick={action.onClick} disabled={action.disabled || action.busy} aria-busy={action.busy || undefined}>{inner}</button>;
}

/** The page column: equal gutters on every side, never touching the sidebar, never wider than the screen. On a desktop
 *  the shell's page area does not scroll (each page scrolls inside itself, as ui.tsx's Page does), so the column sits in
 *  its own scroll box there (FIX-AI-EMPLOYEES, 10 Nov 2026: a long game page was cut off at the window's bottom). */
export function GamePage({ children, label }: { children: ReactNode; label?: string }) {
  return <div className={css.scroll}><div className={css.root} data-game-page="" aria-label={label}>{children}</div></div>;
}

/** Title, one plain line, the one primary action; a ring, streak or badge on the right (`side`). */
export function PageHeader({ eyebrow, title, subtitle, primary, side, shellTitle }: { eyebrow?: ReactNode; title: string; subtitle?: ReactNode; primary?: Action; side?: ReactNode;
  /** The shell's phone top bar already shows this title: below 900px the big one is for screen readers only. */ shellTitle?: boolean }) {
  return <header className={css.head}>
    <div className={css.headText}>
      {eyebrow ? <p className={css.eyebrow}>{eyebrow}</p> : null}
      <h1 className={css.title} data-shell-title={shellTitle ? "" : undefined}>{title}</h1>
      {subtitle ? <p className={css.subtitle}>{subtitle}</p> : null}
    </div>
    {side || primary ? <div className={css.headSide}>{side}{primary ? <ActionButton action={primary} primary /> : null}</div> : null}
  </header>;
}

/** A card holding a section, with an optional heading line. */
export function GameCard({ title, icon: Icon, note, children, label }: { title?: ReactNode; icon?: LucideIcon; note?: ReactNode; children: ReactNode; label?: string }) {
  return <section className={css.card} aria-label={label ?? (typeof title === "string" ? title : undefined)}>
    {title ? <h2 className={css.cardHead}>{Icon ? <Icon size={16} aria-hidden="true" /> : null}{title}{note !== undefined && note !== null ? <small>{note}</small> : null}</h2> : null}
    {children}
  </section>;
}

/** A row of stat tiles that always fills its width (equal tiles; two across on a phone with `pair`). */
export function StatTiles({ children, label = "At a glance", min, pair }: { children: ReactNode; label?: string; /** Narrowest tile, px. */ min?: number; pair?: boolean }) {
  return <dl className={css.tiles} aria-label={label} data-pair={pair ? "" : undefined} style={min ? { "--tile-min": `${min}px` } as CSSProperties : undefined}>{children}</dl>;
}

/** A tiny line of recent values (oldest first). */
export function Sparkline({ values, label }: { values: readonly number[]; label: string }) {
  if (values.length < 2) return null;
  const W = 72, H = 24, top = Math.max(...values), low = Math.min(...values), span = top - low || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - 2 - ((v - low) / span) * (H - 4)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return <svg className={css.spark} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
    <path d={`M0,${H} L${line.replaceAll(" ", " L")} L${W},${H} Z`} /><polyline points={line} />
  </svg>;
}

/** One number that counts up, its name, and optionally a trend and a sparkline. `href` makes the tile a way in. */
export function StatTile({ label, value, unit, icon: Icon, tone, trend, trendLabel, spark, href }: {
  label: string; /** As people read it: "₹4.2 L", "18", "92%". */ value: string | number; unit?: string; icon?: LucideIcon; tone?: Tone;
  trend?: Trend; /** "vs last week" */ trendLabel?: string; spark?: readonly number[]; href?: string }) {
  const text = typeof value === "number" ? value.toLocaleString("en-IN") : value;
  const TrendIcon = trend ? trend.dir === "up" ? ArrowUpRight : trend.dir === "down" ? ArrowDownRight : Minus : null;
  const body = <>
    <dt className={css.tileLabel}>{Icon ? <Icon size={14} aria-hidden="true" /> : null}{href ? <Link className={css.tileLink} href={href}>{label}</Link> : label}</dt>
    <dd className={css.tileValue}><CountUp text={text} />{unit ? <small>{unit}</small> : null}</dd>
    {trend || spark ? <dd className={css.tileFoot} style={{ margin: 0 }}>
      {trend && TrendIcon ? <span className={css.trend} data-good={trend.good === true ? "" : undefined} data-bad={trend.good === false ? "" : undefined} data-flat={trend.good === null ? "" : undefined}>
        <TrendIcon size={14} aria-hidden="true" />{trendText(trend)}{trendLabel ? <span style={{ fontWeight: 500, marginLeft: 4, color: "var(--theme-text-muted)" }}>{trendLabel}</span> : null}</span> : <span />}
      {spark ? <Sparkline values={spark} label={`${label}, recent`} /> : null}
    </dd> : null}
  </>;
  return <div className={css.tile} data-tone={tone} data-link={href ? "" : undefined}>{body}</div>;
}

/** A ring that fills from 0 to `value` (0..1) once, with words or a number inside. */
export function ProgressRing({ value, size = 64, stroke = 8, label, tone, children }: { value: number; size?: number; stroke?: number; label: string; tone?: Tone; children?: ReactNode }) {
  const shown = useShown();
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, Number(value) || 0));
  return <span className={css.ring} style={{ width: size, height: size, "--ring-size": `${size}px` } as CSSProperties} role="img" aria-label={label} data-tone={tone}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className={css.ringTrack} />
      <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className={css.ringFill} strokeDasharray={c} strokeDashoffset={shown ? c * (1 - p) : c} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
    <span className={css.ringText} aria-hidden="true">{children ?? <b>{Math.round(p * 100)}%</b>}</span>
  </span>;
}

/** "My day": how much of today is done, as a ring with the words beside it. */
export function DayRing({ done, total, size = 56, what = "done", sub }: { done: number; total: number; size?: number; what?: string; /** Under the words, e.g. the streak. */ sub?: ReactNode }) {
  const d = dayDone(done, total);
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
    <ProgressRing value={d.pct} size={size} stroke={7} label={`${d.words}`} tone={d.all ? "good" : undefined}>{d.all ? <Check size={size * 0.4} aria-hidden="true" /> : <span />}</ProgressRing>
    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4, lineHeight: 1.25 }}><b style={{ fontSize: 15 }}>{d.all ? "All done today" : `${Math.min(done, total)} of ${total} ${what} today`}</b>
      {sub ?? <small style={{ fontSize: 12, color: "var(--theme-text-muted)" }}>{d.all ? "Nice work." : "Today"}</small>}</span>
  </span>;
}

/** Days in a row: a flame when there is a streak, a quiet nudge when there is none yet. */
export function StreakChip({ days, what = "day" }: { days: number; /** "day", "check-in day" */ what?: string }) {
  const n = Math.max(0, Math.floor(days));
  return <span className={css.streak} data-cold={n ? undefined : ""} title={n ? `${n} ${what}${n === 1 ? "" : "s"} in a row` : "Do it today to start a streak"}>
    <Flame size={15} aria-hidden="true" />{n ? `${n}-${what} streak` : "No streak yet"}</span>;
}

/** Personal progress: the level and how far to the next. Only for the person's own progress, never to rank people. */
export function LevelBadge({ xp, what = "XP" }: { xp: number; what?: string }) {
  const l = levelOf(xp); const shown = useShown();
  return <span className={css.badge} role="img" aria-label={`Level ${l.level}, ${l.into} of ${l.span} ${what} to the next level`}>
    <span className={css.badgeLevel} aria-hidden="true">{l.level}</span>
    <span className={css.badgeText} aria-hidden="true">Level {l.level}<small className={css.num}>{l.into} / {l.span} {what}</small>
      <span className={css.badgeBar}><i style={{ width: `${shown ? Math.round(l.pct * 100) : 0}%` }} /></span></span>
  </span>;
}

/** A small chip: a state or a tag. */
export function Chip({ children, tone }: { children: ReactNode; tone?: Tone | "accent" }) {
  return <span className={css.chip} data-tone={tone}>{children}</span>;
}

/**
 * A celebration, used sparingly: a real milestone (sent, signed, a goal hit, the day done). Once per `id` per browser
 * when an id is given. Nothing when motion is reduced or Fun effects are off.
 */
export function celebrate(origin?: Element | null, opts: { big?: boolean; id?: string } = {}): void {
  if (opts.id) { const key = `pulse-celebrated:${opts.id}`; try { if (localStorage.getItem(key)) return; localStorage.setItem(key, "1"); } catch { /* private mode */ } }
  burst(origin ?? undefined, { big: opts.big });
}

/** A "level up" moment: a pop card with a burst, shown when `show` turns true (once per `id`). */
export function Milestone({ show, id, title, text, once = true }: { show: boolean; id: string; title: string; text?: string; /** Celebrate this id only once per browser. */ once?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (show) celebrate(ref.current, { id: once ? id : undefined, big: true }); }, [show, id, once]);
  if (!show) return null;
  return <div ref={ref} className={css.milestone} role="status"><PartyPopper size={28} aria-hidden="true" /><span><b>{title}</b>{text ? <small>{text}</small> : null}</span></div>;
}

const ART = { done: "/fun/empty-done.webp", nothing: "/fun/empty-nothing.webp", connect: "/fun/empty-connect.webp" } as const;
export type EmptyArt = keyof typeof ART;
/** Nothing here: a friendly picture (drawn by Codex), what it means, and one clear action. */
export function EmptyState({ art = "nothing", title, text, action }: { art?: EmptyArt; title: string; text?: ReactNode; action?: Action }) {
  return <div className={css.empty} data-empty-state="">
    {/* eslint-disable-next-line @next/next/no-img-element -- a small static picture; no layout shift (fixed size) */}
    <img src={ART[art]} alt="" width={136} height={136} loading="lazy" decoding="async" />
    <b>{title}</b>{text ? <span>{text}</span> : null}
    {action ? <ActionButton action={action} primary /> : null}
  </div>;
}

/** A soft bar while something loads. */
export function Skeleton({ width = "100%", height = 16, radius = 8 }: { width?: number | string; height?: number; radius?: number }) {
  return <span className={css.skel} style={{ width, height, borderRadius: radius }} aria-hidden="true" />;
}
/** A loading list: a few rows shaped like the real ones. */
export function SkeletonRows({ rows = 4, height = 64, label = "Loading" }: { rows?: number; height?: number; label?: string }) {
  return <div role="status" aria-label={label} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
    {Array.from({ length: rows }, (_, i) => <Skeleton key={i} height={height} radius={12} />)}
  </div>;
}

// The toast is the app's one toast (UI-DIALOGS, kit/dialogs.tsx): this keeps the kit's short form, with Undo as its action.
type ToastOpts = { undo?: () => void | Promise<void>; tone?: "good" | "bad"; ms?: number; undoLabel?: string };
/** A short message at the bottom of the screen, with Undo when `undo` is given (it stays longer then). */
export function toast(text: string, opts: ToastOpts = {}): void {
  appToast(text, { tone: opts.tone === "bad" ? "error" : "success", timeout: opts.ms,
    action: opts.undo ? { label: opts.undoLabel ?? "Undo", run: () => { void opts.undo?.(); } } : undefined });
}

/** Steps of a flow: done ones show a tick that draws itself; the current one is ringed. */
export function Stepper({ steps, current, label = "Steps" }: { steps: readonly string[]; /** 0-based; steps.length means all done */ current: number; label?: string }) {
  return <ol className={css.stepper} aria-label={label}>
    {steps.map((s, i) => {
      const state = i < current ? "done" : i === current ? "now" : "next";
      return <li key={s} className={css.step} data-state={state} aria-current={state === "now" ? "step" : undefined}>
        <span className={css.stepDot} data-state={state} aria-hidden="true">{state === "done" ? <Tick /> : i + 1}</span>
        <span className={css.stepName}>{s}<span className={css.srOnly}>{state === "done" ? " (done)" : state === "now" ? " (now)" : ""}</span></span>
      </li>;
    })}
  </ol>;
}
function Tick({ size = 16 }: { size?: number }) {
  return <svg className={css.tick} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** A row in a card list: something to lead (an icon, initials), a title and one line, a chip or number at the end. */
export function ListRow({ lead, title, sub, end, href, onClick, stripe, label }: { lead?: ReactNode; title: ReactNode; sub?: ReactNode; end?: ReactNode; href?: string; onClick?: () => void; /** A colour for the left edge. */ stripe?: string; label?: string }) {
  const inner = <>
    {lead !== undefined ? <span className={css.rowLead} aria-hidden="true">{lead}</span> : <span />}
    <span className={css.rowText}><b>{title}</b>{sub ? <small>{sub}</small> : null}</span>
    <span className={css.rowEnd}>{end}{href || onClick ? <ChevronRight size={16} aria-hidden="true" /> : null}</span>
  </>;
  const style = stripe ? { "--row-stripe": stripe } as CSSProperties : undefined;
  if (href) return <Link className={css.row} href={href} style={style} data-stripe={stripe ? "" : undefined} aria-label={label}>{inner}</Link>;
  if (onClick) return <button type="button" className={css.row} style={style} data-stripe={stripe ? "" : undefined} onClick={onClick} aria-label={label}>{inner}</button>;
  return <div className={css.row} style={style} data-stripe={stripe ? "" : undefined}>{inner}</div>;
}
export function ListRows({ children, label }: { children: ReactNode; label?: string }) {
  return <ul className={css.rows} aria-label={label}>{children}</ul>;
}

/** Tabs as a segmented control with counts: buttons (`SegmentedTabs`) or links kept in the URL (`SegmentedTabLinks`). */
export const SegmentedTabs = Segmented;
export const SegmentedTabLinks = SegmentedNav;
export type { SegmentLink, SegmentOption };

/** A bar that stays at the bottom while a long page scrolls: a line of words and the actions (one primary). */
export function StickyBar({ text, children, label = "Actions" }: { text?: ReactNode; children: ReactNode; label?: string }) {
  return <div className={css.bar} role="region" aria-label={label} data-float-avoid=""><span className={css.barText}>{text}</span><span className={css.barActions}>{children}</span></div>;
}

/**
 * A fuel gauge for an account's window: the needle at what is LEFT (0..100), green/amber/red against the rivokeb,
 * a dashed mark at the rivokeb. `left` null draws an empty dial with the words in `missing`.
 */
export function FuelGauge({ left, reserve = 20, label, sub, size = 148, missing = "Not read yet", stale }: { left: number | null; reserve?: number; label: string; sub?: ReactNode; size?: number; missing?: string;
  /** The reading is old (how old, in words): drawn grey, with its age, so it does not look current. */ stale?: string | false }) {
  const shown = useShown();
  const v = left === null ? null : Math.max(0, Math.min(100, left));
  const tone = v === null ? "none" : v <= reserve ? "bad" : v <= reserve + 20 ? "warn" : "good";
  const R = 40, L = Math.PI * R; // a half circle from the left (empty) to the right (full)
  const angle = v === null ? -90 : -90 + (shown ? v : 0) * 1.8;
  return <div className={css.gauge} data-tone={tone} data-stale={stale && v !== null ? "" : undefined} style={{ "--gauge-size": `${size}px` } as CSSProperties} role="img"
    aria-label={v === null ? `${label}: ${missing}` : `${label}: ${Math.round(v)}% left${v <= reserve ? ", in the rivokeb" : ""}${stale ? " (an old reading)" : ""}`}>
    <svg viewBox="0 0 100 58" aria-hidden="true">
      <path d={`M10 50 A${R} ${R} 0 0 1 90 50`} className={css.gaugeTrack} strokeWidth={9} strokeLinecap="round" />
      <path d={`M10 50 A${R} ${R} 0 0 1 90 50`} className={css.gaugeFill} strokeWidth={9} strokeDasharray={L} strokeDashoffset={v === null ? L : L * (1 - (shown ? v : 0) / 100)} />
      {v !== null ? <g className={css.gaugeNeedle} style={{ transform: `rotate(${angle}deg)` }}><line x1={50} y1={50} x2={50} y2={18} /><circle cx={50} cy={50} r={4} /></g> : null}
    </svg>
    <span className={css.gaugeValue} aria-hidden="true">{v === null ? missing : <>{Math.round(v)}<small>% left{stale && stale.trim() ? ` (${stale})` : ""}</small></>}</span>
    {sub ? <span className={css.gaugeLabel} aria-hidden="true">{sub}</span> : null}
  </div>;
}

export type QuestState = "todo" | "done" | "wait" | "blocked";
/** One quest: a coloured edge, a round check that draws its tick (or a wait / blocked mark), a title, a line, an end. */
export function Quest({ title, sub, end, state = "todo", color, onToggle, toggleLabel, icon: Icon }: { title: ReactNode; sub?: ReactNode; end?: ReactNode; state?: QuestState; color?: string;
  /** Makes the check a button (pressed = done). */ onToggle?: (done: boolean, el: HTMLElement) => void; toggleLabel?: string; icon?: LucideIcon }) {
  const done = state === "done";
  return <li className={css.quest} data-state={state} style={color ? { "--quest-color": color } as CSSProperties : undefined}>
    {state === "wait" || state === "blocked" ? <span className={css.questIcon} aria-hidden="true">{Icon ? <Icon size={16} /> : null}</span>
      : <button type="button" className={css.questCheck} aria-pressed={done} disabled={!onToggle} aria-label={toggleLabel ?? (done ? "Done" : "Mark done")}
        onClick={(e) => { const el = e.currentTarget; onToggle?.(!done, el); if (!done) celebrate(el); }}><Tick /></button>}
    <span className={css.questText}><span className={css.questTitle}>{title}</span>{sub ? <span className={css.questSub}>{sub}</span> : null}</span>
    {end ? <span className={css.questEnd}>{end}</span> : null}
  </li>;
}
export function QuestList({ children, label }: { children: ReactNode; label: string }) {
  return <ul className={css.quests} aria-label={label}>{children}</ul>;
}

/** The week in a few numbers, and the streak. */
export function WeeklyRecap({ items, streak, title = "Your week" }: { items: readonly { label: string; value: string | number }[]; streak?: number; title?: string }) {
  return <GameCard title={title} note={streak !== undefined ? <StreakChip days={streak} /> : undefined}>
    <dl className={css.recap}>{items.map((i) => <div key={i.label}><dt>{i.label}</dt><dd><CountUp text={typeof i.value === "number" ? i.value.toLocaleString("en-IN") : i.value} /></dd></div>)}</dl>
  </GameCard>;
}
