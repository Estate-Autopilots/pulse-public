import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronDown, Database } from 'lucide-react';
import { Menu } from '../kit';
import { Badge } from '../ui';
import { ChipFilter, PageHeader, chipClass, type Chip } from '../components/kit';
import type { LiveState } from './types';
import { ago } from '../lib/finance-view.mjs';
import css from './fin.module.css';
import { CloseMeter } from './close-progress';

/** FINANCE-UI: five sections instead of ten tabs (COMP-B adds People cost). The old `?tab=` keys stay, so every shared link still opens. */
export type FinanceTab = { key: string; label: string };
export const SECTIONS: { key: string; label: string; href?: string; tabs: FinanceTab[] }[] = [
 // READY (Datup, 18/21 Oct): a simple cash book first: what came in, what was spent, what is in hand.
 { key: 'book', label: 'Cash book', tabs: [{ key: 'book', label: 'Cash book' }] },
 // FINANCE-TRUTH (Kazuk, 4 Nov 2026): Numbers, revenue from paid invoices net of GST, GST apart, each figure's source.
 { key: 'overview', label: 'Overview', tabs: [{ key: 'overview', label: 'Summary' }, { key: 'numbers', label: 'Numbers' }] },
 // UX-FINANCE (review): the views are Summary and Numbers, so a screen never shows two selected chips both saying Overview.
 { key: 'entries', label: 'Entries', tabs: [{ key: 'entries', label: 'Entries' }] },
 // FINANCE-TRUTH: the finance-mail model's "Revenue" is what was invoiced; revenue (paid, without GST) is Numbers.
 { key: 'in', label: 'Money in', tabs: [{ key: 'revenue', label: 'Collections' }, { key: 'income', label: 'Invoiced' }, { key: 'clients', label: 'Clients' }] },
 { key: 'out', label: 'Money out', tabs: [{ key: 'subscriptions', label: 'Vendors & renewals' }, { key: 'ad-spend', label: 'Ad spend' }, { key: 'budget', label: 'Budget' }, { key: 'people', label: 'People value' }] },
 { key: 'cash', label: 'Cash', tabs: [{ key: 'reconcile', label: 'Reconcile' }, { key: 'forecast', label: 'Forecast' }, { key: 'timeline', label: 'Timeline' }, { key: 'close', label: 'Month close' }] },
 { key: 'pcost', label: 'People cost', href: '/finance/people-cost', tabs: [] },
 { key: 'ca', label: 'CA desk', href: '/finance/desk', tabs: [] },
];
/** UX-SIMPLE (28 Oct 2026): five sections in the row; Entries, People cost and the CA desk wait in More (the one open
 *  joins the row, so the page always names where it is). */
const MORE = ['entries', 'pcost', 'ca'];
/** Screens whose figures are written in Pulse, not read from finance mail. */
const OWN = new Set(['book', 'entries', 'numbers', 'people', 'people-cost', 'ca']);
/** Older views that are only reached by link still sit under their section. */
const LEGACY: Record<string, string> = { spend: 'out', payroll: 'out', plan: 'out' };
export const sectionOf = (tab: string) => SECTIONS.find((s) => s.tabs.some((t) => t.key === tab))?.key ?? LEGACY[tab] ?? (tab === 'ca' ? 'ca' : tab === 'people-cost' ? 'pcost' : '');

/** UX-FINANCE (owner, 5 Nov 2026): every Finance screen names itself and says in one line what it is for. */
export const SCREENS: Record<string, { title: string; lede: string }> = {
 overview: { title: 'Overview', lede: 'How the business is doing this financial year, what needs you first, and where every figure comes from.' },
 numbers: { title: 'Numbers', lede: 'Revenue without GST, what came in, what was spent and the GST kept apart, month by month.' },
 book: { title: 'Cash book', lede: 'Money that came in and went out, newest first, with the money in hand on top.' },
 entries: { title: 'Entries', lede: 'Everything written into Finance, the payment screenshots found in WhatsApp, and the categories.' },
 revenue: { title: 'Collections', lede: 'Every sales invoice, whether its payment reached the bank, and how late the rest are.' },
 income: { title: 'Invoiced', lede: 'What was invoiced each month and each financial year, without GST.' },
 clients: { title: 'Clients', lede: 'Who brings the money in, what each paid, and what is still open.' },
 subscriptions: { title: 'Vendors and renewals', lede: 'Who the money goes to, the software bill, and what renews in the next 30 days.' },
 'ad-spend': { title: 'Ad spend', lede: 'What was paid for ads, month by month and by ad account.' },
 budget: { title: 'Budget', lede: 'Each cost against its plan, the margins, and the monthly costs.' },
 people: { title: 'People value', lede: 'What each person brings in against what they cost.' },
 reconcile: { title: 'Reconcile', lede: 'Invoices matched to bank credits, and what still needs a match.' },
 forecast: { title: 'Forecast', lede: 'Where cash is heading over the next six months, and the assumptions behind it.' },
 timeline: { title: 'Timeline', lede: 'What happened to the money, month by month.' },
 close: { title: 'Month close', lede: 'Closing each month and certifying it with the CA.' },
 'people-cost': { title: 'People cost', lede: 'Payroll this month, the people budget against actual, runway, and what if.' },
 ca: { title: 'Finance desk', lede: 'The CA desk: the registers, close packs and exports the accountant works from.' },
 ledger: { title: 'Data sources', lede: 'Where Finance reads its figures, the records behind them, and what is missing.' },
 spend: { title: 'Spending', lede: 'Older reviewed spending by category and vendor.' },
 payroll: { title: 'Payroll totals', lede: 'Salary totals by month, as the salary sheets report them.' },
};

/** The certification controls (month, currency, basis) and the pilot travel between views; view choices do not. */
const KEEP = ['pilot', 'month', 'currency', 'scale', 'basis', 'period'];
const link = (tab: string, q: Record<string, string>) => {
 const keep = new URLSearchParams(Object.entries(q).filter(([k]) => KEEP.includes(k)));
 // Finance opens on Overview or the Cash book depending on the organisation, so every view names itself.
 keep.set('tab', tab);
 const s = keep.toString();
 return s ? `/finance?${s}` : '/finance';
};

export function LiveStrip({ live }: { live: LiveState | null | undefined }) {
 // UX-FINANCE (review): "0 sources · 0 records" read as an error; with nothing synced the line says nothing.
 if (!live?.model || !live.sources?.length) return null;
 const records = (live.sources ?? []).reduce((n, s) => n + (Number(s.records) || 0), 0);
 return <p className={css.strip}><Badge tone="warning">Uncertified until the CA certifies the month</Badge><span className={css.stripMeta}>{live.sources.length} sources · {records.toLocaleString('en-IN')} records · synced {ago(live.computedAt)}</span><Link className={css.sourcesLink} href="/finance?tab=ledger"><Database size={13} aria-hidden="true" />Data sources</Link></p>;
}

/** UX-FINANCE: what waits in each section, as the chip's count (My day's company chips): invoices with no payment in
 *  the bank lines, renewals in the next 30 days, bank credits without an invoice. */
function counts(live: LiveState | null | undefined): Record<string, { n: number; tone?: 'warning' | 'danger'; label: string }> {
 const m = live?.model;
 if (!m) return {};
 const overdue = m.collections?.overdue?.confirmed?.count ?? 0, renew = m.software?.renewals30?.length ?? 0, unmatched = m.reconcile?.unmatchedCredits ?? 0;
 return {
  in: { n: overdue, tone: 'danger', label: `${overdue} overdue invoice${overdue === 1 ? '' : 's'}` },
  out: { n: renew, tone: 'warning', label: `${renew} renewal${renew === 1 ? '' : 's'} in 30 days` },
  cash: { n: unmatched, tone: 'warning', label: `${unmatched} bank credit${unmatched === 1 ? '' : 's'} to match` },
 };
}

/** Section chips with counts, More, the live-data line, and the section's own views as smaller chips underneath. */
export function FinanceNav({ tab, q = {}, live, title }: { tab: string; q?: Record<string, string>; live?: LiveState | null; /** A page outside the sections (Data sources) names itself in place of the views. */ title?: string }) {
 const current = sectionOf(tab), section = SECTIONS.find((s) => s.key === current), c = counts(live);
 const chips: Chip[] = SECTIONS.filter((s) => !MORE.includes(s.key) || s.key === current).map((s) => ({ key: s.key, label: s.label, href: s.href ?? link(s.tabs[0].key, q), count: c[s.key]?.n || undefined, tone: c[s.key]?.tone, countLabel: c[s.key]?.label }));
 return <div className={css.navBlock}>
  {/* UX-FINANCE (review): More is the row's last chip, so on a phone it scrolls with the sections instead of covering them. */}
  <div className={css.navRow}>
   {/* UX-POLISH-3: every tab carries the month close (ring and count), linking to the checklist on Overview. */}
   {live?.model ? <CloseMeter model={live.model} /> : null}
   <ChipFilter label="Finance sections" items={chips} current={current} trailing={<Menu label="More in Finance" buttonLabel="More in Finance" title="More" className={chipClass}
    items={SECTIONS.filter((s) => MORE.includes(s.key) && s.key !== current).map((s) => ({ key: s.key, label: s.label, href: s.href ?? link(s.tabs[0].key, q) }))}>More<ChevronDown size={14} aria-hidden="true" /></Menu>} />
  </div>
  {title ? null : section && section.tabs.length > 1 ? <ChipFilter size="small" currentAs="true" label={`${section.label} views`} current={tab} items={section.tabs.map((t) => ({ key: t.key, label: t.label, href: link(t.key, q) }))} /> : null}
  {/* UX-FINANCE: the finance-mail line belongs to the screens built from it; the Cash book, Entries, Numbers and the
      pay screens are written in Pulse, and a strip saying "uncertified · 0 sources" there read as an error. */}
  {/* Overview carries the same line in its rail, so it is not said twice. */}
  {OWN.has(tab) || tab === 'overview' ? null : <LiveStrip live={live} />}
 </div>;
}

/** UX-FINANCE: the one header every Finance screen shares: where you are, what the screen is for, its one primary
 *  action, then the sections. `tab` picks the title and the line under it. */
export function FinanceFrame({ tab, q, live, actions, private: note = 'Private to leadership and Finance', title, lede, nav = true, children }: { tab: string; q?: Record<string, string>; live?: LiveState | null; actions?: ReactNode; private?: string; title?: string; lede?: ReactNode; nav?: boolean; children?: ReactNode }) {
 const s = SCREENS[tab] ?? { title: 'Finance', lede: '' };
 return <>
  <PageHeader eyebrow={['Finance', note]} title={title ?? s.title} lede={lede ?? s.lede} actions={actions}>
   {nav ? <FinanceNav tab={tab} q={q} live={live} title={tab === 'ledger' ? s.title : undefined} /> : null}
  </PageHeader>
  {children}
 </>;
}
