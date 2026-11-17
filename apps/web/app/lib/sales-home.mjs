// KAZUK-V2 G13 (Kazuk, 6 Nov 2026, R43–R45): the words and lists of the one salesperson home (/sales). Pure; the page
// passes what the API answered. Unit-tested in sales-home.test.mjs.

/** @param {string} name */
export const firstName = (name) => String(name ?? "").trim().split(/\s+/)[0] || String(name ?? "");

/** The greeting does not guess the hour (the page has the company's date, not its clock). */
export const greeting = () => "Hello";

/** Incentive per deal (R44): Not due until Paid, then Pending until the Sales Head releases it. */
export const INCENTIVE = {
  not_due: { label: "Not due", tone: "neutral" },
  pending: { label: "Pending", tone: "warning" },
  released: { label: "Released", tone: "success" },
};

/** The Neeti / Sales X-Ray numbers, in Kazuk's order (R45). Invoiced and collected sit in the tiles above. */
export const NEETI_ROWS = [
  ["leads", "Leads"], ["attempts", "Call attempts"], ["firstCallMinutes", "First-call time"], ["settingCalls", "Setting calls"],
  ["strategySessions", "Strategy sessions"], ["proposals", "Proposals"], ["closes", "Closes"],
];

/** One Neeti number as words, or null for "Not recorded". @param {Record<string, unknown>} n @param {string} key */
export function neetiValue(n, key) {
  const v = n?.[key];
  if (v === null || v === undefined || !n.connected) return null;
  if (key === "firstCallMinutes") {
    const m = Number(v);
    if (m < 60) return `${m} min`;
    if (m < 60 * 48) return `${Math.round(m / 60)} h`;
    return `${Math.round(m / 1440)} days`;
  }
  return String(v);
}

/** "Last sync 9 Nov, 9:40 am", or why there is none. @param {{ connected: boolean, lastSync: string | null, lastError?: string | null }} n */
export function syncText(n, zone = "Asia/Kolkata") {
  if (!n?.connected) return "Sales X-Ray is not connected, so these are not recorded yet.";
  if (!n.lastSync) return "Not synced yet.";
  const at = new Date(n.lastSync);
  const text = at.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: zone }).replace(/\s?(am|pm)$/i, (x) => x.toLowerCase());
  return `Last sync ${text}${n.lastError ? " · the last try failed" : ""}`;
}

/** Today's list: missed follow-ups, late invoices (biggest first), quotations with no reply, today's follow-ups, then
 *  renewals. The Sales Agent's reminders (`nudges`, 1932's typed rules) carry a drafted message; without them the late
 *  invoices come from the period's invoices. One row per thing. */
export function todayItems({ pipeline, invoices, today, nudges = null }) {
  const out = [];
  for (const f of pipeline?.followUps?.items ?? []) {
    if (!f.overdue && f.dueOn && f.dueOn > today) continue;
    out.push({ key: `t-${f.id}`, kind: "follow", href: `/tasks/${f.id}`, title: f.title, late: !!f.overdue, sub: f.overdue ? "Follow-up missed" : "Follow-up due today", rank: f.overdue ? 0 : 3 });
  }
  if (Array.isArray(nudges)) {
    const RANK = { overdue: 1, no_reply: 2, renewal: 4 };
    for (const n of nudges) out.push({ key: n.key, kind: n.kind === "overdue" ? "invoice" : n.kind, href: n.href, title: n.title, sub: n.sub, late: n.kind === "overdue",
      amount: n.kind === "overdue" ? n.amount : undefined, draft: n.draft, phone: n.phone ?? null, rank: RANK[n.kind] ?? 5 });
  } else {
    for (const i of invoices ?? []) {
      const due = Number(i.baseDue ?? 0) + Number(i.gstDue ?? 0);
      if (!due || !i.dueDate || i.dueDate >= today) continue;
      const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${i.dueDate}T00:00:00Z`)) / 86400000);
      out.push({ key: `i-${i.id}`, kind: "invoice", href: `/erp/documents/${i.id}`, title: `${i.number}${i.buyer ? ` · ${i.buyer}` : ""}`, late: true, amount: due,
        sub: `Invoice ${days} day${days === 1 ? "" : "s"} late: ask for the payment`, rank: 1 });
    }
  }
  return out.sort((a, b) => a.rank - b.rank || (b.amount ?? 0) - (a.amount ?? 0));
}
