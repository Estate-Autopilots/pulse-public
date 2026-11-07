// UX-POLISH-2 (owner, 6 Nov 2026: Finance "more gamified, coherent, less clutter"): the month's books as a short path
// to done. A ring shows how much of this month's close is ready, a checklist names each step (done ones ticked, the
// rest linked to where they are done), small badges mark what is in good shape, and a streak counts GST quarters filed
// on time in a row. Everything is worked out from figures Finance already has; nothing here is invented or stored.
// The ring fills and the ticks pop in once when the page opens (no motion under prefers-reduced-motion).
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { BadgeCheck, CircleCheck, CircleDashed, Flame } from 'lucide-react';
import type { LiveModel } from './types';
import { Celebrate } from '../kit/celebrate';
import css from './close-progress.module.css';

type Step = { key: string; label: string; done: boolean; hint: string; href: string };

/** The close checklist, from the finance-mail model and the Cash book. Exported for tests. */
export function closeSteps(m: LiveModel, uncategorised: number | null): Step[] {
  const end = m.collections.evidenceEnd, fresh = !!end && Date.parse(m.asOf) - Date.parse(end) <= 45 * 864e5;
  const od = m.collections.overdue.confirmed;
  const filedOnTime = !m.compliance.late.length && !m.compliance.gaps.length;
  return [
    { key: 'bank', label: 'Bank statement is current', done: fresh, hint: end ? `Bank lines run to ${end.slice(0, 10)}` : 'No bank lines yet', href: '/finance?tab=reconcile' },
    { key: 'matched', label: 'Every receipt matched to an invoice', done: m.reconcile.unmatchedCredits === 0, hint: m.reconcile.unmatchedCredits ? `${m.reconcile.unmatchedCredits} receipts still to match` : `${m.reconcile.matched} matched`, href: '/finance?tab=reconcile' },
    ...(uncategorised === null ? [] : [{ key: 'sorted', label: 'Cash book sorted into categories', done: uncategorised === 0, hint: uncategorised ? `${uncategorised} lines without a category` : 'Every line has a category', href: '/finance?tab=entries&category=none' }]),
    { key: 'overdue', label: 'No confirmed overdue invoices', done: od.count === 0, hint: od.count ? `${od.count} to chase` : 'Nothing confirmed overdue', href: '/finance?tab=revenue' },
    { key: 'gst', label: 'GST returns filed on time', done: filedOnTime, hint: filedOnTime ? 'No late or missing return' : `${m.compliance.late.length + m.compliance.gaps.length} to look at`, href: '/finance?tab=close' },
    { key: 'certified', label: 'Month certified by the CA', done: m.certified, hint: m.certified ? 'Certified' : 'Waiting for the CA', href: '/finance/desk' },
  ];
}

/** GST quarters filed on time in a row, newest first (both returns filed and neither late). */
export function onTimeStreak(m: LiveModel): number {
  const quarters = [...m.compliance.quarters].filter((q) => !q.open).sort((a, b) => b.quarter.localeCompare(a.quarter));
  let n = 0;
  for (const q of quarters) { if (q.gstr1.filed && q.gstr3b.filed && !q.gstr1.late && !q.gstr3b.late) n++; else break; }
  return n;
}

/** UX-POLISH-4 (owner's chosen concept "Month-close hero", 7 Nov 2026): the month close comes first on Overview: a big
 *  ring, the month's name, one line on what is left, the steps as tick chips in a 3 x 2 grid (done green, open amber
 *  outline, each open one a way in), the earned badges and the on-time streak. */
export function CloseProgress({ model: m, uncategorised }: { model: LiveModel; uncategorised: number }) {
  const steps = closeSteps(m, uncategorised), done = steps.filter((s) => s.done).length, share = done / steps.length;
  const streak = onTimeStreak(m);
  const left = steps.length - done;
  const month = new Intl.DateTimeFormat('en-IN', { month: 'long', timeZone: 'Asia/Kolkata' }).format(new Date(m.asOf));
  const badges = [
    m.reconcile.unmatchedCredits === 0 && m.reconcile.matched ? 'All receipts matched' : null,
    m.collections.overdue.confirmed.count === 0 ? 'Nothing overdue' : null,
    uncategorised === 0 ? 'Cash book sorted' : null,
    m.anomalies.length === 0 ? '0 open exceptions' : null,
  ].filter((x): x is string => !!x);
  const R = 70, C = 2 * Math.PI * R;
  return <section className={css.hero} aria-labelledby="close-title">
    <Celebrate when={done === steps.length} id={`close-${m.asOf.slice(0, 7)}`} />
    <div className={css.heroRing}>
      <svg viewBox="0 0 160 160" role="img" aria-label={`${done} of ${steps.length} close steps done`}>
        <circle cx="80" cy="80" r={R} className={css.track} />
        <circle cx="80" cy="80" r={R} className={css.fill} data-done={done === steps.length ? '' : undefined}
          style={{ '--c': C, '--to': C * (1 - share) } as CSSProperties} strokeDasharray={C} strokeDashoffset={C * (1 - share)} />
      </svg>
      <span className={css.heroRingText}><b>{done}/{steps.length}</b><small>Month-close progress</small></span>
    </div>
    <div className={css.heroBody}>
      <div className={css.heroTop}>
        <span className={css.eyebrow}>{month} close</span>
        {streak ? <span className={css.streak} title="GST quarters with both returns filed on time, in a row"><Flame size={14} aria-hidden="true" />On-time streak: {streak} {streak === 1 ? 'quarter' : 'quarters'}</span> : null}
      </div>
      <h2 id="close-title" className={css.heroTitle}>{left ? 'Finish strong this month' : 'This month is closed'}</h2>
      <p className={css.heroLede}>{left ? `Complete the remaining ${left} ${left === 1 ? 'step' : 'steps'} to close ${month} on time.` : `Every step is done for ${month}. Nicely closed.`}</p>
      <ol className={css.chips}>
        {steps.map((s, i) => <li key={s.key} data-done={s.done ? '' : undefined} style={{ '--i': i } as CSSProperties} title={s.hint}>
          {s.done ? <CircleCheck size={18} className={css.tick} aria-hidden="true" /> : <CircleDashed size={18} className={css.todo} aria-hidden="true" />}
          {s.done ? <span>{s.label}</span> : <Link href={s.href}>{s.label}</Link>}
          <span className={css.srOnly}>{s.done ? ' done' : ` to do: ${s.hint}`}</span>
        </li>)}
      </ol>
      {badges.length ? <ul className={css.badges} aria-label="In good shape">{badges.map((b, k) => <li key={b} style={{ '--i': k } as CSSProperties}><BadgeCheck size={13} aria-hidden="true" />{b}</li>)}</ul> : null}
    </div>
  </section>;
}

/** UX-POLISH-3 (owner, 6 Nov 2026: "Finance still looks un-updated"): the month close as a small ring and a count in
 *  the Finance header of every tab, a way back to the full checklist on Overview. Without the Cash book's count here,
 *  the steps are the five the finance-mail model answers. */
export function CloseMeter({ model: m }: { model: LiveModel }) {
  const steps = closeSteps(m, null), done = steps.filter((s) => s.done).length, share = done / steps.length;
  const R = 9, C = 2 * Math.PI * R, next = steps.find((s) => !s.done);
  return <Link href="/finance?tab=overview" className={css.meter} data-done={done === steps.length ? '' : undefined}
    title={next ? `Next: ${next.label}` : 'Every close step is done'} aria-label={`Month close: ${done} of ${steps.length} steps done`}>
    <svg viewBox="0 0 24 24" className={css.meterRing} aria-hidden="true">
      <circle cx="12" cy="12" r={R} className={css.track} />
      <circle cx="12" cy="12" r={R} className={css.fill} style={{ '--c': C, '--to': C * (1 - share) } as CSSProperties} strokeDasharray={C} strokeDashoffset={C * (1 - share)} />
    </svg>
    <span>Month close <b>{done}/{steps.length}</b></span>
  </Link>;
}
