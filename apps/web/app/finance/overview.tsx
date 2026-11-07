import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, BarChart3, CircleAlert, CircleCheck, Database, Info, Mail, Minus, Sparkles, TriangleAlert } from 'lucide-react';
import { Spark } from '../ui';
import { RailCard, RailLink, StartWith, StatTile, StatTiles, StripeCard, WithRail, type Pick } from '../components/kit';
import { ago, bullets, costMix, dayName, inr, kpis, monthSpan, pct, statementNeed, topClients, trend, type Bullet, type KpiSpec } from '../lib/finance-view.mjs';
import { periodHref, rupees } from '../lib/finance-numbers.mjs';
import type { LiveState } from './types';
import type { CategoryTotal } from './entry-types';
import { Conf } from './live';
import { HBars, MoneyTrend } from './charts';
import { Details } from './details';
import { NumbersBand, NumbersSources, NumbersTrend, type NumbersData } from './numbers';
import css from './fin.module.css';
import { CloseProgress } from './close-progress';
import { CollectionsProgress } from './progress';

/** Signed change against the month before, as text and an arrow. `up="bad"` for costs, where a rise is bad news. */
function Change({ value, previous, up }: { value: number; previous: number; up?: 'bad' }) {
 if (!previous) return null;
 const p = Math.round((value / previous - 1) * 100);
 if (!p) return <span className={css.change} data-tone="flat"><Minus size={12} aria-hidden="true" />0%</span>;
 const good = up === 'bad' ? p < 0 : p > 0, Icon = p > 0 ? ArrowUpRight : ArrowDownRight;
 return <span className={css.change} data-tone={good ? 'good' : 'bad'} title="Against the month before"><Icon size={13} aria-hidden="true" /><span className={css.srOnly}>{p > 0 ? 'up' : 'down'} </span>{Math.abs(p)}%</span>;
}

function Tile({ k }: { k: KpiSpec }) {
 return <StatTile label={k.label} value={k.value} href={k.href} tone={k.tone} note={k.note}
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

/** FINANCE-UI Overview from the finance-mail model: six tiles, the brief as short sentences, and four charts.
 *  UX-FINANCE: each part is a stripe card (iris money in, orange money out) under one heading saying where it is from. */
export function FinanceOverview({ live, tiles: showTiles = true }: { live: LiveState; /** UX-FINANCE (review): Overview shows one row of tiles; with Numbers on top, the finance-mail six are left out. */ tiles?: boolean }) {
 const m = live.model!;
 // FINANCE-TRUTH (Kazuk, 4 Nov 2026): revenue is what clients paid without GST (Numbers, above Overview). The finance-mail
 // model's figure is what was invoiced, so it is named that here and two different "Revenue" figures never sit together.
 const tiles = kpis(m).map((k) => (k.key === 'revenue' ? { ...k, label: k.label.replace(/^Revenue/, 'Invoiced') } : k)), brief = bullets(m), points = trend(m, 18), mix = costMix(m), clients = topClients(m);
 const od = m.collections.overdue;
 const shown = points.filter((p) => p.revenue !== null || p.cost !== null);
 return <div className={css.overview} data-grow="">
  {showTiles ? <StatTiles count={6} label="Finance mail figures">{tiles.map((k) => <Tile key={k.key} k={k} />)}</StatTiles> : null}
  <div className={css.board}>
   <StripeCard className={css.briefPanel} title="What the founders should know" icon={Sparkles} stripe="none">
    <ul className={css.bullets} aria-label="Finance brief">{brief.map((b) => <BriefItem key={b.key} b={b} />)}</ul>
   </StripeCard>
   <StripeCard className={css.trendPanel} title="Invoiced vs costs" icon={BarChart3} stripe="in" sub={shown.length ? `${monthSpan([points[0].month, points.at(-1)!.month])} · without GST · finance mail` : undefined} action={{ href: '/finance?tab=income', label: 'Invoiced' }}>
    <div className={css.chartBody}><MoneyTrend fill points={points} label="Invoiced and costs by month" names={{ in: 'Invoiced', out: 'Costs', inTip: 'invoiced', outTip: 'costs' }} /></div>
   </StripeCard>
   <StripeCard className={css.agePanel} title="Collections ageing" stripe={od.confirmed.count ? 'bad' : 'good'} action={{ href: '/finance?tab=revenue', label: 'See all' }}>
    <div className={css.chartBody}><HBars ramp label="Overdue invoices by days past due" empty="Nothing is overdue."
     items={od.buckets.map((b) => ({ key: b.bucket, label: b.bucket, sub: `${b.count} invoices`, value: b.amount, display: inr(b.amount), href: '/finance?tab=revenue' }))}
     more={<p className={css.chartNote}>{od.confirmed.count ? `${od.confirmed.count} confirmed unpaid · ${od.count - od.confirmed.count} after the last statement` : `${od.count} invoices past due`}</p>} /></div>
   </StripeCard>
   <StripeCard className={css.clientsPanel} title="Top clients" sub="without GST" stripe="in" action={{ href: '/finance?tab=clients', label: 'See all' }}>
    <div className={css.chartBody}><HBars label="Largest clients by invoicing" empty="No client invoices in finance mail yet."
     items={clients.items.map((x) => ({ key: x.client, label: x.client, sub: pct(x.invoiceShare), value: x.invoiced, display: inr(x.invoiced), href: x.clientId ? `/clients/${x.clientId}` : '/finance?tab=clients' }))}
     more={clients.rest.count ? <p className={css.chartNote}>{clients.rest.count} more clients · {inr(clients.rest.invoiced)} ({pct(clients.rest.share)})</p> : null} /></div>
   </StripeCard>
   <StripeCard className={css.costPanel} title="Cost categories" stripe="out" action={{ href: '/finance?tab=budget', label: 'See all' }}>
    <div className={css.chartBody}><HBars side="out" label="Average monthly cost by category" empty="The monthly cost sheet has no months yet."
     items={mix.items.map((x) => ({ key: x.category, label: x.label, sub: pct(x.share), value: x.avg, display: inr(x.avg), href: '/finance?tab=budget' }))}
     more={mix.total ? <p className={css.chartNote}>{inr(mix.total)} a month · avg {monthSpan([mix.months[0], mix.months.at(-1)!])}</p> : null} /></div>
   </StripeCard>
  </div>
 </div>;
}

/** UX-FINANCE: what to do first on Finance, most urgent on top (My day's "Start with"), from figures already on screen. */
export function overviewPicks({ numbers, live, uncategorised }: { numbers: NumbersData | null; live: LiveState | null; uncategorised: number }): Pick[] {
 const picks: Pick[] = [], m = live?.model ?? null;
 const od = m?.collections.overdue.confirmed;
 if (od?.count) picks.push({ key: 'overdue', tone: 'bad', title: `Chase ${od.count} overdue invoice${od.count === 1 ? '' : 's'}`, sub: `${inr(od.amount)} due, with no payment in the bank lines`, href: '/finance?tab=revenue' });
 if (numbers?.unsaidPayments.count) { const n = numbers.unsaidPayments.count; picks.push({ key: 'unsaid', tone: 'warn', title: `Say which account ${n} payment${n === 1 ? '' : 's'} went into`, sub: `So the GST lands in ${numbers.gstAccount ?? 'the GST account'} and not in revenue`, href: periodHref('/finance?tab=numbers', numbers.period) }); }
 if (numbers?.totals.gstOutstanding) picks.push({ key: 'gst', tone: 'warn', title: `Collect ${rupees(numbers.totals.gstOutstanding)} of GST`, sub: `${numbers.outstanding.gstInvoices} invoice${numbers.outstanding.gstInvoices === 1 ? '' : 's'} with GST still to come`, href: periodHref('/finance?tab=numbers', numbers.period) });
 if (numbers?.totals.baseOutstanding) picks.push({ key: 'base', title: `Collect ${rupees(numbers.totals.baseOutstanding)} still due`, sub: `Without GST, on ${numbers.outstanding.invoices} issued invoice${numbers.outstanding.invoices === 1 ? '' : 's'}`, href: '/erp/documents' });
 if (uncategorised) picks.push({ key: 'sort', title: `Sort ${uncategorised} Cash book line${uncategorised === 1 ? '' : 's'} into a category`, sub: 'So spending by category adds up', href: '/finance?tab=entries&category=none' });
 // UX-FINANCE (review): ask for a statement only when the bank lines are missing or older than 45 days (the rule the
 // Collected tile uses), not the day after an upload.
 const end = m?.collections.evidenceEnd ?? null, stale = !!m && (!end || Date.parse(m.asOf) - Date.parse(end) > 45 * 864e5);
 if (m && stale) { const need = statementNeed(m); picks.push({ key: 'statement', tone: 'warn', title: need.what, sub: `${end ? `Payments after ${dayName(end)}` : 'Payments'} cannot be checked until then · ${need.who}`, href: '/finance?tab=reconcile' }); }
 const renew = m?.software.renewals30.length ?? 0;
 if (renew) picks.push({ key: 'renew', title: `Check ${renew} renewal${renew === 1 ? '' : 's'} in the next 30 days`, sub: 'Cancel what nobody uses before it bills again', href: '/finance?tab=subscriptions' });
 return picks.slice(0, 4);
}

/** UX-FINANCE (owner, 5 Nov 2026): Overview in My day's language. This year's four figures with their sources, what to
 *  do first, the trend as a chart, then the finance-mail model's brief and charts; the sources sit in a quiet rail. */
export function OverviewBoard({ numbers, live, uncategorised, fallback }: { numbers: NumbersData | null; live: LiveState | null; uncategorised: number; fallback: ReactNode }) {
 const m = live?.model ?? null, picks = overviewPicks({ numbers, live, uncategorised });
 const records = (live?.sources ?? []).reduce((n, s) => n + (Number(s.records) || 0), 0);
 return <WithRail rail={<>
  <StartWith items={picks} icon={Sparkles} />
  {numbers ? <NumbersSources d={numbers} title="Where these numbers come from" /> : null}
  {m ? <RailCard title="Finance mail figures" icon={Mail}>
   <p className={css.foot}>{live!.sources.length ? <>Read from finance mail, the finance sheets and the bank lines every six hours: {live!.sources.length} sources, {records.toLocaleString('en-IN')} records, synced {ago(live!.computedAt)}.</> : <>Nothing has been read from finance mail yet; the figures below fill in once it syncs.</>} The CA has not certified these months yet.</p>
   <RailLink href="/finance?tab=ledger">Data sources and what is missing</RailLink>
  </RailCard> : null}
  <RailCard title="Shortcuts" icon={Database}>
   <RailLink href="/finance?tab=book">Cash book</RailLink>
   <RailLink href="/finance/desk">CA desk</RailLink>
   <RailLink href="/sales">My sales</RailLink>
  </RailCard>
 </>}>
  {/* UX-POLISH-4 (chosen concept "Month-close hero"): the close first, then the year's figures; what to do first is the right column. */}
  {m ? <CloseProgress model={m} uncategorised={uncategorised} /> : null}
  {numbers ? <NumbersBand d={numbers} /> : null}
  {numbers && !numbers.empty ? <CollectionsProgress d={numbers} /> : null}
  <StartWith items={picks} icon={Sparkles} />
  {numbers && !numbers.empty ? <StripeCard title="Money in and out, month by month" icon={BarChart3} stripe="in" sub="Columns are revenue (without GST) and expenses with HR; the line is the net" action={{ href: periodHref('/finance?tab=numbers', numbers.period), label: 'The month table' }}>
   <NumbersTrend d={numbers} />
  </StripeCard> : null}
  {m ? <FinanceOverview live={live!} tiles={!numbers} /> : fallback}
 </WithRail>;
}

/** How many approved Cash book lines nobody has put in a category yet. */
export const uncategorisedLines = (byCategory: CategoryTotal[] | undefined) => (byCategory ?? []).filter((c) => !c.category).reduce((n, c) => n + c.n, 0);
