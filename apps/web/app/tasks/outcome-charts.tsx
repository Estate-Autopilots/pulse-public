"use client";
// TASKS-3: the outcome charts. One axis each; columns no wider than 24 px with a 2 px gap between stacked parts and a
// rounded top; categorical colours in a fixed order (validated for both themes), the rest folded into "Other"; a
// legend for two or more series; a tooltip per column (hover or focus); and every chart has a table view.
import { useState } from "react";
import { Table2 } from "lucide-react";
import css from "./outcomes.module.css";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (day: string) => { const d = new Date(`${day}T00:00:00Z`); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
export type Series = { key: string; label: string; values: number[]; /** Slot in the categorical order (1–6), or "other". */ slot?: number | "other"; faint?: boolean };
const ticksFor = (max: number) => { if (max <= 4) return [max]; const step = Math.pow(10, Math.floor(Math.log10(max / 2))); const nice = [1, 2, 5, 10].map((m) => m * step).find((s) => max / s <= 4) ?? step * 10; return Array.from({ length: Math.floor(max / nice) }, (_, i) => (i + 1) * nice); };
const fmt = (v: number, unit: string) => unit === "h" ? `${Math.round(v / 6) / 10} h` : `${v.toLocaleString("en-IN")}${unit ? ` ${unit}` : ""}`;

/** Weeks as stacked columns. `unit` is "pts", "tasks" or "h" (values in minutes for hours). */
export function WeekColumns({ title, weeks, series, unit, height = 170, note, labels, now: nowAt }: { title: string; weeks: string[]; series: Series[]; unit: string; height?: number; note?: string;
  /** TASKS-4B: a label per column (days: "Mon"…), shown under every column and in its tooltip; `now` marks today's. */ labels?: string[]; now?: number }) {
  const [table, setTable] = useState(false);
  const totals = weeks.map((_, i) => series.reduce((n, s) => n + s.values[i], 0));
  const max = Math.max(unit === "h" ? 60 : 1, ...totals); const ticks = ticksFor(unit === "h" ? Math.ceil(max / 60) : max).map((t) => unit === "h" ? t * 60 : t);
  const top = Math.max(max, ticks.at(-1) ?? max);
  const now = nowAt ?? weeks.length - 1;
  const named = (i: number) => labels ? labels[i] : `Week of ${label(weeks[i])}`;
  return <figure className={css.chart} aria-label={title}>
    <div className={css.chartTop}>
      {series.length > 1 ? <ul className={css.legend}>{series.map((s) => <li key={s.key}><i data-slot={s.slot ?? "other"} data-faint={s.faint ? "" : undefined} aria-hidden="true" />{s.label}</li>)}</ul> : <span />}
      <button type="button" className={css.tableBtn} aria-pressed={table} onClick={() => setTable(!table)}><Table2 size={13} aria-hidden="true" />{table ? "Chart" : "Table"}</button>
    </div>
    {table ? <div className={css.tableWrap}><table className={css.table}><caption className={css.srOnly}>{title}</caption>
      <thead><tr><th scope="col">{labels ? "Day" : "Week of"}</th>{series.map((s) => <th key={s.key} scope="col">{s.label}</th>)}{series.length > 1 ? <th scope="col">Total</th> : null}</tr></thead>
      <tbody>{weeks.map((w, i) => <tr key={`${w}-${i}`}><th scope="row">{labels ? labels[i] : label(w)}</th>{series.map((s) => <td key={s.key}>{fmt(s.values[i], unit)}</td>)}{series.length > 1 ? <td>{fmt(totals[i], unit)}</td> : null}</tr>)}</tbody></table></div>
      : <div className={css.plot} style={{ height }}>
        {ticks.map((t, i) => <span key={i} className={css.grid} style={{ bottom: `${(100 * t) / top}%` }}><i>{fmt(t, unit === "h" ? "h" : "")}</i></span>)}
        {weeks.map((w, i) => {
          let below = 0;
          return <span key={`${w}-${i}`} className={css.col} tabIndex={0} data-now={i === now ? "" : undefined} aria-label={`${named(i)}: ${series.map((s) => `${s.label} ${fmt(s.values[i], unit)}`).join(", ")}`}>
            <span className={css.stack}>{series.map((s, k) => { const v = s.values[i]; if (!v) return null; const h = (100 * v) / top; const seg = <i key={s.key} data-slot={s.slot ?? "other"} data-faint={s.faint ? "" : undefined}
              data-top={series.slice(k + 1).every((x) => !x.values[i]) ? "" : undefined} style={{ bottom: `calc(${(100 * below) / top}% + ${below ? 2 : 0}px)`, height: `calc(${h}% - ${below ? 2 : 0}px)` }} />; below += v; return seg; })}</span>
            {i === now && totals[i] ? <span className={css.cap} style={{ bottom: `calc(${(100 * totals[i]) / top}% + 4px)` }}>{fmt(totals[i], unit === "h" ? "h" : "")}</span> : null}
            <span className={css.tip} role="tooltip"><b>{named(i)}</b>{series.map((s) => <span key={s.key}><i data-slot={s.slot ?? "other"} data-faint={s.faint ? "" : undefined} aria-hidden="true" />{s.label}<em>{fmt(s.values[i], unit)}</em></span>)}
              {series.length > 1 ? <span className={css.tipTotal}>Total<em>{fmt(totals[i], unit)}</em></span> : null}</span>
          </span>;
        })}
      </div>}
    {!table ? <div className={css.axis} aria-hidden="true">{weeks.map((w, i) => <span key={`${w}-${i}`}>{labels ? (i === now ? "Today" : labels[i].slice(0, 3)) : i === now ? "Now" : i % 3 === now % 3 ? label(w) : ""}</span>)}</div> : null}
    {note ? <figcaption className={css.note}>{note}</figcaption> : null}
  </figure>;
}

/** Twelve weeks of days, one square each, darker for more finished; Sundays are the usual weekly off. */
export function DayCalendar({ days }: { days: { day: string; done: number }[] }) {
  const first = new Date(`${days[0].day}T00:00:00Z`).getUTCDay(); const pad = (first + 6) % 7;
  const cells = [...Array.from({ length: pad }, () => null), ...days];
  const level = (n: number) => n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : 3;
  return <div className={css.calendarWrap}>
    <div className={css.calendar} role="img" aria-label={`Tasks finished per day over twelve weeks: ${days.filter((d) => d.done).length} days with something finished`}>
      {cells.map((c, i) => c ? <span key={c.day} data-level={level(c.done)} title={`${label(c.day)}: ${c.done} finished`} /> : <span key={`pad${i}`} data-pad="" />)}
    </div>
    <div className={css.calendarKey} aria-hidden="true"><span>Less</span>{[0, 1, 2, 3].map((l) => <i key={l} data-level={l} />)}<span>More</span></div>
  </div>;
}

/** A small line of the last weeks with the current one marked; no axis (the number beside it carries the value). */
export function Spark({ values, label: name }: { values: number[]; label: string }) {
  const w = 88, h = 26, max = Math.max(1, ...values);
  const pts = values.map((v, i) => [Math.round((i / Math.max(1, values.length - 1)) * (w - 6)) + 3, Math.round(h - 3 - (v / max) * (h - 6))]);
  return <svg className={css.spark} width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${name}: ${values.join(", ")}`}>
    <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" />
    <circle cx={pts.at(-1)![0]} cy={pts.at(-1)![1]} r={3.5} />
  </svg>;
}

/** Value per week, split by project or by domain (the reader switches; colours follow the entity, not its rank). */
export function ValueByWeek({ weeks, byProject, byDomain, note }: { weeks: string[]; byProject: Series[]; byDomain: Series[]; note?: string }) {
  const [by, setBy] = useState<"project" | "domain">("project");
  const slot = (list: Series[]) => list.map((s, i) => ({ ...s, slot: s.key === "·other" ? "other" as const : i + 1 }));
  return <section className={css.card} aria-labelledby="value-title">
    <div className={css.cardHead}><h2 id="value-title">Accepted work per week</h2>
      <span className={css.seg} role="group" aria-label="Split by">{(["project", "domain"] as const).map((k) => <button key={k} type="button" aria-pressed={by === k} onClick={() => setBy(k)}>By {k}</button>)}</span></div>
    <div className={css.cardBody}><WeekColumns title={`Tasks accepted per week, by ${by}`} weeks={weeks} series={slot(by === "project" ? byProject : byDomain)} unit="tasks" note={note} /></div>
  </section>;
}
