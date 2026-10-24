// COMP-B: what Finance → People cost reads (the API's shapes). Amounts arrive in paise.
import type { RunSummary } from "../../people/pay/payroll/model";

export type PodCell = { pod: string | null; budget: number | null; actual: number | null; committed: number; planned: number; left: number | null; over: boolean };
export type BudgetRow = { month: string; locked: boolean; past: boolean; budget: number | null; actual: number | null; committed: number; planned: number; byPod: PodCell[] };
export type Alert = { pod: string | null; from: string; months: number; by: number; text: string };
export type Runway = { months: number | null; until: string | null; burn: number; beyond: boolean };
export type OutlookRow = { month: string; label: string; budget: number | null;
  base: { cost: number; planned: number; burn: number | null; downsideBurn: number | null; cash: number | null; held: boolean | null };
  scenario: { cost: number; planned: number; burn: number | null; cash: number | null } | null };
export type Outlook = { thisMonth: string; baseline: number; months: OutlookRow[]; runway: { base: Runway | null; downside: Runway | null; scenario: Runway | null };
  overBudget: { base: string[]; scenario: string[] | null }; yearCost: { base: number; scenario: number | null } };
export type Step = { kind: "hire"; count: number; role: string; pod: string | null; monthly: number; from: string }
  | { kind: "raise"; scope: "all" | "pod" | "person"; pod?: string | null; person?: string | null; percent?: number | null; amount?: number | null; from: string }
  | { kind: "pause"; person: string; from: string; to: string; paidPercent: number }
  | { kind: "drop_role"; role: string }
  | { kind: "bonus"; scope: "all" | "pod" | "person"; pod?: string | null; person?: string | null; amount: number; month: string; each?: boolean }
  | { kind: "exit"; person: string; on: string };
export type Scenario = { id: string; name: string; note: string | null; by: string | null; at: string; steps: Step[] };
export type Role = { id: string; jobId: string | null; job: string | null; jobStatus: string | null; title: string; pod: string | null; count: number; from: string; status: string; note: string | null; by: string | null; monthly: number };
export type CostEvent = { on: string; kind: string; person: string; label: string; change: number | null; until?: string };
export type PeopleCost = {
  today: string; thisMonth: string;
  payroll: { runs: RunSummary[]; can: { start: boolean; approve: boolean; read: boolean }; withRecords: number; staff: number };
  budget: { months: string[]; rows: BudgetRow[]; pods: (string | null)[]; alerts: Alert[]; thisMonth: BudgetRow | null; set: boolean };
  cash: { access: boolean; assumptions?: string[]; confidence?: string; basis?: string; balance?: { amount: number; asOf: string; ageDays: number } | null; computedAt?: string };
  opening: number | null; openingAssumed: boolean; outlook: Outlook; events: CostEvent[]; scenarios: Scenario[]; compared: { id: string; name: string; steps: Step[]; outlook: Outlook }[];
  people: { id: string; name: string; pod: string | null }[]; roles: Role[]; jobs?: { id: string; title: string; status: string }[];
  coverage: { withRecords: number; staff: number }; can: { plan: boolean; write: boolean };
};
export type LedgerEntry = { runId: string; month: string; kind: string; account: string; side: "debit" | "credit"; pod: string | null; department: string | null; people: number; amount: number };

export const ACCOUNT: Record<string, string> = { salaries: "Salaries and wages", employer_contributions: "Employer contributions", reimbursements: "Staff reimbursements",
  advances_paid: "Staff advances and loans", advances_recovered: "Advances and loans recovered", statutory_payable: "Statutory dues payable", net_payable: "Net pay payable" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const mon = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(2, 4)}`;
export const monthFull = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
/** Paise in short Indian units for tight places: ₹4.2 L, ₹1.1 Cr, ₹85k. */
export function short(paise: number | null | undefined) {
  if (paise === null || paise === undefined) return "—";
  const r = paise / 100, a = Math.abs(r), s = r < 0 ? "−" : "";
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(a >= 1e8 ? 0 : 2)} Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(a >= 1e6 ? 1 : 2)} L`;
  if (a >= 1e3) return `${s}₹${Math.round(a / 1e3)}k`;
  return `${s}₹${Math.round(a)}`;
}
export const podName = (p: string | null | undefined) => p || "No pod";
export const fyLabel = (months: string[]) => months.length ? `FY ${months[0].slice(0, 4)}–${months[11]?.slice(2, 4) ?? ""}` : "";
