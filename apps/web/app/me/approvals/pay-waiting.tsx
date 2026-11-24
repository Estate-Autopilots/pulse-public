import Link from 'next/link';
import {Wallet} from 'lucide-react';
import {Panel, styles} from '../../ui';
import type {PayRow} from '../../people/pay/model';
import css from './approvals.module.css';

/** The pay decisions that wait for this founder: People & pay's "Needs you" rows that are a decision. */
const DECIDE = new Set(['offer.proposed', 'change.proposed', 'pause.proposed', 'probation.outcome', 'settlement.checked']);
export const payDecisions = (people: PayRow[] | null | undefined) =>
  (people ?? []).filter((p) => p.next?.tone === 'act' && DECIDE.has(p.next.key)).sort((a, b) => a.name.localeCompare(b.name));

/** VITALS-SHIP (24 Nov 2026, tutorials bug): a pay set-up waiting for the founder showed only under People & pay →
 *  Needs you, while Approvals said "Nothing to decide", so a founder who never opens People & pay never learned that
 *  payroll waited on them. Approvals now lists them too, each opening its own Review on the person's pay page. */
export function PayWaiting({rows}: {rows: PayRow[]}) {
  if (!rows.length) return null;
  return <Panel title="Pay waiting for you" sub={`${rows.length} to decide`} action={{href: '/people/pay', label: 'People & pay'}}>
    <ul className={css.payList}>
      {rows.map((p) => <li key={p.id}>
        <Wallet size={16} aria-hidden="true"/>
        <span className={css.payWho}><b>{p.name}</b><small>{p.next!.label}</small></span>
        <Link className={styles.btn} href={p.action ? `/people/pay/${encodeURIComponent(p.id)}?do=${encodeURIComponent(p.action.key)}` : `/people/pay/${encodeURIComponent(p.id)}`}>Review</Link>
      </li>)}
    </ul>
  </Panel>;
}
