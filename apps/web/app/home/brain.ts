import { bullets } from "../lib/finance-view.mjs";
import type { LiveModel } from "../finance/types";
import type { HomeData, Insights } from "../lib/api";
import type { Home as TaskHome, Task } from "../tasks/types";

/** OWNER-HOME: the calm home's brain. Every signal Pulse has becomes a candidate with a score, and the page shows only
 *  the winners: the greeting is the strongest signal, the four cards are the four strongest numbers, Next up is the
 *  actions in score order and "Pulse noticed" is the best piece of good news. The page never decides what matters.
 *
 *  score = impact × urgency × confidence
 *    impact      0–100, against the company's own scale (money against a month's invoicing, people against headcount)
 *    urgency     0.5 (can wait) … 1.5 (past due), from due dates and the age of the problem
 *    confidence  high 1 · medium 0.8 · low 0.55 (from the source's own confidence) */

export type Tone = "bad" | "warn" | "good" | "info";
export type Icon = "money" | "bank" | "doc" | "people" | "renew" | "task" | "client" | "folder" | "leave";
export type Row = { title: string; sub: string; value: string; tone: Tone; href?: string };
export type Glance = { id: string; label: string; value: string; sub: string; tone: Tone; viz: { weight: number; tone: Tone | "accent" | "muted" }[]; score: number;
  sheet: { title: string; big: string; bigSub: string; rows: Row[]; cta?: { label: string; href: string } } };
/** MY-TASKS: `admin` marks a company-level decision (clients, projects, leave) that reaches someone as an admin rather
 *  than as their own work, so the card says so. */
export type Move = { id: string; title: string; cta: string; href: string; tone: Tone; icon: Icon; score: number; admin?: boolean };
export type Brief = { name: string; greeting: { lead: string; figure: string; tail: string }; glance: Glance[]; next: Move[];
  noticed: { text: string; href: string } | null; tasks: Row[]; projects: Row[];
  /** Max mode retains every card and the first nine moves in score order. */
  allGlance: Glance[]; queue: Move[] };

const CONF = { high: 1, medium: 0.8, low: 0.55 } as const;
const cap = (n: number) => Math.max(0, Math.min(100, n));
const DAY = 86_400_000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ₹1.04 Cr, ₹3.03 L, ₹40k: two decimals for crores and lakhs, so the greeting never rounds a crore of debt away. */
export function inrShort(value: number) {
  const sign = value < 0 ? "−" : "", a = Math.abs(value);
  const two = (x: number) => x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return a >= 1e7 ? `${sign}₹${two(a / 1e7)} Cr` : a >= 1e5 ? `${sign}₹${two(a / 1e5)} L` : a >= 1e3 ? `${sign}₹${Math.round(a / 1e3)}k` : `${sign}₹${Math.round(a)}`;
}
/** "#1 - Fohas Homes | Mr. Opobo Gupoz | Shriwal" → "Fohas Homes" (the Drive folder name carries the client and place). */
function projectName(folder: string) {
  return folder.replace(/^#\d+\s*-\s*/, "").split(" | ")[0].trim() || folder;
}
/** "2026-09" (the quarter's last month) → "Jul–Sep 2026"; anything else as it is. */
function quarterName(period: string) {
  const m = /^(\d{4})-(\d{2})/.exec(period);
  if (!m) return period;
  const end = Number(m[2]) - 1, start = (end + 10) % 12;
  return `${MON[start]}–${MON[end]} ${m[1]}`;
}

function daysUntil(date: string | null | undefined, today: number) {
  if (!date) return null;
  const t = Date.parse(date.length === 10 ? `${date}T00:00:00+05:30` : date);
  return Number.isNaN(t) ? null : Math.round((t - today) / DAY);
}
/** Past due 1.5, due within a week 1.2, within a month 0.9, otherwise 0.6. */
function urgency(days: number | null) {
  if (days === null) return 0.8;
  return days < 0 ? 1.5 : days <= 7 ? 1.2 : days <= 31 ? 0.9 : 0.6;
}

type Sources = { me: { name: string; role: string; id?: string | null } | null; live: LiveModel | null; insights: Insights | null; home: HomeData | null; tasks: TaskHome | null; now?: number };

export function think({ me, live: m, insights, home, tasks, now = Date.now() }: Sources): Brief {
  const glance: Glance[] = [], next: Move[] = [];
  const hr = me?.role === "hr";
  const asAdmin = me?.role === "admin";

  if (m) {
    const months = m.revenue.months.filter((x) => x.invoiced > 0);
    const monthly = m.burn.avgMonthlyInvoiced ?? months.at(-1)?.invoiced ?? 1;
    const od = m.collections.overdue;
    if (od.amount > 0) {
      const old = od.buckets.filter((b) => /90/.test(b.bucket) && !/61/.test(b.bucket)).reduce((a, b) => a + b.amount, 0);
      const oldShare = Math.round((old / od.amount) * 100);
      const tones: Record<string, Tone | "accent"> = {};
      od.buckets.forEach((b, i) => { tones[b.bucket] = (["good", "warn", "warn", "bad"] as const)[Math.min(i, 3)]; });
      glance.push({ id: "owed", label: "Owed to us", value: inrShort(od.amount), sub: oldShare >= 50 ? `${oldShare}% is 90+ days old` : `${od.count} invoices`, tone: oldShare >= 50 ? "bad" : "warn",
        viz: od.buckets.map((b) => ({ weight: b.amount, tone: tones[b.bucket] ?? "muted" })), score: cap((od.amount / monthly) * 10) * (oldShare >= 50 ? 1.3 : 1) * CONF.medium,
        sheet: { title: "Owed to us", big: inrShort(od.amount), bigSub: `${od.count} invoices · ${od.confirmed.count} confirmed unpaid`,
          rows: [...od.buckets].reverse().map((b) => ({ title: b.bucket, sub: `${b.count} invoices`, value: inrShort(b.amount), tone: tones[b.bucket] === "bad" ? "bad" : "info" as Tone })),
          cta: { label: "Chase the oldest first", href: "/finance?tab=revenue" } } });
      if (od.confirmed.amount > 0) next.push({ id: "chase", title: `Chase ${inrShort(od.confirmed.amount)} confirmed unpaid`, cta: "Open list", href: "/finance?tab=revenue", tone: "bad", icon: "money",
        score: cap((od.confirmed.amount / monthly) * 45) * 1.3 * CONF.medium });
    }

    const cost = m.burn.avgMonthlyCost, income = m.burn.avgMonthlyInvoiced;
    if (cost !== null && income !== null && cost > income) {
      const gap = cost - income, lastPay = m.payroll.at(-1);
      glance.push({ id: "gap", label: "Monthly gap", value: inrShort(-gap), sub: "Costs ahead of income", tone: "bad", viz: [{ weight: income, tone: "accent" }, { weight: gap, tone: "bad" }],
        score: cap((gap / cost) * 160) * CONF.medium,
        sheet: { title: "Monthly gap", big: inrShort(-gap), bigSub: "a month, costs over invoicing",
          rows: [{ title: "Invoicing", sub: "monthly average", value: inrShort(income), tone: "info" }, { title: "Costs", sub: lastPay ? `payroll ${inrShort(lastPay.total)} in ${lastPay.month}` : "monthly average", value: inrShort(cost), tone: "info" },
            { title: "Cash in bank", sub: m.burn.balance ? `as of ${m.burn.balance.asOf}` : "statement needed", value: m.burn.balance ? inrShort(m.burn.balance.amount) : "?", tone: m.burn.balance && m.burn.balance.ageDays < 35 ? "info" : "warn" }],
          cta: { label: "Open cash", href: "/finance?tab=cash" } } });
    }

    const bal = m.burn.balance;
    if (!bal || bal.ageDays > 35) next.push({ id: "bank", title: "Upload the latest bank statement", cta: "Upload", href: "/finance?tab=cash", tone: "warn", icon: "bank",
      score: 70 * (bal ? Math.min(1.5, 0.8 + bal.ageDays / 365) : 1.2) * CONF.high });

    for (const q of m.compliance.quarters) for (const [form, f] of [["GSTR-1", q.gstr1], ["GSTR-3B", q.gstr3b]] as const) {
      if (f.filed) continue;
      const d = daysUntil(f.due, now);
      if (d !== null && d > 21) continue;
      next.push({ id: `gst-${form}-${q.quarter}`, title: d !== null && d < 0 ? `Confirm ${form} for ${quarterName(q.period)} was filed` : `File ${form} for ${quarterName(q.period)}`, cta: "Open CA desk", href: "/finance?tab=desk",
        tone: d !== null && d < 0 ? "bad" : "warn", icon: "doc", score: 75 * urgency(d) * CONF.high });
    }

    const renewals = m.software.renewals30.length;
    if (renewals) next.push({ id: "renew", title: `Review ${renewals} renewal${renewals > 1 ? "s" : ""} due this month`, cta: "Review", href: "/finance?tab=costs", tone: "info", icon: "renew", score: 22 });
  }

  if (insights) {
    const p = insights.portfolio, quiet = insights.quietTotal;
    if (p.activeClients) {
      const delta = p.activeClientsBefore ? Math.round((p.activeClients / p.activeClientsBefore - 1) * 100) : null;
      glance.push({ id: "clients", label: "Active clients", value: String(p.activeClients), sub: quiet ? `${quiet} going quiet` : "none going quiet", tone: quiet / p.activeClients > 0.3 ? "warn" : "good",
        viz: [{ weight: Math.max(0, p.activeClients - quiet), tone: "good" }, { weight: quiet, tone: "warn" }], score: cap((quiet / p.activeClients) * 90) + 8,
        sheet: { title: "Clients", big: String(p.activeClients), bigSub: delta !== null ? `active · ${delta >= 0 ? "+" : ""}${delta}% on the 8 weeks before` : "active",
          rows: insights.quiet.slice(0, 5).map((q) => ({ title: q.clientName ?? projectName(q.projectName), sub: `quiet since ${q.lastDeliveredAt.slice(0, 10)}`, value: "Quiet", tone: "warn" as Tone, href: `/projects/${q.projectId}` })),
          cta: { label: "Open clients", href: "/clients" } } });
      if (quiet) next.push({ id: "quiet", title: `Check in with ${quiet} quiet clients`, cta: "See them", href: "/clients", tone: "warn", icon: "client", score: cap((quiet / p.activeClients) * 60), admin: asAdmin });
    }
    if (p.projectsNoClient) next.push({ id: "noclient", title: `Give ${p.projectsNoClient} projects a client`, cta: "Review", href: "/clients", tone: "info", icon: "folder", score: Math.min(25, p.projectsNoClient / 3), admin: asAdmin });
  }

  if (home?.attendance) {
    const a = home.attendance, pending = home.leave.pending.length, away = home.leave.onLeaveToday.length;
    glance.push({ id: "people", label: "In today", value: `${a.present} / ${a.headcount}`, sub: away ? `${away} on leave` : pending ? `${pending} to decide` : "shift in progress", tone: "info",
      viz: [{ weight: a.present, tone: "good" }, { weight: Math.max(0, a.headcount - a.present), tone: "muted" }], score: hr ? 90 : 18,
      sheet: { title: "In today", big: `${a.present} / ${a.headcount}`, bigSub: "checked in",
        rows: a.entries.slice(0, 6).map((e) => ({ title: e.name, sub: e.checkedOutAt ? "checked out" : "in", value: new Date(e.checkedInAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }), tone: "info" as Tone })),
        cta: { label: "Open HR desk", href: "/hr" } } });
    if (pending) next.push({ id: "leave", title: `Decide ${pending} leave request${pending > 1 ? "s" : ""}`, cta: "Decide", href: "/hr", tone: "warn", icon: "leave", score: (hr ? 85 : 45) * 1.2, admin: asAdmin });
  }

  const open = (tasks?.rows ?? []).filter((t) => !t.doneAt && t.status !== "done" && t.status !== "accepted");
  const due = (t: Task) => t.dueAt ?? t.dueOn;
  const late = open.filter((t) => { const d = daysUntil(due(t), now); return d !== null && d < 0; });
  if (tasks?.waitingOnMe.length) next.push({ id: "waiting", title: `${tasks.waitingOnMe.length} task${tasks.waitingOnMe.length > 1 ? "s" : ""} wait on you`, cta: "Unblock", href: "/tasks", tone: "warn", icon: "task", score: 50 * 1.2 });
  if (late.length) next.push({ id: "late", title: late.length === 1 ? "1 of your tasks is late" : `${late.length} of your tasks are late`, cta: "Open", href: "/tasks", tone: "bad", icon: "task", score: Math.min(60, 20 + late.length * 8) });

  glance.sort((a, b) => b.score - a.score);
  next.sort((a, b) => b.score - a.score);

  const top = glance[0];
  // QA-BULK: with no glance figures but something in Next up (a late task, a task waiting on you), the headline must not
  // say "Nothing needs you" right above it.
  const greeting = !top ? (next.length ? { lead: "", figure: next.length === 1 ? "One thing" : `${next.length} things`, tail: next.length === 1 ? " needs you." : " need you." } : { lead: "", figure: "Nothing", tail: " needs you right now." })
    : top.id === "owed" ? { lead: "Clients owe us ", figure: top.value, tail: top.tone === "bad" ? ", most of it for over 90 days." : "." }
    : top.id === "gap" ? { lead: "Costs run ", figure: top.value.replace("−", ""), tail: " a month ahead of income." }
    : top.id === "clients" ? { lead: "", figure: `${insights?.quietTotal ?? 0} clients`, tail: " have gone quiet." }
    : top.id === "people" ? { lead: "", figure: top.value, tail: " people are in today." }
    : { lead: `${top.label}: `, figure: top.value, tail: "." };

  const good = m ? bullets(m).find((b: { tone: string }) => b.tone === "good") : null;
  const noticed = good ? { text: `${good.before}${good.figure}${good.after}`, href: good.href } : null;

  const taskRows: Row[] = open.sort((a, b) => (due(a) ?? "9").localeCompare(due(b) ?? "9")).slice(0, 6).map((t) => {
    const d = daysUntil(due(t), now);
    // MY-TASKS: work someone gave you says from whom.
    const from = t.assignerId && me?.id && t.assignerId !== me.id && t.assignerName ? `from ${t.assignerName.split(" ")[0]}` : null;
    return { title: t.title, sub: [from, t.projectName ?? (t.openBlockers ? "blocked" : t.status)].filter(Boolean).join(" · "), value: t.dueLabel ?? (d === null ? "" : d < 0 ? `${-d} d late` : d === 0 ? "Today" : `${d} d`), tone: d !== null && d < 0 ? "bad" : d === 0 ? "warn" : "info", href: `/tasks/${t.id}` };
  });
  const work = home && "topProjects" in home ? home.topProjects : [];
  const projectRows: Row[] = [
    ...work.slice(0, 4).map((p) => ({ title: projectName(p.projectName), sub: `${p.count} this week`, value: "Active", tone: "good" as Tone, href: `/projects/${p.projectId}` })),
    ...(insights?.quiet ?? []).slice(0, 3).map((q) => ({ title: projectName(q.projectName), sub: q.clientName ?? "no client", value: "Quiet", tone: "warn" as Tone, href: `/projects/${q.projectId}` })),
  ];

  return { name: (me?.name ?? "").split(" ")[0] ?? "", greeting, glance: glance.slice(0, 4), next: next.slice(0, 6), noticed, tasks: taskRows, projects: projectRows, allGlance: glance, queue: next.slice(0, 9) };
}
