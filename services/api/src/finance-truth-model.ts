// FINANCE-TRUTH (owner, 4 Nov 2026; Kazuk, meeting lines 1457-1460, 1646, 1907-1916): the arithmetic of Finance →
// Numbers, kept apart from the routes so it is tested on its own (test/finance-truth-model.test.mjs). The database
// (db/migrations/1480_finance_truth.sql) gives each month's parts in paise; this adds HR cost from locked payroll,
// totals the period and writes, for every number, where it comes from in plain words.

export type Period = "month" | "last" | "quarter" | "fy" | "lastfy" | "custom";
export const PERIODS: readonly Period[] = ["month", "last", "quarter", "fy", "lastfy"];

type Money = number;
export type MonthRaw = {
  month: string;
  invoiced: { count: number; taxable: Money; gst: Money; total: Money };
  credited: { count: number; taxable: Money; gst: Money; total: Money };
  receipts: { count: number; base: Money; gstInGstAccount: Money; gstInMain: Money; tds: Money; cash: Money; over?: Money };
  /** Refunds paid to clients (Cash book), net of GST: taken off revenue, not spending. */
  refunds?: { lines: number; net: Money };
  paidInvoices: number;
  bankLines: { lines: number; client: Money; other: Money } | null;
  book: { lines: number; total: Money; intoGst: Money };
  spend: { lines: number; net: Money; gst: Money; salaries: Money; taxes: Money; categories: { category: string; net: Money; lines: number }[] };
};
export type NumbersRaw = {
  from: string; to: string; today: string; bank: boolean; accounts: string[]; gstAccount: string | null; canSetAccount: boolean; bankEnd: string | null;
  months: MonthRaw[]; unpaidBills: { count: number; total: Money };
  outstanding: { invoices: number; base: Money; gst: Money; gstInvoices: number; items: { id: string; number: string; issueDate: string; dueDate: string | null; buyer: string | null; baseDue: Money; gstDue: Money; total: Money }[] };
  /** id null: quotations and invoices with no salesperson (an invoice Billing made without a quotation behind it). */
  salespeople: { id: string | null; name: string; quotes: number; quoted: Money; invoiced: Money; revenue: Money }[];
  /** Payments that do not say which account they arrived in, on invoices whose GST is still due. */
  unsaidPayments?: { count: number; items: { id: string; documentId: string; number: string; receivedOn: string; amount: Money; buyer: string | null }[] };
};
/** Locked payroll by month (salaries and employer contributions, paise); null when the viewer may not read pay. */
export type PayrollMonths = Record<string, Money> | null;

const n = (x: unknown) => (Number.isFinite(Number(x)) ? Math.round(Number(x)) : 0);
const pad = (x: number) => String(x).padStart(2, "0");
const ym = (y: number, m: number) => { const d = new Date(Date.UTC(y, m, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The months a period covers, on the company's calendar day `today` (India's financial year runs April to March). */
export function periodRange(period: string | undefined, today: string, from?: string, to?: string): { period: Period; from: string; to: string } {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)) - 1, fy = m >= 3 ? y : y - 1;
  if (from && to && MONTH.test(from) && MONTH.test(to)) return from <= to ? { period: "custom", from, to } : { period: "custom", from: to, to: from };
  switch (period) {
    case "last": return { period: "last", from: ym(y, m - 1), to: ym(y, m - 1) };
    case "quarter": return { period: "quarter", from: ym(y, m - 2), to: ym(y, m) };
    case "lastfy": return { period: "lastfy", from: `${fy - 1}-04`, to: `${fy}-03` };
    case "month": return { period: "month", from: ym(y, m), to: ym(y, m) };
    default: return { period: "fy", from: `${fy}-04`, to: ym(y, m) };
  }
}

/** HR cost per month from the payroll ledger totals (COMP-B): salaries and employer contributions, debit side. */
export function payrollMonths(totals: { month: string; account: string; side: string; amount: number }[] | null): PayrollMonths {
  if (!totals) return null;
  const out: Record<string, Money> = {};
  for (const t of totals) if (["salaries", "employer_contributions"].includes(t.account) && t.side === "debit") out[t.month] = (out[t.month] ?? 0) + n(t.amount);
  return out;
}

export type Source = { what: string; from: string; note?: string };
export type MonthRow = {
  month: string; revenue: Money; invoiced: Money; gstBilled: Money; gstToGstAccount: Money; gstToMain: Money; collected: Money | null;
  collectedFrom: "bank" | "book" | null; otherIn: Money; expenses: Money; hr: Money; hrFrom: "payroll" | "book" | null; net: Money; paidInvoices: number; payments: number;
  refunds: Money; overpaid: Money;
};

/** One period's numbers: month rows, the totals and the source of each figure. */
export function buildNumbers(raw: NumbersRaw, payroll: PayrollMonths) {
  const months: MonthRow[] = raw.months.map((m) => {
    const bank = raw.bank && m.bankLines ? m.bankLines : null;
    const pay = payroll?.[m.month];
    // A locked payroll is the month's HR cost; the Cash book's salary lines that month are the same money paid out.
    const hrFrom = pay !== undefined && pay > 0 ? "payroll" as const : n(m.spend.salaries) > 0 ? "book" as const : null;
    const hr = hrFrom === "payroll" ? n(pay) : n(m.spend.salaries);
    const expenses = n(m.spend.net) - n(m.spend.salaries) + hr;
    // A refund paid back to a client undoes revenue; it is not an operating expense.
    const refunds = n(m.refunds?.net), revenue = n(m.receipts.base) - refunds;
    const collected = bank ? n(bank.client) : m.book.lines ? n(m.book.total) : null;
    return {
      month: m.month, revenue, invoiced: n(m.invoiced.taxable) - n(m.credited.taxable), gstBilled: n(m.invoiced.gst) - n(m.credited.gst),
      gstToGstAccount: n(m.receipts.gstInGstAccount), gstToMain: n(m.receipts.gstInMain),
      collected, collectedFrom: bank ? "bank" : m.book.lines ? "book" : null, otherIn: bank ? n(bank.other) : 0,
      expenses, hr, hrFrom, net: revenue - expenses, paidInvoices: n(m.paidInvoices), payments: n(m.receipts.count),
      refunds, overpaid: n(m.receipts.over),
    };
  });
  const sum = (k: keyof MonthRow) => months.reduce((a, r) => a + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
  const bankMonths = months.filter((r) => r.collectedFrom === "bank").map((r) => r.month), bookMonths = months.filter((r) => r.collectedFrom === "book").map((r) => r.month);
  const payrollMonthsUsed = months.filter((r) => r.hrFrom === "payroll").map((r) => r.month), bookHr = months.filter((r) => r.hrFrom === "book").map((r) => r.month);
  const tds = raw.months.reduce((a, m) => a + n(m.receipts.tds), 0), taxes = raw.months.reduce((a, m) => a + n(m.spend.taxes), 0);
  const inputGst = raw.months.reduce((a, m) => a + n(m.spend.gst), 0), intoGstBook = raw.months.reduce((a, m) => a + n(m.book.intoGst), 0);
  const spendLines = raw.months.reduce((a, m) => a + n(m.spend.lines), 0);
  const categories = new Map<string, Money>();
  for (const m of raw.months) for (const c of m.spend.categories ?? []) if (!/salar|payroll/i.test(c.category)) categories.set(c.category, (categories.get(c.category) ?? 0) + n(c.net));
  const hrTotal = sum("hr");
  if (hrTotal) categories.set("HR (salaries)", hrTotal);
  const totals = {
    revenue: sum("revenue"), invoiced: sum("invoiced"), gstBilled: sum("gstBilled"), gstToGstAccount: sum("gstToGstAccount"), gstToMain: sum("gstToMain"),
    collected: months.some((r) => r.collected !== null) ? sum("collected") : null, otherIn: sum("otherIn"), expenses: sum("expenses"), hr: hrTotal,
    net: sum("revenue") - sum("expenses"), paidInvoices: sum("paidInvoices"), payments: sum("payments"), tds, taxes, inputGst, refunds: sum("refunds"), overpaid: sum("overpaid"),
    gstOutstanding: n(raw.outstanding.gst), baseOutstanding: n(raw.outstanding.base),
  };
  const list = (ms: string[]) => (ms.length === months.length ? "every month" : ms.length ? ms.map(monthLabel).join(", ") : "no month");
  const sources: Record<string, Source> = {
    revenue: { what: "Revenue, net of GST", from: `What clients paid on invoices in Billing, without the GST: the base part of each payment (with any TDS the client deducted), counted in the month the money arrived. ${totals.payments} payment${totals.payments === 1 ? "" : "s"}; ${totals.paidInvoices} invoice${totals.paidInvoices === 1 ? "" : "s"} fully paid.`,
      note: [totals.invoiced ? `Invoiced in the period (net of GST and credit notes): ${inr(totals.invoiced)}. Revenue counts only what is paid.` : "No invoices were issued in the period.",
        totals.refunds ? `Refunds paid to clients (Cash book, without GST) are taken off: ${inr(totals.refunds)}.` : "",
        totals.overpaid ? `${inr(totals.overpaid)} was paid beyond what the invoices ask for after their credit notes: it is a refund due, counted as neither revenue nor GST.` : ""].filter(Boolean).join(" ") },
    collected: { what: "Collections", from: raw.bank
      ? `Client receipts on the bank statement lines for ${list(bankMonths)}${bookMonths.length ? `; for ${list(bookMonths)}, money received typed in the Cash book` : ""}. Bank lines include GST when the client paid it to the same account, and do not say which account they are, so the GST account's share is told from Billing's payments.`
      : `Money received typed in the Cash book for ${list(bookMonths)}. Bank statement lines are for leadership with the finance amount grants.`,
      note: totals.otherIn ? `Other bank credits (not from clients) in the period: ${inr(totals.otherIn)}.` : raw.bankEnd ? `Bank lines end ${raw.bankEnd}.` : undefined },
    gst: { what: "GST", from: `GST billed is the GST on invoices issued in the period, less credit notes. Received is GST paid on those invoices${raw.gstAccount ? `: into ${raw.gstAccount} (the GST account), or with the base into another account` : "; name the GST account so GST paid there is told apart"}. Still to receive is the GST due on every issued invoice today.`,
      note: [taxes ? `Taxes and GST paid to the government (Cash book, “Taxes & GST”): ${inr(taxes)}. Kept out of expenses.` : "", intoGstBook ? `Money received into the GST account in the Cash book: ${inr(intoGstBook)}.` : "",
        raw.unsaidPayments?.count ? `${raw.unsaidPayments.count} payment${raw.unsaidPayments.count === 1 ? " does" : "s do"} not say which account ${raw.unsaidPayments.count === 1 ? "it" : "they"} arrived in, on invoices with GST still due: each counts as the main account until Billing says otherwise.` : ""].filter(Boolean).join(" ") || undefined },
    expenses: { what: "Expenses, net of GST", from: `Cash book spending (expenses, and paid bills in the month they were written), without the input GST, ${spendLines} entr${spendLines === 1 ? "y" : "ies"}; plus HR cost: ${payroll === null ? "locked payroll needs the salary permission, so the Cash book’s salary entries are used" : payrollMonthsUsed.length ? `locked payroll (salaries and employer contributions) for ${list(payrollMonthsUsed)}` : "no locked payroll in the period"}${bookHr.length && payroll !== null ? `; the Cash book’s salary entries for ${list(bookHr)}` : ""}.`,
      note: raw.unpaidBills.count ? `${raw.unpaidBills.count} unpaid bill${raw.unpaidBills.count === 1 ? "" : "s"} (${inr(raw.unpaidBills.total)}) are not counted until paid.` : undefined },
    net: { what: "Net", from: "Revenue net of GST, less expenses net of GST (HR cost included). GST is not income: it is owed to the government." },
    outstanding: { what: "Still to collect", from: `Every issued invoice’s balance today, base and GST apart: ${raw.outstanding.invoices} invoice${raw.outstanding.invoices === 1 ? "" : "s"}, ${raw.outstanding.gstInvoices} with GST still to come.` },
  };
  return {
    from: raw.from, to: raw.to, today: raw.today, months, totals, sources, categories: [...categories.entries()].map(([category, net]) => ({ category, net })).sort((a, b) => b.net - a.net),
    access: { bank: raw.bank, payroll: payroll !== null, setAccount: raw.canSetAccount }, accounts: raw.accounts, gstAccount: raw.gstAccount, bankEnd: raw.bankEnd,
    outstanding: raw.outstanding, salespeople: raw.salespeople, unsaidPayments: raw.unsaidPayments ?? { count: 0, items: [] },
    // Nothing happened in the period (what is still due today is shown either way).
    empty: !months.some((r) => r.revenue || r.invoiced || r.collected || r.expenses || r.gstBilled || r.gstToGstAccount || r.gstToMain),
  };
}

const NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (m: string) => `${NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
/** Paise as rupees the Indian way, no paise. */
export const inr = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
