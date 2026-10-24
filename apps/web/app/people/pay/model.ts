// COMP-A: what the People & pay screens read (the API's shapes) and the words they use. Amounts arrive in paise.

export type Figures = { monthly: number; ctc: number | null; components: Record<string, number>; rate?: number | null; hours?: number | null };
export type Component = { key: string; label: string; kind: "earning" | "employer" | "deduction"; amount?: number; of?: string; pct?: number; cap?: number; balance?: boolean };
export type NextEvent = { key: string; on: string | null; label: string; tone: "act" | "wait" | "info" };
export type PayRow = {
  id: string; name: string; role: string | null; pod: string | null; department: string | null; photoAt: string | null; stage: string; current: boolean; hasRecord: boolean;
  status?: Status; since?: string; until?: string; startOn?: string; endOn?: string; payType?: PayType; lastDay?: string;
  offer?: { id: string; status: string; startOn: string; validUntil: string; proposedBy?: string; approvedBy?: string; hasLetter?: boolean };
  change?: { id: string; kind: string; status: string; effectiveOn: string; proposedBy?: string };
  probation?: { from: string; to: string; review?: { id: string; kind: string; dueOn: string }; outcome?: { id: string; action: string; proposedBy?: string } };
  pause?: { id: string; status: string; from: string; to: string; paidPercent: number; proposedBy?: string };
  items?: number; claims?: number; settlement?: { id: string; status: string; lastDay: string; checkedBy?: string }; leavingCase?: string;
  next: NextEvent | null; action: { key: string; label: string } | null; pay?: { monthly: number; ctc: number | null; rate: number | null; payType: PayType } | null;
};
export type PeopleData = { today: string; people: PayRow[]; figuresHidden: boolean; can: { read: boolean; write: boolean; approve: boolean }; policy: { approvers: string; managers: string; currency: string; remindDays: number } };
export type Status = "proposed" | "offered" | "accepted" | "probation" | "confirmed" | "paused" | "notice" | "ended";
export type PayType = "salary" | "stipend" | "contractor" | "retainer" | "hourly";
export type Version = { id: string; kind: string; status: string; effectiveOn: string; payType: PayType; role: string | null; reason: string | null; source: string; correctsId: string | null;
  proposedBy: string | null; proposedById: string | null; proposedAt: string | null; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null; letterId: string | null;
  inForce: boolean; figures: Figures | null; before: Figures | null; components?: Component[] };
export type Offer = { id: string; status: string; role: string; startOn: string; probationDays: number; noticeDays: number | null; terms: string | null; validUntil: string; changeId: string;
  payType: PayType; taskId: string | null; task: string | null; proposedBy: string | null; proposedById: string | null; approvedBy: string | null; sentBy: string | null; sentAt: string | null;
  answeredAt: string | null; answerName: string | null; answerVia: string | null; closedNote: string | null; letterId: string | null; link?: { expiresAt: string; openedAt: string | null };
  figures: Figures | null; components?: Component[] };
export type Pause = { id: string; from: string; to: string; endedOn: string | null; paidPercent: number; reasonKind: string; note: string | null; status: string; proposedBy: string | null;
  proposedById: string | null; decidedBy: string | null; letterId: string | null };
export type Item = { id: string; kind: string; status: string; forMonth: string; payout: string; reason: string | null; recoverMonths: number | null; recoverFrom: string | null;
  proposedBy: string | null; proposedById: string | null; decidedBy: string | null; paidAt: string | null; amount: number | null; schedule?: { month: string; amount: number }[] };
export type Claim = { id: string; category: string; spentOn: string; vendor: string | null; note: string | null; status: string; aboveThreshold: boolean; head: string | null; headBy: string | null;
  decidedBy: string | null; decisionNote: string | null; payout: string; forMonth: string; receiptMime: string; createdAt: string; amount: number | null; person?: string; name?: string; pod?: string | null };
export type Letter = { id: string; kind: string; title: string; issuedAt: string; pages: number; sha256: string; issuedBy: string | null; seenAt: string | null };
export type Event = { at: string; kind: string; by: string | null; subjectType: string | null; subjectId: string | null; detail: Record<string, unknown> };
export type PersonPay = {
  person: { id: string; name: string; role: string | null; pod: string | null; department: string | null; joinedOn: string | null; current: boolean; stage: string; photoAt: string | null; head: string | null };
  record?: { status: Status; since: string | null; until: string | null; startOn: string | null; endOn: string | null; confirmedOn: string | null; currency: string };
  employment: { probationFrom: string | null; probationTo: string | null; noticeFrom: string | null; lastWorkingDay: string | null; payrollFrom: string | null };
  versions?: Version[]; offers?: Offer[]; pauses: Pause[]; items?: Item[]; claims?: Claim[]; letters?: Letter[]; timeline: Event[];
  probation: { reviews: { id: string; kind: string; dueOn: string; status: string; note?: string; doneBy: string | null; doneAt: string | null }[];
    outcomes: { id: string; action: string; until: string | null; note: string | null; status: string; proposedBy: string | null; proposedById: string | null; decidedBy: string | null; letterId: string | null }[] };
  settlement?: { id: string; status: string; exitKind: string; lastDay: string; noticeMode: string; legal: Record<string, boolean>; note: string | null; preparedBy: string | null; checkedBy: string | null;
    checkedById: string | null; approvedBy: string | null; letterId: string | null; caseId: string | null };
  leavingCase?: { id: string; effectiveOn: string; leftType: string | null; settlement: Record<string, unknown> | null };
  can: { read: boolean; self: boolean; manager: boolean; propose: boolean; approve: boolean; claim: boolean };
  policy: { approvers: string; probationApproval: string; probationDays: number; offerDays: number; currency: string; noticeProbation: number; noticeConfirmed: number;
    encashBasis: string; encashDivisor: number; dayBasis: string; recoverMax: number; components: Component[] };
  today: string; inForce: { id?: string; payType: PayType; figures: Figures | null; effectiveOn: string; components?: Component[] } | null; figuresSealed?: boolean; keyring: boolean;
  categories?: { key: string; label: string; cap?: number }[]; threshold?: number | null; approvals?: number; me?: string | null;
};

export const STATUS: Record<Status, { label: string; tone: "neutral" | "warning" | "success" | "danger" | "accent" }> = {
  proposed: { label: "Proposed", tone: "neutral" }, offered: { label: "Offered", tone: "accent" }, accepted: { label: "Accepted", tone: "accent" },
  probation: { label: "On probation", tone: "warning" }, confirmed: { label: "Confirmed", tone: "success" }, paused: { label: "Paused", tone: "warning" },
  notice: { label: "On notice", tone: "danger" }, ended: { label: "Ended", tone: "neutral" },
};
/** A contractor, retainer or hourly person "in force" is active, not "confirmed" (that is employment's word). */
export const statusOf = (s: Status, payType?: PayType | null) => (s === "confirmed" && payType && ["contractor", "retainer", "hourly"].includes(payType) ? { label: "Active", tone: "success" as const } : STATUS[s]);
export const PAY_TYPE: Record<PayType, string> = { salary: "Salary", stipend: "Stipend", contractor: "Contractor", retainer: "Retainer", hourly: "Hourly" };
export const CHANGE_KIND: Record<string, string> = { start: "Pay set up", raise: "Raise", cut: "Pay cut", correction: "Correction", promotion: "Promotion", role_change: "Role change", offer: "Offer" };
export const ITEM_KIND: Record<string, string> = { bonus: "Bonus", incentive: "Incentive", extra: "Extra pay", overtime: "Overtime or night work", arrears: "Arrears", advance: "Advance", loan: "Loan" };
export const PAUSE_REASON: Record<string, string> = { unpaid_leave: "Unpaid leave", sabbatical: "Sabbatical", hold: "Pay on hold", other: "Other" };
export const EXIT_KIND: Record<string, string> = { resigned: "Resigned", terminated: "Terminated", contract_ended: "Contract ended", mutual: "By agreement", probation_end: "Probation ended" };
export const NOTICE_MODE: Record<string, string> = { served: "Notice served", short_recovered: "Short notice: recover the days", waived: "Notice waived", paid_in_lieu: "Paid in lieu of notice" };
export const LETTER_KIND: Record<string, string> = { offer: "Offer letter", revision: "Pay revision", promotion: "Promotion", role_change: "Role change", correction: "Correction", start: "Pay record",
  probation_confirm: "Confirmation", probation_extend: "Probation extended", probation_end: "Probation ended", pause: "Pause in pay", settlement: "Full and final" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "13 Oct 2026" (hand-written month names: en-IN prints "Sept"). */
export const day = (d: string | null | undefined) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : "");
export const dayShort = (d: string | null | undefined) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : "");
export const monthName = (d: string | null | undefined) => (d ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : "");
/** Paise as rupees with Indian grouping, without Intl (the server and browser print the same): ₹1,18,000. */
export function rupees(paise: number | null | undefined, currency = "INR") {
  if (paise === null || paise === undefined) return "—";
  const n = Math.round(paise), sign = n < 0 ? "−" : "", abs = Math.abs(n), whole = String(Math.floor(abs / 100)), part = abs % 100;
  const last3 = whole.slice(-3), rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${sign}${currency === "INR" ? "₹" : `${currency} `}${grouped}${part ? `.${String(part).padStart(2, "0")}` : ""}`;
}
/** Paise as the rupees typed in a form ("40000"). */
export const typed = (paise: number | null | undefined) => (paise === null || paise === undefined ? "" : String(paise / 100));
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
