import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FinanceDesk, PrepareFinanceSource } from './desk';
import type { FinanceData, LiveState } from './types';
import type { PeopleCost } from './people-cost/model';
import { FinanceNav } from './nav';
import { FinanceOverview } from './overview';
import { adSpendParts } from '../research/views';
import { AdAccountsView, AdFundingView, BudgetView, ClientsView, CollectionsView, NoModel, RevenueView, VendorsView } from './views';
import { Switch } from './switch';
import { EvidenceView, ExceptionsView, LiveSourcesView, MatchesView, MissingView, ProjectionView, TimelineView } from './cash';
import type { ReactNode } from 'react';
import type { AdData } from '../research/types';
import { ArrowDownLeft, ArrowUpRight, PieChart, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { Badge, Empty, Message, Page, PageHeader, Pager, Workspace, styles } from '../ui';
import { FinanceApprove } from '../company/actions';
import { text, s } from '../company/common';
import { ImportStatement, LedgerQuickEdit } from '../money/actions';
import { money, type MoneyData } from '../money/types';
import css from '../money/money.module.css';
import { ValueBoard, type ValueData } from '../leadership/value';
import fin from './fin.module.css';
import { EntriesView } from './entries-view';
import { CashBook } from './cash-book';
import { AddEntryButton } from './entries';
import type { EntriesData, WaData } from './entry-types';
import { SelectField } from "../kit/select-field";

const labels: Record<string, string> = { money_sheet_transactions: 'Bank & ledger', money_monthly_expenses: 'Expense observations', money_drive_bills: 'Bills', money_gmail_receipts: 'Billing mail', money_payroll_aggregates: 'Payroll reports', money_cost_assumptions: 'Cost assumptions', subscriptions: 'Subscriptions', recurring: 'Rent & recurring' };
/** Views served by the finance workspace (certification + live model); the rest read the money observations. */
const DESK = ['overview', 'income', 'clients', 'reconcile', 'close', 'timeline', 'budget', 'forecast', 'subscriptions', 'revenue'];
const PRIVATE = 'Leadership · private & audited';

function Breakdown({ items, currency }: { items: { key: string; amount: number; count: number }[]; currency: string }) {
 const max = Math.max(1, ...items.map(i => i.amount));
 return <div className={css.breakdown}>{items.slice(0, 8).map(i => <div key={i.key}><span><b>{i.key}</b><span>{money(i.amount, currency)}</span></span><span className={css.track}><i style={{ width: `${i.amount / max * 100}%` }} /></span></div>)}{!items.length ? <p>No reconciled spending in this view yet.</p> : null}</div>;
}

export default async function Finance({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
 const q = await searchParams;
 if (q.tab === 'ca') redirect('/finance/desk');
 // READY: an organisation without bank feeds or synced books (no live model) opens on the Cash book; one with them on Overview.
 const firstLive = q.tab ? null : await api<LiveState>('finance/live');
 // Only a readable answer without a model chooses the Cash book; a refusal or an outage keeps Overview (which explains it).
 const firstTab = firstLive?.data && !firstLive.data.model ? 'book' : null;
 const tab = q.tab === 'plan' ? 'budget' : q.tab ?? firstTab ?? 'overview';

 // READY (Datup): the cash book: one list, money in hand on top.
 if (tab === 'book') {
  const [r, live] = await Promise.all([api<EntriesData>('finance/entries'), api<LiveState>('finance/live')]);
  if (!r.data) return <Page calm><PageHeader title="Finance" context={['Private · separate finance grants']} />
   {r.status === 403 ? <section className={styles.panel} aria-label="Finance access required"><Empty icon={ShieldCheck} first title="Finance access required"
    text="The cash book is for leadership and the Finance role. Ask an organisation admin to give you the Finance role in Settings → Roles & permissions." action={{ href: '/settings?tab=roles', label: 'Settings → Roles & permissions' }} /></section>
    : <Message text={r.error ?? 'The cash book is unavailable'} />}</Page>;
  return <Page calm>
   <PageHeader title="Finance" context={[PRIVATE]} />
   <FinanceNav tab={tab} q={q} live={live.data} />
   <CashBook d={r.data} />
  </Page>;
 }

 // LIFECYCLE: each person's value to the company against their cost (founders and HR with the salary permission).
 if (tab === 'people') {
  const [r, live] = await Promise.all([api<ValueData>(`value${/^\d{4}-\d{2}$/.test(q.month ?? '') ? `?month=${q.month}` : ''}`), api<LiveState>('finance/live')]);
  // QA-1024 (R015): someone who may not see it gets the refusal alone, as on every other Finance view, not the tabs first.
  return <Page calm><PageHeader title="Finance" context={[PRIVATE]} />{r.data ? <FinanceNav tab={tab} q={q} live={live.data} /> : null}
   {r.data ? <ValueBoard data={r.data} base="/finance?tab=people" band={q.band} /> : <section className={styles.panel}><Empty icon={ShieldCheck} first title="Value against cost needs the salary permission"
    text={r.status === 403 ? 'Like salaries, it is for HR and leadership, or an admin given the salary permission. Nothing was read and nothing was logged.' : r.error ?? 'Unavailable'} /></section>}</Page>;
 }
 if (tab === 'ad-spend') {
  const [r, live] = await Promise.all([api<AdData>('money/ad-spend'), api<LiveState>('finance/live')]);
  if (r.error || !r.data) return <Message text={r.error ?? 'Ad observations unavailable'} />;
  const parts = adSpendParts(r.data), pick = (label: string) => parts.items.find((x) => x.label === label)?.content;
  return <Page calm><PageHeader title="Finance" context={[PRIVATE]} /><FinanceNav tab={tab} q={q} live={live.data} />
   <Switch param="adView" label="Ad spend views" items={[
    { label: 'Funding', content: <AdFundingView d={r.data} m={live.data?.model ?? null} note={parts.note} /> },
    { label: 'Accounts', content: <AdAccountsView d={r.data} /> },
    { label: 'Lead costs', content: pick('Cost per lead') },
    { label: 'Segments', content: pick('Segments & outcomes') },
   ]} /></Page>;
 }

 // FIN-ENTRY: entries typed in Pulse, for leadership and the Finance role (who cannot open the other views).
 if (tab === 'entries') {
  const keep = new URLSearchParams(Object.entries(q).filter(([k, v]) => ['month', 'kind', 'status', 'q'].includes(k) && v));
  const show = ['dismissed', 'confirmed'].includes(q.waShow) ? q.waShow : 'new', waOffset = Math.max(0, Number(q.waOffset) || 0);
  const [r, wa, live] = await Promise.all([api<EntriesData>(`finance/entries?${keep}`), api<WaData>(`finance/entries/whatsapp?show=${show}&offset=${waOffset}`), api<LiveState>('finance/live')]);
  if (!r.data) return <Page calm><PageHeader title="Finance" context={['Private · separate finance grants']} />
   {r.status === 403 ? <section className={styles.panel} aria-label="Finance access required"><Empty icon={ShieldCheck} first title="Finance access required"
    text="Finance entries are for leadership and the Finance role. Ask an organisation admin to give you the Finance role in Settings → Roles & permissions." action={{ href: '/settings?tab=roles', label: 'Settings → Roles & permissions' }} /></section>
    : <Message text={r.error ?? 'Finance entries unavailable'} />}</Page>;
  return <Page calm>
   <PageHeader title="Finance" context={[PRIVATE]} actions={r.data.canWrite ? <AddEntryButton options={r.data} /> : undefined} />
   <FinanceNav tab={tab} q={q} live={live.data} />
   <EntriesView d={r.data} wa={wa.data ?? null} q={q} />
  </Page>;
 }

 if (DESK.includes(tab)) {
  const finance = await api<FinanceData>(`finance?${new URLSearchParams(q)}`);
  // POLISH-2: an admin without finance grants read the database's "Finance amount and source grants required".
  // UX-5A: without finance access the tabs lead nowhere: only the one explanation shows.
  if (!finance.data) return <Page calm><PageHeader title="Finance" context={['Private · separate finance grants']} />
   {finance.status === 403 ? <section className={styles.panel} aria-label="Finance access required"><Empty icon={ShieldCheck} first title="Finance access required"
    text="Finance figures are private. You need the Leadership role, or an organisation admin account with both Finance read and amount permissions. The Finance role covers ERP only; it does not unlock these private figures. Ask an organisation admin to review your access."
    action={{ href: '/settings?tab=roles', label: 'Settings → Roles & permissions' }} /></section>
    : <><FinanceNav tab={tab} q={q} /><Message text={finance.error ?? 'Finance sources unavailable'} /></>}
  </Page>;
  const d = finance.data, canWrite = d.permissions.write && !d.synthetic, live = d.synthetic ? null : d.live, m = live?.model ?? null;
  // COMP-B: the forecast with people cost from the pay records, for viewers who may see pay (founders and HR).
  const people = tab === 'forecast' && m ? (await api<PeopleCost>('comp/people-cost')).data : null;
  // The certified workspace for this view (statements, allocations, versions) sits beside the live figures.
  const certified = <FinanceDesk d={d} tab={tab} q={q} canWrite={canWrite} />;
  // Page views use their own `…Page` parameter; a link into the certified workspace (its `…View`) opens that view.
  const pair = (param: string, first: string, view: ReactNode, second: string, inner: string) => m ? <Switch param={param} label="Views" follow={{ param: inner, index: 1 }} items={[{ label: first, content: view }, { label: second, content: certified }]} /> : certified;
  const body = tab === 'overview' ? (m ? <FinanceOverview live={live!} /> : certified)
   : tab === 'income' ? (m ? <RevenueView m={m} /> : <NoModel what="Revenue figures" />)
   : tab === 'clients' ? (m ? <ClientsView m={m} /> : <NoModel what="Client figures" />)
   : tab === 'revenue' ? pair('collectionsPage', 'Invoices', m ? <CollectionsView m={m} /> : null, 'Certified applications', 'collectionsView')
   : tab === 'subscriptions' ? pair('vendorsPage', 'Vendors', m ? <VendorsView m={m} /> : null, 'Contract records', 'vendorView')
   : tab === 'budget' ? pair('budgetPage', 'Plan and costs', m ? <BudgetView m={m} /> : null, 'Budget history', 'budgetView')
   : tab === 'forecast' ? pair('forecastPage', 'Six months', m ? <ProjectionView m={m} people={people?.outlook ?? null} /> : null, 'Thirteen weeks', 'forecastView')
   : tab === 'timeline' ? pair('timelinePage', 'Month by month', m ? <TimelineView m={m} /> : null, 'Monthly lanes', 'timelineView')
   : tab === 'reconcile' && m ? <Switch param="reconcilePage" label="Views" follow={{ param: 'reconcileView', index: 2 }} items={[{ label: 'Matches', content: <MatchesView m={m} upload={canWrite ? <ImportStatement /> : undefined} /> }, { label: 'Exceptions', content: <ExceptionsView m={m} /> }, { label: 'Certified queue', content: certified }]} />
   : certified;
  return <Page calm>
   <PageHeader title="Finance" context={[d.synthetic ? 'Synthetic pilot · read only' : PRIVATE]} actions={canWrite ? <><AddEntryButton /><ImportStatement /></> : undefined} />
   <FinanceNav tab={tab} q={q} live={live} />
   {body}
  </Page>;
 }

 const kinds = ['invoice', 'bill', 'bank_line', 'cost_month', 'filing', 'suspense', 'ad_spend_month', 'subscription', 'expense_month', 'plan', 'bank_balance'], kind = kinds.includes(q.kind) ? q.kind : 'invoice', offset = Math.max(0, Number(q.offset) || 0);
 const [result, live, evidence] = await Promise.all([
  api<MoneyData>(`money?${new URLSearchParams(q)}`),
  tab === 'ledger' ? api<LiveState>('finance/live') : Promise.resolve({ data: null }),
  tab === 'ledger' ? api<{ total: number; rows: { key: string; body: Record<string, unknown>; source: Record<string, unknown>; confidence: 'high' | 'medium' | 'low'; hash: string }[] }>(`finance/live/records?kind=${kind}&offset=${offset}`) : Promise.resolve({ data: null }),
 ]);
 if (result.error) return <Message text={result.error} />;
 const d = result.data; if (!d) return null;
 const w = d.workspace, canWrite = d.permissions.write && d.permissions.amounts;
 return <Page calm><PageHeader title="Finance" context={[PRIVATE]} actions={canWrite ? <ImportStatement /> : undefined} />
  <FinanceNav tab={tab} q={q} live={live.data} title={tab === 'ledger' ? 'Data sources' : undefined} />
  <div className={`${css.paged} ${fin.body}`} data-grow="">
   {!d.permissions.amounts ? <div className={css.notice}><ShieldCheck size={18} />Your account can read metadata. Financial amounts require a separate grant.</div> : null}
   {tab === 'spend' ? <Workspace wrap param="view"><p className={css.tabNote}>Legacy reviewed observations by category and vendor. Certified cash is in Overview and Reconcile. Each currency keeps its own totals.</p>{w?.spend.length ? w.spend.map(x => <div key={x.currency} className={css.grid}><section className={css.card}><h3>By category · {x.currency}</h3><Breakdown items={x.categories} currency={x.currency} /></section><section className={css.card}><h3>By vendor · {x.currency}</h3><Breakdown items={x.vendors} currency={x.currency} /></section></div>) : <Empty icon={PieChart} title="Spend trends need reconciled payments" text="Categorise and reconcile ledger outflows to start." action={{ href: '/finance?tab=ledger', label: 'Open ledger' }} />}{w?.trends.map(t => <section className={css.card} key={t.currency}><h3>Monthly spending trend · {t.currency}</h3><table className={css.table}><thead><tr><th>Month</th><th>Outflow</th><th>Change from preceding recorded month</th></tr></thead><tbody>{t.months.map((m, i) => <tr key={m.month}><td>{m.month}</td><td>{money(m.outflow, t.currency)}</td><td>{i && t.months[i - 1].outflow ? `${Math.round((m.outflow / t.months[i - 1].outflow - 1) * 100)}%` : '—'}</td></tr>)}</tbody></table></section>)}</Workspace> : null}
   {tab === 'payroll' ? <Workspace wrap param="view"><p className={css.tabNote}>Restricted salary totals. Imported salary entries carry effective dates and source evidence; monthly payments and CTC are kept distinct.</p>{d.payroll ? <><section className={css.card}><h3>Salary cost trend</h3><p title="Different sheets are not added together. These are salary rates reported by sheets, not bank-confirmed payments.">Latest salary per person and month, as the salary sheets report it (not bank payments).</p><table className={css.table}><thead><tr><th>Month</th><th>Reported salary cost</th><th>People with an entry</th></tr></thead><tbody>{d.payrollTrend?.map((r, i) => <tr key={i}><td>{s(r.month).slice(0, 7)}</td><td>{money(r.amount, s(r.currency))}</td><td>{text(r.people)}</td></tr>)}</tbody></table></section><section className={css.card}><h3>Latest salary entries</h3><p title="Historical effective dates describe salary changes, not a complete history of payments.">{d.payroll.length} salary records, totalled by the month they took effect.</p><table className={css.table}><thead><tr><th>Effective month</th><th>Currency</th><th>Total latest salary entries effective in month</th><th>People</th></tr></thead><tbody>{Object.entries(d.payroll.reduce<Record<string, { amount: number; people: number }>>((a, r) => { const k = s(r.month).slice(0, 7) + '|' + s(r.currency); a[k] ??= { amount: 0, people: 0 }; a[k].amount += Number(r.amount) || 0; a[k].people++; return a; }, {})).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => <tr key={k}><td>{k.split('|')[0]}</td><td>{k.split('|')[1]}</td><td>{money(v.amount, k.split('|')[1])}</td><td>{v.people}</td></tr>)}</tbody></table><Link className={styles.btn} href="/hr?tab=payroll">Employee salary components & history</Link></section></> : <Empty icon={ShieldCheck} title="Salary permission required" text="Payroll totals need a separate salary read permission." />}</Workspace> : null}
   {tab === 'ledger' ? <Switch param="financeSource" label="Data sources views" items={[
    ...(live.data ? [{ label: 'Live sources', content: <LiveSourcesView live={live.data} /> }, { label: 'What is missing', content: <MissingView m={live.data.model} /> }, { label: 'Evidence', content: <EvidenceView evidence={evidence.data ? { kind, offset, ...evidence.data } : undefined} /> }] : []),
    { label: 'Observations', content: <section aria-label="Observations"><form className={css.controls}><input type="hidden" name="tab" value="ledger" /><label>Source <SelectField name="dataset" defaultValue={d.dataset}>{d.datasets.map(ds => <option key={ds} value={ds}>{labels[ds]}</option>)}</SelectField></label><button className={styles.btn}>Open</button><Badge>{d.total.toLocaleString('en-IN')} observations</Badge><span className={css.tabNote}>Review original observations, then prepare evidence and allocate in Reconcile. Source review alone never certifies cash.</span></form><Pager primary min={4} unit="entries" mobile={8}><div className={`${css.ledger} ${css.compactLedger} ${css.oneLine}`} data-items="">{d.rows.map((o, i) => { const x = o.data, date = s(x.date || x.last_charge_date || x.last_observed_date), out = x.direction === 'outflow'; return <article key={o.id} className={css.ledgerRow}><span className={css.ledgerIcon} data-out={out || undefined}>{out ? <ArrowUpRight size={20} /> : <ArrowDownLeft size={20} />}</span><div>{i === 0 || s(d.rows[i - 1].data.date).slice(0, 7) !== date.slice(0, 7) ? <small>{date.slice(0, 7) || 'Undated observations'}</small> : null}<p title={`${text(x.vendor || x.tool || 'Unlabelled observation')} — source evidence: ${text(o.evidence).slice(0, 400)}`}>{text(x.vendor || x.tool || 'Unlabelled observation')}</p><small>{date || 'Date unknown'} · {text(x.record_kind || x.kind || 'Observation')}</small></div><div className={css.amount}>{d.permissions.amounts ? money(x.amount ?? x.last_amount ?? x.last_charge_amount, s(x.currency) || 'INR') : 'Restricted'}<small>{text(x.direction || 'Direction unknown')}</small></div><div className={css.rowFoot}><Badge>{text(x.category || x.cycle || 'Uncategorised')}</Badge><Badge tone={o.approved ? 'success' : 'warning'}>{o.approved ? 'Source reviewed' : 'Needs review'}</Badge><Badge>{text(o.projectName || x.project_key || 'Project match needed')}</Badge>{canWrite ? <><PrepareFinanceSource observation={o} /><LedgerQuickEdit dataset={d.dataset} id={o.id} category={s(x.category)} projectId={s(o.projectId) || undefined} projects={d.projects} /><FinanceApprove dataset={d.dataset} id={o.id} approved={o.approved} /></> : null}<details><summary>Source evidence</summary><pre className={css.source}>{text(o.evidence)}</pre></details></div></article>; })}</div></Pager><p className={css.pageNote}>Entries {(d.page * 50 + 1).toLocaleString('en-IN')}–{Math.min(d.total, (d.page + 1) * 50).toLocaleString('en-IN')} of {d.total.toLocaleString('en-IN')}{d.page ? <> · <Link href={`/finance?${new URLSearchParams({ ...q, tab: 'ledger', page: String(d.page - 1) })}`}>Previous 50</Link></> : null}{(d.page + 1) * 50 < d.total ? <> · <Link href={`/finance?${new URLSearchParams({ ...q, tab: 'ledger', page: String(d.page + 1) })}`}>Next 50</Link></> : null}</p><p className={css.tabNote}>Bank connection (Account Aggregator): {d.aaEnabled ? 'design enabled, no provider connected' : 'not connected'}. Pulse never asks for banking credentials. <a href="https://www.financialservices.gov.in/account-aggregator-framework" target="_blank" rel="noreferrer">How it works</a></p></section> },
   ]} /> : null}
  </div></Page>;
}
