// FIX-PEOPLE-MONEY C4 (owner, 10 Nov 2026: "The charts don't mean anything as placed. Redesign it as a meaningful
// dashboard based on proper finance practice"): the six questions an owner asks of the books, from the finance model
// (finance mail, the bank lines, the cost sheet) and the Billing numbers. Pure, so it is unit-tested:
//   1. Cash: how much is in the bank, and how fresh that figure is.
//   2. Others owe us: unpaid invoices, by how late (0–30, 31–60, 61–90, 90+ days).
//   3. We owe: salaries for the month, renewals in the next 30 days, the next GST return.
//   4. This month: revenue less expenses (people first) = profit or loss, for the latest month with both figures.
//   5. Burn and runway: average monthly cash out, and how many months the cash lasts.
//   6. Tax due: the next GST returns and any late ones.
// A figure Pulse cannot stand behind says so ("383 days old", "Not known yet") instead of showing a wrong number.

const STALE_DAYS = 45;
const BUCKETS = [["0–30", /^0/], ["31–60", /^31/], ["61–90", /^61/], ["90+", /^90/]];
const PEOPLE = /payroll|salar|people|staff|hr\b/i;
const SOFTWARE = /software|ai\b|tools|saas/i;
const RENT = /rent|office &|office and|utilities/i;
const MARKETING = /marketing|ad spend|ads\b/i;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym) => `${MON[Number(String(ym).slice(5, 7)) - 1] ?? ""} ${String(ym).slice(0, 4)}`.trim();
const monthAfter = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };

/** Cash in the bank: the latest balance and its age; stale after 45 days (the rule the Collected tile uses). */
export function cashOf(m) {
  const b = m?.burn?.balance ?? null;
  if (!b || num(b.amount) === null) return { known: false, amount: null, asOf: null, ageDays: null, stale: true };
  const ageDays = num(b.ageDays) ?? 0;
  return { known: true, amount: b.amount, asOf: b.asOf ?? null, ageDays, stale: ageDays > STALE_DAYS };
}

/** Unpaid invoices and their ageing, always in the four standard buckets (empty ones as 0). */
export function receivablesOf(m) {
  const c = m?.collections;
  const rows = c?.overdue?.buckets ?? [];
  const buckets = BUCKETS.map(([label, re]) => {
    const hit = rows.find((b) => re.test(String(b.bucket ?? "").trim()));
    return { label, amount: num(hit?.amount) ?? 0, count: num(hit?.count) ?? 0 };
  });
  const amount = num(c?.outstanding?.amount) ?? buckets.reduce((n, b) => n + b.amount, 0);
  const count = num(c?.outstanding?.count) ?? buckets.reduce((n, b) => n + b.count, 0);
  const late = buckets.slice(1).reduce((n, b) => n + b.amount, 0);
  // The clients who owe the most (all their late invoices together), largest first.
  const byClient = new Map();
  for (const i of c?.overdue?.top ?? []) { const k = i.client ?? "A client", was = byClient.get(k); byClient.set(k, { client: k, amount: (was?.amount ?? 0) + (num(i.total) ?? 0), ageDays: Math.max(was?.ageDays ?? 0, num(i.ageDays) ?? 0), invoices: (was?.invoices ?? 0) + 1 }); }
  const top = [...byClient.values()].sort((a, b) => b.amount - a.amount).slice(0, 3);
  const confirmed = num(c?.overdue?.confirmed?.amount) ?? 0;
  return { amount, count, buckets, late, veryLate: buckets[3].amount, top, confirmed };
}

/** What the company owes soon: the month's salaries (last payroll total), renewals in 30 days, the next GST return. */
export function payablesOf(m, today) {
  const rows = [];
  const pay = (m?.payroll ?? []).filter((p) => num(p.total)).at(-1);
  if (pay) rows.push({ key: "salaries", label: "Salaries", amount: pay.total, when: `${monthAfter(String(today).slice(0, 7))}-01`, note: `${pay.people ? `${pay.people} people, ` : ""}as in ${monthLabel(pay.month)}` });
  const renewals = m?.software?.renewals30 ?? [];
  // Renewals bill in their own currency (Netlify in USD): only rupee ones add up; the rest are counted.
  const renewalTotal = renewals.filter((v) => !v.currency || v.currency === "INR").reduce((n, v) => n + (num(v.lastAmount) ?? 0), 0);
  if (renewals.length) rows.push({ key: "renewals", label: `${renewals.length} renewal${renewals.length === 1 ? "" : "s"}`, amount: renewalTotal || null, when: renewals.map((v) => v.nextRenewal).filter(Boolean).sort()[0] ?? null, note: renewals.slice(0, 2).map((v) => v.vendor).join(", ") });
  const gst = taxOf(m, today).next;
  if (gst && gst.inDays <= 30) rows.push({ key: "gst", label: gst.what.replace(/ for .*$/, ""), amount: null, when: gst.due, note: gst.what.replace(/^[^ ]+ for /, "For ") });
  const amount = rows.reduce((n, r) => n + (r.amount ?? 0), 0);
  return { rows, amount };
}

/** The latest month with both revenue and expenses: revenue less expenses, people first, then the other groups. */
export function monthOf(m) {
  const rev = new Map((m?.revenue?.months ?? []).map((r) => [r.month, num(r.revenue) ?? num(r.invoiced)]));
  const exp = (m?.expenses?.months ?? []).filter((e) => num(e.total) !== null && rev.get(e.month) !== null && rev.get(e.month) !== undefined);
  const last = exp.at(-1);
  if (!last) return null;
  const revenue = rev.get(last.month) ?? 0, expenses = last.total;
  const groups = { People: 0, "Software & AI": 0, "Rent & office": 0, Marketing: 0, Other: 0 };
  for (const [k, v] of Object.entries(last.byCategory ?? {})) {
    const a = num(v) ?? 0;
    const g = PEOPLE.test(k) ? "People" : SOFTWARE.test(k) ? "Software & AI" : RENT.test(k) ? "Rent & office" : MARKETING.test(k) ? "Marketing" : "Other";
    groups[g] += a;
  }
  const sum = Object.values(groups).reduce((n, v) => n + v, 0);
  if (sum < expenses) groups.Other += expenses - sum;
  const lines = Object.entries(groups).filter(([, v]) => v > 0).map(([label, amount]) => ({ label, amount, share: expenses ? amount / expenses : 0 }));
  const profit = revenue - expenses;
  return { month: last.month, revenue, expenses, profit, margin: revenue ? profit / revenue : null, lines, people: groups.People };
}

/** Burn (average net cash out a month) and runway, with the last six months of net for the line. */
export function burnOf(m) {
  const b = m?.burn ?? {};
  const rev = new Map((m?.revenue?.months ?? []).map((r) => [r.month, num(r.revenue) ?? num(r.invoiced)]));
  const series = (m?.expenses?.months ?? []).filter((e) => num(e.total) !== null && rev.has(e.month)).slice(-6).map((e) => ({ month: e.month, net: (rev.get(e.month) ?? 0) - e.total }));
  // The headline is the average of the last three bars, so the figure and the bars always agree; without months of
  // both figures, the finance model's own average.
  const last3 = series.slice(-3);
  const net = last3.length ? last3.reduce((n, s) => n + s.net, 0) / last3.length : num(b.net);
  const burn = net !== null && net < 0 ? -net : 0;
  const runway = num(b.runwayMonths);
  return { burn, earning: net !== null && net > 0 ? net : 0, avgCost: num(b.avgMonthlyCost), runway, note: runway === null ? (b.runwayNote ? "Needs a recent bank balance" : "Not known yet") : null, series };
}

/** The next GST returns (earliest first) and any filed late or not filed. */
export function taxOf(m, today) {
  const c = m?.compliance ?? {};
  const upcoming = (c.upcoming ?? []).filter((u) => u?.due).slice().sort((a, b) => String(a.due).localeCompare(String(b.due)));
  const late = (c.late ?? []).map(String);
  // A quarter not filed ("Jul 2026–Sep 2026"): GSTR-1 was due on the 13th of the month after it.
  const missing = (c.gaps ?? []).map(String).map((label) => {
    const end = /([A-Z][a-z]{2}) (\d{4})$/.exec(label), i = end ? MON.indexOf(end[1]) : -1;
    const due = i < 0 ? null : i === 11 ? `${Number(end[2]) + 1}-01-13` : `${end[2]}-${String(i + 2).padStart(2, "0")}-13`;
    return { label, due };
  });
  const t = String(today).slice(0, 10);
  const days = (d) => Math.round((Date.parse(d) - Date.parse(t)) / 864e5);
  const list = upcoming.slice(0, 3).map((u) => ({ what: String(u.what), due: String(u.due), inDays: days(String(u.due)) }));
  return { list, next: list[0] ?? null, late, missing };
}

/** Everything the dashboard shows, from the finance model (`m`, may be null) and today (YYYY-MM-DD). */
export function dashboardOf(m, today) {
  return { cash: cashOf(m), receivables: receivablesOf(m), payables: payablesOf(m, today), month: monthOf(m), burn: burnOf(m), tax: taxOf(m, today),
    certified: Boolean(m?.certified), asOf: m?.asOf ?? null };
}
