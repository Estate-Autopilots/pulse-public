import Link from 'next/link';
import { Inbox, MessageCircle } from 'lucide-react';
import { Empty, Kpi, Tiles, styles } from '../ui';
import { Switch } from './switch';
import { EntryList, EntrySettingsForm, QuickAdd, WhatsAppCards } from './entries';
import { KIND_WORDS, rupees, type EntriesData, type WaData } from './entry-types';
import css from './entries.module.css';
import { SelectField } from "../kit/select-field";

/** Finance → Entries: what was typed in Pulse, the WhatsApp screenshots waiting to be confirmed, and (leadership) the settings. */
export function EntriesView({ d, wa, q }: { d: EntriesData; wa: WaData | null; q: Record<string, string> }) {
 const month = /^\d{4}-\d{2}$/.test(q.month ?? '') ? q.month : '', show = ['dismissed', 'confirmed'].includes(q.waShow) ? q.waShow : 'new';
 const monthName = (m: string) => new Date(m + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
 const t = d.totals, scope = month ? monthName(month) : 'All months';
 const waPage = (offset: number, s = show) => `/finance?${new URLSearchParams({ tab: 'entries', entriesPage: 'Found in WhatsApp', waShow: s, ...(offset ? { waOffset: String(offset) } : {}) })}`;
 const list = <div className={css.pane}>
  <form className={css.filters} action="/finance">
   <input type="hidden" name="tab" value="entries" />
   <label className={styles.field}>Month<SelectField name="month" defaultValue={month}><option value="">All months</option>{d.months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}</SelectField></label>
   <label className={styles.field}>Type<SelectField name="kind" defaultValue={q.kind ?? ''}><option value="">All types</option>{Object.entries(KIND_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</SelectField></label>
   <label className={styles.field}>Status<SelectField name="status" defaultValue={q.status ?? ''}><option value="">Current</option><option value="pending">Waiting for approval</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="deleted">Deleted</option></SelectField></label>
   <label className={`${styles.field} ${css.search}`}>Search<input name="q" defaultValue={q.q ?? ''} placeholder="Vendor, client, note" /></label>
   <button className={styles.btn}>Show</button>
  </form>
  {d.entries.length ? <EntryList entries={d.entries} options={d} /> : <Empty icon={Inbox} title={q.q || q.kind || q.status || month ? 'No entries match' : 'Nothing entered yet'}
   text={q.q || q.kind || q.status || month ? 'Change the filters above.' : 'Add an expense, a payment received, a bill, a refund or a transfer. It counts in Overview, Budget and Timeline for its month, marked as entered in Pulse.'} />}
 </div>;
 const found = <div className={css.pane}>
  <p className={css.intro}><MessageCircle size={15} aria-hidden="true" />Payment screenshots found in the company&apos;s WhatsApp groups. Confirm the ones that are company money; each becomes an entry with the screenshot attached as its source. Nothing is sent to WhatsApp.</p>
  <nav className={css.showRow} aria-label="Which screenshots">{[['new', 'To check'], ['confirmed', 'Confirmed'], ['dismissed', 'Set aside']].map(([k, label]) => <Link key={k} href={waPage(0, k)} className={css.showLink} aria-current={k === show ? 'true' : undefined}>{label}{k === 'new' ? ` (${d.whatsapp})` : ''}</Link>)}</nav>
  {wa?.rows.length ? <WhatsAppCards rows={wa.rows} options={d} show={show} /> : <Empty icon={MessageCircle} title={show === 'new' ? 'No screenshots to check' : 'None yet'} text={show === 'new' ? 'Screenshots with an amount appear here after the WhatsApp index is copied into Pulse (the finance sync).' : undefined} />}
  {wa && wa.total > 24 ? <p className={css.pager}>{wa.offset ? <Link href={waPage(Math.max(0, wa.offset - 24))}>Newer</Link> : null}<span>{wa.offset + 1}–{Math.min(wa.total, wa.offset + 24)} of {wa.total}</span>{wa.offset + 24 < wa.total ? <Link href={waPage(wa.offset + 24)}>Older</Link> : null}</p> : null}
 </div>;
 return <div className={css.page} data-grow="">
  <QuickAdd options={d} />
  <Tiles count={4} dense>
   <Kpi label={`Money in · ${scope}`} value={rupees(t.moneyIn)} note="Payments received and refunds back, entered in Pulse" />
   <Kpi label={`Money out · ${scope}`} value={rupees(t.moneyOut)} note="Expenses, bills and refunds paid, entered in Pulse" />
   <Kpi label="Entries" value={String(t.count)} note={month ? 'Approved, this month' : 'Approved, all months'} />
   <Kpi label="Waiting for approval" value={String(t.pending)} tone={t.pending ? 'warning' : undefined} note={t.pending ? `${rupees(t.pendingMinor)} · not in the totals yet` : `Above ${rupees(d.settings.approvalMinor)} needs leadership`} href={t.pending ? '/finance?tab=entries&status=pending' : undefined} />
  </Tiles>
  <Switch param="entriesPage" label="Entries views" items={[
   { label: 'Entries', content: list },
   { label: 'Found in WhatsApp', content: found },
   { label: 'Settings', content: <div className={css.pane}><EntrySettingsForm options={d} /></div> },
  ]} />
 </div>;
}
