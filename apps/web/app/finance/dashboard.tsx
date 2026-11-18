'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, BarChart3, CalendarClock, ChevronDown, CircleAlert, Flame, Landmark, ReceiptText, Sparkles, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { useState } from 'react';
import { createContext, useContext } from 'react';
import { Chip, GameCard, ProgressRing } from '../kit/game';
import type { Dashboard } from '../lib/finance-dashboard.mjs';
import { dayName, inr, monthSpan, type TrendPoint } from '../lib/finance-view.mjs';
import type { Pick } from '../components/kit';
import { MoneyTrend } from './charts';
import css from './dashboard.module.css';

// FIX-PEOPLE-MONEY C4 (owner, 10 Nov 2026: "Still cluttered. The charts don't mean anything as placed."): Finance's
// Overview answers six questions, the way an owner reads the books (Codex concept 2, "Do this first + numbers"):
// what to do first, then Cash · Others owe us · We owe · Profit and loss · Burn and runway · Tax due, each one figure,
// one line about where it comes from and how fresh it is, and one way in. People cost is folded into Profit and loss.
// Then one trend, invoiced against costs. A phone reads the same cards in one column (concept 3).

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (ym: string) => `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const monthsOld = (ym: string, today: string) => { const n = (Number(today.slice(0, 4)) - Number(ym.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(ym.slice(5, 7)); return `${n} month${n === 1 ? '' : 's'}`; };
const pct = (x: number | null) => (x === null ? '' : `${Math.round(x * 100)}%`);

function Figure({ value, tone, children }: { value: ReactNode; tone?: 'good' | 'bad' | 'warn'; children?: ReactNode }) {
  return <div className={css.figure}><b data-tone={tone}>{value}</b>{children ? <span>{children}</span> : null}</div>;
}
/** A phone shows a card's headline figure and its line; the rest opens with "Show details". A computer shows it all. */
const DetailsOpen = createContext(false);
function Detail({ children }: { children: ReactNode }) {
  return <div className={css.detail} data-open={useContext(DetailsOpen) ? '' : undefined}>{children}</div>;
}
function More({ href, children }: { href: string; children: ReactNode }) {
  return <Link className={css.more} href={href}>{children}<ArrowRight size={14} aria-hidden="true" /></Link>;
}

/** `d` is dashboardOf(model, today) worked out on the server (the whole model never reaches the browser); `points` is
 *  trend(model, 12). */
export function FinanceDashboard({ d, points, picks, today }: { d: Dashboard; points: TrendPoint[]; picks: Pick[]; today: string }) {
  const { cash, receivables: r, payables: p, month, burn, tax } = d;
  const [details, setDetails] = useState(false);
  const ageMax = Math.max(1, ...r.buckets.map((b) => b.amount));
  const netMax = Math.max(1, ...burn.series.map((s) => Math.abs(s.net)));
  const shown = points.filter((x) => x.revenue !== null || x.cost !== null);
  const lastCost = points.filter((x) => x.cost !== null && x.cost > 0).at(-1)?.month ?? null;
  return <div className={css.dash}>
    {picks.length ? <GameCard title="Do this first" icon={Sparkles} note={`${Math.min(3, picks.length)} thing${picks.length === 1 ? '' : 's'}`}>
      <ol className={css.first} aria-label="Do this first">{picks.slice(0, 3).map((x, i) => <li key={x.key} data-tone={x.tone}>
        <Link href={x.href ?? '/finance'}><span className={css.step}>{i + 1}</span><span className={css.firstText}><b>{x.title}</b>{x.sub ? <small>{x.sub}</small> : null}</span><ArrowRight size={16} aria-hidden="true" /></Link>
      </li>)}</ol>
    </GameCard> : null}

    <DetailsOpen.Provider value={details}>
    <div className={css.grid}>
      <div className={css.col}>
      <div className={css.cell} data-order="1"><GameCard title="Cash" icon={Landmark} note={cash.known ? (cash.stale ? <Chip tone="warn">{cash.ageDays} days old</Chip> : <Chip tone="good">Up to date</Chip>) : undefined}>
        <Figure value={cash.known ? inr(cash.amount) : 'Not known yet'}>{cash.known ? `In the bank on ${dayName(cash.asOf)}${cash.stale ? ': not today’s cash' : ''}` : 'No bank statement yet'}</Figure>
        {cash.stale ? <ul className={css.stale} aria-label="Why this matters">
          <li><CircleAlert size={14} aria-hidden="true" />{cash.known ? `Until a newer statement is uploaded, runway is not known and payments after ${dayName(cash.asOf)} can’t be matched to invoices.` : 'Pulse has no bank statement yet.'}</li>
        </ul> : <Detail><p className={css.hint}>Every payment in this statement is matched to its invoice or bill.</p></Detail>}
        <More href="/finance?tab=reconcile">{cash.stale ? 'Upload a bank statement' : 'See bank lines'}</More>
      </GameCard></div>

      <div className={css.cell} data-order="2"><GameCard title="Others owe us" icon={ReceiptText} note={r.count ? `${r.count.toLocaleString('en-IN')} unpaid invoice${r.count === 1 ? '' : 's'}` : undefined}>
        <Figure value={inr(r.amount)}>{r.late ? `${inr(r.late)} is 30+ days late` : 'Nothing is late'}</Figure>
        {r.confirmed ? <p className={css.hint}>{inr(r.confirmed)} of it is confirmed unpaid by the bank.</p> : null}
        <Detail><ul className={css.ageing} aria-label="Unpaid invoices by days late">{r.buckets.map((b, i) => <li key={b.label} data-step={i}>
          <span className={css.ageLabel}>{b.label} days</span>
          <span className={css.ageTrack} aria-hidden="true"><i style={{ width: `${Math.max(b.amount ? 3 : 0, (b.amount / ageMax) * 100)}%` }} /></span>
          <span className={css.ageAmount}>{inr(b.amount)}</span>
        </li>)}</ul>
        {r.top.length ? <ul className={css.rows} aria-label="Owe the most">{r.top.map((t) => <li key={t.client}>
          <span><b>{t.client}</b><small>{t.invoices} late invoice{t.invoices === 1 ? '' : 's'} · up to {t.ageDays} days</small></span><span className={css.amount}>{inr(t.amount)}</span>
        </li>)}</ul> : null}</Detail>
        <More href="/finance?tab=revenue">See who owes</More>
      </GameCard></div>

      <div className={css.cell} data-order="5"><GameCard title="How long the cash lasts" icon={Flame}>
        <div className={css.burn}>
          {burn.runway === null ? <Figure value="Runway unknown">{`The bank statement is old.${burn.burn ? ` You lose about ${inr(burn.burn)} a month (last 3 months).` : burn.earning ? ` You keep about ${inr(burn.earning)} a month (last 3 months).` : ''}`}</Figure>
            : <Figure value={burn.burn ? `−${inr(burn.burn)} a month` : burn.earning ? `+${inr(burn.earning)} a month` : 'Not known yet'} tone={burn.burn ? 'bad' : burn.earning ? 'good' : undefined}>
            {burn.burn ? 'You lose about this much each month (last 3 months)' : burn.earning ? 'You keep about this much each month (last 3 months)' : 'Needs a few months of costs'}</Figure>}
          {burn.runway === null ? null
            : <ProgressRing value={Math.min(1, burn.runway / 12)} size={76} stroke={8} label={`Runway ${burn.runway} months`} tone={burn.runway < 6 ? 'bad' : undefined}>
              <span className={css.ringText}><b>{burn.runway}</b><small>months</small></span>
            </ProgressRing>}
        </div>
        <Detail>{burn.series.length ? <div className={css.bars} role="img" aria-label={`Net each month: ${burn.series.map((s) => `${monthName(s.month)} ${inr(s.net)}`).join(', ')}`}>
          {burn.series.map((s) => <span key={s.month} className={css.bar}><em>{s.net < 0 ? '−' : '+'}{inr(Math.abs(s.net))}</em><span className={css.barTrack} data-down={s.net < 0 ? '' : undefined}><i data-neg={s.net < 0 ? '' : undefined} style={{ height: `${Math.max(4, (Math.abs(s.net) / netMax) * 100)}%` }} /></span><small>{MON[Number(s.month.slice(5, 7)) - 1]}</small></span>)}
        </div> : null}
        <p className={css.hint}>{burn.runway === null ? '' : `Cash lasts about ${burn.runway} months at this rate.`}{burn.series.length ? ` In ${monthName(burn.series.at(-1)!.month)}, ${inr(Math.abs(burn.series.at(-1)!.net))} more ${burn.series.at(-1)!.net < 0 ? 'went out than came in' : 'came in than went out'}.` : ''}</p></Detail>
      </GameCard></div>
      </div>
      <div className={css.col}>
      <div className={css.cell} data-order="3"><GameCard title="We owe" icon={Wallet} note="next 30 days">
        <Figure value={p.amount ? inr(p.amount) : 'Nothing due'}>{p.rows.length ? p.rows.map((x) => x.key === 'salaries' ? 'salaries' : x.key === 'renewals' ? 'renewals' : 'tax').join(', ').replace(/^./, (c) => c.toUpperCase()).replace(/, ([^,]+)$/, ' and $1') : 'No bills, salaries or tax found'}</Figure>
        <Detail>{p.rows.length ? <ul className={css.rows}>{p.rows.map((x) => <li key={x.key}>
          <span><b>{x.label}</b><small>{x.when ? (x.when < today ? `overdue since ${dayName(x.when)}` : `by ${dayName(x.when)}`) : ''}{x.note ? `${x.when ? ' · ' : ''}${x.note}` : ''}</small></span>
          <span className={css.amount}>{x.amount ? inr(x.amount) : <span className={css.muted}>Ask your CA</span>}</span>
        </li>)}</ul> : null}</Detail>
        <More href="/finance?tab=subscriptions">See bills and renewals</More>
      </GameCard></div>

      <div className={css.cell} data-order="4"><GameCard title={month ? `Profit and loss · ${MON[Number(month.month.slice(5, 7)) - 1]}` : 'Profit and loss'} icon={month && month.profit < 0 ? TrendingDown : TrendingUp}
        note={month && month.month < today.slice(0, 7) ? <Chip tone="warn">{monthsOld(month.month, today)} old</Chip> : undefined}>
        {month ? <>
          <Figure value={`${month.profit < 0 ? 'Loss ' : 'Profit '}${inr(Math.abs(month.profit))}`} tone={month.profit < 0 ? 'warn' : 'good'}>{month.profit < 0 ? 'More went out than came in' : month.margin !== null ? `${pct(month.margin)} of revenue kept` : ''}{month.month < today.slice(0, 7) ? ` · the latest month with costs` : ''}</Figure>
          <Detail><div className={css.pnl} aria-label="Revenue and expenses">
            <span>Revenue</span><span className={css.pnlTrack} aria-hidden="true"><i data-kind="in" style={{ width: `${(month.revenue / Math.max(month.revenue, month.expenses, 1)) * 100}%` }} /></span><b>{inr(month.revenue)}</b>
            <span>Expenses</span><span className={css.pnlTrack} aria-hidden="true"><i data-kind="out" style={{ width: `${(month.expenses / Math.max(month.revenue, month.expenses, 1)) * 100}%` }} /></span><b>{inr(month.expenses)}</b>
          </div>
          <ul className={css.rows}>{month.lines.slice(0, 3).map((l) => <li key={l.label}>
            <span><b>{l.label}</b><small>{pct(l.share)} of expenses</small></span>
            <span className={css.amount}>{inr(l.amount)}</span>
          </li>)}</ul></Detail>
          <More href="/people/pay">See pay and salaries</More>
        </> : <><Figure value="Not known yet">Needs a month with both revenue and costs</Figure><More href="/finance?tab=book">Open the cash book</More></>}
      </GameCard></div>

      <div className={css.cell} data-order="6"><GameCard title="Tax due" icon={CalendarClock} note="GST">
        {tax.missing.length ? <Figure value="Late returns" tone="bad">{`Ask your CA to file them now.${tax.next ? ` Next due: ${tax.next.what.replace(/ for .*$/, '')} by ${dayName(tax.next.due).replace(/ \d{4}$/, '')}.` : ''}`}</Figure>
          : tax.next ? <Figure value={dayName(tax.next.due).replace(/ \d{4}$/, '')}>{`${tax.next.what.replace(/ for .*$/, '')} is next, in ${tax.next.inDays} days`}</Figure> : null}
        <Detail>{tax.missing.length ? <ul className={css.rows} aria-label="Late GST returns">{tax.missing.map((x) => <li key={x.label}>
          <span><b>GSTR-1 and GSTR-3B</b><small>{x.label}</small></span>
          <span className={css.when}><b>{x.due ? dayName(x.due).replace(/ \d{4}$/, '') : ''}</b><Chip tone="bad">late</Chip></span>
        </li>)}</ul> : null}
        {tax.list.length ? <ul className={css.rows} aria-label="Next GST returns">{tax.list.map((t) => <li key={t.what}>
          <span><b>{t.what.replace(/ for .*$/, '')}</b><small>{t.what.replace(/^[^ ]+ for /, '')}</small></span>
          <span className={css.when}><b>{dayName(t.due).replace(/ \d{4}$/, '')}</b><Chip tone={t.inDays < 0 ? 'bad' : t.inDays <= 7 ? 'warn' : undefined}>{t.inDays < 0 ? `${-t.inDays} days late` : t.inDays === 0 ? 'today' : `in ${t.inDays} days`}</Chip></span>
        </li>)}</ul> : <Figure value="Nothing due">No GST return found yet</Figure>}
        {tax.late.length && !tax.missing.length ? <p className={css.hint}>Filed late before: {tax.late.length} quarter{tax.late.length === 1 ? '' : 's'}</p> : null}</Detail>
        <More href="/finance/desk">{tax.missing.length ? 'Ask your CA to file' : 'Open CA check'}</More>
      </GameCard></div>
      </div>

    </div>

    </DetailsOpen.Provider>
    <button type="button" className={css.toggle} aria-expanded={details} onClick={() => setDetails(!details)}>{details ? 'Show the headlines only' : 'Show every detail'}<ChevronDown size={15} aria-hidden="true" data-open={details ? '' : undefined} /></button>

    <p className={css.source}>From finance e-mails, the bank statements and the monthly costs sheet{d.asOf ? `, read up to ${dayName(d.asOf)}` : ''}. {d.certified ? 'Your CA has certified these months.' : 'Your CA has not certified these months yet.'} <Link href="/finance?tab=ledger">Data sources</Link></p>

    {shown.length ? <div className={css.trendCard}><GameCard title="Invoiced and costs" icon={BarChart3} note={monthSpan([points[0].month, points.at(-1)!.month])}>
      <div className={css.trend}><MoneyTrend fill points={points} label="Invoiced and costs by month" names={{ in: 'Invoiced', out: 'Costs', inTip: 'invoiced', outTip: 'costs' }} /></div>
      <p className={css.hint}>Without GST.{lastCost && lastCost < points.at(-1)!.month ? ` Costs after ${monthName(lastCost)} are not in the cost sheet yet.` : ''}</p>
    </GameCard></div> : null}
  </div>;
}
