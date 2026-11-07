"use client";
// TASKS-4A: Projects as a timeline. Each project a bar from its start to its due date (or its next task due), filled
// as far as its tasks are finished, late ones in red, today marked; projects with no dates are listed after.
import Link from "next/link";
import { useState, type CSSProperties } from "react";
import { Avatar } from "../../ui";
import { Segmented, Tooltip, addDays, dayLabel } from "../../kit";
import type { TreeRow } from "../projects-tree";
import css from "./views.module.css";

type Row = TreeRow & { startsOn?: string | null; lastAt?: string | null };
const span = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const ZOOM = { months: { before: 30, after: 120, px: 6 }, quarters: { before: 60, after: 300, px: 2.4 } } as const;

export function ProjectsTimeline({ rows, today }: { rows: Row[]; today: string }) {
  const [zoom, setZoom] = useState<keyof typeof ZOOM>("months");
  const z = ZOOM[zoom], from = addDays(today, -z.before), to = addDays(today, z.after), width = Math.round(span(from, to) * z.px);
  const pos = (d: string) => Math.max(0, Math.min(width, span(from, d) * z.px));
  const dated = rows.map((r) => {
    const end = r.dueOn ?? r.nextDue; if (!end) return null;
    const start = r.startsOn && r.startsOn <= end ? r.startsOn : r.lastAt ? new Date(Math.min(Date.parse(r.lastAt), Date.parse(`${end}T00:00:00Z`))).toISOString().slice(0, 10) : addDays(end, -14);
    return { r, start, end };
  }).filter(Boolean) as { r: Row; start: string; end: string }[];
  const undated = rows.length - dated.length;
  const months: string[] = []; for (let d = `${from.slice(0, 7)}-01`; d <= to; d = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 1)).toISOString().slice(0, 10)) if (d >= from) months.push(d);
  return <div className={css.timeline} data-standalone="">
    <div className={css.tlHead}>
      <Segmented label="Zoom" size="sm" value={zoom} onChange={setZoom} options={[{ value: "months", label: "Months" }, { value: "quarters", label: "Quarters" }]} />
      <span className={css.muted}>{undated ? `${undated} without a start or due date are in the tree` : "Every project here has a date"}</span>
    </div>
    <div className={css.tlScroll}>
      <div className={css.tlGrid} style={{ "--w": `${width}px`, "--px": `${z.px * 4.3}px` } as CSSProperties}>
        <div className={css.tlScale} aria-hidden="true"><span className={css.tlCorner} />
          <span className={css.tlTrack}>{months.map((m) => <i key={m} style={{ left: pos(m) }} data-major="">{new Date(`${m}T00:00:00Z`).toLocaleString("en-IN", { month: "short", year: m.slice(5, 7) === "01" ? "numeric" : undefined, timeZone: "UTC" })}</i>)}<b className={css.tlToday} style={{ left: pos(today) }} /></span></div>
        <ul className={css.tlRows}>{dated.map(({ r, start, end }) => {
          const pct = r.total ? Math.round(100 * r.finished / r.total) : 0, late = r.overdue > 0 || (end < today && r.open > 0);
          const left = pos(start), w = Math.max(10, pos(end) - left), off = end < from || start > to;
          return <li key={r.id} className={css.tlRow}>
            <span className={css.tlLabel}>{r.ownerName ? <Avatar name={r.ownerName} id={r.ownerId ?? undefined} photoAt={r.ownerPhotoAt} size={18} /> : null}<Link href={`/tasks/projects/${r.id}`} title={r.name}>{r.name}</Link></span>
            <span className={css.tlTrack}><b className={css.tlToday} style={{ left: pos(today) }} aria-hidden="true" />
              {off ? <span className={css.tlOff}>{end < from ? `← ${dayLabel(end, today)}` : `${dayLabel(start, today)} →`}</span>
                : <Tooltip content={`${r.name} · ${dayLabel(start, today)} – ${dayLabel(end, today)} · ${pct}% done${r.open ? ` · ${r.open} open` : ""}${r.overdue ? ` · ${r.overdue} late` : ""}`}>
                  <Link href={`/tasks/projects/${r.id}`} className={css.pbar} data-late={late ? "" : undefined} style={{ left, width: w }} aria-label={`${r.name}: ${dayLabel(start, today)} to ${dayLabel(end, today)}, ${pct}% done`}>
                    <i style={{ width: `${pct}%` }} /><span>{pct}%</span></Link></Tooltip>}
            </span>
          </li>;
        })}</ul>
      </div>
    </div>
  </div>;
}
