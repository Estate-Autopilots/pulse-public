import Link from 'next/link';
import { FileText, Receipt, ShieldCheck, Wallet } from 'lucide-react';
import { api } from '../lib/api';
import { Badge, Message, Page, styles } from '../ui';
import { EmptyState as Empty, PageHeader, StatTile as Kpi, StatTiles as Tiles, StripeCard as Panel } from '../components/kit';
import { LineList, LineRow } from '../kit/line-row';
import { SelectField } from '../kit/select-field';
import { dueText, rupees, span, statusLabel } from '../lib/finance-numbers.mjs';
import { Periods } from '../finance/numbers';
import css from '../finance/numbers.module.css';

/* FINANCE-TRUTH (A19 in part; Kazuk, 3 Nov meeting 1682: the sales person sees their own numbers). My sales: the
   quotations and invoices of the signed-in salesperson (theirs, or made from their quotation), what their clients paid
   in the period, base and GST apart, and what is still to collect. Leadership and Finance pick anyone. Paise from the API. */

type Quote = { id: string; number: string | null; status: string; issueDate: string | null; buyer: string | null; taxable: number; total: number; ownerApprovalNeeded: boolean; named?: boolean };
type Invoice = { id: string; number: string; status: string; issueDate: string; dueDate: string | null; buyer: string | null; taxable: number; gst: number; total: number; baseDue: number; gstDue: number };
type Sales = {
  period: string; from: string; to: string; today: string; canOpenErp: boolean; person: { id: string; name: string; self: boolean };
  quotes: { count: number; value: number; won: number; wonValue: number; open: number; drafts: number; items: Quote[] };
  invoices: { count: number; taxable: number; total: number; paid: number; items: Invoice[] };
  collections: { count: number; cash: number; base: number; gst: number; tds: number };
  open: { count: number; base: number; gst: number; overdue: number; overdueAmount: number };
  team: { id: string; name: string }[] | null;
};

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { paid: 'success', accepted: 'success', converted: 'success', part_paid: 'warning', declined: 'danger' };
const date = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');

export default async function MySales({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const period = ['month', 'last', 'quarter', 'fy', 'lastfy'].includes(q.period) ? q.period : 'month';
  const r = await api<Sales>(`sales-numbers?${new URLSearchParams(Object.entries({ period, person: q.person ?? '' }).filter(([, v]) => v))}`);
  if (!r.data) return <Page calm><PageHeader eyebrow={['Sales']} title="My sales" lede="Your quotations, invoices and what your clients paid." />
    {r.status === 403 ? <Empty icon={ShieldCheck} title={q.person ? 'Another person’s sales are for leadership and Finance' : 'My sales is for staff'}
      text={q.person ? 'You can see your own quotations, invoices and collections.' : 'Sign in with your staff account to see your quotations and invoices.'} action={q.person ? { href: '/sales', label: 'See my own' } : { href: '/', label: 'Back to Home' }} />
      : <Message text={r.error ?? 'My sales is unavailable'} />}</Page>;
  const d = r.data, keep = d.person.self ? undefined : { person: d.person.id }, when = span(d.from, d.to);
  // A quotation opens in Quotes only when the viewer is named its salesperson (0509); one that is theirs because they
  // sent or made it opens nowhere else for them, so it is listed without a link.
  const quoteHref = (x: Quote) => (d.canOpenErp ? `/erp/documents/${x.id}` : x.status === 'draft' || !x.named ? undefined : `/quotes/${x.id}`);
  return <Page calm>
    <PageHeader eyebrow={['Sales', when]} title={d.person.self ? 'My sales' : `Sales · ${d.person.name}`}
      lede={d.person.self ? 'Your quotations, the invoices made from them, and what your clients paid, base and GST apart.' : 'Their quotations, the invoices made from them, and what their clients paid, base and GST apart.'}
      back={d.person.self ? undefined : { href: `/finance?tab=numbers&period=${d.period}`, label: 'Finance numbers' }} />
    <div className={css.page} data-grow="">
      <div className={css.head}>
        <Periods base="/sales" period={d.period} keep={keep} />
        {d.team?.length ? <form className={css.person} action="/sales">
          <input type="hidden" name="period" value={d.period} />
          <label className={styles.field}>Salesperson<SelectField name="person" defaultValue={d.person.id}>
            {d.team.some((p) => p.id === d.person.id) ? null : <option value={d.person.id}>{d.person.name}</option>}
            {d.team.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField></label>
          <button type="submit" className={styles.btn}>Show</button>
        </form> : null}
      </div>
      <Tiles count={6} dense>
        <Kpi label="Quotations" value={String(d.quotes.count)} note={`${rupees(d.quotes.value)} quoted, net of GST${d.quotes.drafts ? ` · ${d.quotes.drafts} draft${d.quotes.drafts === 1 ? '' : 's'}` : ''}`} />
        <Kpi label="Won" value={String(d.quotes.won)} tone={d.quotes.won ? 'success' : undefined} note={`${rupees(d.quotes.wonValue)} · ${d.quotes.open} waiting for an answer`} />
        <Kpi label="Invoiced, net of GST" value={rupees(d.invoices.taxable)} note={`${d.invoices.count} invoice${d.invoices.count === 1 ? '' : 's'} · ${d.invoices.paid} paid`} />
        <Kpi label="Collected" value={rupees(d.collections.cash)} note={`${rupees(d.collections.base)} without GST + GST ${rupees(d.collections.gst)}${d.collections.tds ? ` · TDS ${rupees(d.collections.tds)}` : ''}`} />
        <Kpi label="Still to collect" value={rupees(d.open.base + d.open.gst)} tone={d.open.base + d.open.gst ? 'warning' : undefined}
          note={d.open.count ? `${d.open.count} invoice${d.open.count === 1 ? '' : 's'} · GST ${rupees(d.open.gst)} of it` : 'Nothing outstanding'} />
        <Kpi label="Overdue" value={rupees(d.open.overdueAmount)} tone={d.open.overdue ? 'danger' : undefined} note={d.open.overdue ? `${d.open.overdue} past the due date` : 'None past due'} />
      </Tiles>
      <div className={css.grid}>
        <Panel stripe="in" title="Quotations" sub={`Issued in ${when}, and drafts started in it`}><div>
          {d.quotes.items.length ? <LineList label="Quotations">{d.quotes.items.map((x) => <LineRow key={x.id} href={quoteHref(x)}
            title={`${x.number ?? 'Draft quotation'}${x.buyer ? ` · ${x.buyer}` : ''}`} sub={x.issueDate ? date(x.issueDate) : 'Not sent yet'}
            amount={rupees(x.taxable)} amountSub={x.ownerApprovalNeeded ? <Badge tone="warning">Owner approval needed</Badge> : <Badge tone={TONE[x.status]}>{statusLabel(x.status)}</Badge>} />)}</LineList>
            : <Empty compact icon={FileText} title="No quotations in this period" text={d.person.self ? 'Quotations you make or send appear here. Pick a longer period to see older ones.' : 'None made or sent by this person in the period.'} />}
        </div></Panel>
        <Panel stripe="in" title="Invoices" sub="Issued in the period, with what is still due"><div>
          {d.invoices.items.length ? <LineList label="Invoices">{d.invoices.items.map((x) => <LineRow key={x.id} href={d.canOpenErp ? `/erp/documents/${x.id}` : undefined}
            title={`${x.number}${x.buyer ? ` · ${x.buyer}` : ''}`} sub={`${date(x.issueDate)} · ${dueText(x.baseDue, x.gstDue)}`}
            amount={rupees(x.total)} amountSub={<Badge tone={TONE[x.status]}>{statusLabel(x.status)}</Badge>} />)}</LineList>
            : <Empty compact icon={Receipt} title="No invoices in this period" text="An invoice made from your quotation is yours; Finance issues it and records the payment." />}
        </div></Panel>
      </div>
      <p className={css.quiet}><Wallet size={14} aria-hidden="true" /> Collected counts payments recorded on these invoices in the period; GST paid into the GST account is shown apart from the amount without GST.{d.canOpenErp ? <> <Link href={`/finance?tab=numbers&period=${d.period}`}>Finance → Numbers</Link></> : null}</p>
    </div>
  </Page>;
}
