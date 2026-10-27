/** Shapes returned by the Team & HR endpoints (services/api/src/hr.ts). */
export type Policy = { shiftStart: string; shiftEnd: string; graceMinutes: number; workDays: number[]; wfhPerMonth: number | null; leaveYearStart: number; trackingFrom: string; confirmedAt: string | null };
export type LeaveType = { key: string; name: string; paid: boolean; annualDays: number | null; accrual: "monthly" | "yearly" | "none"; carryForwardMax: number; active: boolean };
export type Holiday = { day: string; name: string; optional: boolean };
export type Balance = { key: string; accrued: number; carried: number; adjusted: number; used: number; pending: number; available: number };
export type Mode = "office" | "wfh" | "field";
/** One day's attendance. `in` and `out` are timestamps; `worked` and `breakMinutes` are minutes. */
export type Entry = { id: string; personId: string; date: string; in: string; out: string | null; mode: Mode; late: number; missedOut: boolean; source: "self" | "regularised"; note: string | null; breakMinutes: number; onBreak: boolean; worked: number };
export type DayStatus = "present" | "leave" | "holiday" | "off" | "absent" | "upcoming" | "today" | "untracked" | "outcome";
export type Eligibility = { eligible: boolean; minutes: number | null; reasons: string[]; labels: string[] };
export type AttendanceDay = Eligibility & { date: string; personId: string; sessions: number; flaggedCount: number; recordedMinutes: number };
export type AttendanceSummary = { filter: { version: string; provisional: boolean; maxMinutes: number }; from: string; to: string; recordedDays: number; eligibleDays: number; flaggedCount: number; excludedDays: number; coverage: number | null; workedMinutes: number; recordedMinutes: number; averageMinutes: number | null };
export type Day = { automaticHalfDay?: boolean; sessions: Entry[]; attendance: AttendanceDay | null; workApproved?: boolean; date: string; status: DayStatus; holiday: string | null; entry: Entry | null; leave: { kind: string; halfDay: "first" | "second" | null } | null; pendingLeave: boolean };
export type Summary = AttendanceSummary & { present: number; wfh: number; late: number; leave: number; absent: number; missedOut: number; };
export type RequestStatus = "pending" | "approved" | "rejected" | "cancelled";
export type LeaveRequest = { id: string; personId: string; name: string; fromDate: string; toDate: string; kind: string; status: RequestStatus; halfDay: "first" | "second" | null; days: number;
  reason: string | null; createdAt: string; decidedAt: string | null; decisionNote: string | null; decidedBy: string | null; photoAt?: string | null; userNo?: number | null; balance?: Balance | null };
export type RegKind = "missed_punch" | "wfh" | "on_duty" | "late";
export type Regularisation = { id: string; personId: string; name: string; date: string; kind: RegKind; inTime: string | null; outTime: string | null; reason: string; status: RequestStatus;
  createdAt: string; decidedAt: string | null; decisionNote: string | null; decidedBy: string | null; photoAt?: string | null };
export type TicketStatus = "open" | "in_progress" | "waiting" | "resolved" | "closed";
export type Ticket = { id: string; no: number; personId?: string; name?: string; photoAt?: string | null; category: string; subject: string; priority: "low" | "normal" | "high"; status: TicketStatus;
  assigneeId?: string | null; assigneeName: string | null; createdAt: string; updatedAt: string; resolvedAt?: string | null; comments?: number;
  /** DATUP-TASKS: a complaint about a colleague (HR, admins and the person who raised it read it). */ aboutId?: string | null; aboutName?: string | null; happenedOn?: string | null; frequency?: Frequency | null };
export type Frequency = "once" | "sometimes" | "often" | "always";
export const FREQUENCY: Record<Frequency, string> = { once: "Once", sometimes: "Sometimes", often: "Often", always: "Every time" };
export type TicketDetail = Required<Pick<Ticket, "personId" | "name">> & Ticket & { body: string; resolution: string | null; staff: boolean; mine: boolean;
  events: { id: string; kind: "comment" | "status" | "assigned" | "resolved"; body: string; internal: boolean; at: string; by: string | null; authorId: string | null }[] };
export type TicketList = { tickets: Ticket[]; assignees: { id: string; name: string }[]; staff: boolean; me: string | null; categories: string[] };
export type Away = { personId: string; name: string; fromDate: string; toDate: string; halfDay: string | null };
export type PerformanceWeek = { start: string; deliveries: number; finals: number; drafts: number };
export type Performance = { linked: false } | { linked: true; weeks: PerformanceWeek[]; thisWeek: number; recent: number; baseline: number; allTime: number; firstDeliveryAt: string | null;
  quality: { total: number; finals: number; revised: number; projects: number; activeDays: number } };
export type NowState = "out" | "in" | "break" | "done" | "leave" | "holiday" | "off" | "outcome";

/** GET hr/self and hr/person/:id — everything "My desk" and the profile's attendance tab show for one person. */
export type PersonHr = {
  attendanceEnabled?: boolean;
  reconciliation: import("./reconciliation").Reconciliation | null;
  person: { id: string; name: string; role: string; pod: string | null; department: string | null; userNo: number | null; photoAt: string | null; status: string; joinedOn: string | null;
    managerId: string | null; managerName: string | null; skills: string[]; employmentType: string | null; username: string | null; phone?: string | null; email?: string | null };
  rules?: {late: {count:number;threshold:number;deduction:number;window:string}|null};
  self: boolean; today: string; clock: string; policy: Policy;
  can: { act: boolean; decide: boolean; record: boolean; performance: boolean; adjust: boolean };
  now: { state: NowState; entry: Entry | null; holiday: string | null; leave: { kind: string; halfDay: string | null } | null;
    /** UX-5A: today's check-in on approved leave: the leave cancelled for the day, or kept for HR to decide. */ leaveCheckIn?: { decision: "cancelled" | "kept"; kind: string | null; ticketId: string | null } | null } | null;
  month: { key: string; from: string; to: string; days: Day[]; summary: Summary; trackedFrom: string | null } | null;
  wfh: { used: number; allowance: number | null } | null;
  leave: { year: number; yearStartsMonth: number; provisional: boolean; trackingFrom: string; types: LeaveType[]; balances: Balance[]; requests: LeaveRequest[] };
  regularisations: Regularisation[] | null; tickets: Ticket[]; away: Away[]; holidays: Holiday[]; performance: Performance | null;
  /** For a manager's own desk: the people who report to them today, and their requests waiting for a decision. */
  team: RosterPerson[] | null; approvals: { leave: LeaveRequest[]; regularisations: Regularisation[] | null } | null;
  /** PRESENCE-ONBOARD: the month as payroll will read it, and HR's cut-off for fixing it. */
  payroll?: PayrollMonth | null;
};
export type PayrollMonth = { month: string; cutoffDay: number | null; cutoffDate: string | null; closed: boolean; daysLeft: number | null;
  present: number; wfh: number; late: number; leave: number; absent: number; missedOut: number; halfDays: number; pendingCorrections: number; pendingLeave: number };

export type RosterStatus = "in" | "break" | "done" | "leave" | "not_in" | "absent" | "untracked" | "upcoming" | "holiday" | "off" | "outcome";
export type RosterPerson = { id: string; name: string; role: string; pod: string | null; department: string | null; userNo: number | null; photoAt: string | null; joinedOn: string | null;
  canSignIn: boolean; trackedFrom: string | null; status: RosterStatus; attendance: AttendanceDay | null; sessions: Entry[]; entry: Entry | null; leave: { kind: string; halfDay: string | null } | null };
export type Anomaly = { type: "statistics_excluded" | "missed_out" | "open" | "long_day" | "long_break" | "late" | "absent"; personId: string; name: string; date: string | null; detail: string };
/** GET hr/desk?date= — the HR dashboard. HR and admins only. */
export type Desk = {
  attendanceEnabled?: boolean;
  date: string; today: string; clock: string; policy: Policy; day: { kind: "working" | "off" | "holiday"; name?: string } | null;
  attendance: AttendanceSummary | null; people: RosterPerson[] | null;
  counts: { ai?: number; headcount: number; in: number; onBreak: number; done: number; wfh: number; late: number; leave: number; notIn: number; canSignIn: number } | null;
  pending: { leave: LeaveRequest[]; regularisations: Regularisation[] | null };
  tickets: { open: number; unassigned: number; high: number };
  upcoming: LeaveRequest[]; holidays: Holiday[]; anomalies: Anomaly[] | null;
  trend: { date: string; present: number; wfh: number; late: number }[] | null; types: LeaveType[]; me: string | null;
};
export type DateCell = { date: string; off: boolean; holiday: string | null };
/** GET hr/attendance?month=YYYY-MM — a month for the whole team. */
export type TeamMonth = { attendanceEnabled?: boolean; month: string; from: string; to: string; today: string; policy: Policy; dates: DateCell[];
  people: { id: string; name: string; role: string; pod: string | null; userNo: number | null; photoAt: string | null; trackedFrom: string | null; canSignIn: boolean; summary: Summary;
    days: { attendance: AttendanceDay | null; status: DayStatus; mode: Mode | null; late: number; worked: number; half: boolean; missedOut: boolean; open: boolean }[] }[] };
/** GET hr/leave?month=YYYY-MM — requests, balances, the team calendar and holidays. */
export type TeamLeave = { month: string; from: string; to: string; today: string; policy: Policy; year: number; types: LeaveType[]; holidays: Holiday[]; dates: DateCell[];
  people: { id: string; name: string; role: string; pod: string | null; department: string | null; userNo: number | null; photoAt: string | null; joinedOn: string | null; balances: Balance[] }[];
  requests: LeaveRequest[]; calendar: LeaveRequest[];
  adjustments: { id: string; personId: string; name: string; kind: string; year: number; days: number; reason: string; createdAt: string; by: string | null }[]; me: string | null };
export type PolicyData = { policy: Policy; confirmedBy: string | null; types: LeaveType[]; holidays: Holiday[]; today: string; canEdit: boolean };
/** GET hr/payroll (no figures) and hr/payroll?figures=1 (a logged read). */
export type Payroll = { people: { id: string; name: string; role: string; pod: string | null; department: string | null; userNo: number | null; photoAt: string | null; status: string; joinedOn: string | null; employmentType: string | null }[];
  figures: { personId: string; month: string; kind: "monthly" | "current"; amount: number; currency: string; entries: number; bankOnFile: boolean; professionalTax?:number;ptReview?:boolean;net?:number|null }[] | null;
  canWrite: boolean; log: { at: string; viewer: string | null; people: number }[] };

export const MODE: Record<Mode, string> = { office: "Office", wfh: "Work from home", field: "On duty outside" };
export const REG_KIND: Record<RegKind, string> = { missed_punch: "Missed check-in or check-out", wfh: "Work from home", on_duty: "On duty outside the office", late: "Late mark to be removed" };
export const CATEGORY: Record<string, string> = { payroll: "Salary & payroll", leave: "Leave", attendance: "Attendance", equipment: "Equipment & access", workplace: "Workplace", grievance: "Complaint or grievance", other: "Something else" };
export const TICKET_STATUS: Record<TicketStatus, { label: string; tone: "neutral" | "warning" | "success" | "accent" }> = {
  open: { label: "Open", tone: "warning" }, in_progress: { label: "In progress", tone: "accent" }, waiting: { label: "Waiting for you", tone: "warning" },
  resolved: { label: "Resolved", tone: "success" }, closed: { label: "Closed", tone: "neutral" } };
export const REQUEST_TONE: Record<RequestStatus, "warning" | "success" | "danger" | "neutral"> = { pending: "warning", approved: "success", rejected: "danger", cancelled: "neutral" };
export const REQUEST_LABEL: Record<RequestStatus, string> = { pending: "Waiting", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled" };
export const ROSTER: Record<RosterStatus, { label: string; tone: "neutral" | "warning" | "success" | "accent" | "danger" }> = {
  in: { label: "In", tone: "success" }, break: { label: "On a break", tone: "warning" }, done: { label: "Done for the day", tone: "neutral" }, leave: { label: "On leave", tone: "accent" },
  not_in: { label: "Not in yet", tone: "warning" }, absent: { label: "No check-in", tone: "danger" }, untracked: { label: "Not using check-in yet", tone: "neutral" },
  upcoming: { label: "", tone: "neutral" }, holiday: { label: "Holiday", tone: "neutral" }, off: { label: "Weekly off", tone: "neutral" }, outcome: { label: "Outcome-based", tone: "accent" } };
export const ticketNo = (no: number) => `HR-${String(no).padStart(4, "0")}`;
/** Minutes as "7 h 40 min". */
export const duration = (minutes: number) => minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
/** Days as "1 day", "2.5 days". */
export const dayCount = (days: number) => `${Number.isInteger(days) ? days : days.toFixed(1)} ${days === 1 ? "day" : "days"}`;
export const leaveName = (types: LeaveType[], key: string) => types.find((t) => t.key === key)?.name ?? key;
