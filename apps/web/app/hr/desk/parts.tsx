import Link from "next/link";
import { ArrowRight, ChevronLeft, ChevronRight, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ago, day, longDay, range } from "../../lib/format";
import { Avatar, Badge, styles } from "../../ui";
import { Decide } from "../actions";
import css from "../desk.module.css";
import { Clamp } from "./clamp";
import { REG_KIND, dayCount, leaveName, type Balance, type LeaveRequest, type LeaveType, type Regularisation } from "../types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
export const shiftMonth = (month: string, by: number) => { const n = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by; return `${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, "0")}`; };
export const weekdayLetter = (date: string) => "SMTWTFS"[new Date(`${date}T00:00:00Z`).getUTCDay()];
export const halfLabel = (h: string | null) => h === "first" ? "first half" : h === "second" ? "second half" : "";
/** Days as a bare number: 2, 1.5. */
export const num = (days: number) => Number.isInteger(days) ? String(days) : days.toFixed(1);

/** Step a month back and forward; the URL carries the month, so a refresh or a shared link shows the same one. */
export function MonthNav({ tab, view, month, today, latest }: { tab: string; /** The sub-tab the month belongs to. */ view?: string; month: string; today: string; latest?: string }) {
  const now = today.slice(0, 7); const href = (m: string) => `/hr?tab=${tab}${m === now ? "" : `&month=${m}`}${view ? `&view=${view}` : ""}`; const last = latest ?? now;
  return (
    <span className={css.pick}>
      <Link href={href(shiftMonth(month, -1))} scroll={false} className={css.pickStep} aria-label="Earlier month" title="Earlier month"><ChevronLeft size={15} aria-hidden="true" /></Link>
      <span className={css.pickLabel}>{monthName(month)}</span>
      <Link href={href(shiftMonth(month, 1))} scroll={false} className={css.pickStep} aria-label="Later month" title="Later month" aria-disabled={month >= last ? "true" : undefined} tabIndex={month >= last ? -1 : undefined}><ChevronRight size={15} aria-hidden="true" /></Link>
      {month !== now ? <Link href={href(now)} scroll={false} className={`${styles.btn} ${styles.btnGhost}`}>This month</Link> : null}
    </span>
  );
}

/** A list with nothing in it yet: one quiet row, so the panel pages it like any other row. */
export function None({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return <li className={css.none}><Icon size={14} aria-hidden="true" /><span>{children}</span></li>;
}

/** "8 Oct", "14 – 16 Oct", "30 Oct – 2 Nov"; the year only when it is not this one. */
export function shortRange(from: string, to: string) {
  const year = from.slice(0, 4) === to.slice(0, 4) && to.slice(0, 4) === String(new Date().getFullYear()) ? "" : ` ${to.slice(0, 4)}`;
  if (from === to) return `${day(from)}${year}`;
  return from.slice(0, 7) === to.slice(0, 7) ? `${Number(from.slice(8))} – ${day(to)}${year}` : `${day(from)} – ${day(to)}${year}`;
}
/** Correction kinds short enough to sit beside a name. */
const REG_SHORT: Record<Regularisation["kind"], string> = { missed_punch: "Missed check-in/out", wfh: "Work from home", on_duty: "On duty", late: "Late mark" };

/** What approving a leave request does to the person's balance: "Balance 1.5 → 0.5 days", the sentence for screen readers. */
function Impact({ request, balance, types }: { request: LeaveRequest; balance: Balance | null | undefined; types: LeaveType[] }) {
  const type = types.find((t) => t.key === request.kind);
  if (!balance) return <span className={css.askImpact}>{type && !type.paid ? "Unpaid, so no balance is used" : "This leave type has no fixed allowance"}</span>;
  const after = balance.available - request.days;
  if (after < 0) return <span className={css.askImpact} data-over=""><TriangleAlert size={13} aria-hidden="true" />{dayCount(-after)} more than the {dayCount(balance.available)} available</span>;
  return (
    <span className={css.askImpact}>
      <span className={css.askBalance} aria-hidden="true"><span>Balance</span><b>{num(balance.available)}</b><ArrowRight size={13} /><b>{num(after)}</b>{after === 1 ? "day" : "days"}</span>
      <span className={styles.srOnly}>{dayCount(balance.available)} available now, {dayCount(after)} left after this</span>
    </span>
  );
}

/** The decision row of a waiting request: Approve and Reject side by side, when it was asked on the right. */
function AskFoot({ own, decide, createdAt }: { own: boolean; decide: ReactNode; createdAt: string }) {
  return (
    <div className={css.askFoot}>
      {own ? <span className={css.askOwn} title="The service does not let anyone decide their own request">Yours: someone else decides</span> : decide}
      <span className={css.askAgo}>Asked {ago(createdAt)}</span>
    </div>
  );
}

/** One leave request waiting for a decision: who and what, when, why (two lines, "more"), the balance, the decision. The person who asked cannot decide their own. */
export function LeaveAsk({ request: l, balance, types, me }: { request: LeaveRequest; balance?: Balance | null; types: LeaveType[]; me: string | null }) {
  return (
    <li className={css.ask}>
      <div className={css.askTop}>
        <Avatar name={l.name} id={l.personId} photoAt={l.photoAt} size={28} />
        <Link href={`/people/${l.personId}?tab=attendance`} className={css.askName}>{l.name}</Link>
        <Badge tone="accent">{leaveName(types, l.kind)}</Badge>
      </div>
      <div className={css.askBody}>
        <span className={css.askWhen} title={range(l.fromDate, l.toDate)}><b>{shortRange(l.fromDate, l.toDate)}</b> · {dayCount(l.days)}{l.halfDay ? ` (${halfLabel(l.halfDay)})` : ""}</span>
        {l.reason ? <Clamp className={css.askReason} text={`“${l.reason}”`} /> : null}
        <Impact request={l} balance={balance} types={types} />
      </div>
      <AskFoot own={l.personId === me} decide={<Decide kind="leave" id={l.id} name={l.name} />} createdAt={l.createdAt} />
    </li>
  );
}

/** One attendance correction waiting for a decision, laid out like a leave request. */
export function CorrectionAsk({ request: r, me }: { request: Regularisation; me: string | null }) {
  const times = r.inTime || r.outTime ? ` · ${r.inTime ? `in ${r.inTime}` : ""}${r.inTime && r.outTime ? ", " : ""}${r.outTime ? `out ${r.outTime}` : ""}` : "";
  return (
    <li className={css.ask}>
      <div className={css.askTop}>
        <Avatar name={r.name} id={r.personId} photoAt={r.photoAt} size={28} />
        <Link href={`/people/${r.personId}?tab=attendance`} className={css.askName}>{r.name}</Link>
        <span title={REG_KIND[r.kind]}><Badge>{REG_SHORT[r.kind] ?? REG_KIND[r.kind]}</Badge></span>
      </div>
      <div className={css.askBody}>
        <span className={css.askWhen} title={longDay(r.date)}><b>{shortRange(r.date, r.date)}</b>{times}</span>
        <Clamp className={css.askReason} text={`“${r.reason}”`} />
        <span className={css.askImpact}>{r.kind === "late" ? "Approving removes the late mark from that day" : "Approving updates that day and marks it as corrected"}</span>
      </div>
      <AskFoot own={r.personId === me} decide={<Decide kind="regularisation" id={r.id} name={r.name} />} createdAt={r.createdAt} />
    </li>
  );
}
