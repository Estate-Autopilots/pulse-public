"use client";
// TASKS-4A views: Timeline. Each task as a bar from when it started (or was made) to when it is due (or finished),
// grouped like the other views, against weeks or months, with today marked. Tasks with no date at all are counted
// under the chart (the calendar's tray schedules them).
import { RowLink } from "../../kit/row-link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Diamond } from "lucide-react";
import { Segmented, Tooltip, addDays, dayLabel } from "../../kit";
import { STATUS } from "../parts";
import type { Task } from "../types";
import { isFinished, type Bucket } from "./model";
import { zoneDay } from "../../lib/zone.mjs";
import { useOrgZone } from "../../org-code";
import css from "./views.module.css";

const DAY = 86400000;
const span = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
type Zoom = "weeks" | "months";
const ZOOM: Record<Zoom, { before: number; after: number; px: number }> = { weeks: { before: 7, after: 49, px: 30 }, months: { before: 30, after: 150, px: 7 } };

/** A task's bar, in days on the company's calendar (`zone`). */
export function barOf(t: Task, today: string, zone: string): { from: string; to: string; point: boolean } | null {
  const toDay = (iso: string | null | undefined) => iso ? zoneDay(zone, iso) : null;
  const due = t.dueOn, done = toDay(t.doneAt), start = toDay(t.startedAt) ?? toDay(t.createdAt) ?? t.workOn;
  const end = done ?? due ?? (t.status === "in_progress" ? today : null);
  if (!end) return null;
  const from = start && start <= end ? start : end;
  return { from, to: end, point: from === end };
}

export function TimelineView({ buckets, today }: { buckets: Bucket[]; today: string }) {
  const zone = useOrgZone();
  const [zoom, setZoom] = useState<Zoom>("weeks");
  // WORK-SPINE (owner, 10 Nov 2026: "the timeline shows a huge cluttered graph"): the range fits the work: from a few days
  // before today (or the first bar) to just past the last due day, within the zoom's limits.
  const z = ZOOM[zoom];
  const spanOf = buckets.flatMap((b) => b.rows).map((t) => barOf(t, today, zone)).filter((b): b is NonNullable<typeof b> => !!b);
  const firstDay = spanOf.reduce((m, b) => b.from < m ? b.from : m, today), lastDay = spanOf.reduce((m, b) => b.to > m ? b.to : m, today);
  const lo = addDays(today, -z.before), early = addDays(firstDay, -2), from = early < lo ? lo : early < addDays(today, -2) ? early : addDays(today, -2);
  const hi = addDays(today, z.after), late = addDays(lastDay, zoom === "weeks" ? 4 : 14), floor = addDays(today, zoom === "weeks" ? 28 : 120);
  const to = (late > hi ? hi : late) < floor ? floor : late > hi ? hi : late;
  const width = span(from, to) * z.px, before = span(from, today);
  const ticks = useMemo(() => { const out: { day: string; label: string; major: boolean }[] = []; for (let d = from; d <= to; d = addDays(d, 1)) {
    const x = new Date(`${d}T00:00:00Z`); if ((zoom === "weeks" ? x.getUTCDay() === 1 : x.getUTCDate() === 1) && Math.abs(span(today, d)) > (zoom === "weeks" ? 2 : 6)) out.push({ day: d, label: zoom === "weeks" ? dayLabel(d, undefined, true).replace(/^\w+ /, "") : x.toLocaleString("en-IN", { month: "short", timeZone: "UTC" }), major: x.getUTCDate() === 1 }); }
    return out; }, [from, to, zoom, today]);
  const pos = (d: string) => Math.max(0, Math.min(width, span(from, d) * z.px));
  const unscheduled = buckets.reduce((n, b) => n + b.rows.filter((t) => !barOf(t, today, zone)).length, 0);
  const groups = buckets.map((b) => ({ ...b, rows: b.rows.filter((t) => barOf(t, today, zone)) })).filter((b) => b.rows.length);
  // A phone's narrow track holds only the week before today, so today's and later work sat off to the right: there the
  // chart starts at yesterday (it still scrolls back); a wide one keeps the week before for context.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current, grid = el?.firstElementChild; if (!el || !grid) return;
    const { px } = ZOOM[zoom], label = parseFloat(getComputedStyle(grid).getPropertyValue("--label")) || 0;
    el.scrollLeft = el.clientWidth - label < (before + 7) * px ? Math.max(0, before - 1) * px : 0;
  }, [zoom, before]);
  return <div className={css.timeline}>
    <div className={css.tlHead}>
      <Segmented label="Zoom" size="sm" value={zoom} onChange={setZoom} options={[{ value: "weeks", label: "Weeks" }, { value: "months", label: "Months" }]} />
      <span className={css.tlLegend}><span><i />From start to due day</span><span><b />Late</span></span>
      {unscheduled ? <span className={css.muted}>{unscheduled} without any date are not on the chart</span> : null}
    </div>
    <div ref={scroller} className={css.tlScroll} data-grow="">
      <div className={css.tlGrid} style={{ "--w": `${width}px`, "--px": `${z.px}px` } as CSSProperties}>
        <div className={css.tlScale} aria-hidden="true"><span className={css.tlCorner} />
          <span className={css.tlTrack}>{ticks.map((t) => <i key={t.day} style={{ left: pos(t.day) }} data-major={t.major ? "" : undefined}>{t.label}</i>)}<b className={css.tlToday} style={{ left: pos(today) }} /><span className={css.tlTodayTag} style={{ left: pos(today) }}>Today</span></span></div>
        {groups.map((g) => <section key={g.key} aria-label={g.label} className={css.tlGroup}>
          {groups.length > 1 || g.key !== "all" ? <h3 className={css.tlGroupHead}><span>{g.label}</span><span className={css.count}>{g.rows.length}</span></h3> : null}
          <ul className={css.tlRows}>{g.rows.map((t) => {
            const b = barOf(t, today, zone)!, left = pos(b.from), right = pos(b.to), late = !isFinished(t) && !!t.dueOn && t.dueOn < today, st = STATUS[t.status] ?? STATUS.unknown;
            const off = b.to < from || b.from > to;
            return <li key={t.id} className={css.tlRow}>
              <span className={css.tlLabel}><RowLink href={`/tasks/${t.id}`} title={t.assigneeName ? `${t.title} · ${t.assigneeName}` : t.title}>{t.title}</RowLink>{t.assigneeName ? <small className={css.tlWho} title={t.assigneeName}>{t.assigneeName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("")}</small> : null}</span>
              <span className={css.tlTrack}>
                <b className={css.tlToday} style={{ left: pos(today) }} aria-hidden="true" />
                {off ? <span className={css.tlOff}>{b.to < from ? `← ${dayLabel(b.to, today)}` : `${dayLabel(b.from, today)} →`}</span>
                  : <Tooltip content={`${t.title} · ${b.point ? dayLabel(b.to, today) : `${dayLabel(b.from, today)} – ${dayLabel(b.to, today)}`} · ${st.label}`}>
                    <RowLink href={`/tasks/${t.id}`} className={css.bar} data-status={t.status} data-late={late ? "" : undefined} data-point={b.point ? "" : undefined} data-priority={t.priority}
                      style={{ left, width: b.point ? undefined : Math.max(z.px, right - left + z.px) }} aria-label={`${t.title}: ${b.point ? `due ${dayLabel(b.to, today)}` : `${dayLabel(b.from, today)} to ${dayLabel(b.to, today)}`}, ${st.label}`}>
                      {b.point ? <Diamond size={12} aria-hidden="true" /> : null}</RowLink>
                  </Tooltip>}
              </span>
            </li>;
          })}</ul>
        </section>)}
      </div>
    </div>
  </div>;
}
