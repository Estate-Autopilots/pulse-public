import type { CSSProperties } from 'react';
import { niceMax } from '../lib/format';
import { inr, inrShort } from '../lib/finance-view.mjs';
import css from './kit.module.css';

/* UX-FINANCE: a trend people can trust. Columns per month for up to two series on one rupee axis that starts at zero
   (and goes below it only when a figure does), an optional line for a third (the net), gridlines with short labels,
   and each month a keyboard stop whose name reads every figure aloud and whose tip shows them. Money in is iris,
   money out orange (the Finance chart colours, validated for colour-blind separation in light and dark). */

export type TrendSeries = { key: string; label: string; tone: 'in' | 'out' };
export type TrendPoint = { month: string; label: string; values: Record<string, number | null> };
const COLOUR: Record<string, string> = { in: 'var(--stripe-in)', out: 'var(--stripe-out)' };

export function TrendChart({ points, series, line, label, height = 200, empty = 'No figures for these months yet.' }: {
  points: TrendPoint[]; series: TrendSeries[]; line?: { key: string; label: string }; label: string; height?: number; empty?: string;
}) {
  const keys = [...series.map((s) => s.key), ...(line ? [line.key] : [])];
  const some = points.filter((p) => keys.some((k) => p.values[k]));
  if (some.length < 2) return <p className={css.chartEmpty}>{some.length ? `Only one month has figures so far: ${some[0].label}. The trend draws from the second month.` : empty}</p>;
  const all = points.flatMap((p) => keys.map((k) => p.values[k] ?? 0));
  const top = niceMax(Math.max(1, ...all)), lowest = Math.min(0, ...all);
  const bottom = lowest < 0 ? -niceMax(-lowest) : 0, range = top - bottom;
  const y = (v: number) => ((v - bottom) / range) * 100;
  const zero = y(0);
  const ticks = bottom < 0 ? [bottom, 0, top / 2, top] : [0, top / 4, top / 2, (top * 3) / 4, top];
  const n = points.length;
  const linePts = line ? points.map((p, i) => [((i + 0.5) / n) * 100, p.values[line.key]] as const).filter(([, v]) => v !== null && v !== undefined) : [];
  return <figure className={`${css.kit} ${css.chart}`} role="group" aria-label={label}>
    <figcaption className={css.legend}>{series.map((s) => <span key={s.key}><i className={css.swatch} style={{ '--c': COLOUR[s.tone] } as CSSProperties} aria-hidden="true" />{s.label}</span>)}
      {line ? <span><i className={css.swatch} data-line="" style={{ '--c': 'var(--theme-text)' } as CSSProperties} aria-hidden="true" />{line.label}</span> : null}</figcaption>
    <div className={css.plot} style={{ '--h': `${height}px` } as CSSProperties}>
      {ticks.map((t) => <div key={t} className={css.gridLine} data-zero={t === 0 ? '' : undefined} style={{ bottom: `${y(t)}%` }}><span>{t ? inrShort(t) : '₹0'}</span></div>)}
      <div className={css.cols}>{points.map((p) => {
        const words = `${p.label}: ${[...series, ...(line ? [line] : [])].map((s) => `${s.label.toLowerCase()} ${p.values[s.key] === null || p.values[s.key] === undefined ? 'not recorded' : inr(p.values[s.key])}`).join(', ')}`;
        return <span key={p.month} className={css.col} tabIndex={0} role="img" aria-label={words}>
          <span className={css.bars} aria-hidden="true">{series.map((s) => { const v = p.values[s.key] ?? 0; return <span key={s.key} className={css.bar}>
            <i data-neg={v < 0 ? '' : undefined} style={{ '--c': COLOUR[s.tone], '--b': `${v < 0 ? y(v) : zero}%`, '--v': `${v ? Math.max(0.8, (Math.abs(v) / range) * 100) : 0}%` } as CSSProperties} /></span>; })}</span>
          <span className={css.tip} aria-hidden="true"><b>{p.label}</b>{series.map((s) => <span key={s.key}><i className={css.swatch} style={{ '--c': COLOUR[s.tone] } as CSSProperties} />{s.label}: {p.values[s.key] === null || p.values[s.key] === undefined ? 'not recorded' : inr(p.values[s.key])}</span>)}
            {line ? <span><i className={css.swatch} data-line="" style={{ '--c': 'var(--theme-text)' } as CSSProperties} />{line.label}: {p.values[line.key] === null || p.values[line.key] === undefined ? 'not recorded' : inr(p.values[line.key])}</span> : null}</span>
        </span>;
      })}</div>
      {linePts.length > 1 ? <svg className={css.line} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points={linePts.map(([x, v]) => `${x},${100 - y(v as number)}`).join(' ')} /></svg> : null}
      {linePts.map(([x, v]) => <i key={x} className={css.dot} style={{ left: `${x}%`, bottom: `${y(v as number)}%` }} aria-hidden="true" />)}
    </div>
    <div className={css.axis} data-many={n > 6 ? '' : undefined} aria-hidden="true">{points.map((p) => <span key={p.month}>{p.label.replace(/ 20(\d\d)$/, ' ’$1')}</span>)}</div>
  </figure>;
}
