import { BookOpen } from 'lucide-react';
import { EmptyState, StatTile, StatTiles } from '../components/kit';
import { AddEntryButton, BookTable, CategoryBreakdown, QuickAdd } from './entries';
import { rupees as plain, type EntriesData } from './entry-types';
import css from './entries.module.css';

/** A signed amount reads −₹1,500, not ₹-1,500. */
const rupees = (minor: number) => (minor < 0 ? '−' : '') + plain(Math.abs(minor));

/** READY (Datup, Atlas Crest, 18 and 21 Oct 2026: "Finance is too hard … I want easy"; his sketch: the date and the
 *  money that came in, then each cost with its date, amount and nature, then the total in hand). One list, newest first:
 *  date · in or out · amount · nature · note, with the balance after each line and the money in hand at the top. It reads
 *  the same entries as Finance → Entries (approved ones count; transfers move money between accounts and are left out).
 *  UX-FINANCE (owner, 5 Nov 2026): the money in hand and its parts as stat tiles, Spent as the one primary action (the
 *  commonest line) with Money in beside it, and the empty book saying exactly what to write first. */
export function CashBook({ d }: { d: EntriesData }) {
 const inHand = d.totals.moneyIn - d.totals.moneyOut;
 // The list is the newest 300; each line's balance is counted back from the total in hand.
 const lines = d.entries.filter((e) => e.status === 'approved' && !e.deleted && e.direction !== 'neutral');
 const effect = lines.map((e) => (e.direction === 'in' ? e.amountMinor : -e.amountMinor));
 const before = effect.reduce<number[]>((acc, x) => [...acc, acc[acc.length - 1] + x], [0]);
 const rows = lines.map((e, i) => ({ e, balance: inHand - before[i] }));
 const pending = d.entries.filter((e) => e.status === 'pending' && !e.deleted);
 const unsorted = (d.byCategory ?? []).filter((c) => !c.category).reduce((n, c) => n + c.n, 0);
 return <div className={css.page} data-grow="">
  <section className={css.bookHead} aria-label="Money in hand">
   <StatTiles count={4} label="Cash book totals">
    <StatTile label="In hand" value={rupees(inHand)} tone={inHand < 0 ? 'danger' : undefined} note="Came in less spent, approved lines" />
    <StatTile label="Came in" value={rupees(d.totals.moneyIn)} note="Payments received and refunds back" />
    <StatTile label="Spent" value={rupees(d.totals.moneyOut)} note={unsorted ? `${unsorted} line${unsorted === 1 ? '' : 's'} without a category` : 'Every line has a category'} href={unsorted ? '/finance?tab=entries&category=none' : undefined} tone={unsorted ? 'warning' : undefined} />
    <StatTile label="Waiting for approval" value={String(pending.length)} tone={pending.length ? 'warning' : undefined} note={pending.length ? 'Not in the totals yet' : `Above ${plain(d.settings.approvalMinor)} a leader approves`} />
   </StatTiles>
   {d.canWrite ? <div className={css.bookActions}>
    <AddEntryButton options={d} label="Spent" start={{ kind: 'expense', direction: 'out' }} primary />
    <AddEntryButton options={d} label="Money in" start={{ kind: 'income', direction: 'in' }} secondary />
   </div> : null}
  </section>
  {d.canWrite ? <QuickAdd options={d} /> : null}
  {/* FIN-CAT: what each category cost this month, above the lines. */}
  <CategoryBreakdown totals={d.byCategory ?? []} limit={6} />
  {/* FIN-CAT: each line opens its entry (change, delete, approve, history); waiting ones sit on top so they are not missed. */}
  {pending.length ? <BookTable options={d} rows={pending.map((e) => ({ e, balance: Number.NaN }))} caption={`${pending.length} waiting for approval · not in the total yet`} /> : null}
  {rows.length ? <BookTable options={d} rows={rows} /> : <EmptyState icon={BookOpen} title="The cash book is empty"
   text="Add the money that came in and each thing you spent: the date, the amount and what it was for. Pulse keeps the total in hand. Or type it in one line above, like “Spent 1,200 on printing today”." />}
 </div>;
}
