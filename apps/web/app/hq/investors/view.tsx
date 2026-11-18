"use client";
// GROWTH-LOOP slice 1: Codex concept 1 "Tiles with sparklines" (one tile per number with its 12-week line and the
// week's change), concept 2's one-line headline, and one large weekly chart where you pick the number. A table view
// of every week sits under "See the weeks as a table"; "How we count" names each rule.
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ArrowDownRight, ArrowUpRight, Check, Copy, Minus } from "lucide-react";
import { Columns } from "../../charts";
import { METRICS, change, deckText, funnel, headline, num, series, sparkPoints, total, weekLabel, type InvestorData } from "../../lib/investors.mjs";
import hq from "../hq.module.css";
import css from "./investors.module.css";

function ago(iso: string, now: number) {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} ${mins === 1 ? "minute" : "minutes"} ago`;
  const h = Math.round(mins / 60);
  return `${h} ${h === 1 ? "hour" : "hours"} ago`;
}

function Spark({ values, label }: { values: number[]; label: string }) {
  const pts = sparkPoints(values);
  if (!pts) return <span className={css.sparkEmpty}>The line draws from the second week.</span>;
  const last = pts.split(" ").pop()!.split(",");
  return <svg className={css.spark} viewBox="0 0 100 28" preserveAspectRatio="none" role="img" aria-label={`${label}, last ${values.length} weeks: ${values.map(num).join(", ")}`}>
    <polyline points={`0,28 ${pts} 100,28`} className={css.sparkArea} />
    <polyline points={pts} className={css.sparkLine} vectorEffect="non-scaling-stroke" />
    <circle cx={last[0]} cy={last[1]} r="2.4" className={css.sparkDot} vectorEffect="non-scaling-stroke" />
  </svg>;
}

export function InvestorView({ data }: { data: InvestorData }) {
  const [pick, setPick] = useState(METRICS[0].key);
  const [copied, setCopied] = useState<"" | "ok" | "no">("");
  const [now, setNow] = useState(() => Date.parse(data.asOf));
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); const first = setTimeout(() => setNow(Date.now()), 0); return () => { clearInterval(t); clearTimeout(first); }; }, []);
  const metric = METRICS.find((m) => m.key === pick) ?? METRICS[0];
  const picked = series(data, metric);
  const items = useMemo(() => data.weeks.map((w, i) => ({
    key: w, label: i % 2 === data.weeks.length % 2 || i === data.weeks.length - 1 ? weekLabel(w) : "", value: picked[i] ?? 0,
    tip: `${num(picked[i] ?? 0)} · week of ${weekLabel(w)}`, tipSub: metric.label, on: i === data.weeks.length - 1,
  })), [data.weeks, picked, metric.label]);
  const copy = () => void navigator.clipboard.writeText(deckText(data)).then(() => setCopied("ok"), () => setCopied("no"));
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(""), 2600); return () => clearTimeout(t); }, [copied]);

  return <>
    <header className={hq.pageHead}>
      <div><h1>Investor numbers</h1><p>Across the whole Vitals network. Totals only: no company is named.</p></div>
      <button type="button" className={css.primary} onClick={copy}>{copied === "ok" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{copied === "ok" ? "Copied" : "Copy for the deck"}</button>
    </header>
    <p className={css.status} role="status" aria-live="polite">{copied === "no" ? "Your browser did not allow copying. Select the table below instead." : ""}</p>
    <p className={css.headline}>{headline(data)}</p>

    <section className={css.tiles} aria-label="The numbers">
      {METRICS.map((m, i) => {
        const ch = change(data, m);
        const Arrow = ch.tone === "up" ? ArrowUpRight : ch.tone === "down" ? ArrowDownRight : Minus;
        return <button type="button" key={m.key} className={css.tile} data-on={m.key === pick ? "" : undefined} aria-pressed={m.key === pick}
          style={{ "--i": i } as CSSProperties} onClick={() => setPick(m.key)}>
          <span className={css.tileLabel}>{m.label}</span>
          <span className={css.tileValue}>{num(total(data, m))}</span>
          <span className={css.change} data-tone={ch.tone}><Arrow size={14} aria-hidden="true" />{ch.text}</span>
          {m.key === "chatUsers" ? <span className={css.sub}>{num(data.totals.chatUsersClient ?? 0)} client-side</span> : null}
          <Spark values={series(data, m)} label={m.label} />
        </button>;
      })}
    </section>

    <section className={css.chartCard} aria-labelledby="gl-chart">
      <div className={css.chartHead}>
        <h2 id="gl-chart">{metric.label} <span>each week, last {data.weeks.length} weeks</span></h2>
        <label className={css.pick}><span className={css.srOnly}>Number to show</span>
          <select value={pick} onChange={(e) => setPick(e.target.value)}>{METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select>
        </label>
      </div>
      <Columns items={items} label={`${metric.label}, each week`} steps={4} />
      <p className={css.note}>{metric.how}</p>
    </section>

    <section className={css.funnel} aria-labelledby="gl-funnel">
      <h2 id="gl-funnel">“What is Vitals?” on other companies’ pages</h2>
      {(() => { const f = funnel(data); return <ol className={css.steps}>
        <li><b>{num(f.viewed)}</b><span>saw the card</span></li>
        <li><b>{num(f.clicked)}</b><span>pressed “Start free” <em>{f.clickRate}</em></span></li>
        <li><b>{num(f.made)}</b><span>opened their own company <em>{f.madeRate}</em></span></li>
      </ol>; })()}
      <p className={css.note}>Client-side people and guests see the card in a company’s chat, quotation link and agreement link. A visitor counts once a week.</p>
    </section>

    <details className={css.more}>
      <summary>See the weeks as a table</summary>
      <div className={css.tableWrap}><table className={css.table}>
        <thead><tr><th scope="col">Week of</th>{METRICS.map((m) => <th key={m.key} scope="col">{m.label}</th>)}</tr></thead>
        <tbody>{data.weeks.map((w, i) => <tr key={w}><th scope="row">{weekLabel(w)}</th>{METRICS.map((m) => <td key={m.key}>{num(series(data, m)[i] ?? 0)}</td>)}</tr>)}</tbody>
      </table></div>
    </details>
    <details className={css.more}>
      <summary>How we count</summary>
      <ul className={css.rules}>{METRICS.map((m) => <li key={m.key}><b>{m.label}.</b> {m.how}</li>)}
        <li>Weeks start on Monday, India time. Practice companies and personal workspaces are left out. A person in two companies with one Vitals sign-in counts once.</li>
      </ul>
    </details>
    <p className={css.foot}>Counted from live data · updated {ago(data.asOf, now)}</p>
  </>;
}
