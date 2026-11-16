// "This is what payroll will use": the month's attendance as payroll reads it, and HR's cut-off for fixing it.
import Link from "next/link";
import { day } from "../lib/format";
import type { PayrollMonth } from "../hr/types";
import css from "./presence.module.css";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function PayrollCard({ payroll, compact }: { payroll: PayrollMonth; compact?: boolean }) {
  const name = MONTHS[Number(payroll.month.slice(5, 7)) - 1];
  const waiting = payroll.pendingCorrections + payroll.pendingLeave;
  const items: { label: string; value: number; warn?: boolean; href: string }[] = [
    { label: "Present", value: payroll.present, href: "/me?tab=attendance" },
    { label: "Late marks", value: payroll.late, warn: payroll.late > 0, href: "/me?tab=attendance" },
    { label: "Half days", value: payroll.halfDays, warn: payroll.halfDays > 0, href: "/me?tab=attendance" },
    { label: "Leave", value: payroll.leave, href: "/me?tab=leave" },
    { label: "No check-out", value: payroll.missedOut, warn: payroll.missedOut > 0, href: "/me?tab=attendance" },
    { label: "Waiting", value: waiting, warn: waiting > 0, href: "/me?tab=attendance" },
  ];
  const deadline = payroll.closed
    ? payroll.cutoffDate ? `Closed for payroll on ${day(payroll.cutoffDate)}. Ask HR if something is wrong.` : "This month has ended. Ask HR if something is wrong."
    : payroll.cutoffDate ? <>Fix anything before <b>{day(payroll.cutoffDate)}</b>{payroll.daysLeft !== null ? ` (${payroll.daysLeft === 0 ? "today" : payroll.daysLeft === 1 ? "1 day left" : `${payroll.daysLeft} days left`})` : ""}.</>
    : "Fix anything before HR runs payroll; HR has not set a cut-off date yet.";
  return (
    <section className={css.payroll} data-compact={compact ? "" : undefined} data-closed={payroll.closed ? "" : undefined} aria-label={`${name} payroll`}>
      <p className={css.payrollHead}><b>This is what {name} payroll will use</b><span>{deadline}</span></p>
      <dl className={css.payrollStats}>
        {items.map((i) => <div key={i.label} data-warn={i.warn ? "" : undefined}><dt>{i.label}</dt><dd><Link href={i.href}>{i.value}</Link></dd></div>)}
      </dl>
      {!payroll.closed && (payroll.missedOut || payroll.absent) ? <p className={css.payrollFix}>A missed check-out or a day without a check-in? <Link href="/me?tab=attendance">Request a correction</Link> so it counts.</p> : null}
    </section>
  );
}
