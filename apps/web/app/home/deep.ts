import type { LiveModel } from "../finance/types";
import type { HomeData, Insights } from "../lib/api";
import { issues } from "../insights";
import { inrShort, type Brief, type Row, type Tone } from "./brain";

/** OWNER-HOME: Max mode's extra reading of the same sources. Focus shows the winners; Max shows the whole field, still
 *  ranked: six numbers, the money over time, who owes what, the full queue, the team and what blocks a trustworthy view. */

export type Kpi = { id: string; label: string; value: string; sub: string; tone: Tone; href: string; spark?: number[]; viz?: { weight: number; tone: Tone | "accent" | "muted" }[] };
export type Month = { label: string; invoiced: number; collected: number | null; partial?: boolean };
export type Age = { title: string; sub: string; value: string; tone: Tone; share: number };
export type MaxData = { kpis: Kpi[]; months: Month[]; avgCost: number | null; aging: Age[]; agingTotal: string; clients: Row[];
  team: { present: number; headcount: number; away: number; pending: number; rows: Row[] } | null; fix: Row[] };

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => { const x = /^(\d{4})-(\d{2})/.exec(m); return x ? `${MON[Number(x[2]) - 1]} ${x[1].slice(2)}` : m; };

export function deep({ brief, live: m, insights, home, now = Date.now() }: { now?: number; brief: Brief; live: LiveModel | null; insights: Insights | null; home: HomeData | null }): MaxData {
  const g = (id: string) => brief.allGlance.find((x) => x.id === id);
  const kpis: Kpi[] = [];
  const hrefs: Record<string, string> = { owed: "/finance?tab=revenue", gap: "/finance?tab=cash", clients: "/clients", people: "/hr" };
  const push = (id: string) => { const x = g(id); if (x) kpis.push({ id, label: x.label, value: x.value, sub: x.sub, tone: id === "clients" || id === "people" ? "info" : x.tone, href: hrefs[id] ?? "/dashboard", viz: x.viz }); };

  // The running month is drawn but marked "so far"; comparisons use the last full month.
  const monthNow = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(now)).slice(0, 7);
  const months: Month[] = (m?.revenue.months ?? []).slice(-9).map((x) => ({ label: monthLabel(x.month), invoiced: x.invoiced, collected: x.collected, partial: x.month.startsWith(monthNow) || undefined }));
  push("owed"); push("gap");
  if (m) {
    const bal = m.burn.balance;
    kpis.push({ id: "cash", label: "Cash in bank", value: bal ? inrShort(bal.amount) : "?", tone: !bal || bal.ageDays > 35 ? "warn" : "info", href: "/finance?tab=cash",
      sub: !bal ? "statement needed" : bal.ageDays > 35 ? `statement ${bal.ageDays} days old` : m.burn.runwayMonths !== null ? `${m.burn.runwayMonths.toFixed(1)} months of runway` : `as of ${bal.asOf}` });
    const last = months.filter((x) => x.invoiced > 0 && !x.partial).at(-1), avg = m.burn.avgMonthlyInvoiced;
    if (last) {
      const delta = avg ? Math.round((last.invoiced / avg - 1) * 100) : null;
      kpis.push({ id: "invoiced", label: `Invoiced ${last.label}`, value: inrShort(last.invoiced), tone: delta !== null && delta < -15 ? "warn" : "info", href: "/finance?tab=revenue",
        sub: delta === null ? "last full month" : `${delta >= 0 ? "+" : "−"}${Math.abs(delta)}% on average`, spark: months.filter((x) => !x.partial).map((x) => x.invoiced) });
    }
  }
  push("clients"); push("people");

  const od = m?.collections.overdue;
  const big = Math.max(1, ...(od?.buckets ?? []).map((b) => b.amount));
  const aging: Age[] = od ? [...od.buckets].reverse().map((b, i) => ({ title: b.bucket, sub: `${b.count} invoice${b.count === 1 ? "" : "s"}`, value: inrShort(b.amount),
    tone: (i === 0 && /90/.test(b.bucket) ? "bad" : /6\d|90/.test(b.bucket) ? "warn" : "info") as Tone, share: b.amount / big })) : [];

  const clients: Row[] = [...(m?.revenue.clients ?? [])].filter((c) => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding).slice(0, 6)
    .map((c) => ({ title: c.client, sub: `${c.invoices} invoice${c.invoices === 1 ? "" : "s"}${c.last ? ` · last ${monthLabel(c.last)}` : ""}`, value: inrShort(c.outstanding), tone: "bad" as Tone, href: "/finance?tab=revenue" }));

  let team: MaxData["team"] = null;
  if (home?.attendance) { const a = home.attendance; team = { present: a.present, headcount: a.headcount, away: home.leave.onLeaveToday.length, pending: home.leave.pending.length,
    rows: a.entries.slice(0, 7).map((e) => ({ title: e.name, sub: e.checkedOutAt ? "checked out" : "in now", tone: "info" as Tone,
      value: new Date(e.checkedInAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) })) }; }

  const fix: Row[] = insights ? issues(insights).map((i) => ({ title: i.title, sub: i.detail, value: i.action, tone: i.tone === "danger" ? "bad" : i.tone === "warning" ? "warn" : "info", href: i.href })) : [];

  return { kpis: kpis.slice(0, 6), months, avgCost: m?.burn.avgMonthlyCost ?? null, aging, agingTotal: od ? inrShort(od.amount) : "", clients, team, fix };
}
