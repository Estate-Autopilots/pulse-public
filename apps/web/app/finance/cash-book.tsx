import { BookOpen } from 'lucide-react';
import { Empty, styles } from '../ui';
import { dayName } from '../lib/finance-view.mjs';
import { AddEntryButton, QuickAdd } from './entries';
import { rupees as plain, type EntriesData } from './entry-types';
import css from './entries.module.css';

/** A signed amount reads −₹1,500, not ₹-1,500. */
const rupees = (minor: number) => (minor < 0 ? '−' : '') + plain(Math.abs(minor));

/** READY (Datup, Atlas Crest, 18 and 21 Oct 2026: "Finance is too hard … I want easy"; his sketch: the date and the
 *  money that came in, then each cost with its date, amount and nature, then the total in hand). One list, newest first:
 *  date · in or out · amount · nature · note, with the balance after each line and the money in hand at the top. It reads
 *  the same entries as Finance → Entries (approved ones count; transfers move money between accounts and are left out). */
export function CashBook({ d }: { d: EntriesData }) {
 const inHand = d.totals.moneyIn - d.totals.moneyOut;
 // The list is the newest 300; each line's balance is counted back from the total in hand.
 const lines = d.entries.filter((e) => e.status === 'approved' && !e.deleted && e.direction !== 'neutral');
 const effect = lines.map((e) => (e.direction === 'in' ? e.amountMinor : -e.amountMinor));
 const before = effect.reduce<number[]>((acc, x) => [...acc, acc[acc.length - 1] + x], [0]);
 const rows = lines.map((e, i) => ({ e, balance: inHand - before[i] }));
 const pending = d.entries.filter((e) => e.status === 'pending' && !e.deleted);
 return <div className={css.page} data-grow="">
  <section className={css.bookHead} aria-label="Money in hand">
   <div><small>In hand</small><b data-tone={inHand < 0 ? 'neg' : undefined}>{rupees(inHand)}</b>
    <span>{rupees(d.totals.moneyIn)} came in · {rupees(d.totals.moneyOut)} spent{pending.length ? ` · ${pending.length} waiting for approval` : ''}</span></div>
   {d.canWrite ? <div className={css.bookActions}>
    <AddEntryButton options={d} label="Money in" start={{ kind: 'income', direction: 'in' }} />
    <AddEntryButton options={d} label="Spent" start={{ kind: 'expense', direction: 'out' }} />
   </div> : null}
  </section>
  {d.canWrite ? <QuickAdd options={d} /> : null}
  {rows.length ? <table className={css.book}>
   <thead><tr><th scope="col">Date</th><th scope="col">Nature</th><th scope="col" className={css.num}>In</th><th scope="col" className={css.num}>Out</th><th scope="col" className={css.num}>In hand after</th></tr></thead>
   <tbody>{rows.map(({ e, balance }) => <tr key={e.id}>
    <td>{dayName(e.date)}</td>
    <td><b>{e.category ?? (e.direction === 'in' ? 'Money in' : 'Spent')}</b>{e.vendor || e.clientName || e.note ? <small>{[e.direction === 'in' ? e.clientName ?? e.vendor : e.vendor, e.note].filter(Boolean).join(' · ')}</small> : null}</td>
    <td className={css.num}>{e.direction === 'in' ? rupees(e.amountMinor) : ''}</td>
    <td className={css.num}>{e.direction === 'out' ? rupees(e.amountMinor) : ''}</td>
    <td className={css.num}>{rupees(balance)}</td>
   </tr>)}</tbody>
  </table> : <section className={styles.panel}><Empty icon={BookOpen} first title="The cash book is empty"
   text="Add the money that came in and each thing you spent: the date, the amount and what it was for. Pulse keeps the total in hand. Or type it in one line above, like “Spent 1,200 on printing today”." /></section>}
 </div>;
}
