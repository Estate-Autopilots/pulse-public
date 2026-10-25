import Link from "next/link";
import { CalendarClock, CalendarOff, ChevronLeft, ChevronRight, Inbox, Info, MessageSquare, TrendingUp } from "lucide-react";
import { ago, day, dayYear, plural, range, shiftDay } from "../lib/format";
import { Badge, Empty, styles } from "../ui";
import { Decide, Withdraw } from "./actions";
import css from "./hr.module.css";
import { SparseFacts } from "../charts";
import { sparse } from "../lib/sparse.mjs";
import { CATEGORY, REG_KIND, REQUEST_LABEL, REQUEST_TONE, TICKET_STATUS, dayCount, duration, leaveName, ticketNo,
  type AttendanceSummary, type AttendanceDay, type Balance, type LeaveRequest, type LeaveType, type Performance, type Regularisation, type RequestStatus, type Summary, type Ticket } from "./types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const shiftMonth = (month: string, by: number) => { const n = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by; return `${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, "0")}`; };
const half = (h: string | null) => h === "first" ? "first half" : h === "second" ? "second half" : "";

export function RequestBadge({ status }: { status: RequestStatus }) {
  return <Badge tone={REQUEST_TONE[status]}>{REQUEST_LABEL[status]}</Badge>;
}

/** Earlier and later months; the current month has no link forward. */
export function MonthNav({ base, month, today, keep }: { base: string; month: string; today: string; keep?: string }) {
  const href = (m: string) => `${base}${base.includes("?") ? "&" : "?"}${m === today.slice(0, 7) ? "" : `month=${m}`}${keep ? `&${keep}` : ""}`.replace(/[?&]$/, "").replace("?&", "?");
  const isNow = month >= today.slice(0, 7);
  return (
    <span className={css.monthNav}>
      <Link href={href(shiftMonth(month, -1))} scroll={false} className={styles.iconBtn} aria-label="Earlier month"><ChevronLeft size={15} aria-hidden="true" /></Link>
      <b>{monthName(month)}</b>
      {isNow ? <span className={styles.iconBtn} aria-hidden="true" style={{ opacity: 0.3 }}><ChevronRight size={15} /></span>
        : <Link href={href(shiftMonth(month, 1))} scroll={false} className={styles.iconBtn} aria-label="Later month"><ChevronRight size={15} aria-hidden="true" /></Link>}
    </span>
  );
}

/** One person's month as a calendar (a client component since R43: keyboard, tap for a day's details). */
export { MonthCalendar } from "./month-calendar";

const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export type OffHours = { workDays: number[]; shiftStart: string; shiftEnd: string; confirmed: boolean; comp: { credit: number; expiryDays: number } | null };
export function CalendarLegend({ explain }: { explain?: OffHours }) {
  const items: [string, string][] = [["office", "In the office"], ["wfh", "Work from home"], ["field", "On duty outside"], ["leave", "Leave"], ["holiday", "Holiday"], ["absent", "No check-in"], ["off", "Weekly off"]];
  return <><p className={css.legend}>{items.map(([key, label]) => <span key={key}><i data-status={key} />{label}</span>)}</p>
    {explain ? <OffHoursNote {...explain} /> : null}</>;
}
/** R43: why a day is off, how working on one is asked for and credited, and what happens to hours outside the shift.
 *  Only what Pulse actually does: comp-off for approved day-off work; nothing extra for hours on a working day. */
function OffHoursNote({ workDays, shiftStart, shiftEnd, confirmed, comp }: OffHours) {
  const days = workDays.length === 7 ? "every day" : WEEKDAY.filter((_, i) => workDays.includes(i + 1)).join(", ");
  return <details className={css.offHours}><summary>Off days and extra hours</summary><div className={css.offHoursBody}>
    <p>You work {days}, {shiftStart} to {shiftEnd}, on the company’s clock.{confirmed ? "" : " These are Pulse’s starting hours until HR confirms them."} Weekly offs and holidays need no check-in, and a day without one there is never marked missing.</p>
    <p>Want to work on a day off? Ask first under “Working on a day off?” on Attendance. Once approved, that day counts as a working day{comp ? comp.credit ? <> and checking in earns {comp.credit === 1 ? "1 day" : `${comp.credit} day`} of comp-off, usable for {comp.expiryDays} days</> : <>; HR’s current rule gives no comp-off for it</> : null}.</p>
    <p>Time before or after your shift on a working day is recorded as time worked. It earns no comp-off, and Pulse adds no extra pay for it by itself; ask HR how your policy treats it.</p>
  </div></details>;
}

/** The month in numbers, one line. */
export function MonthSummary({ summary }: { summary: Summary }) {
  const items: [string, string | number, boolean?][] = [["Present", summary.present], ["From home", summary.wfh], ["Late", summary.late, summary.late > 0], ["On leave", summary.leave],
    ["No check-in", summary.absent, summary.absent > 0], ["Average day", summary.averageMinutes !== null ? duration(summary.averageMinutes) : "No eligible days"]];
  return <><dl className={css.stats}>{items.map(([label, value, warn]) => <div key={label} data-warn={warn ? "" : undefined}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><AttendanceCoverage summary={summary} /></>;
}

/** Coverage is about recorded samples; missing records never become zero performance. */
/** Attendance averages: one headline number and one line saying what it means; how it is counted is one tap away.
 *  `compact` (table cells, team cards) shows just the line. Days that need review never count, so a missed
 *  check-out cannot turn into a 43-hour "average". */
export function AttendanceCoverage({ summary: s, href, compact }: { summary: AttendanceSummary; href?: string; compact?: boolean }) {
  const unit = href === "/hr?tab=attendance&view=totals" ? "person-days" : "days";
  const line = s.averageMinutes === null
    ? (s.recordedDays ? `No average yet: ${plural(s.recordedDays, "recorded day")} still need${s.recordedDays === 1 ? "s" : ""} review` : "No check-ins in this period")
    : `a usual day across ${s.eligibleDays} checked ${unit}`;
  const meaning = `${line}${s.averageMinutes !== null && s.flaggedCount ? ` · ${s.flaggedCount} to review` : ""}`;
  const counted = <>
    <p>{s.from} – {s.to} · {s.eligibleDays} eligible {unit} / {s.recordedDays} recorded · Coverage {s.coverage === null ? "unknown" : `${Math.round(s.coverage * 100)}%`} · {s.flaggedCount} flagged sessions · {s.excludedDays} excluded days</p>
    <p>Average: {s.averageMinutes === null ? "No eligible days" : duration(s.averageMinutes)} · Eligible hours: {duration(s.workedMinutes)} · Recorded before filter: {duration(s.recordedMinutes)}. Average uses the same {s.eligibleDays} eligible days.</p>
    <p className={styles.muted}>Provisional filter: sessions or daily totals over 12 hours need review. HR role/shift thresholds await approval. Recorded punches are retained; salary and payroll are unchanged.{href ? <> <Link href={href}>Review corrections</Link></> : null}</p>
  </>;
  // Table cells and team cards: one short line, and how it is counted behind an (i) that opens in place.
  const short = s.averageMinutes === null ? (s.recordedDays ? `${plural(s.recordedDays, "day")} to review` : "No check-ins yet") : `${plural(s.eligibleDays, "checked day")}${s.flaggedCount ? ` · ${s.flaggedCount} to review` : ""}`;
  if (compact) return <div data-attendance-statistics="" className={css.avgCompact}><span title={meaning}>{short}</span><details className={css.avgMore}><summary aria-label="How this is counted" title="How this is counted"><Info size={13} aria-hidden="true" /></summary><div className={css.avgMoreBody}>{counted}</div></details></div>;
  // One headline number and one line; what still needs review is a small chip, how it is counted a quiet popover.
  const flagged = `${s.flaggedCount} to review`;
  return <div data-attendance-statistics="" className={css.avg}>
    <strong className={css.avgValue}>{s.averageMinutes === null ? "—" : duration(s.averageMinutes)}</strong>
    <span className={css.avgLine}>{line}</span>
    {s.flaggedCount ? <span className={css.avgFlag}><span className={styles.srOnly}> · </span>{href ? <Link href={href} className={css.avgChip}>{flagged}<ChevronRight size={13} aria-hidden="true" /></Link> : <span className={css.avgChip}>{flagged}</span>}</span> : null}
    <details className={css.avgPop}><summary><Info size={13} aria-hidden="true" />How this is counted</summary><div className={css.avgPopBody}>{counted}</div></details>
  </div>;
}

export function AttendanceReasons({ attendance: a }: { attendance: AttendanceDay | null }) {
  return a && !a.eligible ? <span className={styles.cellSub} title={a.reasons.join(", ")}>Excluded from average: {a.labels.join("; ")}</span> : null;
}

/** Leave balances: what is free to take, and how the number is made up. */
/** How leave balances are counted, in words: the panel's foot, or its "how Pulse knows" note when the panel is narrow. */
export const balanceNote = (provisional: boolean, trackingFrom: string) => `${provisional ? "Provisional: these allowances are Pulse’s starting values until HR confirms the leave policy. " : ""}Balances count from ${dayYear(trackingFrom)}, when leave moved into Pulse; HR adds anything earned before that as an adjustment.`;

export function BalanceCards({ types, balances, provisional, trackingFrom, stacked }: { types: LeaveType[]; balances: Balance[]; provisional: boolean; trackingFrom: string; /** One card per row, without the foot (give the panel a Why with `balanceNote`). */ stacked?: boolean }) {
  return <>
    <div className={css.balances} data-stacked={stacked ? "" : undefined}>
      {types.map((t) => {
        const b = balances.find((x) => x.key === t.key); const total = b ? b.accrued + b.carried + b.adjusted : 0;
        return (
          <div key={t.key} className={css.balance}>
            <span className={css.balanceName}>{t.name}{t.paid ? null : <Badge>Unpaid</Badge>}</span>
            {b ? <>
              <strong className={css.balanceValue}>{Number.isInteger(b.available) ? b.available : b.available.toFixed(1)}<small>{b.available === 1 ? "day" : "days"} left</small></strong>
              <span className={css.balanceBar} aria-hidden="true"><i style={{ width: `${total > 0 ? Math.min(100, (b.used / total) * 100) : 0}%` }} /><i data-pending="" style={{ width: `${total > 0 ? Math.min(100, (b.pending / total) * 100) : 0}%` }} /></span>
              <span className={css.balanceMeta}>{dayCount(b.used)} taken{b.pending ? ` · ${dayCount(b.pending)} waiting` : ""} · {dayCount(b.accrued)} earned so far{b.carried ? ` · ${dayCount(b.carried)} carried over` : ""}{b.adjusted ? ` · ${b.adjusted > 0 ? "+" : ""}${dayCount(b.adjusted)} adjusted by HR` : ""}</span>
              <span className={css.balanceRule}>{t.key==='comp_off'?"Earned by approved day-off work; use before credit expiry":<>{t.annualDays} days a year, {t.accrual === "monthly" ? "earned month by month" : t.accrual === "yearly" ? "given at the start of the year" : "available at once"}{t.carryForwardMax ? `; up to ${t.carryForwardMax} carry over` : ""}</>}</span>
            </> : <>
              <strong className={css.balanceValue} data-open="">No limit<small>taken as needed</small></strong>
              <span className={css.balanceRule}>No fixed allowance{t.paid ? "" : "; days taken are not paid"}</span>
            </>}
          </div>
        );
      })}
    </div>
    {stacked ? null : <p className={styles.panelFoot}>{provisional ? <span><b>Provisional.</b> These allowances are Pulse’s starting values until HR confirms the leave policy. </span> : null}<span>Balances count from {dayYear(trackingFrom)}, when leave moved into Pulse; HR adds anything earned before that as an adjustment.</span></p>}
  </>;
}

/** Leave requests of one person, newest first. `mine` lets the person withdraw; `decide` lets a manager or HR decide. */
export function LeaveList({ requests, types, today, mine, decide, empty }: { requests: LeaveRequest[]; types: LeaveType[]; today: string; mine?: boolean; decide?: boolean; empty?: string }) {
  if (!requests.length) return <Empty icon={CalendarOff} compact title="No leave requests yet" text={empty} />;
  return <ul className={styles.list}>{requests.map((l) => (
    <li key={l.id} className={`${styles.row} ${css.request}`}>
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{range(l.fromDate, l.toDate)}<span className={styles.muted}> · {dayCount(l.days)}{l.halfDay ? ` (${half(l.halfDay)})` : ""}</span></span>
        <span className={styles.rowMeta}><span>{leaveName(types, l.kind)}</span>{l.reason ? <span title={l.reason}>{l.reason}</span> : null}
          {l.decidedBy && l.status !== "pending" ? <span>{REQUEST_LABEL[l.status]} by {l.decidedBy}{l.decisionNote ? `: “${l.decisionNote}”` : ""}</span> : <span>asked {ago(l.createdAt)}</span>}</span>
      </span>
      <span className={styles.rowEnd}>
        <RequestBadge status={l.status} />
        {decide && l.status === "pending" ? <Decide kind="leave" id={l.id} /> : null}
        {mine && (l.status === "pending" || (l.status === "approved" && l.fromDate > today)) ? <Withdraw kind="leave" id={l.id} label={l.status === "pending" ? "Withdraw" : "Cancel"} /> : null}
      </span>
    </li>
  ))}</ul>;
}

/** Attendance correction requests of one person. */
export function CorrectionList({ items, mine, decide }: { items: Regularisation[]; mine?: boolean; decide?: boolean }) {
  if (!items.length) return <Empty icon={CalendarClock} compact title="No corrections asked for" text="Forgot to check out, worked from home, or were out on a shoot? Ask for the day to be corrected and it is fixed once approved." />;
  return <ul className={styles.list}>{items.map((r) => (
    <li key={r.id} className={`${styles.row} ${css.request}`}>
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{dayYear(r.date)}<span className={styles.muted}> · {REG_KIND[r.kind]}{r.inTime || r.outTime ? ` (${r.inTime ?? "…"} to ${r.outTime ?? "…"})` : ""}</span></span>
        <span className={styles.rowMeta}><span title={r.reason}>{r.reason}</span>
          {r.decidedBy && r.status !== "pending" ? <span>{REQUEST_LABEL[r.status]} by {r.decidedBy}{r.decisionNote ? `: “${r.decisionNote}”` : ""}</span> : <span>asked {ago(r.createdAt)}</span>}</span>
      </span>
      <span className={styles.rowEnd}>
        <RequestBadge status={r.status} />
        {decide && r.status === "pending" ? <Decide kind="regularisation" id={r.id} /> : null}
        {mine && r.status === "pending" ? <Withdraw kind="regularisation" id={r.id} /> : null}
      </span>
    </li>
  ))}</ul>;
}

/** Requests raised with HR. Each opens its conversation. */
export function TicketList({ tickets, showPerson, empty }: { tickets: Ticket[]; showPerson?: boolean; empty?: string }) {
  if (!tickets.length) return <Empty icon={Inbox} compact title="Nothing raised yet" text={empty ?? "Questions about salary, leave, equipment or anything at work go to HR from here, and you can follow every reply."} />;
  return <ul className={styles.list}>{tickets.map((t) => (
    <li key={t.id}><Link href={`/me/requests/${t.id}`} className={styles.row}>
      <span className={styles.rowIcon} aria-hidden="true"><MessageSquare size={13} /></span>
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{t.subject}</span>
        <span className={styles.rowMeta}><span className={styles.mono}>{ticketNo(t.no)}</span><span>{CATEGORY[t.category] ?? t.category}</span>{showPerson && t.name ? <span>{t.name}</span> : null}
          <span>{t.assigneeName ? `with ${t.assigneeName}` : "not picked up yet"}</span><span>updated {ago(t.updatedAt)}</span></span>
      </span>
      <span className={styles.rowEnd}>{t.priority === "high" ? <Badge tone="danger">Urgent</Badge> : null}<Badge tone={TICKET_STATUS[t.status].tone}>{TICKET_STATUS[t.status].label}</Badge></span>
    </Link></li>
  ))}</ul>;
}

/** Twelve weeks of deliveries against the person's own usual week. */
export function PerformanceChart({ data, today }: { data: Extract<Performance, { linked: true }>; today: string }) {
  const few = sparse(data.weeks, (w) => w.deliveries);
  if (few) return <SparseFacts label="Deliveries per week, last twelve weeks" total={data.weeks.length} empty="No deliveries in the last twelve weeks."
    facts={few.map((w) => ({ key: w.start, n: w.deliveries, value: w.deliveries, text: `${w.deliveries === 1 ? "delivery" : "deliveries"} in the week of ${day(w.start)}`, sub: `${w.finals} final · ${w.drafts} draft` }))} />;
  const max = Math.max(4, ...data.weeks.map((w) => w.deliveries), Math.ceil(data.baseline));
  return (
    <div className={css.perf}>
      <div className={css.perfPlot}>
        {data.baseline > 0 ? <span className={css.perfBase} style={{ bottom: `${(data.baseline / max) * 100}%` }}><em>Your usual week: {data.baseline.toFixed(1)}</em></span> : null}
        {data.weeks.map((w) => {
          const current = shiftDay(w.start, 6) >= today;
          return (
            <span key={w.start} className={css.perfCol} data-current={current ? "" : undefined} title={`Week of ${day(w.start)}: ${plural(w.deliveries, "delivery", "deliveries")} (${w.finals} final, ${w.drafts} draft)${current ? ", so far" : ""}`}>
              <b>{w.deliveries || ""}</b>
              <i style={{ height: `${(w.finals / max) * 100}%` }} data-kind="final" /><i style={{ height: `${(w.drafts / max) * 100}%` }} data-kind="draft" />
            </span>
          );
        })}
      </div>
      <div className={css.perfAxis} aria-hidden="true">{data.weeks.map((w, i) => <span key={w.start}>{i % 2 === 0 ? day(w.start) : ""}</span>)}</div>
      <p className={css.legend}><span><i data-status="final" />Finals</span><span><i data-status="draft" />Drafts</span><span><i data-status="base" />Your usual week (average of the eight weeks before the last four)</span></p>
    </div>
  );
}

export function NoPerformance({ self, linked }: { self: boolean; linked?: boolean }) {
  const whose = self ? "your" : "this person's";
  return <Empty icon={TrendingUp} title={linked ? "No deliveries through the linked account yet" : "No deliveries are credited yet"}
    text={linked ? `An account is linked to ${whose} record, but no file has been uploaded through it into a project's delivery folder. Weekly deliveries, the usual week and the quality signals appear here with the first one.`
      : `Pulse credits deliveries through a personal uploader account linked to ${whose} record. Most of the team uploads through shared logins, which are never credited to one person. An admin can link a personal account on the profile.`} />;
}
