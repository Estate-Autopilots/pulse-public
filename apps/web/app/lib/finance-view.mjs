// FINANCE-UI (10 Oct 2026): what the Finance pages show, worked out from the live finance model (FIN-LIVE) so the
// pages only lay it out. Founders read lakh and crore; every figure keeps the confidence the model gave it; a figure
// the sources cannot support says what is missing and who supplies it instead of guessing.

/** ₹1,23,456 → ₹1.23 L; ₹1,23,45,678 → ₹1.23 Cr. Other currencies keep their own symbol. */
export function inr(value, currency = "INR") {
  if (value === null || value === undefined || value === "") return "Unknown";
  const n = Number(value);
  if (!Number.isFinite(n)) return "Unknown";
  if (currency !== "INR") return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
  const sign = n < 0 ? "−" : "", a = Math.abs(n);
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)} L`;
  return `${sign}₹${a.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/** Axis ticks and bar ends: one decimal at most (₹9.5 L, ₹1.2 Cr, ₹40k). */
export function inrShort(value) {
  const sign = value < 0 ? "−" : "", a = Math.abs(value);
  const one = (x) => (Math.round(x * 10) / 10).toLocaleString("en-IN", { maximumFractionDigits: 1 });
  if (a >= 1e7) return `${sign}₹${one(a / 1e7)} Cr`;
  if (a >= 1e5) return `${sign}₹${one(a / 1e5)} L`;
  if (a >= 1e3) return `${sign}₹${Math.round(a / 1e3)}k`;
  return `${sign}₹${Math.round(a)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const utc = (m) => new Date(`${String(m).slice(0, 7)}-01T00:00:00Z`);
const mon = (m) => MONTHS[Number(String(m).slice(5, 7)) - 1] ?? "?";
/** "Sep 2026" (written out by hand: en-IN prints "Sept"). */
export const monthName = (m) => `${mon(m)} ${String(m).slice(0, 4)}`;
/** Axis label: "Sep", with the year on January so a reader knows where a year turns. */
export const monthTick = (m) => mon(m) + (String(m).slice(5, 7) === "01" ? ` ${String(m).slice(2, 4)}` : "");
/** "13 Oct 2026". */
export const dayName = (d) => d ? `${Number(String(d).slice(8, 10))} ${mon(d)} ${String(d).slice(0, 4)}` : "Unknown";
export const ago = (iso, now = Date.now()) => {
  if (!iso) return "never";
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  return minutes < 60 ? `${minutes} min ago` : minutes < 2880 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
};
export const pct = (x, digits = 0) => x === null || x === undefined || !Number.isFinite(x) ? "Unknown" : `${x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(digits)}%`;
export const prevMonth = (m) => { const d = utc(m); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
/** `n` consecutive months ending with `last`, oldest first. */
export const monthsEnding = (last, n) => { const out = [String(last).slice(0, 7)]; while (out.length < n) out.unshift(prevMonth(out[0])); return out; };
/** "Jul–Sep 2026", or "Nov 2025–Jan 2026" across a year. */
export const monthSpan = (months) => {
  if (!months?.length) return "";
  const [a, b] = [months[0], months.at(-1)];
  if (a === b) return monthName(a);
  return a.slice(0, 4) === b.slice(0, 4) ? `${mon(a)}–${monthName(b)}` : `${monthName(a)}–${monthName(b)}`;
};
/** Who supplies a missing source, without the explanation: "Kazuk: Axis export (or CA …)" → "Kazuk". */
export const supplier = (who) => String(who ?? "").split(/[:(]/)[0].trim() || "Finance";

/** The last complete month before the model's as-of date. */
export const lastFullMonth = (asOf) => prevMonth(String(asOf).slice(0, 7));

const missingAbout = (m, re) => (m.missing ?? []).find((x) => re.test(x.what));
/** "Upload Axis statements after 7 Oct 2025 — Kazuk": what a view needs and who supplies it. */
export function statementNeed(m) {
  const end = m.collections?.evidenceEnd ?? m.reconcile?.evidenceEnd;
  const gap = missingAbout(m, /bank statement/i);
  return { what: end ? `Upload Axis statements after ${dayName(end)}` : "Upload the Axis bank statements", who: supplier(gap?.who ?? "Your finance owner"), detail: gap?.who ?? null, impact: gap?.impact ?? null };
}

/** Revenue and costs month by month over `n` months ending with the last complete month. Unknown stays null. */
export function trend(m, n = 18) {
  const last = lastFullMonth(m.asOf);
  const rev = new Map((m.revenue?.months ?? []).map((r) => [r.month, r]));
  const cost = new Map((m.expenses?.months ?? []).map((r) => [r.month, r]));
  return monthsEnding(last, n).map((month) => {
    const r = rev.get(month), c = cost.get(month);
    const revenue = r && r.revenue !== null && r.revenue !== undefined ? Number(r.revenue) : null;
    return { month, revenue, bank: !!r && revenue !== null && !r.invoices, revenueBasis: r?.revenueBasis ?? null, revenueConfidence: r?.confidence ?? null,
      cost: c ? Number(c.total) : null, costConfidence: c?.confidence ?? null };
  });
}

const latest = (rows, pick) => { for (let i = rows.length - 1; i >= 0; i--) if (pick(rows[i]) !== null && pick(rows[i]) !== undefined) return i; return -1; };

/** The six Overview tiles. A tile the sources cannot fill says what is needed instead. */
export function kpis(m) {
  const last = lastFullMonth(m.asOf), now = String(m.asOf).slice(0, 7);
  const rev = (m.revenue?.months ?? []).filter((r) => r.month <= last);
  const ri = latest(rev, (r) => (r.revenue === null || r.revenue === undefined || !r.invoices && !r.collected ? null : r.revenue));
  const r = rev[ri], rp = ri > 0 ? rev[ri - 1] : null;
  const thisMonth = (m.revenue?.months ?? []).find((x) => x.month === now);
  const spark = (rows, key) => rows.slice(-12).map((x) => Math.max(0, Number(x[key]) || 0));
  const allRev = m.revenue?.months ?? [];
  const end = m.collections?.evidenceEnd;
  // A month the bank lines only partly cover would understate what came in: use the last fully covered month.
  const covered = allRev.filter((x) => !end || x.month < String(end).slice(0, 7));
  const col = covered[latest(covered, (x) => x.collected)];
  const od = m.collections?.overdue ?? { amount: 0, count: 0, confirmed: { count: 0 } };
  const exp = m.expenses?.months ?? [], e = exp.at(-1), ep = exp.at(-2);
  const payroll = e ? Object.entries(e.byCategory ?? {}).find(([k]) => /payroll/i.test(k))?.[1] : null;
  const burn = m.burn ?? {};
  const need = statementNeed(m);
  const bal = burn.balance, fresh = bal && bal.ageDays <= 35;
  const balanceWho = supplier(missingAbout(m, /balance/i)?.who ?? need.who);
  return [
    r ? { key: "revenue", label: `Revenue · ${monthName(r.month)}`, value: inr(r.revenue), delta: rp && rp.revenue ? { value: Number(r.revenue), previous: Number(rp.revenue) } : null,
      spark: spark(rev, "revenue"), note: thisMonth?.invoiced ? `${monthName(now).split(" ")[0]} so far ${inr(thisMonth.invoiced)}` : r.invoices ? "Invoiced, ex-GST" : "Bank credits, incl. GST", confidence: r.confidence ?? "medium", href: "/finance?tab=income" }
      : { key: "revenue", label: "Revenue", value: "No invoices yet", note: "Zoho invoices reach finance mail", confidence: "low", href: "/finance?tab=income" },
    col ? { key: "collected", label: `Collected · ${monthName(col.month)}`, value: inr(col.collected), note: end ? `Bank lines end ${dayName(end)}` : "From bank lines", tone: end && Date.parse(m.asOf) - Date.parse(end) > 45 * 864e5 ? "warning" : undefined, confidence: col.collectedConfidence ?? "medium", href: "/finance?tab=reconcile" }
      : { key: "collected", label: "Collected", value: "Statement needed", note: `${need.what} — ${need.who}`, tone: "warning", confidence: "low", href: "/finance?tab=reconcile" },
    { key: "overdue", label: "Overdue", value: inr(od.amount), note: `${od.count} invoices · ${od.confirmed?.count ?? 0} confirmed unpaid`, tone: od.amount ? "warning" : undefined, confidence: "medium", href: "/finance?tab=revenue" },
    e ? { key: "costs", label: `Costs · ${monthName(e.month)}`, value: inr(e.total), delta: ep ? { value: Number(e.total), previous: Number(ep.total) } : null, spark: spark(exp, "total"), note: payroll ? `Payroll ${inr(payroll)} of it` : (e.basis ?? "Monthly cost sheet"), confidence: e.confidence ?? "medium", href: "/finance?tab=budget", up: "bad" }
      : { key: "costs", label: "Monthly costs", value: "Not recorded", note: "Monthly cost sheet — HR", confidence: "low", href: "/finance?tab=budget" },
    burn.net === null || burn.net === undefined ? { key: "burn", label: "Net burn", value: "Unknown", note: "Needs costs and invoicing for the same months", confidence: "low", href: "/finance?tab=forecast" }
      : { key: "burn", label: burn.net < 0 ? "Net burn a month" : "Net surplus a month", value: inr(Math.abs(burn.net)), note: burn.costMonths?.length ? `Average of ${monthSpan(burn.costMonths)}` : "Three-month average", tone: burn.net < 0 ? "warning" : "success", confidence: burn.confidence ?? "medium", href: "/finance?tab=forecast" },
    fresh ? { key: "cash", label: "Cash in bank", value: inr(bal.amount), note: `As of ${dayName(bal.asOf)}${burn.runwayMonths !== null && burn.runwayMonths !== undefined ? ` · runway ${burn.runwayMonths} months` : ""}`, confidence: "high", href: "/finance?tab=forecast" }
      : { key: "cash", label: "Cash in bank", value: "Statement needed", note: bal ? `Last balance ${dayName(bal.asOf)} — ${balanceWho}` : `No bank balance on file — ${balanceWho}`, tone: "warning", confidence: "low", href: "/finance?tab=ledger&financeSource=What+is+missing" },
  ];
}

/** Cost mix over the last twelve months with costs: a monthly average per category (payroll as one total), the
 *  largest five and the rest together. */
export function costMix(m, top = 5) {
  const from = monthsEnding(lastFullMonth(m.asOf), 12)[0];
  const months = (m.expenses?.months ?? []).filter((e) => e.month >= from);
  const sums = new Map();
  for (const e of months) for (const [k, v] of Object.entries(e.byCategory ?? {})) sums.set(k, (sums.get(k) ?? 0) + Number(v || 0));
  const all = [...sums].map(([category, sum]) => ({ category, label: category.replace(/\s*\(monthly total\)/i, ""), avg: months.length ? sum / months.length : 0 })).sort((a, b) => b.avg - a.avg);
  const total = all.reduce((n, x) => n + x.avg, 0);
  const head = all.slice(0, all.length > top + 1 ? top : all.length), rest = all.slice(head.length);
  const items = rest.length ? [...head, { category: "Other", label: `Other (${rest.length})`, avg: rest.reduce((n, x) => n + x.avg, 0) }] : head;
  return { months: months.map((e) => e.month), total, items: items.map((x) => ({ ...x, share: total ? x.avg / total : 0 })) };
}

/** The largest clients by invoicing, and what the rest add up to. */
export function topClients(m, top = 5) {
  const all = [...(m.revenue?.clients ?? [])].filter((c) => Number(c.invoiced) > 0).sort((a, b) => b.invoiced - a.invoiced);
  const rest = all.slice(top);
  return { items: all.slice(0, top), rest: { count: rest.length, invoiced: rest.reduce((n, c) => n + Number(c.invoiced), 0), share: rest.reduce((n, c) => n + Number(c.invoiceShare || 0), 0) } };
}

const VIEW = { revenue: "Revenue", overdue: "Collections", burn: "Forecast", margin: "Budget", compliance: "CA desk", anomalies: "Reconcile", software: "Vendors & renewals", ads: "Ad spend" };
const HREF = { revenue: "/finance?tab=income", overdue: "/finance?tab=revenue", burn: "/finance?tab=forecast", margin: "/finance?tab=budget", compliance: "/finance/desk", anomalies: "/finance?tab=reconcile", software: "/finance?tab=subscriptions", ads: "/finance?tab=ad-spend" };

/** The founders' brief as one sentence per item: words before the figure, the figure (shown bold), words after.
 *  The model's paragraph moves into the item's details; at most seven items, in the model's order. */
export function bullets(m) {
  const last = lastFullMonth(m.asOf);
  const out = [];
  for (const item of m.brief ?? []) {
    const base = { key: item.key, tone: item.tone ?? "info", confidence: item.confidence ?? "low", title: item.title, paragraph: item.text, basis: item.basis, href: HREF[item.key] ?? item.href, view: VIEW[item.key] ?? item.title };
    const s = sentence(m, item.key, last);
    out.push({ ...base, ...(s ?? { before: "", figure: item.title, after: "." }) });
  }
  return out.slice(0, 7);
}

function sentence(m, key, last) {
  if (key === "revenue") {
    const inv = (m.revenue?.months ?? []).filter((r) => r.month <= last && r.invoices);
    const recent = inv.slice(-3), prior = inv.slice(-6, -3);
    if (!recent.length) return null;
    const avg = recent.reduce((n, r) => n + Number(r.invoiced), 0) / recent.length;
    const before = prior.length ? prior.reduce((n, r) => n + Number(r.invoiced), 0) / prior.length : null;
    const change = before ? avg / before - 1 : null;
    return { before: "Invoicing averaged ", figure: inr(avg), after: ` a month over ${monthSpan(recent.map((r) => r.month))}${change === null ? "" : `, ${change >= 0 ? "up" : "down"} ${Math.abs(Math.round(change * 100))}% on the three months before`}.` };
  }
  if (key === "overdue") {
    const od = m.collections?.overdue;
    if (!od?.count) return null;
    if (od.confirmed?.count) return { before: "", figure: inr(od.confirmed.amount), after: ` across ${od.confirmed.count} invoices is past due with no payment in the bank lines.` };
    return { before: "", figure: inr(od.unverified?.amount ?? od.amount), after: ` across ${od.unverified?.count ?? od.count} invoices is past due and cannot be checked without newer bank statements.` };
  }
  if (key === "burn") {
    const b = m.burn;
    if (b?.net === null || b?.net === undefined) return b?.avgMonthlyCost ? { before: "Monthly costs average ", figure: inr(b.avgMonthlyCost), after: "." } : null;
    return b.net < 0 ? { before: "Costs run ", figure: inr(Math.abs(b.net)), after: " a month ahead of invoicing (three-month average)." }
      : { before: "Invoicing covers costs with ", figure: inr(b.net), after: " a month to spare (three-month average)." };
  }
  if (key === "margin") {
    const op = m.margins?.operating;
    if (op?.margin === null || op?.margin === undefined) return null;
    return { before: "Operating margin was ", figure: pct(op.margin), after: ` over the last ${op.months.length} months with both invoices and costs.` };
  }
  if (key === "compliance") {
    const next = m.compliance?.upcoming?.[0];
    if (!next) return null;
    return { before: "", figure: next.what, after: ` is due on ${dayName(next.due)}.` };
  }
  if (key === "anomalies") {
    const a = m.anomalies ?? [];
    if (!a.length) return null;
    return { before: "", figure: `${a.length} ${a.length === 1 ? "exception" : "exceptions"}`, after: ` need clearing, starting with “${a[0].title.replace(/\.$/, "")}”.` };
  }
  if (key === "software") {
    const s = m.software;
    if (!s) return null;
    const n = s.renewals30?.length ?? 0;
    return { before: "Software and AI cost ", figure: inr(s.ownerMonthly), after: ` a month${n ? `; ${n} ${n === 1 ? "renewal falls" : "renewals fall"} in the next 30 days` : ""}.` };
  }
  if (key === "ads") {
    const a = m.adSpend;
    if (!a?.avg3) return null;
    return { before: "Client ad funding averaged ", figure: inr(a.avg3), after: " a month over the last three months." };
  }
  return null;
}

/** CSV with a header row; numbers stay plain numbers so a spreadsheet can add them up. */
export function toCsv(columns, rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    // A leading = + - @ would run as a formula in a spreadsheet: quote it as text.
    const safe = typeof v !== "number" && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [columns.map((c) => cell(c.label)).join(","), ...rows.map((r) => columns.map((c) => cell(r[c.key])).join(","))].join("\r\n") + "\r\n";
}

/** Sort rows by a column: numbers and dates in order, text alphabetically; unknowns always last. */
export function sortRows(rows, key, dir = "desc") {
  const sign = dir === "asc" ? 1 : -1;
  return rows.map((r, i) => [r, i]).sort(([a, ai], [b, bi]) => {
    const x = a[key], y = b[key];
    const xn = x === null || x === undefined || x === "", yn = y === null || y === undefined || y === "";
    if (xn || yn) return xn && yn ? ai - bi : xn ? 1 : -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "en-IN", { numeric: true, sensitivity: "base" });
    return c ? c * sign : ai - bi;
  }).map(([r]) => r);
}
