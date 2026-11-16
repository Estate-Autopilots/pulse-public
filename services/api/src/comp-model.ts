// COMP-A: the arithmetic of pay, in one place and without a database, so the screens, the letters, the tests and COMP-B's
// payroll run all agree. Every amount is an integer number of paise (or the currency's minor unit); dates are
// YYYY-MM-DD strings on the company's calendar. Nothing here reads or writes: comp.ts opens the sealed figures and calls
// these functions.

export const PAY_TYPES = ["salary", "stipend", "contractor", "retainer", "hourly"] as const;
export type PayType = (typeof PAY_TYPES)[number];
export type Component = { key: string; label: string; kind: "earning" | "employer" | "deduction"; of?: string; pct?: number; cap?: number; balance?: boolean };
/** A version's sealed figures. components: amount a month per component key. */
export type Figures = { monthly: number; ctc: number | null; components: Record<string, number>; rate?: number | null; hours?: number | null };
/** code (COMP-B's ledger): pay · pause · item:<kind> · recovery:<kind> · claim, and payroll's own (lop, pf, esi, pt, tds, …); ref: the item or claim. */
export type Line = { label: string; kind: "earning" | "deduction" | "reimbursement" | "employer"; amount: number; basis?: string; code?: string; ref?: string };

/** The company structure a new pay policy starts with (0440_comp_pay.sql's default): India. */
export const DEFAULT_TEMPLATE: Component[] = [{ key: "basic", label: "Basic", kind: "earning", of: "gross", pct: 50 }, { key: "hra", label: "House rent allowance", kind: "earning", of: "basic", pct: 40 },
  { key: "special", label: "Special allowance", kind: "earning", balance: true }, { key: "pf_employer", label: "Employer PF", kind: "employer", of: "basic", pct: 12, cap: 180000 }];

export class PayInputError extends Error { readonly statusCode = 400; readonly expose = true; }
const fail = (m: string): never => { throw new PayInputError(m); };
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

// ------------------------------------------------------------------------------------------------------- dates
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (d: unknown): d is string => typeof d === "string" && DAY.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => new Date(t(d) + n * 86400000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((t(b) - t(a)) / 86400000); // b − a
export const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
export const monthEnd = (d: string) => { const [y, m] = d.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
export const daysInMonth = (d: string) => Number(monthEnd(d).slice(8, 10));
export const nextMonth = (d: string) => addDays(monthEnd(d), 1);
/** The end of India's financial year (31 March) a day falls in. */
export const fyEnd = (d: string) => { const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)); return `${m >= 4 ? y + 1 : y}-03-31`; };

// ------------------------------------------------------------------------------------------------ components
/** The company's structure applied to a monthly gross: earnings that add up to it, then employer contributions. */
export function splitPay(gross: number, template: Component[]) {
  const out: Record<string, number> = {};
  const earning = template.filter((c) => c.kind === "earning"), others = template.filter((c) => c.kind !== "earning");
  const base = (c: Component) => (c.of === "gross" || !c.of ? gross : out[c.of] ?? 0);
  for (const c of earning.filter((c) => !c.balance)) out[c.key] = Math.min(c.cap ?? Infinity, Math.round((base(c) * (Number(c.pct) || 0)) / 100));
  const used = Object.values(out).reduce((a, b) => a + b, 0);
  const bal = earning.find((c) => c.balance);
  if (bal) out[bal.key] = Math.max(0, gross - used);
  else if (used !== gross && earning.length) out[earning[earning.length - 1].key] += gross - used;
  for (const c of others) out[c.key] = Math.min(c.cap ?? Infinity, Math.round((base(c) * (Number(c.pct) || 0)) / 100));
  const employer = others.filter((c) => c.kind === "employer").reduce((a, c) => a + out[c.key], 0);
  return { components: out, employer, ctc: 12 * (gross + employer) };
}

/**
 * What a person typed, made whole for the pay type: salary gets its components (the template's split unless given) and
 * a CTC (12 × gross and employer contributions unless given); a stipend, fee or retainer is its monthly figure; hourly
 * pay is the rate and the usual hours. Throws a sentence for HR when something does not add up.
 */
export function normaliseFigures(input: Record<string, unknown>, payType: PayType, template: Component[]): Figures {
  if (!PAY_TYPES.includes(payType)) fail("Choose the pay type");
  if (payType === "hourly") {
    const rate = int(input.rate), hours = int(input.hours);
    if (!rate || rate <= 0) fail("Give the hourly rate");
    if (hours !== null && (hours < 1 || hours > 400)) fail("Usual hours a month are between 1 and 400");
    const monthly = hours ? rate! * hours : int(input.monthly) ?? 0;
    return { monthly, ctc: monthly ? 12 * monthly : null, components: {}, rate, hours };
  }
  const monthly = int(input.monthly);
  if (!monthly || monthly <= 0) fail("Give the pay a month");
  if (payType !== "salary") return { monthly: monthly!, ctc: int(input.ctc) ?? 12 * monthly!, components: {} };
  const given = input.components && typeof input.components === "object" ? Object.fromEntries(Object.entries(input.components as Record<string, unknown>).map(([k, v]) => [k, int(v)]).filter(([, v]) => v !== null)) as Record<string, number> : null;
  let components: Record<string, number>, employer: number;
  if (given && Object.keys(given).length) {
    const known = new Map(template.map((c) => [c.key, c]));
    for (const k of Object.keys(given)) if (!known.has(k)) fail(`${k} is not one of the company's pay components`);
    if (Object.values(given).some((v) => v < 0)) fail("Components cannot be negative");
    const earned = template.filter((c) => c.kind === "earning").reduce((a, c) => a + (given[c.key] ?? 0), 0);
    if (earned !== monthly) fail("The earnings components must add up to the pay a month");
    components = given; employer = template.filter((c) => c.kind === "employer").reduce((a, c) => a + (given[c.key] ?? 0), 0);
  } else ({ components, employer } = splitPay(monthly!, template));
  const ctc = int(input.ctc) ?? 12 * (monthly! + employer);
  if (ctc < 12 * monthly!) fail("The yearly CTC is at least twelve months of pay");
  return { monthly: monthly!, ctc, components };
}

/** The company's cost of a version a month: its CTC spread over twelve months, else its monthly figure. */
export const monthlyCost = (f: Figures | null) => (f ? (f.ctc ? Math.round(f.ctc / 12) : f.monthly) : 0);

/** The components as labelled rows for a letter or screen (template order, then any others). */
export function componentRows(f: Figures | null, template: Component[]) {
  if (!f) return [];
  const rows = template.filter((c) => c.kind === "earning" && f.components[c.key]).map((c) => ({ key: c.key, label: c.label, kind: c.kind, amount: f.components[c.key] }));
  const employer = template.filter((c) => c.kind === "employer" && f.components[c.key]).map((c) => ({ key: c.key, label: c.label, kind: c.kind, amount: f.components[c.key] }));
  return [...rows, ...employer];
}

// -------------------------------------------------------------------------------------------- change preview
/** Before and after a change, its cost a month, for the rest of the financial year, and what is owed for months already
 *  paid at the old figures (backdated changes). COMP-B fills the budget line. */
export function previewChange(before: Figures | null, after: Figures, effectiveOn: string, today: string) {
  const costBefore = monthlyCost(before), costAfter = monthlyCost(after);
  const from = effectiveOn > today ? effectiveOn : today;
  const restMonths = Math.max(0, monthsBetween(from, addDays(fyEnd(from), 1)));
  const owed = before ? arrears(before, after, effectiveOn, monthStart(today)) : { amount: 0, months: 0 };
  return {
    before: before ? { monthly: before.monthly, ctc: before.ctc, cost: costBefore } : null,
    after: { monthly: after.monthly, ctc: after.ctc, cost: costAfter },
    diff: { monthly: after.monthly - (before?.monthly ?? 0), cost: costAfter - costBefore, percent: before?.monthly ? Math.round(((after.monthly - before.monthly) / before.monthly) * 1000) / 10 : null },
    restOfYear: { months: Math.round(restMonths * 10) / 10, cost: Math.round((costAfter - costBefore) * restMonths) },
    arrears: owed,
    budget: budgetImpact(),
  };
}
/** Whole and part months from a day (inclusive) to another (exclusive), by days in each month. */
export function monthsBetween(from: string, to: string) {
  let n = 0, d = from;
  while (d < to) {
    const end = monthEnd(d) < addDays(to, -1) ? monthEnd(d) : addDays(to, -1);
    n += (daysBetween(d, end) + 1) / daysInMonth(d);
    d = addDays(end, 1);
  }
  return n;
}
/** The difference owed for the months from a backdated change's date up to `paidUntilExclusive` (the current month's
 *  first day: months before it were paid at the old figures). */
export function arrears(before: Figures, after: Figures, effectiveOn: string, paidUntilExclusive: string) {
  if (effectiveOn >= paidUntilExclusive) return { amount: 0, months: 0 };
  const months = monthsBetween(effectiveOn, paidUntilExclusive);
  return { amount: Math.round((after.monthly - before.monthly) * months), months: Math.round(months * 100) / 100 };
}
/** COMP-B: the running budget's view of a change. Until COMP-B sets a budget there is none to compare with. */
export type BudgetLine = { available: boolean; note: string; [k: string]: unknown };
export function budgetImpact(): BudgetLine {
  return { available: false, note: "No people budget is set yet: the budget arrives with payroll (COMP-B)." };
}

// ------------------------------------------------------------------------------------------- recoveries
/** An advance or loan recovered in equal parts from a month; the last part takes the remainder. */
export function recoverySchedule(amount: number, months: number, from: string) {
  const n = Math.max(1, Math.round(months)), part = Math.floor(amount / n);
  const out: { month: string; amount: number }[] = [];
  let m = monthStart(from);
  for (let i = 0; i < n; i++) { out.push({ month: m, amount: i === n - 1 ? amount - part * (n - 1) : part }); m = nextMonth(m); }
  return out;
}

// ------------------------------------------------------------------------------------------------ a month's pay
export type Version = { effectiveOn: string; payType: PayType; figures: Figures };
export type Pause = { from: string; to: string; paidPercent: number };
export type Item = { kind: string; amount: number; forMonth: string; payout: string; recoverMonths?: number | null; recoverFrom?: string | null; label?: string; id?: string };
export type Claim = { amount: number; forMonth: string; payout: string; label?: string; id?: string };
export const ITEM_LABEL: Record<string, string> = { bonus: "Bonus", incentive: "Incentive", extra: "Extra pay", overtime: "Overtime and night work", arrears: "Arrears", advance: "Advance", loan: "Loan" };

/**
 * One month's pay lines (COMP-B's payroll input): each version's pay for its days in the month (the person's start and
 * last day respected), paused days paid at their share, the month's one-time items and approved claims, and the
 * month's part of any advance or loan recovery.
 */
export function monthPay(p: { month: string; versions: Version[]; start?: string | null; end?: string | null; pauses?: Pause[]; items?: Item[]; claims?: Claim[] }) {
  const first = monthStart(p.month), last = monthEnd(p.month), dim = daysInMonth(first);
  const lines: Line[] = [];
  const vs = [...p.versions].sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn));
  const from = p.start && p.start > first ? p.start : first, to = p.end && p.end < last ? p.end : last;
  for (let i = 0; i < vs.length; i++) {
    const segFrom = vs[i].effectiveOn > from ? vs[i].effectiveOn : from;
    const nextOn = vs[i + 1]?.effectiveOn ?? null;
    const segTo = nextOn && addDays(nextOn, -1) < to ? addDays(nextOn, -1) : to;
    if (segFrom > segTo) continue;
    const days = daysBetween(segFrom, segTo) + 1, f = vs[i].figures;
    const base = vs[i].payType === "hourly" && !f.hours ? 0 : f.monthly;
    lines.push({ label: days === dim ? "Pay" : `Pay for ${days} of ${dim} days`, kind: "earning", amount: Math.round((base * days) / dim), basis: `${segFrom}..${segTo}`, code: "pay" });
    for (const z of p.pauses ?? []) {
      const zf = z.from > segFrom ? z.from : segFrom, zt = z.to < segTo ? z.to : segTo;
      if (zf > zt) continue;
      const zd = daysBetween(zf, zt) + 1, unpaid = (100 - z.paidPercent) / 100;
      if (unpaid > 0) lines.push({ label: `Paused ${zd} ${zd === 1 ? "day" : "days"}${z.paidPercent ? ` at ${z.paidPercent}%` : ""}`, kind: "deduction", amount: -Math.round((base * zd * unpaid) / dim), basis: `${zf}..${zt}`, code: "pause" });
    }
  }
  for (const it of p.items ?? []) {
    if (monthStart(it.forMonth) === first && it.payout === "payroll") lines.push({ label: it.label ?? ITEM_LABEL[it.kind] ?? it.kind, kind: "earning", amount: it.amount, code: `item:${it.kind}`, ref: it.id });
    if (["advance", "loan"].includes(it.kind) && it.recoverMonths && it.recoverFrom) {
      const part = recoverySchedule(it.amount, it.recoverMonths, it.recoverFrom).find((r) => r.month === first);
      if (part) lines.push({ label: `${ITEM_LABEL[it.kind]} recovery`, kind: "deduction", amount: -part.amount, code: `recovery:${it.kind}`, ref: it.id });
    }
  }
  for (const c of p.claims ?? []) if (monthStart(c.forMonth) === first && c.payout === "payroll") lines.push({ label: c.label ?? "Reimbursement", kind: "reimbursement", amount: c.amount, code: "claim", ref: c.id });
  const sum = (k: Line["kind"][]) => lines.filter((l) => k.includes(l.kind)).reduce((a, l) => a + l.amount, 0);
  return { lines, gross: sum(["earning"]), deductions: -sum(["deduction"]), reimbursements: sum(["reimbursement"]), net: sum(["earning", "deduction", "reimbursement"]) };
}

// ------------------------------------------------------------------------------------------- full and final
export type SettlementInput = {
  lastDay: string; figures: Figures | null; basicKey?: string; lastMonthPaid?: boolean;
  encash: { days: number; basis: "basic" | "gross" | "none"; divisor: number };
  notice: { required: number; served: number; mode: "served" | "short_recovered" | "waived" | "paid_in_lieu" };
  items?: { label: string; amount: number }[]; claims?: { label: string; amount: number }[]; recoveries?: { label: string; amount: number }[];
  joinedOn?: string | null; gratuity?: boolean; adjustments?: { label: string; amount: number; reason: string }[];
};
/** The full and final statement: what is paid and what is recovered, each line with how it was worked out. */
export function settlement(s: SettlementInput) {
  const lines: Line[] = [];
  const gross = s.figures?.monthly ?? 0;
  const basic = s.figures?.components?.[s.basicKey ?? "basic"] ?? gross;
  const day = (x: number, div: number) => Math.round(x / div);
  if (!s.lastMonthPaid && s.figures) {
    const days = Number(s.lastDay.slice(8, 10)), dim = daysInMonth(s.lastDay);
    lines.push({ label: `Pay for ${days} of ${dim} days in the last month`, kind: "earning", amount: Math.round((gross * days) / dim), basis: `${monthStart(s.lastDay)}..${s.lastDay}` });
  }
  if (s.encash.basis !== "none" && s.encash.days > 0) {
    const per = day(s.encash.basis === "basic" ? basic : gross, s.encash.divisor);
    lines.push({ label: `Leave encashment, ${s.encash.days} ${s.encash.days === 1 ? "day" : "days"}`, kind: "earning", amount: Math.round(per * s.encash.days), basis: `${s.encash.basis} ÷ ${s.encash.divisor} a day` });
  }
  const short = Math.max(0, s.notice.required - s.notice.served);
  if (s.notice.mode === "short_recovered" && short > 0) lines.push({ label: `Notice not served, ${short} days`, kind: "deduction", amount: -day(gross, 30) * short, basis: "gross ÷ 30 a day" });
  if (s.notice.mode === "paid_in_lieu" && s.notice.required > 0) lines.push({ label: `Pay in lieu of notice, ${s.notice.required} days`, kind: "earning", amount: day(gross, 30) * s.notice.required, basis: "gross ÷ 30 a day" });
  for (const i of s.items ?? []) lines.push({ label: i.label, kind: "earning", amount: i.amount });
  for (const c of s.claims ?? []) lines.push({ label: c.label, kind: "reimbursement", amount: c.amount });
  for (const r of s.recoveries ?? []) lines.push({ label: r.label, kind: "deduction", amount: -Math.abs(r.amount) });
  if (s.gratuity && s.joinedOn) {
    const years = serviceYears(s.joinedOn, s.lastDay);
    if (years >= 5) lines.push({ label: `Gratuity, ${years} years of service`, kind: "earning", amount: Math.round((basic * 15 * years) / 26), basis: "15 days of basic (÷ 26) a year of service" });
  }
  for (const a of s.adjustments ?? []) lines.push({ label: a.label, kind: a.amount < 0 ? "deduction" : "earning", amount: a.amount, basis: a.reason });
  const net = lines.reduce((a, l) => a + l.amount, 0);
  return { lines, net };
}
/** Completed years of service, rounding up a final part year of more than six months (India's gratuity rule). */
export function serviceYears(joined: string, last: string) {
  let years = Number(last.slice(0, 4)) - Number(joined.slice(0, 4));
  if (last.slice(5) < joined.slice(5)) years--;
  const anniversary = `${Number(joined.slice(0, 4)) + years}${joined.slice(4)}`;
  return monthsBetween(anniversary, addDays(last, 1)) > 6 ? years + 1 : years;
}

// ------------------------------------------------------------------------------------- the table's next event
export type PeopleRow = {
  id: string; status?: string; until?: string | null; hasRecord: boolean; current: boolean; stage?: string; lastDay?: string | null;
  offer?: { id: string; status: string; startOn: string; validUntil: string; proposedBy?: string | null; approvedBy?: string | null; hasLetter?: boolean };
  change?: { id: string; kind: string; status: string; effectiveOn: string; proposedBy?: string | null };
  probation?: { from: string; to: string; review?: { id: string; kind: string; dueOn: string }; outcome?: { id: string; action: string; proposedBy?: string | null } };
  pause?: { id: string; status: string; from: string; to: string; paidPercent: number; proposedBy?: string | null };
  items?: number; claims?: number; settlement?: { id: string; status: string; lastDay: string; checkedBy?: string | null }; leavingCase?: string | null;
};
export type NextEvent = { key: string; on: string | null; label: string; tone: "act" | "wait" | "info" };
export type Viewer = { me: string; writer: boolean; approver: boolean };
const KIND: Record<string, string> = { raise: "Raise", cut: "Pay cut", correction: "Correction", promotion: "Promotion", role_change: "Role change", start: "Pay set-up" };
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (d: string | null | undefined) => (d ? `${Number(d.slice(8, 10))} ${SHORT[Number(d.slice(5, 7)) - 1]}` : "");

/** What happens next for a person (the nearest thing to act on first, then the nearest date), in a few words. */
export function nextEvent(r: PeopleRow, today: string, v: Viewer): NextEvent | null {
  const mine = (by?: string | null) => by === v.me;
  if (r.offer) {
    const o = r.offer;
    if (o.status === "draft") return { key: "offer.draft", on: o.startOn, label: "Offer draft: ask a founder", tone: v.writer ? "act" : "info" };
    if (o.status === "proposed") return { key: "offer.proposed", on: o.startOn, label: "Offer waiting for a founder", tone: v.approver && !mine(o.proposedBy) ? "act" : "wait" };
    if (o.status === "approved") return { key: "offer.approved", on: o.startOn, label: "Offer approved: send it", tone: v.approver ? "act" : "wait" };
    if (o.status === "sent") return { key: "offer.sent", on: o.validUntil, label: o.validUntil < today ? "Offer expired" : `Offer sent, open until ${short(o.validUntil)}`, tone: "wait" };
    if (o.status === "accepted") return { key: "offer.accepted", on: o.startOn, label: `Starts ${short(o.startOn)}`, tone: "info" };
  }
  if (r.settlement) {
    const s = r.settlement;
    if (s.status === "draft") return { key: "settlement.draft", on: s.lastDay, label: "Full and final to check", tone: v.writer ? "act" : "wait" };
    if (s.status === "checked") return { key: "settlement.checked", on: s.lastDay, label: "Full and final waiting for a founder", tone: v.approver && !mine(s.checkedBy) ? "act" : "wait" };
    if (s.status === "approved") return { key: "settlement.approved", on: s.lastDay, label: "Full and final approved: issue the letter", tone: v.writer || v.approver ? "act" : "wait" };
  }
  if (r.change?.status === "proposed") return { key: "change.proposed", on: r.change.effectiveOn, label: `${KIND[r.change.kind] ?? "Change"} waiting for approval`, tone: v.approver && !mine(r.change.proposedBy) ? "act" : "wait" };
  if (r.pause?.status === "proposed") return { key: "pause.proposed", on: r.pause.from, label: "Pause waiting for approval", tone: v.approver && !mine(r.pause.proposedBy) ? "act" : "wait" };
  if (r.probation?.outcome) return { key: "probation.outcome", on: r.probation.to, label: `Probation ${r.probation.outcome.action} waiting for a founder`, tone: v.approver && !mine(r.probation.outcome.proposedBy) ? "act" : "wait" };
  if (r.claims) return { key: "claims", on: null, label: `${r.claims} ${r.claims === 1 ? "claim" : "claims"} to review`, tone: "act" };
  if (r.items) return { key: "items", on: null, label: `${r.items} one-time ${r.items === 1 ? "item" : "items"} waiting`, tone: v.approver ? "act" : "wait" };
  if (r.change?.status === "draft") return { key: "change.draft", on: r.change.effectiveOn, label: `${KIND[r.change.kind] ?? "Change"} draft`, tone: v.writer ? "act" : "info" };
  if (r.leavingCase && !r.settlement) return { key: "settlement.none", on: r.lastDay ?? null, label: `Leaving ${short(r.lastDay)}: prepare the full and final`, tone: v.writer ? "act" : "wait" };
  const dated: NextEvent[] = [];
  if (r.probation) {
    const soon = daysBetween(today, r.probation.to) <= 21;
    dated.push({ key: "probation.ends", on: r.probation.to, label: `Probation ends ${short(r.probation.to)}`, tone: soon ? "act" : "info" });
    if (r.probation.review && r.probation.review.dueOn <= today) dated.push({ key: "probation.review", on: r.probation.review.dueOn, label: "Probation review due", tone: "act" });
  }
  if (r.change?.status === "approved") dated.push({ key: "change.scheduled", on: r.change.effectiveOn, label: `${KIND[r.change.kind] ?? "Change"} from ${short(r.change.effectiveOn)}`, tone: "info" });
  if (r.pause?.status === "approved") dated.push(r.pause.from > today ? { key: "pause.scheduled", on: r.pause.from, label: `Pause from ${short(r.pause.from)}`, tone: "info" }
    : { key: "pause.running", on: r.pause.to, label: `Paused until ${short(r.pause.to)}`, tone: "info" });
  if (r.lastDay && r.lastDay >= today && r.status === "notice") dated.push({ key: "last.day", on: r.lastDay, label: `Last day ${short(r.lastDay)}`, tone: "info" });
  dated.sort((a, b) => (a.tone === "act" ? -1 : 0) - (b.tone === "act" ? -1 : 0) || String(a.on).localeCompare(String(b.on)));
  if (dated.length) return dated[0];
  if (!r.offer && ["candidate", "offer"].includes(r.stage ?? "")) return { key: "candidate", on: null, label: "Candidate: draft the offer", tone: v.writer ? "act" : "info" };
  if (!r.hasRecord) return r.current ? { key: "setup", on: null, label: "No pay record yet", tone: "info" } : null;
  return null;
}

export type Action = { key: string; label: string };
/** The one thing the viewer can do for a row (People & pay: one primary action per row). */
export function primaryAction(r: PeopleRow, e: NextEvent | null, v: Viewer): Action | null {
  const self = r.id === v.me;
  if (self) return null;
  switch (e?.key) {
    case "offer.draft": return v.writer ? { key: "offer.propose", label: "Ask a founder" } : null;
    case "offer.proposed": return v.approver && r.offer?.proposedBy !== v.me ? { key: "offer.approve", label: "Review offer" } : null;
    case "offer.approved": return v.approver ? { key: "offer.send", label: "Send offer" } : null;
    case "change.proposed": return v.approver && r.change?.proposedBy !== v.me ? { key: "change.approve", label: "Review change" } : null;
    case "pause.proposed": return v.approver && r.pause?.proposedBy !== v.me ? { key: "pause.approve", label: "Review pause" } : null;
    case "probation.outcome": return v.approver && r.probation?.outcome?.proposedBy !== v.me ? { key: "probation.approve", label: "Review probation" } : null;
    case "claims": return { key: "claims", label: "Review claim" };
    case "items": return v.approver ? { key: "items", label: "Review items" } : null;
    case "settlement.draft": case "settlement.none": return v.writer ? { key: "settlement", label: "Full and final" } : null;
    case "settlement.checked": return v.approver && r.settlement?.checkedBy !== v.me ? { key: "settlement", label: "Approve full and final" } : null;
    case "settlement.approved": return v.writer || v.approver ? { key: "settlement", label: "Issue letter" } : null;
    case "probation.ends": case "probation.review": return v.writer ? { key: "probation", label: "Confirm probation" } : null;
    case "setup": return v.writer ? { key: "setup", label: "Set up pay" } : null;
    case "candidate": return v.writer ? { key: "offer", label: "Draft offer" } : null;
  }
  return v.writer && r.hasRecord && r.status !== "ended" ? { key: "change", label: "Change pay" } : null;
}

// ------------------------------------------------------------------------------------- set-up from records
type Setup = { id: string; amount: number; on: string; payType: PayType; source: string; note?: string | null };
/** From imported salary rows: the latest settled monthly figure (an invoice row makes a contractor's), and a proposed
 *  one newer than it (the offer draft). Amounts in paise. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setupPlan(rows: Record<string, any>[]): { start: Setup | null; offer: Setup | null } {
  const on = (x: Record<string, any>) => String(x.effectiveFrom ?? x.month).slice(0, 10);
  const settled = rows.filter((x) => (["monthly", "current"].includes(x.kind) && !["proposed", "conditional"].includes(x.termsStatus)) || (x.kind === "invoice" && x.termsStatus === "settled"))
    .sort((a, b) => on(b).localeCompare(on(a)) || (a.kind === "current" ? -1 : 1));
  const proposed = rows.filter((x) => ["monthly", "current"].includes(x.kind) && x.termsStatus === "proposed").sort((a, b) => on(b).localeCompare(on(a)));
  const s = settled[0] ?? null, p = proposed[0] ?? null;
  const paise = (x: Record<string, any>) => Math.round(Number(x.amount) * 100);
  return {
    start: s ? { id: s.id, amount: paise(s), on: monthStart(on(s)), payType: s.kind === "invoice" ? "contractor" : "salary", source: String(s.sourceName ?? "") } : null,
    offer: p && (!s || on(p) > on(s)) ? { id: p.id, amount: paise(p), on: on(p), payType: "salary", source: String(p.sourceName ?? ""), note: p.termsNote ?? null } : null,
  };
}
