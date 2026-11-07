import Link from 'next/link';
import { BarChart3, Calculator, Landmark, Receipt, Users } from 'lucide-react';
import { LineList, LineRow } from '../kit/line-row';
import { ChipFilter, EmptyState, RailCard, RailLink, SourceList, StatTile, StatTiles, StripeCard, WithRail } from '../components/kit';
import { TrendChart } from '../components/trend-chart';
import { PERIODS, dueText, monthName, periodHref, rupees, span } from '../lib/finance-numbers.mjs';
import { GstAccountPicker } from './numbers-actions';
import { Details } from './details';
import css from './numbers.module.css';

/* FINANCE-TRUTH (owner, 4 Nov 2026; Kazuk, 3 Nov meeting 1907-1916: "the finance dashboard numbers don't add up,
   because GST is collected into a separate account"). Finance → Numbers: revenue is what clients paid on invoices
   without the GST, collections are bank lines (else the Cash book), GST is its own line (billed, received into the GST
   account, still to come), expenses include HR cost, and every figure says where it comes from. Paise from the API.
   UX-FINANCE (owner, 5 Nov 2026): the same figures in My day's language: tiles that each name their source, the trend
   as a proper chart, cards with a colour stripe (iris money in, orange money out), and the sources in a quiet rail. */

type Source = { what: string; from: string; note?: string };
type Month = { month: string; revenue: number; invoiced: number; gstBilled: number; gstToGstAccount: number; gstToMain: number; collected: number | null;
  collectedFrom: 'bank' | 'book' | null; otherIn: number; expenses: number; hr: number; hrFrom: 'payroll' | 'book' | null; net: number; paidInvoices: number; payments: number; refunds: number; overpaid: number };
export type NumbersData = {
  period: string; from: string; to: string; today: string; months: Month[];
  totals: { revenue: number; invoiced: number; gstBilled: number; gstToGstAccount: number; gstToMain: number; collected: number | null; otherIn: number; expenses: number; hr: number;
    net: number; paidInvoices: number; payments: number; tds: number; taxes: number; inputGst: number; gstOutstanding: number; baseOutstanding: number; refunds: number; overpaid: number };
  sources: Record<'revenue' | 'collected' | 'gst' | 'expenses' | 'net' | 'outstanding', Source>;
  categories: { category: string; net: number }[];
  access: { bank: boolean; payroll: boolean; setAccount: boolean }; accounts: string[]; gstAccount: string | null; bankEnd: string | null;
  outstanding: { invoices: number; base: number; gst: number; gstInvoices: number; items: { id: string; number: string; issueDate: string; dueDate: string | null; buyer: string | null; baseDue: number; gstDue: number; total: number }[] };
  salespeople: { id: string | null; name: string; quotes: number; quoted: number; invoiced: number; revenue: number }[];
  unsaidPayments: { count: number; items: { id: string; documentId: string; number: string; receivedOn: string; amount: number; buyer: string | null }[] };
  empty: boolean;
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function Why({ s }: { s: Source }) {
  return <Details label="How it is worked out" name={`How it is worked out: ${s.what}`} title={s.what} sub="Finance → Numbers">
    <p>{s.from}</p>{s.note ? <p>{s.note}</p> : null}
  </Details>;
}

export function Periods({ base, period, keep }: { base: string; period: string; keep?: Record<string, string | undefined> }) {
  return <ChipFilter size="small" currentAs="true" label="Period" current={period} items={PERIODS.map((p) => ({ key: p.key, label: p.label, href: periodHref(base, p.key, keep) }))} />;
}

/** Revenue and expenses as columns, the net as a line, one month per stop (rupees from the API's paise). */
export function NumbersTrend({ d, height }: { d: NumbersData; height?: number }) {
  return <TrendChart label="Revenue, expenses and net by month" height={height}
    series={[{ key: 'revenue', label: 'Revenue, net of GST', tone: 'in' }, { key: 'expenses', label: 'Expenses, with HR', tone: 'out' }]} line={{ key: 'net', label: 'Net' }}
    points={d.months.map((m) => ({ month: m.month, label: monthName(m.month), values: { revenue: m.revenue / 100, expenses: m.expenses / 100, net: m.net / 100 } }))}
    empty="No revenue or spending in these months yet." />;
}

/** The rail beside Numbers and Overview: where each figure comes from, in one list. */
export function NumbersSources({ d, title = 'Where each number comes from' }: { d: NumbersData; title?: string }) {
  return <RailCard title={title} icon={Landmark}>
    <SourceList items={(['revenue', 'collected', 'gst', 'expenses', 'net', 'outstanding'] as const).map((k) => d.sources[k])} />
    {d.bankEnd ? <p className={css.quiet}>Bank lines reach {d.bankEnd}; later months count the Cash book.</p> : null}
  </RailCard>;
}

export function NumbersView({ d }: { d: NumbersData }) {
  const t = d.totals, when = span(d.from, d.to), base = '/finance?tab=numbers';
  const head = <div className={css.head}><Periods base={base} period={d.period} /><p className={css.when}>{when} · without GST unless it says GST</p></div>;
  if (d.empty) return <div className={css.page} data-grow="">{head}
    <EmptyState icon={Calculator} title="No invoices, payments or spending in this period"
      text="Numbers fill in as invoices are issued and paid in Billing, and as money in and out is written in the Cash book. Pick a longer period, or start with an invoice."
      action={{ href: '/erp/documents', label: 'Open Billing documents' }} secondary={{ href: '/finance?tab=book', label: 'Write money in or out in the Cash book' }} />
    {d.outstanding.invoices ? <p className={css.quiet}>Today, on issued invoices: {rupees(t.baseOutstanding)} still to collect without GST, and GST {rupees(t.gstOutstanding)} still to receive.</p> : null}
    <GstPanel d={d} />
  </div>;
  const fromBank = d.months.some((m) => m.collectedFrom === 'bank');
  return <div className={css.page} data-grow="">
    {head}
    <WithRail rail={<>
      <NumbersSources d={d} />
      <RailCard title="Go deeper" icon={BarChart3}>
        <RailLink href="/finance?tab=book">The Cash book behind expenses</RailLink>
        <RailLink href="/erp/documents">Invoices and payments in Billing</RailLink>
        <RailLink href="/finance?tab=revenue">Collections from the bank lines</RailLink>
      </RailCard>
    </>}>
      <StatTiles count={6}>
        <StatTile label="Revenue, net of GST" value={rupees(t.revenue)} note={`${plural(t.paidInvoices, 'invoice')} fully paid${t.refunds ? ` · refunds ${rupees(t.refunds)} off` : ''}`} source={<><b>Billing</b> payments<Why s={d.sources.revenue} /></>} />
        <StatTile label="Collected" value={t.collected === null ? (d.access.bank ? 'No bank lines or Cash book money in' : 'Cash book has none') : rupees(t.collected)}
          note="Base and GST together" source={<><b>{fromBank ? 'Bank lines' : 'Cash book'}</b><Why s={d.sources.collected} /></>} />
        <StatTile label="Expenses, with HR" value={rupees(t.expenses)} note={`HR ${rupees(t.hr)}`} source={<><b>Cash book</b> and payroll<Why s={d.sources.expenses} /></>} />
        <StatTile label={t.net < 0 ? 'Net loss' : 'Net'} value={rupees(t.net)} tone={t.net < 0 ? 'danger' : 'success'} note="Revenue less expenses" source={<Why s={d.sources.net} />} />
        <StatTile label="GST still to receive" value={rupees(t.gstOutstanding)} tone={t.gstOutstanding ? 'warning' : undefined} note={plural(d.outstanding.gstInvoices, 'invoice')} source={<><b>Kept apart</b> from revenue<Why s={d.sources.gst} /></>} />
        <StatTile label="Still to collect" value={rupees(t.baseOutstanding)} tone={t.baseOutstanding ? 'warning' : undefined} note="Without GST, on issued invoices" source={<Why s={d.sources.outstanding} />} />
      </StatTiles>

      <StripeCard title="Month by month" sub={`${when} · columns are revenue and expenses, the line is the net`} stripe="in" icon={BarChart3}>
        <NumbersTrend d={d} />
        <div className={css.scroll} role="region" aria-label="Month by month figures" tabIndex={0}><table className={css.table}>
          <thead><tr><th scope="col">Month</th><th scope="col">Revenue</th><th scope="col">Invoiced</th><th scope="col">GST billed</th><th scope="col">GST received</th><th scope="col">Collected</th><th scope="col">Expenses</th><th scope="col">of it HR</th><th scope="col">Net</th></tr></thead>
          <tbody>{d.months.map((m) => <tr key={m.month}>
            <th scope="row">{monthName(m.month)}</th><td>{rupees(m.revenue)}</td><td>{rupees(m.invoiced)}</td><td>{rupees(m.gstBilled)}</td>
            <td title={`Into the GST account ${rupees(m.gstToGstAccount)} · with the base ${rupees(m.gstToMain)}`}>{rupees(m.gstToGstAccount + m.gstToMain)}</td>
            <td>{m.collected === null ? '—' : rupees(m.collected)}<small>{m.collectedFrom === 'bank' ? 'bank' : m.collectedFrom === 'book' ? 'Cash book' : ''}</small></td>
            <td>{rupees(m.expenses)}</td><td>{rupees(m.hr)}<small>{m.hrFrom === 'payroll' ? 'payroll' : m.hrFrom === 'book' ? 'Cash book' : ''}</small></td>
            <td data-tone={m.net < 0 ? 'bad' : undefined}>{rupees(m.net)}</td></tr>)}</tbody>
          <tfoot><tr><th scope="row">Total</th><td>{rupees(t.revenue)}</td><td>{rupees(t.invoiced)}</td><td>{rupees(t.gstBilled)}</td><td>{rupees(t.gstToGstAccount + t.gstToMain)}</td>
            <td>{t.collected === null ? '—' : rupees(t.collected)}</td><td>{rupees(t.expenses)}</td><td>{rupees(t.hr)}</td><td data-tone={t.net < 0 ? 'bad' : undefined}>{rupees(t.net)}</td></tr></tfoot>
        </table></div>
      </StripeCard>

      <GstPanel d={d} />

      <div className={css.grid}>
        <StripeCard title="Expenses by category" sub="Net of GST" stripe="out" icon={Receipt}>
          {d.categories.length ? <LineList label="Expenses by category">{d.categories.map((c) => <LineRow key={c.category} title={c.category} amount={rupees(c.net)} />)}</LineList>
            : <EmptyState compact icon={Receipt} title="No spending in this period" text="Expenses, paid bills and salaries written in the Cash book, and locked payroll, appear here." action={{ href: '/finance?tab=book', label: 'Open the Cash book' }} />}
        </StripeCard>
        <StripeCard title="By salesperson" sub="Quotations and invoices issued in the period; revenue paid in it" stripe="in" icon={Users}>
          {d.salespeople.length ? <LineList label="By salesperson">{d.salespeople.map((p) => <LineRow key={p.id ?? 'none'} href={p.id ? periodHref(`/sales?person=${p.id}`, d.period) : undefined} title={p.name}
            sub={`${plural(p.quotes, 'quotation')} · ${rupees(p.quoted)} quoted · ${rupees(p.invoiced)} invoiced`} amount={rupees(p.revenue)} amountSub="revenue" />)}</LineList>
            : <EmptyState compact icon={Users} title="No quotations or invoices in this period" text="Each salesperson’s quotations, invoices and what their clients paid appear here." />}
        </StripeCard>
      </div>
    </WithRail>
  </div>;
}

/** FINANCE-TRUTH (Kazuk, 4 Nov 2026: "the finance dashboard is wrong"): the top of Overview shows these figures, so
 *  Finance names revenue one way only; the finance-mail model's invoicing sits below as "Invoiced". */
export function NumbersBand({ d }: { d: NumbersData }) {
  const t = d.totals, open = periodHref('/finance?tab=numbers', d.period);
  return <section className={css.band} aria-label="Finance numbers">
    <div className={css.bandHead}><p><b>{span(d.from, d.to)}</b> · from Billing&apos;s paid invoices, the Cash book and payroll · without GST</p>
      <Link href={open}>Open Numbers →</Link></div>
    <StatTiles count={4}>
      <StatTile label="Revenue, net of GST" value={rupees(t.revenue)} href={open} note={`From ${plural(t.payments, 'payment')} on invoices`} source={t.gstOutstanding ? <>GST <b>{rupees(t.gstOutstanding)}</b> still to receive, kept apart</> : 'GST kept apart'} />
      <StatTile label="Collected" value={t.collected === null ? 'None recorded yet' : rupees(t.collected)} href={open} note={d.months.some((m) => m.collectedFrom === 'bank') ? 'From the bank lines' : 'From the Cash book'} />
      <StatTile label="Expenses, with HR" value={rupees(t.expenses)} href={open} note={`HR ${rupees(t.hr)} · Cash book and payroll`} />
      <StatTile label={t.net < 0 ? 'Net loss' : 'Net'} value={rupees(t.net)} tone={t.net < 0 ? 'danger' : 'success'} href={open} note="Revenue less expenses" />
    </StatTiles>
  </section>;
}

function GstPanel({ d }: { d: NumbersData }) {
  const t = d.totals;
  return <StripeCard title="GST" sub="Kept apart from revenue" stripe={t.gstOutstanding ? 'warn' : 'good'} icon={Landmark} className={css.gst}>
    <dl className={css.gstFacts}>
      <div><dt>Billed in the period</dt><dd>{rupees(t.gstBilled)}</dd></div>
      <div><dt>{d.gstAccount ? `Received into ${d.gstAccount}` : 'Received into a GST account'}</dt><dd>{rupees(t.gstToGstAccount)}</dd></div>
      <div><dt>Received with the base</dt><dd>{rupees(t.gstToMain)}</dd></div>
      <div><dt>Still to receive, today</dt><dd data-tone={t.gstOutstanding ? 'warn' : undefined}>{rupees(t.gstOutstanding)}</dd></div>
      {t.taxes ? <div><dt>Taxes & GST paid to the government</dt><dd>{rupees(t.taxes)}</dd></div> : null}
      {t.inputGst ? <div><dt>GST on spending (input credit)</dt><dd>{rupees(t.inputGst)}</dd></div> : null}
    </dl>
    <GstAccountPicker accounts={d.accounts} current={d.gstAccount} canSet={d.access.setAccount} />
    {d.unsaidPayments.count ? <>
      <p className={css.label}>Payments that do not say which account</p>
      <p className={css.quiet}>{plural(d.unsaidPayments.count, 'payment')} on invoices with GST still due {d.unsaidPayments.count === 1 ? 'counts' : 'count'} as the main account. If one was the GST, open the invoice and choose “Paid into {d.gstAccount}” on the payment.</p>
      <LineList label="Payments that do not say which account">{d.unsaidPayments.items.map((x) => <LineRow key={x.id} href={`/erp/documents/${x.documentId}`}
        title={`${x.number}${x.buyer ? ` · ${x.buyer}` : ''}`} sub={`Received ${x.receivedOn}`} amount={rupees(x.amount)} />)}</LineList>
    </> : null}
    {d.outstanding.items.some((x) => x.gstDue > 0) ? <>
      <p className={css.label}>Invoices with GST still to come</p>
      <LineList label="Invoices with GST still to come">{d.outstanding.items.filter((x) => x.gstDue > 0).slice(0, 8).map((x) => <LineRow key={x.id} href={`/erp/documents/${x.id}`}
        title={`${x.number}${x.buyer ? ` · ${x.buyer}` : ''}`} sub={dueText(x.baseDue, x.gstDue)} amount={rupees(x.gstDue)} amountSub="GST" />)}</LineList>
    </> : <p className={css.quiet}><Landmark size={14} aria-hidden="true" /> No GST is waiting on any issued invoice.</p>}
  </StripeCard>;
}
