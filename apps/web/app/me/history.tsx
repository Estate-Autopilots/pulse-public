// R43: My desk → History. Everything a person has on record from earlier periods, each with where it came from:
// months Pulse recorded, monthly reports HR confirmed as theirs, leave by year, requests, documents and the payslips
// HR issued. Reports whose owner is not settled stay with HR; nothing is made up from salary records.
import Link from "next/link";
import { CalendarDays, FileText, Inbox, ReceiptText, Umbrella } from "lucide-react";
import { day, dayYear, plural, range } from "../lib/format";
import { Payslip } from "../hr/payslip";
import { RequestBadge, monthName } from "../hr/parts";
import { dayCount, leaveName, type LeaveType, type RequestStatus } from "../hr/types";
import { Empty, Panel, Workspace, styles } from "../ui";
import css from "./history.module.css";

export type SelfHistory = {
  today: string; attendanceEnabled: boolean; joinedOn: string | null; leaveYearStart: number;
  coverage: { pulseFrom: string | null; trackingFrom: string | null; importedMonths: number; withHr: number };
  attendance: { month: string; days: number; wfh: number; field: number; corrected: number }[];
  imported: { key: string; month: string | null; monthLabel: string; leaveDays: number | null; wfhDays: number | null; halfDays: number | null; coverage: string | null; basis: string | null; sheet: string | null; enteredByHr: boolean }[];
  leave: { year: number; kind: string; approved: number; pending: number; closed: number; requests: number }[];
  requests: { rows: { id: string; kind: string; status: RequestStatus; stage: string; subject: string; fromDate: string; toDate: string; updatedAt: string }[]; total: number; pending: number };
  tickets: { total: number; open: number };
  documents: { onFile: { type: string; seenAt: string }[]; files: { id: string; kind: string; title: string; name: string; addedAt: string }[]; policies: { kind: string; title: string; version: number; at: string }[] };
  payslips: { month: string; version: number; issuedAt: string }[];
};

const KIND: Record<string, string> = { leave: "Leave", correction: "Correction", work: "Day-off work", request: "Request" };
const DOCUMENT: Record<string, string> = { appointment_letter: "Appointment letter", joining_letter: "Joining letter", offer_letter: "Offer letter", relieving_letter: "Relieving letter" };
// A blank count in a report stays unknown; it is never shown as zero.
const count = (v: number | null, one: string, many?: string) => v === null ? `${many ?? `${one}s`}: unknown` : plural(v, one, many);

export function SelfHistoryView({ d, personId, types }: { d: SelfHistory; personId: string; types: LeaveType[] }) {
  const years = [...new Set(d.leave.map((l) => l.year))];
  const yearLabel = (y: number) => d.leaveYearStart === 1 ? String(y) : `${y}–${String(y + 1).slice(2)}`;
  const issued = d.payslips.map((p) => p.month);
  const docs = d.documents.files.length + d.documents.onFile.length;
  const from = d.coverage.pulseFrom ? `Pulse check-ins from ${monthName(d.coverage.pulseFrom)}` : "No Pulse check-ins yet";
  return <Workspace wrap labels={["Attendance by month", "Leave by year", "Requests", "Documents", "Payslips"]}>
    <Panel title="Attendance by month" sub={`${from}${d.coverage.importedMonths ? ` · ${plural(d.coverage.importedMonths, "earlier monthly report")}` : ""}`}>
      {/* Rows, not tables: the source of each month stays visible on a phone. */}
      {d.attendance.length ? <ul className={styles.list} aria-label="Months recorded in Pulse">{d.attendance.map((m) => <li key={m.month}><Link href={`/me?tab=attendance&month=${m.month}`} className={styles.row}>
        <span className={styles.rowMain}><span className={styles.rowTitle}>{monthName(m.month)}</span><span className={styles.rowMeta}><span>Your check-ins{m.corrected ? ` · ${plural(m.corrected, "day")} corrected after a request` : ""}</span></span></span>
        <span className={css.counts}><b>{plural(m.days, "day")} in</b><small>{m.wfh} from home{m.field ? ` · ${m.field} on duty` : ""}</small></span>
      </Link></li>)}</ul> : <Empty icon={CalendarDays} compact title={d.attendanceEnabled ? "No check-ins recorded yet" : "Attendance is off"} text={d.attendanceEnabled ? "Each month you check in shows here and opens its calendar." : "When HR turns attendance on, each month you check in shows here."} />}
      {d.imported.length ? <><p className={css.subhead}>Before Pulse</p><ul className={styles.list} aria-label="Earlier monthly reports">{d.imported.map((h) => <li key={h.key} className={styles.row}>
        <span className={styles.rowMain}><span className={styles.rowTitle}>{h.month ? monthName(h.month.slice(0, 7)) : `${h.monthLabel} (year not established)`}</span>
          <span className={styles.rowMeta}><span>{h.enteredByHr ? "Recorded by HR" : `HR monthly report${h.sheet ? `, sheet “${h.sheet}”` : ""}`}{h.basis && !h.enteredByHr ? ` · ${h.basis}` : ""}</span></span></span>
        <span className={css.counts}><b>{count(h.leaveDays, "leave day")}</b><small>{count(h.wfhDays, "from home", "from home")} · {count(h.halfDays, "half day")}</small></span>
      </li>)}</ul></> : null}
      <p className={css.note}>Earlier monthly reports are counts HR kept before Pulse; they hold no daily check-ins, and a blank count stays unknown.{d.coverage.withHr ? ` ${plural(d.coverage.withHr, "more report")} with your name ${d.coverage.withHr === 1 ? "is" : "are"} waiting for HR to confirm ${d.coverage.withHr === 1 ? "it is" : "they are"} yours.` : ""}</p>
    </Panel>

    <Panel title="Leave by year" sub={d.leaveYearStart === 1 ? "Calendar years" : `Leave years start in ${monthName(`2000-${String(d.leaveYearStart).padStart(2, "0")}`).split(" ")[0]}`} action={{ href: "/me?tab=leave", label: "Requests" }}>
      {years.length ? <ul className={css.years}>{years.map((y) => { const rows = d.leave.filter((l) => l.year === y); const taken = rows.reduce((a, l) => a + l.approved, 0); return <li key={y}>
        <p className={css.yearHead}><b>{yearLabel(y)}</b><span>{dayCount(taken)} taken · {plural(rows.reduce((a, l) => a + l.requests, 0), "request")}</span></p>
        <ul className={styles.list}>{rows.map((l) => <li key={l.kind} className={styles.row}><span className={styles.rowMain}><span className={styles.rowTitle}>{leaveName(types, l.kind)}</span>
          <span className={styles.rowMeta}><span>{l.pending ? `${dayCount(l.pending)} waiting` : ""}{l.pending && l.closed ? " · " : ""}{l.closed ? `${plural(l.closed, "request")} rejected or cancelled` : ""}</span></span></span>
          <span className={styles.rowEnd}><b>{dayCount(l.approved)}</b></span></li>)}</ul>
      </li>; })}</ul> : <Empty icon={Umbrella} compact title="No leave on record" text="Leave you apply for in Pulse shows here by year, with what was taken." />}
    </Panel>

    <Panel title="Requests" sub={d.requests.total ? `${plural(d.requests.total, "request")}${d.requests.pending ? ` · ${d.requests.pending} waiting` : ""}` : undefined} action={{ href: "/me/approvals", label: "All requests" }}>
      {d.requests.rows.length ? <ul className={styles.list}>{d.requests.rows.slice(0, 8).map((r) => <li key={r.id}><Link href={`/me/requests/${r.id}`} className={styles.row}>
        <span className={styles.rowMain}><span className={styles.rowTitle}>{KIND[r.kind] ?? "Request"} · {r.subject}</span><span className={styles.rowMeta}><span>{range(r.fromDate, r.toDate)}</span></span></span>
        <span className={styles.rowEnd}><RequestBadge status={r.status} /></span></Link></li>)}</ul>
        : <Empty icon={Inbox} compact title="No requests yet" text="Leave, corrections and day-off work you ask for show here with their decisions." />}
      <p className={css.note}><Link href="/me?tab=requests">Questions with HR</Link>: {d.tickets.total ? `${d.tickets.total} raised, ${d.tickets.open} open` : "none raised"}.</p>
    </Panel>

    <Panel title="Documents" sub={docs ? plural(docs, "document") : undefined} action={{ href: "/me?tab=policies", label: "Policies" }}>
      {docs ? <ul className={styles.list}>
        {d.documents.files.map((f) => <li key={f.id} className={styles.row}><span className={styles.rowMain}><span className={styles.rowTitle}><a href={`/api/v0/people/files/${f.id}`}>{f.title}</a></span><span className={styles.rowMeta}><span>Added by HR {dayYear(f.addedAt)}</span></span></span></li>)}
        {d.documents.onFile.map((o) => <li key={o.type} className={styles.row}><span className={styles.rowMain}><span className={styles.rowTitle}>{DOCUMENT[o.type] ?? "Employment document"}</span><span className={styles.rowMeta}><span>On file with HR since {dayYear(o.seenAt)} · ask HR for a copy</span></span></span></li>)}
      </ul> : <Empty icon={FileText} compact title="No documents shared with you yet" text="Letters and agreements HR keeps for you show here." />}
      {d.documents.policies.length ? <><p className={css.subhead}>Policies you acknowledged</p><ul className={styles.list}>{d.documents.policies.slice(0, 6).map((p) => <li key={`${p.kind}${p.version}`} className={styles.row}>
        <span className={styles.rowMain}><span className={styles.rowTitle}><Link href={`/me?tab=policies&kind=${p.kind}`}>{p.title}</Link></span><span className={styles.rowMeta}><span>Version {p.version} · {day(p.at)}</span></span></span></li>)}</ul></> : null}
    </Panel>

    <Panel title="Payslips" sub={issued.length ? plural(issued.length, "issued payslip") : undefined}>
      {issued.length ? <ul className={styles.list}>{d.payslips.map((p) => <li key={p.month} className={styles.row}>
        <span className={styles.rowMain}><span className={styles.rowTitle}>{monthName(p.month)}</span><span className={styles.rowMeta}><span>Issued {dayYear(p.issuedAt)}{p.version > 1 ? ` · version ${p.version}` : ""}</span></span></span>
        <span className={styles.rowEnd}><Payslip personId={personId} month={p.month} issued={issued} label="Open" /></span></li>)}</ul>
        : <Empty icon={ReceiptText} compact title="No payslip issued yet" text="Payslips show here once HR issues them after payroll. Salary records alone never become a payslip." />}
    </Panel>
  </Workspace>;
}
