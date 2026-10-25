import Link from 'next/link';
import { Database } from 'lucide-react';
import { Badge } from '../ui';
import type { LiveState } from './types';
import { ago } from '../lib/finance-view.mjs';
import css from './fin.module.css';

/** FINANCE-UI: five sections instead of ten tabs (COMP-B adds People cost). The old `?tab=` keys stay, so every shared link still opens. */
export type FinanceTab = { key: string; label: string };
export const SECTIONS: { key: string; label: string; href?: string; tabs: FinanceTab[] }[] = [
 // READY (Datup, 18/21 Oct): a simple cash book first: what came in, what was spent, what is in hand.
 { key: 'book', label: 'Cash book', tabs: [{ key: 'book', label: 'Cash book' }] },
 { key: 'overview', label: 'Overview', tabs: [{ key: 'overview', label: 'Overview' }] },
 { key: 'entries', label: 'Entries', tabs: [{ key: 'entries', label: 'Entries' }] },
 { key: 'in', label: 'Money in', tabs: [{ key: 'revenue', label: 'Collections' }, { key: 'income', label: 'Revenue' }, { key: 'clients', label: 'Clients' }] },
 { key: 'out', label: 'Money out', tabs: [{ key: 'subscriptions', label: 'Vendors & renewals' }, { key: 'ad-spend', label: 'Ad spend' }, { key: 'budget', label: 'Budget' }, { key: 'people', label: 'People value' }] },
 { key: 'cash', label: 'Cash', tabs: [{ key: 'reconcile', label: 'Reconcile' }, { key: 'forecast', label: 'Forecast' }, { key: 'timeline', label: 'Timeline' }, { key: 'close', label: 'Month close' }] },
 { key: 'pcost', label: 'People cost', href: '/finance/people-cost', tabs: [] },
 { key: 'ca', label: 'CA desk', href: '/finance/desk', tabs: [] },
];
/** Older views that are only reached by link still sit under their section. */
const LEGACY: Record<string, string> = { spend: 'out', payroll: 'out', plan: 'out' };
export const sectionOf = (tab: string) => SECTIONS.find((s) => s.tabs.some((t) => t.key === tab))?.key ?? LEGACY[tab] ?? (tab === 'ca' ? 'ca' : tab === 'people-cost' ? 'pcost' : '');

/** The certification controls (month, currency, basis) and the pilot travel between views; view choices do not. */
const KEEP = ['pilot', 'month', 'currency', 'scale', 'basis'];
const link = (tab: string, q: Record<string, string>) => {
 const keep = new URLSearchParams(Object.entries(q).filter(([k]) => KEEP.includes(k)));
 // Finance opens on Overview or the Cash book depending on the organisation, so every view names itself.
 keep.set('tab', tab);
 const s = keep.toString();
 return s ? `/finance?${s}` : '/finance';
};

export function LiveStrip({ live }: { live: LiveState | null | undefined }) {
 if (!live?.model) return null;
 const records = (live.sources ?? []).reduce((n, s) => n + (Number(s.records) || 0), 0);
 return <p className={css.strip}><Badge tone="warning">Uncertified until the CA certifies the month</Badge><span className={css.stripMeta}>{live.sources.length} sources · {records.toLocaleString('en-IN')} records · synced {ago(live.computedAt)}</span><Link className={css.sourcesLink} href="/finance?tab=ledger"><Database size={13} aria-hidden="true" />Data sources</Link></p>;
}

/** Section tabs, the live-data strip on the same line, and the section's own views as one segmented row underneath. */
export function FinanceNav({ tab, q = {}, live, title }: { tab: string; q?: Record<string, string>; live?: LiveState | null; /** A page outside the sections (Data sources) names itself in place of the views. */ title?: string }) {
 const current = sectionOf(tab), section = SECTIONS.find((s) => s.key === current);
 return <div className={css.navBlock}>
  <div className={css.navRow}>
   <nav className={css.sections} aria-label="Finance sections">{SECTIONS.map((s) => <Link key={s.key} href={s.href ?? link(s.tabs[0].key, q)} scroll={false} className={css.section} aria-current={s.key === current ? 'page' : undefined}>{s.label}</Link>)}</nav>
   <LiveStrip live={live} />
  </div>
  {title ? <p className={css.navTitle}>{title}</p> : section && section.tabs.length > 1 ? <nav className={css.views} aria-label={`${section.label} views`}>{section.tabs.map((t) => <Link key={t.key} href={link(t.key, q)} scroll={false} className={css.view} aria-current={t.key === tab ? 'true' : undefined}>{t.label}</Link>)}</nav> : null}
 </div>;
}
