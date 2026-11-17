import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { niceMax } from "./lib/format";
import { change, sparse } from "./lib/sparse.mjs";
import d from "./dashboard/dash.module.css";
import styles from "./ui.module.css";

export type BarItem = { key: string; label: string; sub?: string; value: number; href?: string; note?: ReactNode };

/** Ranked horizontal bars on one zero-based scale: one hue, the value written at the end of every bar. */
export function BarList({ items, total, unit = "", empty = "Nothing to show yet." }: { items: BarItem[]; total?: number; unit?: string; empty?: string }) {
  const few = sparse(items);
  if (few) return <SparseFacts label="Counts by category" total={items.length} compare={false} empty={empty}
    facts={few.map((i) => ({ key: i.key, n: i.value, value: `${i.value}${unit}`, text: i.label,
      sub: [i.sub, total ? `${Math.round((i.value / total) * 100)}%` : null].filter(Boolean).join(" · ") || undefined, href: i.href }))} />;
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <p className={styles.chartEmpty}>{empty}</p>;
  return (
    <ul className={`${styles.barList} ${d.bars}`}>{items.map((i) => {
      const share = total ? ` · ${Math.round((i.value / total) * 100)}%` : "";
      const body = <>
        <span className={styles.barListLabel} title={i.label}>{i.label}{i.sub ? <small>{i.sub}</small> : null}</span>
        <span className={`${styles.barListTrack} ${d.track}`} aria-hidden="true"><i style={{ width: `${(i.value / max) * 100}%` }} /></span>
        <span className={styles.barListValue}>{i.value}{unit}{total ? <small>{Math.round((i.value / total) * 100)}%</small> : null}</span>
      </>;
      return <li key={i.key}>{i.href ? <Link href={i.href} className={styles.barListRow} title={`${i.label}: ${i.value}${unit}${share}`}>{body}</Link> : <span className={styles.barListRow} title={`${i.label}: ${i.value}${unit}${share}`}>{body}</span>}</li>;
    })}</ul>
  );
}

export type ColItem = { key: string; label: string; value: number; tip: string; tipSub?: string; on?: boolean; href?: string; muted?: boolean };

/** Columns over time on a zero-based scale with a hover tip per column. `suffix` is written after axis and value labels. */
export function Columns({ items, suffix = "", max: fixedMax, label, steps = 2 }: { items: ColItem[]; suffix?: string; max?: number; label: string; /** Gridlines above the baseline; a large plot can carry four. */ steps?: 2 | 4 }) {
  const few = sparse(items);
  if (few) return <SparseFacts label={label} total={items.length} facts={few.map((i) => ({ key: i.key, value: `${i.value}${suffix}`, text: i.tip, sub: i.tipSub ?? i.label, href: i.href, n: i.value }))} />;
  const max = fixedMax ?? niceMax(Math.max(1, ...items.map((i) => i.value)));
  const ticks = Array.from({ length: steps + 1 }, (_, i) => (max / steps) * i);
  return (
    <div className={styles.chart} role="group" aria-label={label}>
      <div className={styles.plot}>
        {ticks.map((t) => <div key={t} className={styles.gridline} data-base={t === 0 ? "" : undefined} style={{ bottom: `${(t / max) * 100}%` }}><span>{Number.isInteger(t) ? t : t.toFixed(1)}{suffix}</span></div>)}
        <div className={styles.cols}>{items.map((i) => {
          const inner = <>
            <span className={`${styles.bar} ${d.colBar}`} data-some={i.value ? "" : undefined} data-muted={i.muted ? "" : undefined} />
            {i.on ? <span className={styles.barValue}>{i.value}{suffix}</span> : null}
            <span className={styles.tip} aria-hidden="true"><b>{i.tip}</b>{i.tipSub ? <span>{i.tipSub}</span> : null}</span>
          </>;
          const props = { className: styles.col, "data-on": i.on ? "" : undefined, style: { "--h": `${Math.min(100, (i.value / max) * 100)}%` } as CSSProperties, "aria-label": `${i.label}: ${i.tip}` };
          return i.href ? <Link key={i.key} href={i.href} {...props}>{inner}</Link> : <span key={i.key} tabIndex={0} {...props}>{inner}</span>;
        })}</div>
      </div>
      <div className={styles.axis} aria-hidden="true">{items.map((i) => <span key={i.key} data-on={i.on ? "" : undefined}>{i.label}</span>)}</div>
    </div>
  );
}

/** Too few points for a chart: the values themselves, side by side, and what changed between two of them. */
export function SparseFacts({ label, facts, total, compare = true, empty = "Nothing recorded in this period yet." }: { label: string; facts: { key: string; value: ReactNode; text: ReactNode; sub?: ReactNode; href?: string; n: number }[]; total: number; compare?: boolean; empty?: string }) {
  if (!facts.length) return <p className={styles.chartEmpty} role="note" aria-label={label}>{empty}</p>;
  return (
    <div className={styles.sparse} role="group" aria-label={label}>
      <div className={styles.sparseRow}>{facts.map((f, i) => {
        const body = <><b>{f.value}</b><span>{f.text}</span>{f.sub ? <small>{f.sub}</small> : null}</>;
        return <div key={f.key} className={styles.sparseItem}>{compare && i === 1 ? <span className={styles.sparseChange}>{change(facts[0].n, f.n)}</span> : null}{f.href ? <Link href={f.href} className={styles.sparseFact}>{body}</Link> : <div className={styles.sparseFact}>{body}</div>}</div>;
      })}</div>
      {facts.length < total ? <p className={styles.sparseNote}>{facts.length === 1 ? `Only one of the ${total} has any so far.` : `Only two of the ${total} have any so far.`}</p> : null}
    </div>
  );
}

export type Part = { key: string; label: string; value: number; tone: "accent" | "success" | "warning" | "neutral" | "danger" };

/** One bar split into named parts, each written out underneath: the parts are never told apart by colour alone. */
export function Split({ parts, unit }: { parts: Part[]; unit: string }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  const draw = parts.filter((p) => p.value > 0).length >= 3;
  return (
    <div className={styles.split}>
      {draw ? <div className={styles.splitBar} role="img" aria-label={parts.map((p) => `${p.label}: ${p.value} ${unit}`).join(", ")}>
        {total ? parts.filter((p) => p.value).map((p) => <i key={p.key} data-tone={p.tone} style={{ flexGrow: p.value }} />) : <i data-tone="neutral" style={{ flexGrow: 1, opacity: 0.4 }} />}
      </div> : null}
      <ul className={styles.splitLegend}>{parts.map((p) => (
        <li key={p.key}><i data-tone={p.tone} aria-hidden="true" /><span>{p.label}</span><b>{p.value}</b><small>{total ? `${Math.round((p.value / total) * 100)}%` : "–"}</small></li>
      ))}</ul>
    </div>
  );
}

/** A small headline figure inside a panel. */
export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "warning" | "success" | "danger" }) {
  return <div className={styles.stat}><span className={styles.statLabel}>{tone ? <i className={styles.stateDot} data-tone={tone} /> : null}{label}</span><b className={styles.statValue}>{value}</b>{note ? <span className={styles.statNote}>{note}</span> : null}</div>;
}
