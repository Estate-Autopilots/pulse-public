import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { niceMax } from '../lib/format';
import { inr, inrShort, monthName, monthTick, type TrendPoint } from '../lib/finance-view.mjs';
import c from './charts.module.css';

/* FINANCE-UI charts. One colour per side of the money everywhere in Finance: money in (revenue, clients, receivables)
   is Pulse iris, money out (costs, categories) is orange; both validated for colour-blind separation in light and
   dark. Ordered buckets (ageing) use one iris ramp, older = stronger. Labels and values stay in text colours. */

const h = (v: number | null, max: number) => ({ '--h': `${v ? Math.max(1.5, Math.min(100, (v / max) * 100)) : 0}%` }) as CSSProperties;

/** Revenue and costs month by month on one rupee axis: two thin columns per month, a tip with both and the net. */
export function MoneyTrend({ points, label, fill, names = { in: 'Revenue', out: 'Costs', inTip: 'invoiced', outTip: 'costs' } }: { points: TrendPoint[]; label: string; /** Grow with the panel on a computer. */ fill?: boolean; names?: { in: string; out: string; inTip: string; outTip: string } }) {
 const shown = points.filter((p) => p.revenue !== null || p.cost !== null);
 if (shown.length < 3) return <p className={c.empty}>{shown.length ? `Only ${shown.length} month${shown.length > 1 ? 's have' : ' has'} revenue or cost figures so far.` : 'No revenue or cost figures for these months yet.'}</p>;
 const max = niceMax(Math.max(1, ...points.flatMap((p) => [p.revenue ?? 0, p.cost ?? 0])));
 const ticks = [0, max / 2, max];
 const bank = points.some((p) => p.bank);
 return <figure className={c.chart} role="group" aria-label={label} data-fill={fill ? '' : undefined} data-dense={points.length > 20 ? '' : undefined}>
  <div className={c.legend} aria-hidden="true"><span><i data-s="in" />{names.in}</span><span><i data-s="out" />{names.out}</span>{bank ? <span><i data-s="in" data-bank="" />Bank credits, before invoicing</span> : null}</div>
  <div className={c.plot}>
   {ticks.map((t) => <div key={t} className={c.grid} data-base={t === 0 ? '' : undefined} style={{ bottom: `${(t / max) * 100}%` }}><span>{t ? inrShort(t) : '₹0'}</span></div>)}
   <div className={c.groups}>{points.map((p) => {
    const net = p.revenue !== null && p.cost !== null ? p.revenue - p.cost : null;
    const words = `${monthName(p.month)}: ${names.in.toLowerCase()} ${p.revenue === null ? 'unknown' : inr(p.revenue)}, ${names.out.toLowerCase()} ${p.cost === null ? 'not recorded' : inr(p.cost)}${net === null ? '' : `, net ${inr(net)}`}`;
    return <span key={p.month} className={c.group} tabIndex={0} aria-label={words}>
     <i className={c.bar} data-s="in" data-bank={p.bank ? '' : undefined} style={h(p.revenue, max)} />
     <i className={c.bar} data-s="out" style={h(p.cost, max)} />
     <span className={c.tip} aria-hidden="true"><b>{monthName(p.month)}</b>
      <span><i data-s="in" />{p.revenue === null ? `${names.in} unknown` : `${inr(p.revenue)} ${p.bank ? 'bank credits' : names.inTip}`}</span>
      <span><i data-s="out" />{p.cost === null ? `${names.out} not recorded yet` : `${inr(p.cost)} ${names.outTip}`}</span>
      {net === null ? null : <span className={c.tipNet}>Net {inr(net)}</span>}</span>
    </span>;
   })}</div>
  </div>
  <div className={c.axis} aria-hidden="true">{points.map((p, i) => <span key={p.month} data-k={(points.length - 1 - i) % 6}>{monthTick(p.month)}</span>)}</div>
 </figure>;
}

export type HBar = { key: string; label: string; value: number; display: string; sub?: string; href?: string; tip?: string };

/** Ranked horizontal bars on one zero-based scale: the name above its bar, the value at the end. `ramp` colours ordered
 *  buckets from light to strong; otherwise every bar is the side's single colour. */
export function HBars({ items, side = 'in', label, ramp, empty = 'Nothing recorded yet.', more }: { items: HBar[]; side?: 'in' | 'out'; label: string; ramp?: boolean; empty?: string; more?: ReactNode }) {
 if (!items.length) return <p className={c.empty}>{empty}</p>;
 const max = Math.max(1, ...items.map((i) => i.value));
 return <div className={c.hwrap}><ul className={c.hbars} aria-label={label}>{items.map((i, n) => {
  const body = <><span className={c.hlabel}>{i.label}{i.sub ? <small>{i.sub}</small> : null}</span><b className={c.hvalue}>{i.display}</b>
   <span className={c.track} aria-hidden="true"><i data-s={ramp ? 'age' : side} data-step={ramp ? Math.min(4, n + 1) : undefined} style={{ width: `${i.value > 0 ? Math.max(1, (i.value / max) * 100) : 0}%` }} /></span></>;
  return <li key={i.key}>{i.href ? <Link className={c.hrow} href={i.href} title={i.tip ?? `${i.label}: ${i.display}`}>{body}</Link> : <span className={c.hrow} title={i.tip ?? `${i.label}: ${i.display}`}>{body}</span>}</li>;
 })}</ul>{more}</div>;
}

export type MonthPoint = { month: string; value: number | null; muted?: boolean; tip: string; tipSub?: string };

/** One series of monthly columns on a rupee axis (revenue, ad funding). Muted columns are a weaker basis, named in the legend. */
export function MonthBars({ points, label, side = 'in', legend, mutedLabel, fill }: { points: MonthPoint[]; label: string; side?: 'in' | 'out'; legend?: string; mutedLabel?: string; fill?: boolean }) {
 const some = points.filter((p) => p.value);
 if (some.length < 3) return <p className={c.empty}>{some.length ? `Only ${some.length} month${some.length > 1 ? 's have' : ' has'} figures so far.` : 'No figures for these months yet.'}</p>;
 const max = niceMax(Math.max(1, ...points.map((p) => p.value ?? 0)));
 const muted = points.some((p) => p.muted && p.value);
 return <figure className={c.chart} role="group" aria-label={label} data-fill={fill ? '' : undefined} data-dense={points.length > 20 ? '' : undefined} data-single="">
  {legend || muted ? <div className={c.legend} aria-hidden="true">{legend ? <span><i data-s={side} />{legend}</span> : null}{muted && mutedLabel ? <span><i data-s={side} data-bank="" />{mutedLabel}</span> : null}</div> : null}
  <div className={c.plot}>
   {[0, max / 2, max].map((t) => <div key={t} className={c.grid} data-base={t === 0 ? '' : undefined} style={{ bottom: `${(t / max) * 100}%` }}><span>{t ? inrShort(t) : '₹0'}</span></div>)}
   <div className={c.groups}>{points.map((p) => <span key={p.month} className={c.group} tabIndex={0} aria-label={`${monthName(p.month)}: ${p.tip}`}>
    <i className={c.bar} data-s={side} data-bank={p.muted ? '' : undefined} style={h(p.value, max)} />
    <span className={c.tip} aria-hidden="true"><b>{monthName(p.month)}</b><span>{p.tip}</span>{p.tipSub ? <span className={c.tipNet}>{p.tipSub}</span> : null}</span>
   </span>)}</div>
  </div>
  <div className={c.axis} aria-hidden="true">{points.map((p, i) => <span key={p.month} data-k={(points.length - 1 - i) % 6}>{monthTick(p.month)}</span>)}</div>
 </figure>;
}
