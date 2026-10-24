import Link from 'next/link';
import type { ReactNode } from 'react';
import { Kpi, Panel, Tiles } from '../ui';
import { ago, dayName, inr, statementNeed, supplier } from '../lib/finance-view.mjs';
import type { Confidence, LiveModel, LiveState } from './types';
import { Conf } from './live';
import { MoneyTrend } from './charts';
import { FinTable, type FinCell } from './table';
import type { Outlook } from './people-cost/model';
import fin from './fin.module.css';

/* FINANCE-UI Cash pages (Reconcile, Forecast, Timeline) and Data sources, from the live model. Queues have one
   action per row; an empty queue says exactly what is missing and who supplies it. */

const CONF: Record<string, { t: string; tone: 'accent' | 'neutral' | 'warning' }> = { high: { t: 'High', tone: 'accent' }, medium: { t: 'Medium', tone: 'neutral' }, low: { t: 'Low', tone: 'warning' } };
const conf = (c?: Confidence | string | null): FinCell => { const x = CONF[c ?? 'low'] ?? CONF.low; return { v: c ?? 'low', t: x.t, tone: x.tone, chip: true }; };
const money = (n: number | null | undefined): FinCell => n === null || n === undefined ? null : { v: Math.round(Number(n) * 100) / 100, t: inr(n) };
const day = (d: string | null | undefined): FinCell => d ? { v: d.slice(0, 10), t: dayName(d) } : null;
const confWords = (c?: string | null) => c === 'high' ? 'High · a system document (Zoho invoice, bank export, GST portal mail)' : c === 'medium' ? 'Medium · a staff-kept sheet or a mail snippet' : 'Low · inferred or owner-reported; check before relying on it';

/** What is missing, who supplies it, and (for leadership with write access) the upload right there. */
export function Need({ what, who, why, action }: { what: string; who: string; why?: string | null; action?: ReactNode }) {
 return <div className={fin.need} role="note"><div><b>{what} — {who}</b>{why ? <span>{why}</span> : null}</div>{action}</div>;
}

/** Cash → Reconcile → Matches: invoices against bank credits. */
export function MatchesView({ m, upload }: { m: LiveModel; upload?: ReactNode }) {
 const r = m.reconcile, need = statementNeed(m), stale = !r.evidenceEnd || Date.parse(m.asOf) - Date.parse(r.evidenceEnd) > 45 * 864e5;
 return <div className={fin.body} data-grow="">
  <Tiles count={4} dense>
   <Kpi label="Invoices matched to bank credits" value={String(r.matched)} note="a unique match each" />
   <Kpi label="Invoices still open" value={String(r.unmatchedInvoices)} tone={r.unmatchedInvoices ? 'warning' : undefined} note="no bank credit matched yet" />
   <Kpi label="Client credits unexplained" value={String(r.unmatchedCredits)} note="bank credits with no invoice" />
   <Kpi label="Bank lines end" value={<span className={fin.wordValue}>{dayName(r.evidenceEnd)}</span>} tone={stale ? 'warning' : undefined} note={stale ? 'Newer statements needed' : 'Up to date'} />
  </Tiles>
  {stale ? <Need what={need.what} who={need.who} why={need.impact ?? 'Matching stops where the bank lines stop.'} action={upload} /> : null}
  <FinTable fill search openLabel="Review" title="Invoices matched to bank credits" sub="suggestions are not certified until the CA reviews them" label="Invoice and bank matches" csv="matches" sort={{ key: 'bankDate', dir: 'desc' }}
   filters={[{ key: 'all', label: 'All' }, { key: 'suggested', label: 'Suggested' }, { key: 'settled', label: 'Settled' }]}
   columns={[{ key: 'invoice', label: 'Invoice', phone: 'title' }, { key: 'client', label: 'Client' }, { key: 'invoiceTotal', label: 'Invoice', align: 'right' }, { key: 'bankDate', label: 'Bank credit' }, { key: 'bankAmount', label: 'Credited', align: 'right', phone: 'value' }, { key: 'state', label: 'Status' }]}
   rows={r.suggestions.map((s) => ({ id: s.invoice + s.bankKey, tags: [s.confidence === 'high' ? 'settled' : 'suggested'],
    cells: { invoice: { v: s.invoice, sub: dayName(s.invoiceDate) }, client: s.client ?? 'Client unknown', invoiceTotal: money(s.invoiceTotal), bankDate: day(s.bankDate), bankAmount: money(s.bankAmount), state: s.confidence === 'high' ? { v: 'Settled', t: 'Settled', tone: 'success', chip: true } : { v: 'Suggested', t: 'Suggested', tone: 'warning', chip: true } },
    drawer: { title: `${s.invoice} → ${s.payer ?? 'payer not named'}`, sub: s.client ?? 'Client unknown', facts: [
     { label: 'Status', value: s.confidence === 'high' ? 'Settled by a unique match' : 'Suggested · check before relying on it', tone: s.confidence === 'high' ? 'success' : 'warning' },
     { label: 'Invoice', value: `${s.invoice} · ${dayName(s.invoiceDate)} · ${inr(s.invoiceTotal)}` },
     { label: 'Bank credit', value: `${dayName(s.bankDate)} · ${inr(s.bankAmount)}` },
     ...(s.payer ? [{ label: 'Paid by', value: s.payer }] : []), ...(s.reference ? [{ label: 'Reference', value: s.reference }] : []),
     { label: 'Why it matches', value: s.basis }, { label: 'Confidence', value: confWords(s.confidence) }],
     text: ['A match allows 2% or 10% TDS and instalments. The CA certifies it in the month close; nothing is posted from here.'] } }))}
   empty={<>No invoice has a matching bank credit yet. {need.what} — {need.who}.</>} />
 </div>;
}

/** Cash → Reconcile → Exceptions: what needs clearing and who clears it, and the CA's suspense entries. */
export function ExceptionsView({ m }: { m: LiveModel }) {
 return <div className={fin.body} data-grow="">
  <FinTable fill openLabel="Review" title="Exceptions to clear" sub={`${m.anomalies.length}`} label="Exceptions to clear" csv="exceptions"
   columns={[{ key: 'title', label: 'Exception', phone: 'title' }, { key: 'who', label: 'Who clears it' }, { key: 'confidence', label: 'Confidence', phone: 'hide' }]}
   rows={m.anomalies.map((a) => ({ id: a.kind, cells: { title: a.title, who: supplier(a.who), confidence: conf(a.confidence) },
    drawer: { title: a.title, sub: `Who clears it: ${a.who}`, facts: [{ label: 'Who', value: a.who }, { label: 'Confidence', value: confWords(a.confidence) }], text: [a.text] } }))}
   empty="Nothing to clear: no missing invoice numbers, duplicate charges, filing gaps, notices or suspense entries." />
  <FinTable fill search title="CA suspense ledger" sub="bank entries without an explanation" label="Suspense entries" csv="suspense" sort={{ key: 'date', dir: 'desc' }}
   columns={[{ key: 'date', label: 'Date', phone: 'title' }, { key: 'dir', label: 'Direction' }, { key: 'amount', label: 'Amount', align: 'right', phone: 'value' }, { key: 'nature', label: 'Nature' }, { key: 'file', label: 'Source', phone: 'hide' }]}
   rows={m.suspense.map((s, i) => ({ id: `${s.date}-${i}`, cells: { date: day(s.date), dir: s.direction === 'in' ? 'Credit' : 'Debit', amount: money(s.amount), nature: s.nature ?? { v: null, t: 'No explanation recorded', tone: 'warning', chip: true }, file: s.source?.file ?? null } }))}
   empty="The CA's suspense ledger has no entries." />
 </div>;
}

/** Cash → Forecast → Six months: base, downside and upside, with the assumptions written out. */
export function ProjectionView({ m, people }: { m: LiveModel; /** COMP-B: people cost from the pay records (paise), for founders and HR. */ people?: Outlook | null }) {
 const f = m.forecast, b = m.burn, need = statementNeed(m);
 const pc = (month: string) => people?.months.find((x) => x.month.slice(0, 7) === month.slice(0, 7)) ?? null;
 const change = (month: string) => { const x = pc(month); return x ? (x.base.cost - people!.baseline) / 100 : null; };
 const fresh = b.balance && b.balance.ageDays <= 35;
 return <div className={fin.body} data-grow="">
  <Tiles count={4} dense>
   <Kpi label="Costs a month" value={inr(b.avgMonthlyCost)} note="three-month average" />
   <Kpi label="Invoicing a month" value={inr(b.avgMonthlyInvoiced)} note="three-month average, ex-GST" />
   <Kpi label={b.net !== null && b.net < 0 ? 'Shortfall a month' : 'Surplus a month'} value={b.net === null ? 'Unknown' : inr(Math.abs(b.net))} tone={b.net !== null && b.net < 0 ? 'warning' : undefined} note="if every sale is invoiced in Zoho" />
   <Kpi label="Runway" value={b.runwayMonths != null ? `${b.runwayMonths} months` : <span className={fin.wordValue}>Statement needed</span>} tone={b.runwayMonths == null ? 'warning' : undefined} note={fresh ? `From the balance on ${dayName(b.balance!.asOf)}` : b.balance ? `Last balance ${dayName(b.balance.asOf)} — ${need.who}` : `No bank balance — ${need.who}`} />
  </Tiles>
  <div className={fin.pair}>
   <Panel title="Six-month cash projection" sub="base case · uncertified">
    <div className={fin.chartBody}><MoneyTrend fill label="Expected money in and out, next six months" names={{ in: 'Expected in', out: 'Expected out', inTip: 'expected in', outTip: 'expected out' }}
     points={f.months.map((x) => ({ month: x.month, revenue: x.base.inflow, cost: x.base.outflow, bank: false, revenueBasis: null, revenueConfidence: null, costConfidence: null }))} />
     <p className={fin.chartNote}><Conf level={f.confidence} /> {f.basis}</p></div>
   </Panel>
   <section className={fin.card}><h3>Assumptions</h3><ul className={fin.assumptions}>{f.assumptions.map((a) => <li key={a}>{a}</li>)}
    {people ? <li>People cost from Pulse pay records: the forecast&apos;s costs already hold the cost sheet&apos;s payroll, so only the change from this month is added (known raises, last days, pauses, accepted offers). Offers not yet accepted and planned roles count in the downside. <Link href="/finance/people-cost">People cost and what-if →</Link></li> : null}</ul>{b.runwayNote ? <p className={fin.chartNote}>{b.runwayNote}</p> : null}</section>
  </div>
  <FinTable fill title="Month by month" sub="net = expected in − expected out" label="Six-month projection" csv="projection"
   columns={[{ key: 'month', label: 'Month', phone: 'title' }, { key: 'in', label: 'Expected in', align: 'right' }, { key: 'out', label: 'Expected out', align: 'right' }, { key: 'net', label: 'Net (base)', align: 'right', phone: 'value' }, { key: 'cum', label: 'Cumulative', align: 'right' },
    ...(people ? [{ key: 'people', label: 'People cost change', align: 'right' as const }, { key: 'withPeople', label: 'Net with people', align: 'right' as const }] : []), { key: 'down', label: 'Downside net', align: 'right' }, { key: 'up', label: 'Upside net', align: 'right' }]}
   rows={f.months.map((x) => ({ id: x.month, cells: { month: { v: x.month, t: x.label }, in: money(x.base.inflow), out: money(x.base.outflow), net: money(x.base.net), cum: money(x.base.cumulative),
    people: change(x.month) === null ? null : money(change(x.month)), withPeople: change(x.month) === null ? null : money(x.base.net - change(x.month)!), down: money(x.downside.net), up: money(x.upside.net) } }))} />
 </div>;
}

const KINDS: Record<string, string> = { invoices: 'Invoices', collections: 'Collections', costs: 'Costs', payroll: 'Payroll', ads: 'Ad funding', filing: 'Filings', filings: 'Filings' };

/** Cash → Timeline → Month by month: every event the sources show, newest first. */
export function TimelineView({ m }: { m: LiveModel }) {
 const kinds = [...new Set(m.timeline.flatMap((t) => t.events.map((e) => e.kind)))];
 return <div className={fin.body} data-grow="">
  <FinTable fill search title="Month by month" sub="invoices, collections, costs, payroll, ad funding and filings" label="Monthly timeline" csv="timeline" sort={{ key: 'month', dir: 'desc' }}
   filters={[{ key: 'all', label: 'All' }, ...kinds.map((k) => ({ key: k, label: KINDS[k] ?? k }))]}
   columns={[{ key: 'month', label: 'Month' }, { key: 'event', label: 'What happened', phone: 'title' }, { key: 'date', label: 'Date', phone: 'hide' }, { key: 'amount', label: 'Amount', align: 'right', phone: 'value' }, { key: 'confidence', label: 'Confidence' }]}
   rows={m.timeline.flatMap((t) => t.events.map((e, i) => ({ id: `${t.month}-${i}`, tags: [e.kind], cells: { month: { v: t.month, t: t.label }, event: { v: e.label, sub: KINDS[e.kind] ?? e.kind }, date: day(e.date), amount: money(e.amount), confidence: conf(e.confidence) } })))}
   empty="No months yet: the live finance sync fills the timeline every six hours." />
  <p className={fin.foot}>Every month stays uncertified until the CA certifies it. Payroll is shown only as a monthly total.</p>
 </div>;
}

/* ---------- Data sources ---------- */

export function LiveSourcesView({ live }: { live: LiveState }) {
 const run = live.runs[0];
 return <div className={fin.body} data-grow="">
  <p className={fin.lead}>Read-only: Drive exports as the file owner, finance-only mail attachments and the EA index; invoice PDFs are filed in the EA Finance Shared Drive. The sync runs every six hours.{run ? ` Last run ${run.ok ? 'succeeded' : run.ok === false ? `failed (${run.error ?? 'error'})` : 'is running'} ${ago(run.finishedAt ?? run.startedAt)}.` : ''}</p>
  <FinTable fill search title="Live sources" sub={`synced ${ago(live.computedAt)}`} label="Live sources" csv="sources" sort={{ key: 'records', dir: 'desc' }}
   filters={[{ key: 'all', label: 'All' }, { key: 'attention', label: 'Needs attention' }]}
   columns={[{ key: 'label', label: 'Source', phone: 'title' }, { key: 'kind', label: 'Kind' }, { key: 'status', label: 'Status' }, { key: 'records', label: 'Records', align: 'right', phone: 'value' }, { key: 'supplier', label: 'Supplied by' }, { key: 'synced', label: 'Synced', phone: 'hide' }]}
   rows={live.sources.map((s) => ({ id: s.key, tags: s.status === 'ok' ? [] : ['attention'],
    cells: { label: { v: s.label, sub: s.missing }, kind: s.kind, status: { v: s.status, t: s.status === 'ok' ? 'OK' : s.status, tone: s.status === 'ok' ? 'success' : 'warning', chip: true }, records: Number(s.records ?? 0), supplier: s.supplier ?? null, synced: { v: s.syncedAt, t: ago(s.syncedAt) } },
    drawer: { title: s.label, sub: s.kind, facts: [{ label: 'Status', value: s.status, tone: s.status === 'ok' ? 'success' : 'warning' }, { label: 'Records', value: Number(s.records ?? 0).toLocaleString('en-IN') }, ...(s.supplier ? [{ label: 'Supplied by', value: s.supplier }] : []), ...(s.readAs ? [{ label: 'Read as', value: s.readAs }] : []), ...(s.modified ? [{ label: 'Last edited', value: dayName(String(s.modified)) }] : []), { label: 'Synced', value: ago(s.syncedAt) }], text: s.missing ? [s.missing] : undefined } }))} />
 </div>;
}

export function MissingView({ m }: { m: LiveModel | null }) {
 const items = m?.missing ?? [];
 return <div className={fin.body} data-grow="">
  <p className={fin.lead}>Each gap below limits a figure somewhere in Finance. The person named supplies it; Pulse picks it up on the next sync.</p>
  <ul className={fin.needs}>{items.map((x) => <li key={x.what} className={fin.needItem}><b>{x.what}</b><span>{x.impact}</span><small>Who: {x.who}</small></li>)}</ul>
  {!items.length ? <p className={fin.lead}>Nothing is missing.</p> : null}
 </div>;
}

const KIND_LABEL: Record<string, string> = { invoice: 'Invoices', bill: 'Bills', bank_line: 'Bank lines', cost_month: 'Cost months', filing: 'Filings', suspense: 'Suspense', ad_spend_month: 'Ad funding', subscription: 'Subscriptions', expense_month: 'Expense months', plan: 'Plans', bank_balance: 'Bank balances' };

export function EvidenceView({ evidence }: { evidence?: { kind: string; total: number; rows: { key: string; body: Record<string, unknown>; source: Record<string, unknown>; confidence: Confidence; hash: string }[]; offset: number } }) {
 return <div className={fin.body} data-grow="">
  <nav className={fin.kinds} aria-label="Record kinds">{Object.entries(KIND_LABEL).map(([k, label]) => <Link key={k} className={fin.kind} aria-current={evidence?.kind === k ? 'true' : undefined} href={`/finance?tab=ledger&financeSource=Evidence&kind=${k}`}>{label}</Link>)}</nav>
  <FinTable fill search title="Evidence behind every number" sub={evidence ? `${evidence.total.toLocaleString('en-IN')} ${KIND_LABEL[evidence.kind]?.toLowerCase() ?? 'records'}` : undefined} label="Evidence records" csv={`evidence-${evidence?.kind ?? 'records'}`}
   columns={[{ key: 'what', label: 'Record', phone: 'title' }, { key: 'source', label: 'Source' }, { key: 'hash', label: 'Hash', phone: 'hide' }, { key: 'confidence', label: 'Confidence' }]}
   rows={(evidence?.rows ?? []).map((r) => ({ id: r.key, cells: { what: summary(r.body), source: provenance(r.source), hash: r.hash.slice(0, 10), confidence: conf(r.confidence) } }))}
   empty="No stored records of this kind yet." />
  {evidence && evidence.total > evidence.offset + 100 ? <p className={fin.foot}><Link href={`/finance?tab=ledger&financeSource=Evidence&kind=${evidence.kind}&offset=${evidence.offset + 100}`}>Next 100 of {evidence.total.toLocaleString('en-IN')} →</Link></p> : null}
 </div>;
}

function summary(b: Record<string, unknown>): string {
 const date = b.date ?? b.month ?? b.day ?? b.asOf ?? '';
 const who = b.client ?? b.vendor ?? b.counterparty ?? b.category ?? b.type ?? b.name ?? b.item ?? '';
 const amount = b.total ?? b.amount ?? b.payroll ?? b.monthly ?? b.closing;
 return [date, who, b.number ?? b.invoiceNo, amount !== undefined && amount !== null ? inr(amount, String(b.currency ?? 'INR')) : null].filter(Boolean).join(' · ');
}
function provenance(s: Record<string, unknown>): string {
 if (s.type === 'sheet') return `${s.file} › ${s.sheet ?? ''}${s.row ? ` › row ${s.row}` : s.rows ? ` › ${s.rows} rows` : ''}`;
 if (s.type === 'mail') return `Mail ${s.mailbox} · ${s.sent ?? ''}${s.attachment ? ` · ${s.attachment}` : ''}`;
 if (s.type === 'mail-header') return `Mail header ${s.mailbox}`;
 if (s.type === 'document') return `${s.file}${s.section ? ` › ${s.section}` : ''}`;
 return String(s.type ?? 'Index');
}
