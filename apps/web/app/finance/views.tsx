import type { ReactNode } from 'react';
import { Kpi, Panel, Tiles } from '../ui';
import { RecordForm, type FieldDef } from '../records';
import type { AdData } from '../research/types';
import { dayName, inr, lastFullMonth, monthName, monthSpan, pct, statementNeed } from '../lib/finance-view.mjs';
import type { Confidence, LiveInvoice, LiveModel } from './types';
import { MonthBars } from './charts';
import { FinTable, type FinCell, type FinRow } from './table';
import fin from './fin.module.css';

/* FINANCE-UI pages for Money in and Money out, drawn from the live finance model (uncertified; the strip above every
   page says so). Tables sort, filter, export CSV and open a drawer per row; phones get cards. */

const CONF: Record<string, { t: string; tone: 'accent' | 'neutral' | 'warning' }> = { high: { t: 'High', tone: 'accent' }, medium: { t: 'Medium', tone: 'neutral' }, low: { t: 'Low', tone: 'warning' } };
const conf = (c?: Confidence | string | null): FinCell => { const x = CONF[c ?? 'low'] ?? CONF.low; return { v: c ?? 'low', t: x.t, tone: x.tone, chip: true }; };
const money = (n: number | null | undefined, currency = 'INR'): FinCell => n === null || n === undefined ? null : { v: Math.round(Number(n) * 100) / 100, t: inr(n, currency) };
const day = (d: string | null | undefined): FinCell => d ? { v: d.slice(0, 10), t: dayName(d) } : null;
const month = (m: string): FinCell => ({ v: m, t: monthName(m) });
const confWords = (c?: string | null) => c === 'high' ? 'High · a system document (Zoho invoice, bank export, GST portal mail)' : c === 'medium' ? 'Medium · a staff-kept sheet or a mail snippet' : 'Low · inferred or owner-reported; check before relying on it';

/** Words, not a blank, when the live sync has not produced a model yet. */
export function NoModel({ what }: { what: string }) {
 return <div className={fin.body}><div className={fin.notice}><b>{what} come from the live finance sync, which has not run for this workspace yet.</b><span>Pulse reads EA&apos;s finance sheets, finance mail and the EA index every six hours as the EA service account. Ops starts it with the finance sync timer.</span></div></div>;
}

function invoiceStatus(i: LiveInvoice): { t: string; tone: 'success' | 'danger' | 'warning' } {
 return i.status === 'paid' ? { t: 'Paid', tone: 'success' } : i.status === 'unpaid' ? { t: 'No payment in bank lines', tone: 'danger' } : { t: 'Not verifiable yet', tone: 'warning' };
}
function invoiceRow(i: LiveInvoice): FinRow {
 const st = invoiceStatus(i), open = i.status !== 'paid';
 return {
  id: i.number, tags: [i.status, ...(open && i.overdueDays > 0 ? ['overdue'] : [])],
  cells: { client: i.client ?? 'Client unknown', number: i.number, issued: day(i.date), due: day(i.due), overdue: open && i.overdueDays ? { v: i.overdueDays, t: `${i.overdueDays} days` } : null, total: money(i.total), status: { v: st.t, t: st.t, tone: st.tone, chip: true } },
  drawer: {
   title: `${i.number} · ${i.client ?? 'Client unknown'}`, sub: `Sales invoice issued ${dayName(i.date)}`,
   facts: [
    { label: 'Status', value: st.t, tone: st.tone },
    { label: 'Amount (incl. GST)', value: inr(i.total) }, { label: 'Taxable (ex-GST)', value: inr(i.taxable) },
    { label: 'Due', value: i.due ? dayName(i.due) : 'No due date on the invoice' },
    ...(open && i.overdueDays ? [{ label: 'Overdue', value: `${i.overdueDays} days` }] : []),
    ...(i.paidAmount ? [{ label: 'Paid', value: `${inr(i.paidAmount)}${i.paidDate ? ` on ${dayName(i.paidDate)}` : ''}` }] : []),
    ...(i.paidBasis ? [{ label: 'How Pulse knows', value: i.paidBasis }] : []),
    ...(i.clientGstin ? [{ label: 'Client GSTIN', value: i.clientGstin }] : []),
    ...(i.drive?.path ? [{ label: 'Filed in', value: i.drive.path }] : []),
    { label: 'Confidence', value: confWords(i.status === 'paid' ? i.confidence : 'medium') },
   ],
   text: i.description ? [i.description] : undefined,
   links: i.drive?.id ? [{ href: `https://drive.google.com/file/d/${encodeURIComponent(i.drive.id)}/view`, label: 'Open the PDF in Drive' }] : undefined,
  },
 };
}

/** Money in → Collections: what is owed, how old it is, and every invoice with its payment status. */
export function CollectionsView({ m }: { m: LiveModel }) {
 const c = m.collections, od = c.overdue, need = statementNeed(m);
 return <div className={fin.body} data-grow="">
  <Tiles count={4} dense>
   <Kpi label="Due, no payment in bank lines" value={inr(od.confirmed.amount)} tone={od.confirmed.amount ? 'warning' : undefined} note={`${od.confirmed.count} invoices due before ${dayName(c.evidenceEnd)}`} />
   <Kpi label="Past due, not verifiable" value={inr(od.unverified.amount)} note={`${od.unverified.count} invoices after the last statement`} />
   <Kpi label="All open invoices" value={inr(c.outstanding.amount)} note={`${c.outstanding.count} without a matched payment`} />
   <Kpi label="Bank evidence ends" value={<span className={fin.wordValue}>{dayName(c.evidenceEnd)}</span>} tone="warning" note={`${need.what} — ${need.who}`} />
  </Tiles>
  <FinTable fill search label="Sales invoices" csv="invoices" sort={{ key: 'overdue', dir: 'desc' }}
   filters={[{ key: 'all', label: 'All' }, { key: 'overdue', label: 'Overdue' }, { key: 'unpaid', label: 'No payment seen' }, { key: 'unconfirmed', label: 'Not verifiable' }, { key: 'paid', label: 'Paid' }]}
   columns={[{ key: 'client', label: 'Client', phone: 'title' }, { key: 'number', label: 'Invoice' }, { key: 'issued', label: 'Issued' }, { key: 'due', label: 'Due', phone: 'hide' }, { key: 'overdue', label: 'Overdue', align: 'right' }, { key: 'total', label: 'Amount', align: 'right', phone: 'value' }, { key: 'status', label: 'Status' }]}
   rows={c.invoices.map(invoiceRow)} empty="No sales invoices have reached finance mail yet. Zoho Invoice mails each one to marketing@ — Kazuk." />
  <p className={fin.foot}>Payment status comes from bank credits up to {dayName(c.evidenceEnd)}; {c.paidRateBasis ?? 'no invoice falls inside the bank evidence yet'}. Amounts include GST. Invoice PDFs are filed in the EA Finance Shared Drive.</p>
 </div>;
}

/** Money in → Revenue: month by month and by financial year. */
export function RevenueView({ m }: { m: LiveModel }) {
 const last = lastFullMonth(m.asOf), months = m.revenue.months.filter((r) => r.month <= last && r.revenue !== null && r.revenue !== undefined).slice(-24);
 const year = months.slice(-12), sum = year.reduce((n, r) => n + Number(r.revenue), 0), fy = m.revenue.fiscal.at(-1);
 const bestWorst = [m.revenue.best, m.revenue.worst];
 return <div className={fin.body} data-grow="">
  <Tiles count={4} dense>
   <Kpi label="Last 12 months" value={inr(sum)} note={year.length ? `${monthSpan([year[0].month, year.at(-1)!.month])} · ex-GST where invoiced` : 'No months yet'} />
   <Kpi label={fy ? `${fy.fy} so far` : 'This financial year'} value={fy ? inr(fy.invoiced || fy.collected) : 'Unknown'} note={fy ? (fy.invoicedMonths ? `${fy.invoicedMonths} months invoiced` : `${fy.collectedMonths} months of bank credits`) : ''} />
   <Kpi label="Best month" value={bestWorst[0] ? inr(bestWorst[0].invoiced) : 'Unknown'} note={bestWorst[0] ? monthName(bestWorst[0].month) : ''} />
   <Kpi label="Weakest month" value={bestWorst[1] ? inr(bestWorst[1].invoiced) : 'Unknown'} note={bestWorst[1] ? monthName(bestWorst[1].month) : ''} />
  </Tiles>
  <div className={fin.pair}>
   <Panel title="Revenue by month" sub={months.length ? monthSpan([months[0].month, months.at(-1)!.month]) : undefined}>
    <div className={fin.chartBody}><MonthBars fill label="Revenue by month" legend="Invoiced, ex-GST" mutedLabel="Bank credits from clients, incl. GST (before invoicing)"
     points={months.map((r) => ({ month: r.month, value: Number(r.revenue), muted: !r.invoices, tip: inr(r.revenue), tipSub: `${r.revenueBasis ?? ''} · ${r.confidence ?? 'low'} confidence` }))} /></div>
   </Panel>
   <FinTable fill title="By financial year" label="Revenue by financial year" csv="revenue-by-year"
     columns={[{ key: 'fy', label: 'Year', phone: 'title' }, { key: 'invoiced', label: 'Invoiced', align: 'right', phone: 'value' }, { key: 'collected', label: 'Collected', align: 'right' }, { key: 'basis', label: 'Months' }]}
     rows={[...m.revenue.fiscal].reverse().map((f) => ({ id: f.fy, cells: { fy: f.fy, invoiced: f.invoicedMonths ? money(f.invoiced) : null, collected: f.collectedMonths ? money(f.collected) : null, basis: [f.invoicedMonths ? `${f.invoicedMonths} invoiced` : '', f.collectedMonths ? `${f.collectedMonths} of bank lines` : ''].filter(Boolean).join(' · ') } }))} />
  </div>
  <FinTable fill title="Month by month" label="Revenue by month" csv="revenue-by-month" sort={{ key: 'month', dir: 'desc' }}
   columns={[{ key: 'month', label: 'Month', phone: 'title' }, { key: 'revenue', label: 'Revenue', align: 'right', phone: 'value' }, { key: 'invoices', label: 'Invoices', align: 'right' }, { key: 'collected', label: 'Collected (bank)', align: 'right' }, { key: 'basis', label: 'Basis', phone: 'hide' }, { key: 'confidence', label: 'Confidence' }]}
   rows={months.map((r) => ({ id: r.month, cells: { month: month(r.month), revenue: money(r.revenue), invoices: r.invoices || null, collected: money(r.collected), basis: r.revenueBasis, confidence: conf(r.confidence) } }))} />
  <p className={fin.foot}>{m.revenue.basis}.</p>
 </div>;
}

/** Money in → Clients: who brings the revenue, what they paid, what is still open. */
export function ClientsView({ m }: { m: LiveModel }) {
 const byClient = new Map<string, LiveInvoice[]>();
 for (const i of m.collections.invoices) { const k = i.client ?? ''; byClient.set(k, [...(byClient.get(k) ?? []), i]); }
 const a = m.activeClients;
 return <div className={fin.body} data-grow="">
  <FinTable fill search title="Clients" label="Revenue by client" csv="clients" sort={{ key: 'invoiced', dir: 'desc' }}
   filters={[{ key: 'all', label: 'All' }, { key: 'open', label: 'No payment seen' }, { key: 'recent', label: 'Invoiced in the last 90 days' }]}
   columns={[{ key: 'client', label: 'Client', phone: 'title' }, { key: 'invoiced', label: 'Invoiced', align: 'right', phone: 'value' }, { key: 'share', label: 'Share', align: 'right' }, { key: 'collected', label: 'Collected', align: 'right' }, { key: 'open', label: 'No payment seen', align: 'right' }, { key: 'invoices', label: 'Invoices', align: 'right' }, { key: 'first', label: 'First', phone: 'hide' }, { key: 'last', label: 'Last' }]}
   rows={m.revenue.clients.map((c) => {
    const recent = c.last && Date.parse(m.asOf) - Date.parse(c.last) < 90 * 864e5, invoices = (byClient.get(c.client) ?? []).slice().sort((x, y) => y.date.localeCompare(x.date));
    const months = Object.entries((c as { months?: Record<string, number> }).months ?? {}).sort(([x], [y]) => y.localeCompare(x)).slice(0, 6);
    return {
     id: c.client, tags: [...(c.outstanding ? ['open'] : []), ...(recent ? ['recent'] : [])],
     cells: { client: c.clientId ? { v: c.client, href: `/clients/${c.clientId}` } : c.client, invoiced: money(c.invoiced), share: { v: c.invoiceShare, t: pct(c.invoiceShare, 1) }, collected: c.collected ? money(c.collected) : null, open: c.outstanding ? { v: c.outstanding, t: inr(c.outstanding), tone: 'warning', chip: true } : null, invoices: c.invoices, first: day(c.first), last: day(c.last) },
     drawer: {
      title: c.client, sub: `${c.invoices} invoices · ${pct(c.invoiceShare, 1)} of invoicing`,
      facts: [{ label: 'Invoiced (ex-GST)', value: inr(c.invoiced) }, { label: 'Collected (bank)', value: c.collected ? inr(c.collected) : 'None matched' }, ...(c.outstanding ? [{ label: 'No payment seen', value: inr(c.outstanding), tone: 'warning' as const }] : []), { label: 'First and last', value: `${dayName(c.first)} → ${dayName(c.last)}` },
       ...months.map(([k, v]) => ({ label: monthName(k), value: `${inr(v)} invoiced` })),
       ...invoices.slice(0, 8).map((i) => ({ label: i.number, value: `${inr(i.total)} · ${invoiceStatus(i).t}` }))],
      links: [...(c.clientId ? [{ href: `/clients/${c.clientId}`, label: 'Open the client' }] : []), { href: '/finance?tab=revenue', label: 'All invoices' }],
     },
    };
   })} empty="No client invoices in finance mail yet." />
  <p className={fin.foot}>Invoiced = Zoho invoices ex-GST; collected = matched bank credits incl. GST. Share is of all invoiced revenue in finance mail.{a ? ` The pod trackers list ${a.active} active clients; ${a.invoiced60} were invoiced in the last 60 days.` : ''}</p>
 </div>;
}

/** Money out → Vendors & renewals. */
export function VendorsView({ m }: { m: LiveModel }) {
 const s = m.software, soon = s.renewals30;
 const soonTotal = soon.reduce((n, v) => n + (v.currency === 'INR' ? Number(v.lastAmount ?? 0) : 0), 0);
 return <div className={fin.body} data-grow="">
  <Tiles count={4} dense>
   <Kpi label="Software and AI a month" value={inr(s.ownerMonthly)} note="Owner's tool list · low confidence" />
   <Kpi label="AI tools a month" value={inr(s.aiMonthly)} note="Claude, ChatGPT, Kling, ElevenLabs" />
   <Kpi label="Office and connectivity" value={inr(s.officeMonthly)} note="Rent, food, Wi-Fi, SIMs" />
   <Kpi label="Renewing in 30 days" value={String(soon.length)} tone={soon.length ? 'warning' : undefined} note={soon.length ? `${inr(soonTotal)} at the last bill` : 'Nothing due'} />
  </Tiles>
  <div className={fin.pair}>
   <FinTable fill title="Renewals in the next 30 days" sub={`${soon.length}`} label="Renewals in the next 30 days" sort={{ key: 'renews', dir: 'asc' }} empty="Nothing renews in the next 30 days."
     columns={[{ key: 'vendor', label: 'Vendor', phone: 'title' }, { key: 'renews', label: 'Renews' }, { key: 'amount', label: 'Last bill', align: 'right', phone: 'value' }, { key: 'cadence', label: 'Cadence' }]}
     rows={soon.map((v) => ({ id: v.vendor, cells: { vendor: v.vendor, renews: day(v.nextRenewal), amount: money(v.lastAmount, v.currency), cadence: v.cadence },
      drawer: { title: v.vendor, sub: `Renews ${dayName(v.nextRenewal)}`, facts: [{ label: 'Last bill', value: v.lastAmount === null ? 'Amount unknown' : inr(v.lastAmount, v.currency) }, { label: 'Cadence', value: v.cadence }, { label: 'Why this date', value: v.renewalBasis ?? 'Last bill plus its cadence' }, { label: 'Confidence', value: confWords(v.confidence) }], text: ['Contract dates are not on file; the owner confirms before acting.'] } }))} />
   <FinTable fill title="Software and AI tools" sub="a month" label="Software and AI tools" csv="tools" sort={{ key: 'monthly', dir: 'desc' }}
     columns={[{ key: 'name', label: 'Tool', phone: 'title' }, { key: 'category', label: 'Category' }, { key: 'monthly', label: 'A month', align: 'right', phone: 'value' }]}
     rows={s.tools.map((t) => ({ id: t.name, cells: { name: { v: t.name, sub: t.basis }, category: t.category, monthly: money(t.monthly) } }))} />
  </div>
  <FinTable fill search title="Vendors by spend" label="Vendors by spend" csv="vendors" sort={{ key: 'total', dir: 'desc' }}
   filters={[{ key: 'all', label: 'All' }, { key: 'renews', label: 'Has a next renewal' }, { key: 'changed', label: 'Price changed' }]}
   columns={[{ key: 'vendor', label: 'Vendor', phone: 'title' }, { key: 'category', label: 'Category' }, { key: 'total', label: 'Spend', align: 'right', phone: 'value' }, { key: 'count', label: 'Bills', align: 'right' }, { key: 'last', label: 'Last bill' }, { key: 'lastAmount', label: 'Last amount', align: 'right' }, { key: 'cadence', label: 'Cadence', phone: 'hide' }, { key: 'next', label: 'Next renewal' }, { key: 'confidence', label: 'Confidence', phone: 'hide' }]}
   rows={m.expenses.vendors.map((v) => ({ id: v.vendor, tags: [...(v.nextRenewal ? ['renews'] : []), ...(v.priceChange ? ['changed'] : [])],
    cells: { vendor: v.vendor, category: v.category ?? 'Uncategorised', total: money(v.total, v.currency), count: v.count, last: day(v.last), lastAmount: money(v.lastAmount, v.currency), cadence: v.cadence, next: day(v.nextRenewal), confidence: conf(v.confidence) },
    drawer: { title: v.vendor, sub: v.category ?? 'Uncategorised', facts: [{ label: 'Spend', value: inr(v.total, v.currency) }, { label: 'Bills', value: String(v.count) }, { label: 'Last bill', value: `${dayName(v.last)}${v.lastAmount !== null ? ` · ${inr(v.lastAmount, v.currency)}` : ''}` }, { label: 'Cadence', value: v.cadence }, { label: 'Next renewal', value: v.nextRenewal ? dayName(v.nextRenewal) : 'Not predictable from the bills' }, ...(v.renewalBasis ? [{ label: 'Why this date', value: v.renewalBasis }] : []), ...(v.priceChange ? [{ label: 'Last price change', value: inr(v.priceChange, v.currency) }] : []), { label: 'Confidence', value: confWords(v.confidence) }] } }))}
   empty="No vendor bills in finance mail yet." />
  <p className={fin.foot}>Vendor bills from finance mail (PDF totals) and named company payees in the bank lines. Payments to individuals appear only as category totals. Next renewal = last bill plus its cadence.</p>
 </div>;
}

/** Money out → Budget: plan against actual, margins, and monthly costs with payroll as one total. */
export function BudgetView({ m }: { m: LiveModel }) {
 const months = [...new Set(m.budget.vsActual.map((v) => v.month))].sort().slice(-3);
 const cats = [...new Set(m.budget.vsActual.filter((v) => months.includes(v.month)).map((v) => v.category))];
 const plan = cats.map((cat) => { const rows = m.budget.vsActual.filter((v) => v.category === cat && months.includes(v.month)); const actual = rows.reduce((n, v) => n + v.actual, 0) / Math.max(1, rows.length), p = rows.find((v) => v.plan !== null)?.plan ?? null; return { cat, actual, plan: p, diff: p === null ? null : actual - p }; });
 const op = m.margins.operating;
 const top = m.expenses.categories.map((c) => c.category).filter((c) => !/payroll/i.test(c)).slice(0, 4);
 return <div className={fin.body} data-grow="">
  <Tiles count={Math.min(4, 1 + m.margins.packages.length) as 2 | 3 | 4} dense>
   <Kpi label="Operating margin" value={op.margin === null ? 'Unknown' : pct(op.margin)} tone={op.margin !== null && op.margin < 0 ? 'warning' : undefined} note={`${op.months.length} months · ${inr(op.revenue)} invoiced vs ${inr(op.cost)} costs`} />
   {m.margins.packages.slice(0, 3).map((p) => <Kpi key={p.package} label={`${p.package} package model`} value={pct(p.margin)} note={`${inr(p.cost)} to deliver vs ${inr(p.price)} price · low confidence`} />)}
  </Tiles>
  <div className={fin.pair}>
   <FinTable fill title="Plan vs actual" sub={months.length ? `a month, average of ${monthSpan([months[0], months.at(-1)!])}` : undefined} label="Plan vs actual" csv="plan-vs-actual" sort={{ key: 'actual', dir: 'desc' }}
     columns={[{ key: 'cat', label: 'Category', phone: 'title' }, { key: 'plan', label: 'Plan', align: 'right' }, { key: 'actual', label: 'Actual', align: 'right', phone: 'value' }, { key: 'diff', label: 'Difference', align: 'right' }, { key: 'state', label: 'Status' }]}
     rows={plan.map((p) => ({ id: p.cat, cells: { cat: p.cat.replace(/\s*\(monthly total\)/i, ''), plan: p.plan === null ? null : money(p.plan), actual: money(p.actual), diff: p.diff === null ? null : money(p.diff), state: p.plan === null ? { v: 'No plan', t: 'No recorded plan', chip: true } : p.diff! > 0 ? { v: 'Over', t: 'Over plan', tone: 'danger', chip: true } : { v: 'Under', t: 'Within plan', tone: 'success', chip: true } } }))} />
   <FinTable fill title="Client margin estimates" sub="costs are not tracked per client" label="Client margin estimates" csv="client-margins" sort={{ key: 'margin', dir: 'desc' }} empty="No client has enough invoicing for an estimate."
     columns={[{ key: 'client', label: 'Client', phone: 'title' }, { key: 'revenue', label: 'Revenue', align: 'right' }, { key: 'cost', label: 'Est. cost', align: 'right' }, { key: 'margin', label: 'Est. margin', align: 'right', phone: 'value' }, { key: 'confidence', label: 'Confidence', phone: 'hide' }]}
     rows={m.margins.clients.map((c) => ({ id: c.client, cells: { client: c.client, revenue: money(c.revenue), cost: money(c.estCost), margin: money(c.estMargin), confidence: conf(c.confidence) }, drawer: { title: c.client, sub: 'Estimated margin', facts: [{ label: 'Revenue', value: inr(c.revenue) }, { label: 'Estimated cost', value: inr(c.estCost) }, { label: 'Estimated margin', value: inr(c.estMargin) }, { label: 'How', value: c.basis }, { label: 'Confidence', value: confWords(c.confidence) }] } }))} />
  </div>
  <FinTable fill title="Monthly costs" sub="payroll as one total" label="Monthly costs" csv="monthly-costs" sort={{ key: 'month', dir: 'desc' }}
   columns={[{ key: 'month', label: 'Month', phone: 'title' }, { key: 'total', label: 'Total', align: 'right', phone: 'value' }, { key: 'payroll', label: 'Payroll', align: 'right' }, { key: 'people', label: 'People', align: 'right', phone: 'hide' }, ...top.map((t) => ({ key: `c:${t}`, label: t, align: 'right' as const })), { key: 'confidence', label: 'Confidence', phone: 'hide' }]}
   rows={m.expenses.months.map((e) => { const p = m.payroll.find((x) => x.month === e.month); return { id: e.month, cells: { month: month(e.month), total: money(e.total), payroll: p ? money(p.total) : null, people: p?.people ?? null, ...Object.fromEntries(top.map((t) => [`c:${t}`, money(e.byCategory[t] ?? null)])), confidence: conf(e.confidence) },
    drawer: { title: monthName(e.month), sub: e.basis ?? 'Monthly cost sheet', facts: [{ label: 'Total', value: inr(e.total) }, ...Object.entries(e.byCategory).sort(([, x], [, y]) => y - x).map(([k, v]) => ({ label: k.replace(/\s*\(monthly total\)/i, ''), value: inr(v) })), ...(p?.people ? [{ label: 'People on payroll', value: String(p.people) }] : [])], text: ['Payroll is one monthly total. Individual salaries stay in the HR salary area (founders, HR and the person).'] } }; })}
   empty="The monthly cost sheet has no months yet — HR keeps it." />
  <p className={fin.foot}>Plans: the owner&apos;s tool and office list and the plans typed in the Agency Finance Sheets. Actuals: EA&apos;s monthly cost sheet. {m.margins.note}</p>
 </div>;
}

const mapFields = (d: AdData): FieldDef[] => [{ key: 'projectId', label: 'Engagement / development', type: 'select', options: d.projects.map((p) => ({ value: p.id, label: p.name })) }, { key: 'clientId', label: 'Client (optional when project linked)', type: 'select', options: d.clients.map((c) => ({ value: c.id, label: c.name })) }];

/** Money out → Ad spend → Funding: client ad payments by month from receipts in EA mail. */
export function AdFundingView({ d, m, note }: { d: AdData; m: LiveModel | null; note: ReactNode }) {
 const keys = [...new Set(d.months.filter((x) => x.currency === 'INR').map((x) => x.month.slice(0, 7)))].sort();
 const monthly = keys.map((k) => { const of = (kind: string) => d.months.filter((x) => x.currency === 'INR' && x.kind === kind && x.month.slice(0, 7) === k).reduce((n, x) => n + x.amount, 0); return { month: k, funds: of('funds'), billed: of('billed') }; });
 const total = d.totals.find((x) => x.currency === 'INR'), mapped = d.accounts.filter((x) => x.projectKey || x.clientId).length;
 return <div className={fin.body} data-grow="">
  <Tiles count={4} dense>
   <Kpi label="Ad payments seen · INR" value={total ? inr(total.amount) : 'None'} note={total ? `${total.n.toLocaleString('en-IN')} receipts · ${dayName(total.first)} → ${dayName(total.last)}` : 'No receipts in EA mail'} />
   <Kpi label="Last three months" value={m?.adSpend.avg3 ? inr(m.adSpend.avg3) : 'Unknown'} note="a month, from receipts" />
   <Kpi label="Accounts mapped" value={`${mapped} / ${d.accounts.length}`} note="to a client or development" />
   <Kpi label="Account runway" value={<span className={fin.wordValue}>Unknown</span>} note="No verified balance or daily spend" />
  </Tiles>
  <div className={fin.pair}>
  <Panel title="Ad payments by month" sub="INR · prepaid funds and postpaid bills">
   <div className={fin.chartBody}><MonthBars fill side="out" label="Ad payments by month" legend="Paid to Meta"
    points={monthly.slice(-18).map((x) => ({ month: x.month, value: x.funds + x.billed, tip: inr(x.funds + x.billed), tipSub: `funds ${inr(x.funds)} · billed ${inr(x.billed)}` }))} /></div>
  </Panel>
  <FinTable fill title="By month" label="Ad payments by month" csv="ad-payments" sort={{ key: 'month', dir: 'desc' }}
   columns={[{ key: 'month', label: 'Month', phone: 'title' }, { key: 'total', label: 'Total', align: 'right', phone: 'value' }, { key: 'funds', label: 'Prepaid funds', align: 'right' }, { key: 'billed', label: 'Postpaid billed', align: 'right' }]}
   rows={monthly.map((x) => ({ id: x.month, cells: { month: month(x.month), total: money(x.funds + x.billed), funds: money(x.funds), billed: money(x.billed) } }))} />
  </div>
  <div className={fin.foot}>{note}</div>
 </div>;
}

/** Money out → Ad spend → Accounts: which ad account belongs to which client; one action per row (map it). */
export function AdAccountsView({ d }: { d: AdData }) {
 const sorted = d.accounts.toSorted((a, b) => b.amount - a.amount), total = sorted.reduce((n, x) => n + x.amount, 0) || 1;
 const top5 = sorted.slice(0, 5).reduce((n, x) => n + x.amount, 0) / total;
 const fields = mapFields(d);
 return <div className={fin.body} data-grow="">
  <p className={fin.lead}>{sorted.length} ad accounts · the largest five carry {pct(top5)} of payments · {d.accounts.filter((x) => !(x.projectKey || x.clientId)).length} not yet mapped to a client.</p>
  <FinTable fill search title="Ad accounts" label="Ad accounts" csv="ad-accounts" sort={{ key: 'amount', dir: 'desc' }}
   filters={[{ key: 'all', label: 'All' }, { key: 'unmapped', label: 'Not mapped' }, { key: 'manual', label: 'Mapped by hand' }]}
   columns={[{ key: 'name', label: 'Account', phone: 'title' }, { key: 'link', label: 'Belongs to' }, { key: 'amount', label: 'Payments', align: 'right', phone: 'value' }, { key: 'share', label: 'Share', align: 'right' }, { key: 'receipts', label: 'Receipts', align: 'right', phone: 'hide' }, { key: 'last', label: 'Last' }]}
   rows={sorted.map((x) => ({ id: x.accountId, tags: [...(!(x.projectKey || x.clientId) ? ['unmapped'] : []), ...(x.manual ? ['manual'] : [])],
    cells: { name: x.name, link: x.projectName ?? x.projectKey ?? x.clientName ?? { v: null, t: 'Not mapped', tone: 'warning', chip: true }, amount: money(x.amount), share: { v: x.amount / total, t: pct(x.amount / total, 1) }, receipts: x.receipts, last: day(x.last) },
    action: d.permissions.write ? <RecordForm path="money/ad-account" title="Map ad account" label="Map account" extra={{ accountId: x.accountId }} fields={fields} values={{ projectId: x.projectId, clientId: x.clientId }} note="Choose the correct engagement. Development-wide cost calculations use its source key. Clearing both links confirms the account as unmatched; future imports preserve that choice." /> : undefined,
    drawer: { title: x.name, sub: x.projectName ?? x.clientName ?? 'Not mapped', facts: [{ label: 'Payments (INR)', value: inr(x.amount) }, { label: 'Receipts', value: `${x.receipts} (${x.inrReceipts} in INR)` }, { label: 'Months seen', value: String(x.months) }, { label: 'Last receipt', value: dayName(x.last) }, { label: 'Funding notices', value: String(x.alerts) }, { label: 'Mapping', value: x.manual ? 'Set by hand' : x.projectKey || x.clientId ? 'Matched automatically' : 'Not mapped' }] } }))}
   empty="No ad accounts in EA mail yet." />
 </div>;
}
