import Link from 'next/link';
import { ArrowDownRight, ArrowUpRight, CircleAlert, CircleCheck, Info, Minus, TriangleAlert } from 'lucide-react';
import { Kpi, Panel, Spark, Tiles } from '../ui';
import { bullets, costMix, inr, kpis, monthSpan, pct, topClients, trend, type Bullet, type KpiSpec } from '../lib/finance-view.mjs';
import type { LiveState } from './types';
import { Conf } from './live';
import { HBars, MoneyTrend } from './charts';
import { Details } from './details';
import css from './fin.module.css';

/** Signed change against the month before, as text and an arrow. `up="bad"` for costs, where a rise is bad news. */
function Change({ value, previous, up }: { value: number; previous: number; up?: 'bad' }) {
 if (!previous) return null;
 const p = Math.round((value / previous - 1) * 100);
 if (!p) return <span className={css.change} data-tone="flat"><Minus size={12} aria-hidden="true" />0%</span>;
 const good = up === 'bad' ? p < 0 : p > 0, Icon = p > 0 ? ArrowUpRight : ArrowDownRight;
 return <span className={css.change} data-tone={good ? 'good' : 'bad'} title="Against the month before"><Icon size={13} aria-hidden="true" /><span className={css.srOnly}>{p > 0 ? 'up' : 'down'} </span>{Math.abs(p)}%</span>;
}

function Tile({ k }: { k: KpiSpec }) {
 // Words in place of a figure ("Statement needed") are set smaller so they fit the tile.
 return <Kpi label={k.label} value={/^[−-]?₹|^\d/.test(k.value) ? k.value : <span className={css.wordValue}>{k.value}</span>} href={k.href} tone={k.tone} note={k.note}
  delta={k.delta ? <Change value={k.delta.value} previous={k.delta.previous} up={k.up} /> : undefined}
  spark={k.spark ? <Spark values={k.spark} label={`${k.label}, last ${k.spark.length} months`} /> : undefined} />;
}

const TONE = {
 good: { icon: CircleCheck, label: 'Good news' },
 warn: { icon: CircleAlert, label: 'Watch' },
 bad: { icon: TriangleAlert, label: 'Needs attention' },
 info: { icon: Info, label: 'For information' },
} as const;

function BriefItem({ b }: { b: Bullet }) {
 const tone = TONE[b.tone as keyof typeof TONE] ?? TONE.info, Icon = tone.icon;
 return <li><article className={css.bullet} data-tone={b.tone}>
  <span className={css.bulletIcon} title={tone.label}><Icon size={15} aria-hidden="true" /><span className={css.srOnly}>{tone.label}: </span></span>
  <p className={css.bulletText}>{b.before}<b>{b.figure}</b>{b.after}</p>
  <div className={css.bulletFoot}><Conf level={b.confidence} />
   <Details title={b.title} sub={`Finance brief · ${b.view}`}>
    <p>{b.paragraph}</p>
    <dl className={css.facts}><div><dt>Source</dt><dd>{b.basis}</dd></div><div><dt>Confidence</dt><dd><Conf level={b.confidence} /></dd></div><div><dt>Status</dt><dd>Uncertified until the CA certifies the month</dd></div></dl>
    <Link className={css.openLink} href={b.href}>Open {b.view} →</Link>
   </Details></div>
 </article></li>;
}

/** FINANCE-UI Overview: six tiles, the brief as short sentences, and four charts. On a computer it fits one window. */
export function FinanceOverview({ live }: { live: LiveState }) {
 const m = live.model!;
 const tiles = kpis(m), brief = bullets(m), points = trend(m, 18), mix = costMix(m), clients = topClients(m);
 const od = m.collections.overdue;
 const shown = points.filter((p) => p.revenue !== null || p.cost !== null);
 return <div className={css.overview} data-grow="">
  <Tiles count={6} dense>{tiles.map((k) => <Tile key={k.key} k={k} />)}</Tiles>
  <div className={css.board}>
   <Panel className={css.briefPanel} title="What the founders should know" >
    <ul className={css.bullets} aria-label="Finance brief">{brief.map((b) => <BriefItem key={b.key} b={b} />)}</ul>
   </Panel>
   <Panel className={css.trendPanel} title="Revenue vs costs" sub={shown.length ? `${monthSpan([points[0].month, points.at(-1)!.month])} · ex-GST` : undefined} action={{ href: '/finance?tab=income', label: 'Revenue' }}>
    <div className={css.chartBody}><MoneyTrend fill points={points} label="Revenue and costs by month" /></div>
   </Panel>
   <Panel className={css.agePanel} title="Collections ageing" action={{ href: '/finance?tab=revenue', label: 'See all' }}>
    <div className={css.chartBody}><HBars ramp label="Overdue invoices by days past due" empty="Nothing is overdue."
     items={od.buckets.map((b) => ({ key: b.bucket, label: b.bucket, sub: `${b.count} invoices`, value: b.amount, display: inr(b.amount), href: '/finance?tab=revenue' }))}
     more={<p className={css.chartNote}>{od.confirmed.count ? `${od.confirmed.count} confirmed unpaid · ${od.count - od.confirmed.count} after the last statement` : `${od.count} invoices past due`}</p>} /></div>
   </Panel>
   <Panel className={css.clientsPanel} title="Top clients" sub="ex-GST" action={{ href: '/finance?tab=clients', label: 'See all' }}>
    <div className={css.chartBody}><HBars label="Largest clients by invoicing" empty="No client invoices in finance mail yet."
     items={clients.items.map((x) => ({ key: x.client, label: x.client, sub: pct(x.invoiceShare), value: x.invoiced, display: inr(x.invoiced), href: x.clientId ? `/clients/${x.clientId}` : '/finance?tab=clients' }))}
     more={clients.rest.count ? <p className={css.chartNote}>{clients.rest.count} more clients · {inr(clients.rest.invoiced)} ({pct(clients.rest.share)})</p> : null} /></div>
   </Panel>
   <Panel className={css.costPanel} title="Cost categories" action={{ href: '/finance?tab=budget', label: 'See all' }}>
    <div className={css.chartBody}><HBars side="out" label="Average monthly cost by category" empty="The monthly cost sheet has no months yet."
     items={mix.items.map((x) => ({ key: x.category, label: x.label, sub: pct(x.share), value: x.avg, display: inr(x.avg), href: '/finance?tab=budget' }))}
     more={mix.total ? <p className={css.chartNote}>{inr(mix.total)} a month · avg {monthSpan([mix.months[0], mix.months.at(-1)!])}</p> : null} /></div>
   </Panel>
  </div>
 </div>;
}
