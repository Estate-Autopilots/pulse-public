// COMP-B: what the payroll screens read (the API's shapes) and the words they use. Amounts arrive in paise.

export type Totals = { people: number; gross: number; deductions: number; reimbursements: number; net: number; employer: number; cost: number; difference: number | null; toPay: number; statutory: number };
export type RunSummary = { id: string; month: string; seq: number; kind: "regular" | "correction"; status: RunStatus; calc: number; people: number; exceptions: number; payOn: string | null; note: string | null;
  openedBy: string | null; openedAt: string; checkedBy: string | null; checkedAt: string | null; approvedBy: string | null; approvedAt: string | null; payslips: number; payout: boolean; totals?: Totals | null };
export type RunStatus = "draft" | "checked" | "locked" | "withdrawn";
export type Runs = { today: string; runs: RunSummary[]; can: { start: boolean; approve: boolean; read: boolean }; cutoffDay: number | null; attendanceEnabled: boolean; withRecords: number; staff: number; payDay: number };
/** The month whose payroll is due: last month while its pay day (in this month) is still ahead and it is not locked,
 *  else this month; null when that is locked too. */
export function dueMonth(r: Pick<Runs, "today" | "runs" | "payDay">) {
  const thisMonth = r.today.slice(0, 7), [y, m] = thisMonth.split("-").map(Number), last = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const locked = (mm: string) => r.runs.some((x) => x.month.slice(0, 7) === mm && x.kind === "regular" && x.status === "locked");
  if (!locked(last) && Number(r.today.slice(8, 10)) <= (r.payDay || 7)) return last;
  return locked(thisMonth) ? null : thisMonth;
}
export type PayslipLine = { label: string; kind: "earning" | "deduction" | "reimbursement" | "employer"; amount: number; basis?: string; code: string };
export type Slip = { person: { id: string; name: string; role?: string | null; pod?: string | null }; month: string; payType: string; monthDays: number; paidDays: number; lopDays: number; lopBasis: string | null;
  lines: PayslipLine[]; gross: number; deductions: number; reimbursements: number; net: number; employer: number; cost: number; advances: number; exceptions: string[]; hold: boolean;
  statutory: { pf: number; pfEmployer: number; esi: number; esiEmployer: number; pt: number; tds: number }; paid?: number | null; difference?: number | null };
export type Adjustment = { id: string; kind: "lop_days" | "amount" | "hold"; days: number | null; label: string | null; reason: string; by: string | null; at: string };
export type RunLine = { person: string; name: string; role: string | null; pod: string | null; department: string | null; payType: string | null; exceptions: string[]; hold: boolean; settlement: boolean;
  recover: boolean; self: boolean; adjustments: Adjustment[]; payslip: { id: string; version: number; seenAt: string | null } | null; slip?: Slip | null };
export type RunEvent = { at: string; kind: string; by: string | null; detail: Record<string, unknown> };
export type Run = RunSummary & { checkedCalc: number | null; checkedById: string | null; checkNote: string | null; approveNote: string | null; correctsId: string | null; lines: RunLine[]; events: RunEvent[];
  calcs: number[]; payout: { format: string; rows: number; leftOut: number; sha256: string; createdAt: string } | null; corrections: { id: string; seq: number; status: string }[];
  can: { compute: boolean; adjust: boolean; check: boolean; approve: boolean; return: boolean; withdraw: boolean; payout: boolean; correct: boolean; figures: boolean };
  today: string; totals?: Totals | null; figuresCalc?: number; runExceptions: { key: string; text: string }[] };

export const RUN_STATUS: Record<RunStatus, { label: string; tone: "neutral" | "warning" | "success" | "accent" }> = {
  draft: { label: "Draft", tone: "neutral" }, checked: { label: "Waiting for a founder", tone: "warning" }, locked: { label: "Locked", tone: "success" }, withdrawn: { label: "Withdrawn", tone: "neutral" },
};
/** What each exception means and what clears it. */
export const EXCEPTION: Record<string, { label: string; fix: string }> = {
  no_bank: { label: "No bank details", fix: "Ask them to add bank details in My info, or hold their pay and pay it by hand" },
  bank_unchecked: { label: "Bank details not checked", fix: "Check the bank details they entered (People → their page → My info)" },
  open_checkout: { label: "Open check-out", fix: "Close the forgotten check-out so the day counts" },
  pending_leave: { label: "Leave waiting", fix: "Decide the leave request so unpaid days are known" },
  pending_correction: { label: "Attendance correction waiting", fix: "Decide the correction" },
  pending_claims: { label: "Claims waiting", fix: "Claims decided after this run go to the next payroll" },
  pt_details: { label: "PT details missing", fix: "Add their professional-tax state and category in their HR record" },
  hourly_no_hours: { label: "Hourly, no usual hours", fix: "Add an amount for the hours worked" },
  negative_net: { label: "Pay below zero", fix: "Spread the recovery or adjust it" },
};
export const ADJUST: Record<string, string> = { lop_days: "Loss-of-pay days", amount: "Amount", hold: "Hold from the bank file" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLong = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
export const runTitle = (r: { month: string; kind: string; seq: number }) => `${monthLong(r.month)} payroll${r.kind === "correction" ? ` · correction ${r.seq - 1}` : ""}`;
export const EVENT: Record<string, string> = { opened: "Started", "correction.opened": "Correction started", computed: "Calculated", recomputed: "Recalculated", adjusted: "Adjusted", "adjustment.removed": "Adjustment removed",
  checked: "Checked by HR", returned: "Sent back", withdrawn: "Withdrawn", locked: "Approved and locked", "payout.downloaded": "Bank file downloaded" };
