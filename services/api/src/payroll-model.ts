// COMP-B: the arithmetic of payroll, the people-cost ledger, the running budget, the people-cost projection and the
// what-if scenarios, in one place and without a database (payroll.ts opens the sealed values and calls these). Amounts
// are integer paise; dates are YYYY-MM-DD on the company's calendar; months are their first day. docs/ops/PAYROLL.md.
import { addDays, daysInMonth, fyEnd, ITEM_LABEL, monthEnd, monthPay, monthStart, monthlyCost, nextMonth, normaliseFigures, recoverySchedule,
  type Component, type Figures, type Line, type PayType, type Version } from "./comp-model.js";

// ------------------------------------------------------------------------------------------------- settings
export type Slab = { upTo: number | null; pct: number };
export type Statutory = {
  pf: { on: boolean; employeePct: number; employerPct: number; wageCap: number; capped: boolean };
  esi: { on: boolean; employeePct: number; employerPct: number; grossLimit: number };
  pt: { on: boolean; state?: string };
  tds: { on: boolean; standardDeduction: number; rebateUpTo: number; cessPct: number; contractorPct: number; slabs: Slab[] };
};
export type AttendanceRules = { unpaidLeave: "pay" | "none"; halfDays: "pay" | "none"; lateMarks: "pay" | "leave"; absent: "pay" | "none" };
export const INDIA: Statutory = {
  pf: { on: true, employeePct: 12, employerPct: 12, wageCap: 1500000, capped: true },
  esi: { on: true, employeePct: 0.75, employerPct: 3.25, grossLimit: 2100000 },
  pt: { on: true, state: "MH" },
  tds: { on: true, standardDeduction: 7500000, rebateUpTo: 120000000, cessPct: 4, contractorPct: 10, slabs: [{ upTo: 40000000, pct: 0 }, { upTo: 80000000, pct: 5 },
    { upTo: 120000000, pct: 10 }, { upTo: 160000000, pct: 15 }, { upTo: 200000000, pct: 20 }, { upTo: 240000000, pct: 25 }, { upTo: null, pct: 30 }] },
};
export const DEFAULT_RULES: AttendanceRules = { unpaidLeave: "pay", halfDays: "none", lateMarks: "leave", absent: "none" };
/** Maharashtra's professional tax a month in rupees (the company's confirmed HR rule replaces it). */
export const MH_PT = [{ category: "men", upTo: 7500, monthly: 0, february: 0 }, { category: "men", upTo: 10000, monthly: 175, february: 175 }, { category: "men", upTo: null, monthly: 200, february: 300 },
  { category: "women", upTo: 25000, monthly: 0, february: 0 }, { category: "women", upTo: null, monthly: 200, february: 300 }];
export type PtSlab = { category: string; upTo: number | null; monthly: number; february: number };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const shortMonth = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3)} ${d.slice(0, 4)}`;
const plural = (n: number, one: string) => `${Number.isInteger(n) ? n : n.toFixed(1)} ${n === 1 ? one : `${one}s`}`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------------------------- statutory
/** Income tax on a year's taxable income under the slabs, with the rebate (nil up to the limit, marginal relief above
 *  it) and the cess. Paise in, paise out. */
export function incomeTax(taxable: number, t: Statutory["tds"]) {
  if (taxable <= 0) return 0;
  let tax = 0, lower = 0;
  for (const s of t.slabs) {
    const top = s.upTo ?? Infinity;
    if (taxable > lower) tax += ((Math.min(taxable, top) - lower) * s.pct) / 100;
    lower = top;
    if (taxable <= top) break;
  }
  if (taxable <= t.rebateUpTo) tax = 0;
  else tax = Math.min(tax, taxable - t.rebateUpTo);
  return Math.round((tax * (100 + t.cessPct)) / 100);
}
/** Professional tax for a month's gross (paise) from slabs in rupees; null when the person's details are missing. */
export function professionalTax(gross: number, month: string, category: string | null | undefined, slabs: PtSlab[]) {
  if (!category) return null;
  const rupees = gross / 100, own = slabs.filter((s) => s.category === category);
  if (!own.length) return null;
  const band = own.find((s) => s.upTo === null || rupees <= s.upTo) ?? own[own.length - 1];
  return Math.round((month.slice(5, 7) === "02" ? band.february : band.monthly) * 100);
}
const ceilRupee = (paise: number) => Math.ceil(paise / 100) * 100;

// ------------------------------------------------------------------------------------------ a person's month
export type LopDay = { date: string; weight: number; why: "unpaid_leave" | "half_day" | "absent" };
export type Attendance = { enabled: boolean; lop?: LopDay[]; lateDebit?: number; lateMarks?: number; paidLeaveDays?: number; workingDays?: number;
  openCheckouts?: number; pendingLeave?: number; pendingCorrections?: number };
export type PayItem = { id: string; kind: string; amount: number; forMonth: string; payout: string; recoverMonths?: number | null; recoverFrom?: string | null; paid?: boolean; reason?: string | null };
export type PayClaim = { id: string; amount: number; forMonth: string; label: string };
export type Adjustment = { id: string; kind: "lop_days" | "amount" | "hold"; days?: number | null; amount?: number | null; label?: string | null; reason: string };
export type PayslipLine = Line & { code: string };
export type PersonMonth = {
  month: string; person: { id: string; name: string; role?: string | null; pod?: string | null; department?: string | null };
  start?: string | null; end?: string | null; versions: Version[]; pauses?: { from: string; to: string; paidPercent: number }[];
  items?: PayItem[]; claims?: PayClaim[]; settlement?: { id: string; lines: Line[]; net: number; preparedOn?: string | null } | null;
  attendance?: Attendance; rules?: AttendanceRules; statutory?: Statutory; dayBasis?: string; template?: Component[];
  pt?: { state?: string | null; category?: string | null; exempt?: boolean } | null; ptSlabs?: PtSlab[] | null;
  adjustments?: Adjustment[]; carries?: { runId: string; month: string; amount: number }[];
  bank?: { onFile: boolean; status: string } | null; pendingClaims?: number;
};
export type Payslip = {
  person: PersonMonth["person"]; month: string; payType: PayType; monthDays: number; paidDays: number; lopDays: number; lopBasis: string | null;
  lines: PayslipLine[]; gross: number; deductions: number; reimbursements: number; net: number; employer: number; cost: number; advances: number;
  statutory: { pf: number; pfEmployer: number; esi: number; esiEmployer: number; pt: number; tds: number };
  items: string[]; claims: string[]; carries: string[]; settlementId: string | null; exceptions: string[]; hold: boolean;
  paid?: number | null; difference?: number | null; previous?: Payslip | null;
};
const EARNING_ITEMS = ["bonus", "incentive", "extra", "overtime", "arrears"];

/** The version in force on a day (the latest effective on or before it). */
const inForce = (vs: Version[], on: string) => [...vs].filter((v) => v.effectiveOn <= on).sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn)).at(-1) ?? null;

/**
 * One person's payslip for a month: pay pro-rated (COMP-A's monthPay, pauses at their share), loss of pay from attendance
 * by the company's rules (or HR's days), one-time items, reimbursements, recoveries, a full and final when there is one,
 * HR's amounts, corrections still to recover, and the statutory basics. Totals and the exceptions HR checks.
 */
export function payrollLine(p: PersonMonth): Payslip {
  const first = monthStart(p.month), last = monthEnd(first), dim = daysInMonth(first);
  const st = p.statutory ?? INDIA, rules = { ...DEFAULT_RULES, ...(p.rules ?? {}) };
  const from = p.start && p.start > first ? p.start : first, to = p.end && p.end < last ? p.end : last;
  const vs = [...p.versions].sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn));
  const current = inForce(vs, to < from ? last : to) ?? vs.at(-1) ?? null;
  const payType: PayType = current?.payType ?? "salary";
  const lines: PayslipLine[] = [];
  const ex = new Set<string>();
  const items: string[] = [], claims: string[] = [], carries: string[] = [];
  const add = (l: Line, code: string) => lines.push({ ...l, code: l.code ?? code });
  let lopDays = 0, lopBasis: string | null = null;
  const settlementLike = !!p.settlement;

  if (p.settlement) {
    // The full and final is the month: its statement's lines, coded for the ledger.
    for (const l of p.settlement.lines) {
      const code = l.kind === "reimbursement" ? "claim" : /^Pay for /.test(l.label) ? "pay" : /still to recover/.test(l.label) ? "recovery:fnf" : "fnf";
      add({ ...l }, code);
    }
    // Its recoveries cover the months after it was prepared; the month it was prepared in is recovered here.
    if (p.settlement.preparedOn && monthStart(p.settlement.preparedOn) === first) {
      for (const it of p.items ?? []) if (["advance", "loan"].includes(it.kind) && it.recoverMonths && it.recoverFrom) {
        const part = recoverySchedule(it.amount, it.recoverMonths, it.recoverFrom).find((r) => r.month === first);
        if (part) add({ label: `${ITEM_LABEL[it.kind]} recovery`, kind: "deduction", amount: -part.amount, ref: it.id }, `recovery:${it.kind}`);
      }
    }
    for (const it of p.items ?? []) if (!it.paid && it.payout === "payroll") items.push(it.id);
    for (const k of p.claims ?? []) claims.push(k.id);
  } else {
    // Pay for the days, pauses at their share (COMP-A's calculator).
    const base = monthPay({ month: first, versions: vs, start: p.start, end: p.end, pauses: p.pauses });
    for (const l of base.lines) add(l, l.code ?? "pay");
    // Loss of pay: salary and stipends only; days in a pause are counted there already.
    if (["salary", "stipend"].includes(payType) && current) {
      const paused = (d: string) => (p.pauses ?? []).some((z) => d >= z.from && d <= z.to);
      const counts = (d: LopDay) => d.date >= from && d.date <= to && !paused(d.date) && (d.why === "unpaid_leave" ? rules.unpaidLeave === "pay" : d.why === "half_day" ? rules.halfDays === "pay" : rules.absent === "pay");
      const dated = (p.attendance?.lop ?? []).filter(counts);
      const late = rules.lateMarks === "pay" ? Number(p.attendance?.lateDebit ?? 0) : 0;
      const divisor = () => (p.dayBasis === "30" ? 30 : p.dayBasis === "26" ? 26 : dim);
      const rate = (on: string) => (inForce(vs, on)?.figures.monthly ?? current.figures.monthly) / divisor();
      const set = (p.adjustments ?? []).find((a) => a.kind === "lop_days");
      let amount: number;
      if (set) {
        lopDays = Number(set.days) || 0; amount = Math.round(rate(to) * lopDays); lopBasis = `Set by HR: ${set.reason}`;
      } else {
        lopDays = sum(dated.map((d) => d.weight)) + late;
        amount = Math.round(sum(dated.map((d) => rate(d.date) * d.weight)) + rate(to) * late);
        const parts = [["unpaid_leave", "unpaid leave"], ["half_day", "half days"], ["absent", "days without a check-in"]]
          .map(([k, w]) => [w, sum(dated.filter((d) => d.why === k).map((d) => d.weight))] as const).filter(([, n]) => n > 0).map(([w, n]) => `${w} ${n}`);
        if (late) parts.push(`late marks ${late}`);
        lopBasis = parts.length ? parts.join(" · ") : null;
      }
      const earned = sum(lines.filter((l) => ["pay", "pause"].includes(l.code)).map((l) => l.amount));
      amount = Math.min(amount, Math.max(0, earned));
      if (lopDays > 0 && amount > 0) add({ label: `Loss of pay, ${plural(lopDays, "day")}`, kind: "deduction", amount: -amount, basis: lopBasis ?? undefined }, "lop");
    }
    // One-time pay (approved and not yet paid, this month or earlier), advances paid with payroll, and recoveries.
    for (const it of p.items ?? []) {
      if (!it.paid && it.payout === "payroll" && monthStart(it.forMonth) <= first) {
        const late = monthStart(it.forMonth) < first ? ` (${shortMonth(it.forMonth)})` : "";
        add({ label: `${ITEM_LABEL[it.kind] ?? it.kind}${["advance", "loan"].includes(it.kind) ? " paid" : ""}${late}`, kind: "earning", amount: it.amount, ref: it.id, basis: it.reason ?? undefined }, `item:${it.kind}`);
        items.push(it.id);
      }
      if (["advance", "loan"].includes(it.kind) && it.recoverMonths && it.recoverFrom) {
        const part = recoverySchedule(it.amount, it.recoverMonths, it.recoverFrom).find((r) => r.month === first);
        if (part) add({ label: `${ITEM_LABEL[it.kind]} recovery`, kind: "deduction", amount: -part.amount, ref: it.id }, `recovery:${it.kind}`);
      }
    }
    for (const k of p.claims ?? []) { add({ label: k.label, kind: "reimbursement", amount: k.amount, ref: k.id }, "claim"); claims.push(k.id); }
  }
  for (const a of p.adjustments ?? []) if (a.kind === "amount" && a.amount) add({ label: a.label ?? "Adjustment", kind: a.amount < 0 ? "deduction" : "earning", amount: a.amount, basis: a.reason }, "adjust");
  for (const c of p.carries ?? []) if (c.amount > 0) { add({ label: `Correction to recover (${shortMonth(c.month)})`, kind: "deduction", amount: -c.amount }, "carry"); carries.push(c.runId); }

  // Statutory basics on the month's earned pay.
  const earnedPay = Math.max(0, sum(lines.filter((l) => ["pay", "pause", "lop"].includes(l.code)).map((l) => l.amount)));
  const oneTime = sum(lines.filter((l) => l.code.startsWith("item:") && EARNING_ITEMS.includes(l.code.slice(5)) || l.code === "fnf" && l.amount > 0 || l.code === "adjust" && l.amount > 0).map((l) => l.amount));
  const s = { pf: 0, pfEmployer: 0, esi: 0, esiEmployer: 0, pt: 0, tds: 0 };
  if (payType === "salary" && current) {
    if (st.pf.on) {
      const basic = current.figures.components?.basic, share = basic && current.figures.monthly ? basic / current.figures.monthly : 1;
      const wage = Math.round(earnedPay * share), capped = st.pf.capped ? Math.min(wage, st.pf.wageCap) : wage;
      s.pf = Math.round((capped * st.pf.employeePct) / 100); s.pfEmployer = Math.round((capped * st.pf.employerPct) / 100);
    }
    if (st.esi.on && current.figures.monthly <= st.esi.grossLimit) {
      const wage = earnedPay + sum(lines.filter((l) => ["item:incentive", "item:extra", "item:overtime"].includes(l.code)).map((l) => l.amount));
      s.esi = ceilRupee((wage * st.esi.employeePct) / 100); s.esiEmployer = ceilRupee((wage * st.esi.employerPct) / 100);
    }
  }
  if (["salary", "stipend"].includes(payType) && st.pt.on && !p.pt?.exempt) {
    const state = p.pt?.state ?? null;
    if (!state) ex.add("pt_details");
    else if (state === "MH") {
      const tax = professionalTax(earnedPay + oneTime, first, p.pt?.category, p.ptSlabs?.length ? p.ptSlabs : MH_PT);
      if (tax === null) ex.add("pt_details"); else s.pt = tax;
    }
  }
  if (st.tds.on && current && !settlementLike) {
    if (["salary", "stipend"].includes(payType)) {
      const year = current.figures.monthly * 12, taxable = (x: number) => Math.max(0, x - st.tds.standardDeduction);
      const base = incomeTax(taxable(year), st.tds) / 12, scale = current.figures.monthly ? Math.min(1, earnedPay / current.figures.monthly) : 0;
      s.tds = Math.round(base * scale + (incomeTax(taxable(year + oneTime), st.tds) - incomeTax(taxable(year), st.tds)));
    } else s.tds = ceilRupee(((earnedPay + oneTime) * st.tds.contractorPct) / 100);
  }
  if (s.pf) add({ label: `Provident fund (${st.pf.employeePct}%)`, kind: "deduction", amount: -s.pf }, "pf");
  if (s.esi) add({ label: `ESI (${st.esi.employeePct}%)`, kind: "deduction", amount: -s.esi }, "esi");
  if (s.pt) add({ label: "Professional tax", kind: "deduction", amount: -s.pt }, "pt");
  if (s.tds) add({ label: ["salary", "stipend"].includes(payType) ? "Income tax (TDS, estimate)" : `TDS on fees (${st.tds.contractorPct}%, estimate)`, kind: "deduction", amount: -s.tds }, "tds");
  if (s.pfEmployer) add({ label: `Provident fund, company share (${st.pf.employerPct}%)`, kind: "employer", amount: s.pfEmployer }, "pf_er");
  if (s.esiEmployer) add({ label: `ESI, company share (${st.esi.employerPct}%)`, kind: "employer", amount: s.esiEmployer }, "esi_er");

  const of = (k: Line["kind"]) => sum(lines.filter((l) => l.kind === k).map((l) => l.amount));
  const gross = of("earning"), deductions = -of("deduction"), reimbursements = of("reimbursement"), employer = of("employer");
  const net = gross - deductions + reimbursements;
  const advances = sum(lines.filter((l) => ["item:advance", "item:loan"].includes(l.code)).map((l) => l.amount));
  const cost = sum(lines.filter((l) => accountOf(l.code) === "salaries").map((l) => l.amount)) + employer;

  // What HR checks.
  const a = p.attendance;
  if (a?.openCheckouts) ex.add("open_checkout");
  if (a?.pendingLeave) ex.add("pending_leave");
  if (a?.pendingCorrections) ex.add("pending_correction");
  if (p.pendingClaims) ex.add("pending_claims");
  if (payType === "hourly" && current && !current.figures.hours) ex.add("hourly_no_hours");
  if (net < 0) ex.add("negative_net");
  const hold = (p.adjustments ?? []).some((x) => x.kind === "hold");
  if (net > 0 && !hold) {
    if (!p.bank?.onFile) ex.add("no_bank");
    else if (p.bank.status !== "confirmed") ex.add("bank_unchecked");
  }
  const span = (basis?: string) => { const [a1, b1] = (basis ?? "").split(".."); return a1 && b1 ? Math.round((Date.parse(b1) - Date.parse(a1)) / 864e5) + 1 : 0; };
  const pausedOff = settlementLike ? 0 : sum((p.pauses ?? []).map((z) => { const zf = z.from > from ? z.from : from, zt = z.to < to ? z.to : to; return zf > zt ? 0 : span(`${zf}..${zt}`) * (1 - z.paidPercent / 100); }));
  const paidDays = Math.max(0, Math.round((sum(lines.filter((l) => l.code === "pay").map((l) => span(l.basis))) - pausedOff - lopDays) * 10) / 10);
  return { person: p.person, month: first, payType, monthDays: dim, paidDays, lopDays, lopBasis, lines, gross, deductions, reimbursements, net, employer, cost, advances, statutory: s,
    items, claims, carries, settlementId: p.settlement?.id ?? null, exceptions: [...ex].sort(), hold };
}

/** A correction: the corrected month against what the locked runs paid; null when nothing changed. */
export function correction(next: Payslip, paid: Payslip | null): Payslip | null {
  const before = paid?.net ?? 0, diff = next.net - before;
  const changed = !paid || diff !== 0 || paid.cost !== next.cost || paid.lines.length !== next.lines.length;
  if (!changed) return null;
  const ex = new Set(next.exceptions);
  if (diff <= 0) { ex.delete("no_bank"); ex.delete("bank_unchecked"); }
  return { ...next, paid: before, difference: diff, previous: paid ? { ...paid, previous: null } : null, exceptions: [...ex].sort() };
}

// -------------------------------------------------------------------------------------------------- ledger
export const ACCOUNTS = ["salaries", "employer_contributions", "reimbursements", "advances_paid", "advances_recovered", "statutory_payable", "net_payable"] as const;
export type Account = (typeof ACCOUNTS)[number];
export const ACCOUNT_LABEL: Record<Account, string> = { salaries: "Salaries and wages", employer_contributions: "Employer contributions", reimbursements: "Staff reimbursements",
  advances_paid: "Staff advances and loans", advances_recovered: "Advances and loans recovered", statutory_payable: "Statutory dues payable", net_payable: "Net pay payable" };
export const SIDE: Record<Account, "debit" | "credit"> = { salaries: "debit", employer_contributions: "debit", reimbursements: "debit", advances_paid: "debit",
  advances_recovered: "credit", statutory_payable: "credit", net_payable: "credit" };
/** The account a payslip line's own amount posts to (statutory and employer lines also credit the dues payable). */
export function accountOf(code: string): Account | null {
  if (["pf", "esi", "pt", "tds"].includes(code)) return "statutory_payable";
  if (["pf_er", "esi_er"].includes(code)) return "employer_contributions";
  if (code === "claim") return "reimbursements";
  if (["item:advance", "item:loan"].includes(code)) return "advances_paid";
  if (code.startsWith("recovery:")) return "advances_recovered";
  if (code === "carry") return "net_payable";
  return "salaries";
}
/** A payslip's journal: the amount on each account (debits and credits positive on their own side). */
export function journal(s: Payslip): Record<Account, number> {
  const j = Object.fromEntries(ACCOUNTS.map((a) => [a, 0])) as Record<Account, number>;
  for (const l of s.lines) {
    const a = accountOf(l.code)!;
    if (a === "statutory_payable" || a === "advances_recovered" || a === "net_payable") j[a] += -l.amount; // deductions: credits
    else j[a] += l.amount;
    if (a === "employer_contributions") j.statutory_payable += l.amount;
  }
  j.net_payable += s.net;
  return j;
}
/** The run's ledger: entries by pod and department and totals by account, with a balance check. For a correction the
 *  journal posts the difference from what the locked runs posted. */
export function ledgerFor(lines: { slip: Payslip; pod?: string | null; department?: string | null; paid?: Payslip | null }[]) {
  const key = (pod?: string | null, dept?: string | null) => `${pod ?? ""}\u0000${dept ?? ""}`;
  const groups = new Map<string, { pod: string | null; department: string | null; people: Set<string>; j: Record<Account, number> }>();
  const totals = Object.fromEntries(ACCOUNTS.map((a) => [a, { amount: 0, people: new Set<string>() }])) as Record<Account, { amount: number; people: Set<string> }>;
  for (const x of lines) {
    const j = journal(x.slip), before = x.paid ? journal(x.paid) : null;
    const g = groups.get(key(x.pod, x.department)) ?? { pod: x.pod ?? null, department: x.department ?? null, people: new Set(), j: Object.fromEntries(ACCOUNTS.map((a) => [a, 0])) as Record<Account, number> };
    for (const a of ACCOUNTS) {
      const amount = j[a] - (before?.[a] ?? 0);
      if (!amount) continue;
      g.j[a] += amount; totals[a].amount += amount; totals[a].people.add(x.slip.person.id);
    }
    g.people.add(x.slip.person.id);
    groups.set(key(x.pod, x.department), g);
  }
  const debit = sum(ACCOUNTS.filter((a) => SIDE[a] === "debit").map((a) => totals[a].amount)), credit = sum(ACCOUNTS.filter((a) => SIDE[a] === "credit").map((a) => totals[a].amount));
  if (debit !== credit) throw new Error(`The payroll journal does not balance (${debit} against ${credit})`);
  const entries = [...groups.values()].flatMap((g) => ACCOUNTS.filter((a) => g.j[a]).map((a) => ({ account: a, side: SIDE[a], pod: g.pod, department: g.department, people: g.people.size, amount: g.j[a] })));
  return { entries, totals: ACCOUNTS.filter((a) => totals[a].amount).map((a) => ({ account: a, side: SIDE[a], people: totals[a].people.size, amount: totals[a].amount })), debit, credit };
}
/** The run's totals for its page and list. */
export function runTotals(slips: Payslip[]) {
  const t = (f: (s: Payslip) => number) => sum(slips.map(f));
  return { people: slips.length, gross: t((s) => s.gross), deductions: t((s) => s.deductions), reimbursements: t((s) => s.reimbursements), net: t((s) => s.net),
    employer: t((s) => s.employer), cost: t((s) => s.cost), difference: slips.some((s) => s.difference !== undefined) ? t((s) => s.difference ?? 0) : null,
    toPay: t((s) => Math.max(0, s.difference ?? s.net) * (s.hold ? 0 : 1)), statutory: t((s) => s.statutory.pf + s.statutory.esi + s.statutory.pt + s.statutory.tds + s.statutory.pfEmployer + s.statutory.esiEmployer) };
}

// ----------------------------------------------------------------------------------------------- bank file
export type BankRow = { name: string; account: string; ifsc: string; amount: number; reference: string; email?: string | null };
const csvCell = (x: unknown) => { let t = x === null || x === undefined ? "" : String(x); if (/^[=+@-]/.test(t)) t = `'${t}`; return /[",\r\n]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t; };
const plain = (s: string, max: number) => s.normalize("NFKD").replace(/[^A-Za-z0-9 .&/-]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const rupeesText = (paise: number) => `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;
/** The bank's bulk-upload CSV. `axis`: Axis Bank corporate bulk upload (IFT to Axis accounts, NEFT to others);
 *  `generic`: name, account, IFSC, amount, reference, narration. The founder checks the layout with the bank once. */
export function bankFile(format: "axis" | "generic", rows: BankRow[], o: { payOn: string; narration: string; debitAccount?: string | null }) {
  const valueDate = `${o.payOn.slice(8, 10)}-${o.payOn.slice(5, 7)}-${o.payOn.slice(0, 4)}`, narration = plain(o.narration, 30);
  const out = format === "axis"
    ? [["Payment Mode", "Beneficiary Account Number", "Amount", "Value Date", "Beneficiary Name", "Beneficiary IFSC", "Debit Account Number", "Customer Reference", "Remarks"],
      ...rows.map((r) => [r.ifsc.toUpperCase().startsWith("UTIB") ? "IFT" : "NEFT", r.account, rupeesText(r.amount), valueDate, plain(r.name, 35), r.ifsc.toUpperCase(), o.debitAccount ?? "", r.reference, narration])]
    : [["Name", "Account Number", "IFSC", "Amount", "Reference", "Narration", "Value Date"],
      ...rows.map((r) => [plain(r.name, 35), r.account, r.ifsc.toUpperCase(), rupeesText(r.amount), r.reference, narration, valueDate])];
  return out.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------------------------------------- payslip
/** What the payslip PDF says (drawn by @pulse/invoice-doc's letter writer, kind "payslip"). */
export function payslipLetter(s: Payslip, o: { company: string; payOn: string | null; bankLast4?: string | null; version: number; money: (paise: number) => string }) {
  const m = s.month, last = monthEnd(m);
  const paragraphs = [
    `Pay period: 1 to ${Number(last.slice(8, 10))} ${monthLabel(m)} · days paid: ${s.paidDays} of ${s.monthDays}${s.lopDays ? ` · loss of pay: ${plural(s.lopDays, "day")}` : ""}.`,
  ];
  if (s.difference !== undefined && s.difference !== null) {
    paragraphs.push(`This revised payslip (version ${o.version}) replaces the earlier one for ${monthLabel(m)}. Paid before: ${o.money(s.paid ?? 0)}. ${s.difference > 0 ? `Still to pay: ${o.money(s.difference)}.`
      : s.difference < 0 ? `Paid too much: ${o.money(-s.difference)}, recovered from your next pay.` : "Nothing more is paid or recovered."}`);
  }
  if (s.hold) paragraphs.push("This month's pay is paid separately; HR will tell you when.");
  else if (s.net > 0) paragraphs.push(`Paid to your bank account${o.bankLast4 ? ` ending ${o.bankLast4}` : ""}${o.payOn ? ` from ${Number(o.payOn.slice(8, 10))} ${monthLabel(o.payOn).replace(/ \d{4}$/, "")}` : ""}.`);
  if (s.employer) paragraphs.push(`The company also pays ${o.money(s.employer)} for you (provident fund and ESI, company share); it is not part of your take-home pay.`);
  if (s.statutory.tds) paragraphs.push("Income tax deducted is an estimate; the company's chartered accountant confirms it and your Form 16 is final.");
  const row = (l: Line) => [l.label, `${l.amount < 0 ? "− " : ""}${o.money(Math.abs(l.amount))}`];
  const shown = s.lines.filter((l) => l.kind !== "employer");
  return {
    kind: "payslip", title: `Payslip for ${monthLabel(m)}`, paragraphs,
    table: { columns: ["", "Amount"], rows: [...shown.filter((l) => l.kind === "earning").map(row), ["Total earnings", o.money(s.gross)], ...shown.filter((l) => l.kind === "deduction").map(row),
      ...shown.filter((l) => l.kind === "reimbursement").map(row)], total: ["Net pay", `${s.net < 0 ? "− " : ""}${o.money(Math.abs(s.net))}`] },
  };
}

// ------------------------------------------------------------------------- budget, projection, scenarios
export type Person = { id: string; name: string; pod: string | null; department?: string | null; status?: string | null; start?: string | null; end?: string | null;
  versions: Version[]; pauses?: { from: string; to: string; paidPercent: number }[]; items?: { kind: string; amount: number; forMonth: string; payout: string }[] };
export type Pending = { id: string; person: string; pod: string | null; kind: "offer" | "change"; from: string; payType: PayType; figures: Figures; label: string };
export type Role = { id: string; title: string; pod: string | null; count: number; from: string; monthly: number; status: string; jobId?: string | null };

/** The months from a month (its first day) for n months. */
export const monthsFrom = (m: string, n: number) => { const out: string[] = []; let d = monthStart(m); for (let i = 0; i < n; i++) { out.push(d); d = nextMonth(d); } return out; };
/** The financial year's months (April to March) a day falls in. */
export const fyMonths = (d: string) => monthsFrom(`${Number(fyEnd(d).slice(0, 4)) - 1}-04-01`, 12);

/** A person's people cost in a month from their pay records: each version's cost (CTC / 12) for its days, paused days at
 *  their share, approved one-time pay in the month. */
export function personCost(p: Person, month: string) {
  const first = monthStart(month), last = monthEnd(first), dim = daysInMonth(first);
  const vs = [...p.versions].sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn));
  const from = p.start && p.start > first ? p.start : first, to = p.end && p.end < last ? p.end : last;
  let cost = 0;
  if (from > to) return 0;
  for (let i = 0; i < vs.length; i++) {
    const segFrom = vs[i].effectiveOn > from ? vs[i].effectiveOn : from, nextOn = vs[i + 1]?.effectiveOn ?? null;
    const segTo = nextOn && addDays(nextOn, -1) < to ? addDays(nextOn, -1) : to;
    if (segFrom > segTo) continue;
    const c = monthlyCost(vs[i].figures);
    let days = 0;
    for (let d = segFrom; d <= segTo; d = addDays(d, 1)) {
      const z = (p.pauses ?? []).find((x) => d >= x.from && d <= x.to);
      days += z ? z.paidPercent / 100 : 1;
    }
    cost += (c * days) / dim;
  }
  for (const it of p.items ?? []) if (monthStart(it.forMonth) === first && EARNING_ITEMS.includes(it.kind)) cost += it.amount;
  return Math.round(cost);
}

export type Step =
  | { kind: "hire"; count: number; role: string; pod: string | null; monthly: number; from: string }
  | { kind: "raise"; scope: "all" | "pod" | "person"; pod?: string | null; person?: string | null; percent?: number | null; amount?: number | null; from: string }
  | { kind: "pause"; person: string; from: string; to: string; paidPercent: number }
  | { kind: "drop_role"; role: string }
  | { kind: "bonus"; scope: "all" | "pod" | "person"; pod?: string | null; person?: string | null; amount: number; month: string; each?: boolean }
  | { kind: "exit"; person: string; on: string };

/** A scenario's people as the steps change them (never the records): raises become versions, pauses and exits change
 *  dates, hires and bonuses add cost, a dropped role leaves the plan. Template: the company's salary structure. */
export function applySteps(people: Person[], roles: Role[], steps: Step[], template: Component[]) {
  const ps = people.map((p) => ({ ...p, versions: [...p.versions], pauses: [...(p.pauses ?? [])], items: [...(p.items ?? [])] }));
  let rs = roles.map((r) => ({ ...r }));
  const extra: { pod: string | null; month: string; amount: number; from?: string; monthly?: number; label: string }[] = [];
  const hits = (p: Person, s: { scope: string; pod?: string | null; person?: string | null }) => s.scope === "all" || (s.scope === "pod" && p.pod === (s.pod ?? null)) || (s.scope === "person" && p.id === s.person);
  for (const s of steps) {
    if (s.kind === "hire") {
      const f = normaliseFigures({ monthly: s.monthly }, "salary", template);
      extra.push({ pod: s.pod, month: monthStart(s.from), amount: 0, from: monthStart(s.from), monthly: monthlyCost(f) * Math.max(1, s.count), label: `${s.count} × ${s.role}` });
    } else if (s.kind === "raise") {
      for (const p of ps) if (hits(p, s)) {
        const v = inForce(p.versions, s.from);
        if (!v) continue;
        const add = s.percent ? Math.round((v.figures.monthly * s.percent) / 100) : Math.round(s.amount ?? 0);
        if (!add) continue;
        const monthly = Math.max(0, v.figures.monthly + add);
        const figures = v.payType === "salary" ? normaliseFigures({ monthly }, "salary", template) : { ...v.figures, monthly, ctc: v.figures.ctc ? Math.round((v.figures.ctc * monthly) / Math.max(1, v.figures.monthly)) : null };
        p.versions.push({ effectiveOn: s.from, payType: v.payType, figures });
      }
    } else if (s.kind === "pause") {
      const p = ps.find((x) => x.id === s.person);
      if (p) p.pauses.push({ from: s.from, to: s.to, paidPercent: s.paidPercent });
    } else if (s.kind === "drop_role") rs = rs.filter((r) => r.id !== s.role);
    else if (s.kind === "bonus") {
      const who = ps.filter((p) => hits(p, s) && personCost({ ...p, items: [] }, s.month) > 0); // employed that month
      if (s.scope === "person" || s.each) for (const p of who) p.items.push({ kind: "bonus", amount: s.amount, forMonth: monthStart(s.month), payout: "payroll" });
      else if (who.length) { const part = Math.floor(s.amount / who.length); who.forEach((p, i) => p.items.push({ kind: "bonus", amount: i === who.length - 1 ? s.amount - part * (who.length - 1) : part, forMonth: monthStart(s.month), payout: "payroll" })); }
      else extra.push({ pod: s.pod ?? null, month: monthStart(s.month), amount: s.amount, label: "Bonus" });
    } else if (s.kind === "exit") {
      const p = ps.find((x) => x.id === s.person);
      if (p && (!p.end || p.end > s.on)) p.end = s.on;
    }
  }
  return { people: ps, roles: rs, extra };
}

/** People cost a month by pod: committed (records), planned (open roles, pending offers and changes), and extra
 *  (a scenario's hires and lump sums). */
export function costByMonth(months: string[], people: Person[], o: { roles?: Role[]; pending?: Pending[]; extra?: ReturnType<typeof applySteps>["extra"] } = {}) {
  return months.map((m) => {
    const pods = new Map<string, { committed: number; planned: number }>();
    const at = (pod: string | null) => { const k = pod ?? ""; const x = pods.get(k) ?? { committed: 0, planned: 0 }; pods.set(k, x); return x; };
    for (const p of people) { const c = personCost(p, m); if (c) at(p.pod).committed += c; }
    for (const r of o.roles ?? []) if (r.status === "planned" && monthStart(r.from) <= m) at(r.pod).planned += r.monthly * Math.max(1, r.count);
    for (const q of o.pending ?? []) if (monthStart(q.from) <= m) {
      const base = people.find((p) => p.id === q.person);
      const now = base ? personCost(base, m) : 0;
      const next = personCost({ ...(base ?? { id: q.person, name: "", pod: q.pod, versions: [] }), versions: [...(base?.versions ?? []), { effectiveOn: q.from, payType: q.payType, figures: q.figures }],
        start: base?.start ?? q.from }, m);
      at(q.pod).planned += Math.max(0, next - now);
    }
    for (const e of o.extra ?? []) {
      if (e.monthly && e.from && e.from <= m) at(e.pod).committed += e.monthly;
      if (e.amount && e.month === m) at(e.pod).committed += e.amount;
    }
    const byPod = [...pods.entries()].map(([pod, v]) => ({ pod: pod || null, committed: Math.round(v.committed), planned: Math.round(v.planned) }));
    return { month: m, committed: sum(byPod.map((x) => x.committed)), planned: sum(byPod.map((x) => x.planned)), byPod };
  });
}

export type BudgetCell = { month: string; pod: string | null; amount: number };
/** Budget against actual (locked payroll), committed and planned, a month and a pod, with alerts. */
export function budgetView(months: string[], o: { budget: BudgetCell[]; actual: { month: string; pod: string | null; amount: number }[]; cost: ReturnType<typeof costByMonth>; today: string }) {
  const pods = [...new Set([...o.budget.map((b) => b.pod ?? ""), ...o.actual.map((a) => a.pod ?? ""), ...o.cost.flatMap((c) => c.byPod.map((x) => x.pod ?? ""))])].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  const locked = new Set(o.actual.map((a) => a.month));
  const rows = months.map((m) => {
    const c = o.cost.find((x) => x.month === m);
    const byPod = pods.map((pod) => {
      const budget = o.budget.find((b) => b.month === m && (b.pod ?? "") === pod)?.amount ?? null;
      const actual = locked.has(m) ? sum(o.actual.filter((a) => a.month === m && (a.pod ?? "") === pod).map((a) => a.amount)) : null;
      const cp = c?.byPod.find((x) => (x.pod ?? "") === pod);
      const committed = actual === null ? cp?.committed ?? 0 : 0, planned = actual === null ? cp?.planned ?? 0 : 0;
      const used = (actual ?? 0) + committed + planned;
      return { pod: pod || null, budget, actual, committed, planned, left: budget === null ? null : budget - used, over: budget !== null && used > budget };
    });
    const total = (k: "actual" | "committed" | "planned") => sum(byPod.map((x) => Number(x[k] ?? 0)));
    const budgetTotal = byPod.some((x) => x.budget !== null) ? sum(byPod.map((x) => x.budget ?? 0)) : null;
    return { month: m, locked: locked.has(m), past: m < monthStart(o.today), budget: budgetTotal, actual: locked.has(m) ? total("actual") : null, committed: total("committed"), planned: total("planned"), byPod };
  });
  const alerts: { pod: string | null; from: string; months: number; by: number; text: string }[] = [];
  for (const pod of pods) {
    const over = rows.filter((r) => !r.locked && r.month >= monthStart(o.today)).map((r) => ({ month: r.month, x: r.byPod.find((y) => (y.pod ?? "") === pod)! })).filter((r) => r.x.over);
    if (!over.length) continue;
    const by = Math.max(...over.map((r) => -(r.x.left ?? 0)));
    alerts.push({ pod: pod || null, from: over[0].month, months: over.length, by, text: `${pod || "People without a pod"} goes over its people budget from ${monthLabel(over[0].month)}` });
  }
  return { pods: pods.map((p) => p || null), rows, alerts };
}

/** COMP-A's Change pay preview: the change's extra cost a month against the pod's budget left, from its month to the
 *  end of the financial year. */
export function budgetCheck(view: ReturnType<typeof budgetView>, pod: string | null, from: string, extra: number) {
  const months = view.rows.filter((r) => r.month >= monthStart(from) && !r.locked);
  const cells = months.map((r) => ({ month: r.month, x: r.byPod.find((y) => (y.pod ?? "") === (pod ?? "")) }));
  if (!cells.length || cells.every((c) => !c.x || c.x.budget === null)) return { available: false, note: `No people budget is set for ${pod ?? "people without a pod"} yet: leadership sets it in Finance → People cost.` };
  const after = cells.filter((c) => c.x && c.x.budget !== null).map((c) => ({ month: c.month, left: (c.x!.left ?? 0) - extra }));
  const over = after.filter((c) => c.left < 0);
  const minLeft = Math.min(...after.map((c) => c.left));
  return over.length
    ? { available: true, over: true, pod, from: over[0].month, by: -Math.min(...over.map((c) => c.left)), months: over.length, note: `Puts ${pod ?? "people without a pod"} over its people budget from ${monthLabel(over[0].month)}` }
    : { available: true, over: false, pod, left: minLeft, months: after.length, note: `Within ${pod ?? "people without a pod"}'s people budget` };
}

export type CashMonth = { month: string; label?: string; base: { inflow: number; outflow: number }; downside: { inflow: number; outflow: number }; upside: { inflow: number; outflow: number } };
/**
 * FIN-LIVE's cash forecast with people cost from the pay records. Its outflow already holds the cost sheet's payroll,
 * so only the change from this month's people cost is added (downside: plus pending offers and planned roles). Beyond
 * its months the last month is held flat. All amounts in paise (the caller converts FIN-LIVE's rupees).
 */
export function cashWithPeople(months: string[], cash: CashMonth[], people: ReturnType<typeof costByMonth>, baseline: number, opening: number | null) {
  const last = cash.at(-1);
  let cum = { base: 0, downside: 0, upside: 0 };
  const rows = months.map((m) => {
    const c = cash.find((x) => x.month.slice(0, 7) === m.slice(0, 7)) ?? (last ? { ...last, month: m } : null);
    const p = people.find((x) => x.month === m);
    const delta = (p?.committed ?? 0) - baseline, planned = p?.planned ?? 0;
    const row = { month: m, held: !cash.some((x) => x.month.slice(0, 7) === m.slice(0, 7)), peopleCost: p?.committed ?? 0, peopleChange: delta, planned } as Record<string, unknown> & { month: string };
    for (const k of ["base", "downside", "upside"] as const) {
      const inflow = c ? c[k].inflow : 0, outflow = (c ? c[k].outflow : 0) + delta + (k === "downside" ? planned : 0);
      cum = { ...cum, [k]: cum[k] + inflow - outflow };
      row[k] = { inflow: Math.round(inflow), outflow: Math.round(outflow), net: Math.round(inflow - outflow), cumulative: Math.round(cum[k]), cash: opening === null ? null : Math.round(opening + cum[k]) };
    }
    return row as { month: string; held: boolean; peopleCost: number; peopleChange: number; planned: number } & Record<"base" | "downside" | "upside", { inflow: number; outflow: number; net: number; cumulative: number; cash: number | null }>;
  });
  return rows;
}
/** Runway from an opening balance: the month cash first goes below zero, else beyond the horizon; and the average burn. */
export function runway(rows: ReturnType<typeof cashWithPeople>, k: "base" | "downside" | "upside", opening: number | null) {
  const burn = rows.length ? -sum(rows.map((r) => r[k].net)) / rows.length : 0;
  if (opening === null) return { months: null, until: null, burn: Math.round(burn), beyond: false };
  const i = rows.findIndex((r) => (r[k].cash ?? 0) < 0);
  return i < 0 ? { months: rows.length, until: null, burn: Math.round(burn), beyond: true } : { months: i, until: rows[i].month, burn: Math.round(burn), beyond: false };
}
