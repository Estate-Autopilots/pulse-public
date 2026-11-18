// GAP-FOUNDER-VIEW (9 Nov 2026): the words of "All my companies" (app/founder) and the designation line of a profile.
// Pure: no clock, no browser. Money arrives in paise from the API (services/api/src/founder.ts) and is said in ₹ lakh
// and crore through the kit's rupees().
import { rupees } from "./goals.mjs";

/** Paise → "₹1.18 L". */
export const money = (paise) => rupees(Math.round((Number(paise) || 0) / 100)).replace(/ /g, "\u00A0");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const days = (n) => (Number(n) > 0 ? plural(Number(n), "day") : "today").replace(/ /g, "\u00A0");

const KIND_ROLE = { client: "Client", partner: "Partner", freelancer: "Freelancer", agent: "AI employee" };
/** A seat's designation: its job title, else what the seat is ("Client"), else "Team member". */
const ACCESS_ROLE = { owner: "Owner", admin: "Admin", leadership: "Leader", hr: "HR", finance: "Finance", manager: "Manager", pgs: "Team lead" };
/** A seat's designation: its job title, else its access there ("Admin"), else what the seat is ("Client"), else
 *  "Team member". The same words on the cards, the profile and a colleague's card. */
export function roleWord(role, kind, access) {
  const r = String(role ?? "").trim();
  if (r) return r;
  return ACCESS_ROLE[access] ?? KIND_ROLE[kind] ?? "Team member";
}

/** "Head PGS at EA · Adviser at Vitals": a person's current roles, one per company (PM-07). */
export function designationLine(roles) {
  return designations(roles).join(" · ");
}

/** One "Role at Company" per company. */
export function designations(roles) {
  return (roles ?? []).filter((r) => r && r.company).map((r) => `${roleWord(r.role, r.kind, r.access)} at ${r.company}`);
}

/** "Diya Nair is also head of sales at Kite Studio" for someone in two of the founder's companies. */
export function sharedPersonLine(p) {
  const there = (p.elsewhere ?? []).map((e) => e.role || (e.kind && e.kind !== "staff") ? `${lowerFirst(roleWord(e.role, e.kind))} at ${e.company}` : `works at ${e.company}`);
  if (!there.length) return p.name;
  const words = there.map((t) => (t.startsWith("works at ") ? t : `is also ${t}`));
  return `${p.name} ${words[0].startsWith("works at ") ? `also ${words[0]}` : words[0]}${words.slice(1).map((w) => `, and ${w.replace(/^is also /, "")}`).join("")}`;
}
function lowerFirst(s) {
  // "Adviser" → "adviser", but keep "CEO" or "PGS" as typed.
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

/** Where a next thing opens inside its company. */
export function nextHref(n) {
  if (!n) return null;
  switch (n.kind) {
    case "late_bill": return `/erp/documents/${n.id}`;
    case "ai_stuck": return `/people/ai/${n.id}`;
    case "client_issue": return n.taskId ? `/tasks/${n.taskId}` : n.projectId ? `/projects/${n.projectId}` : n.clientId ? `/clients/${n.clientId}` : "/clients";
    case "late_task": return `/tasks/${n.id}`;
    case "unbilled": return n.why === "milestone" ? (n.projectId ? `/projects/${n.projectId}` : "/erp") : `/erp/documents/${n.id}`;
    default: return null;
  }
}

/** The next thing in a few words, for the "Do this first" line (the card says it in full). */
export function nextShort(n) {
  if (!n) return "All clear today";
  switch (n.kind) {
    case "late_bill": return "collect a late bill";
    case "ai_stuck": return `${n.name} is stuck`;
    case "client_issue": return `answer ${n.client || "a client"}`;
    case "late_task": return `a task is ${Number(n.days) > 0 ? `${days(n.days)} late` : "due today"}`;
    case "unbilled": return `send a bill for ${money(n.amount)}`;
    default: return "open the company";
  }
}

/** The one next thing, in plain words. */
export function nextText(n) {
  if (!n) return "All clear today";
  switch (n.kind) {
    case "late_bill": return `Collect the bill from ${n.buyer || "a client"} · ${days(n.age)}\u00A0late`;
    case "ai_stuck": return n.why === "paused" ? `${n.name} is paused. See why` : n.why === "blocked" ? `${n.name} is stuck on “${n.task}”` : `${n.name} hit a problem today`;
    case "client_issue": return `Answer ${n.client || "a client"}: ${n.title}`;
    case "late_task": return `Follow up “${n.title}” (${Number(n.days) > 0 ? `${days(n.days)}\u00A0late` : "due\u00A0today"})`;
    case "unbilled": return `Send the bill to ${n.buyer || "the client"} for ${money(n.amount)}`;
    default: return "Open the company to see more";
  }
}

/** How clear a company's day is: four checks, the same things the next thing looks at (nothing late to collect, no
 *  client issue, no late task, no AI employee stuck). Money that cannot be read counts as clear. Who checked in is shown,
 *  never scored: a morning is not a problem. */
export function clearOf(t) {
  const checks = [
    !t.money || Number(t.money.late?.count ?? 0) === 0,
    Number(t.clientIssues?.count ?? 0) === 0,
    Number(t.tasksLate?.count ?? 0) === 0,
    Number(t.ai?.stuck ?? 0) === 0,
  ];
  return { clear: checks.filter(Boolean).length, of: checks.length };
}

/** The card's edge: rose when money is late or an AI employee is stuck, amber for issues or late work, else green. */
export function toneOf(t) {
  if ((t.money && Number(t.money.late?.count ?? 0) > 0) || Number(t.ai?.stuck ?? 0) > 0) return "bad";
  if (Number(t.clientIssues?.count ?? 0) > 0 || Number(t.tasksLate?.count ?? 0) > 0) return "warn";
  return "good";
}

/** The four counts of a card, each as a short line and a tone. */
export function countsOf(t) {
  const issues = Number(t.clientIssues?.count ?? 0), late = Number(t.tasksLate?.count ?? 0);
  const p = t.people ?? { in: 0, total: 0, away: 0 }, ai = t.ai ?? { total: 0, working: 0, stuck: 0 };
  return [
    { key: "issues", text: issues ? plural(issues, "client issue") : "No issues", tone: issues ? "warn" : "good" },
    { key: "late", text: late ? `${plural(late, "task")} late` : "None late", tone: late ? "warn" : "good" },
    // Who is in is information, never an alarm: amber and rose mean something is late or stuck.
    { key: "people", text: p.total ? `${p.in} of ${p.total} at work today` : "No team yet", tone: undefined },
    { key: "ai", text: !ai.total ? "No AI helpers" : ai.stuck ? `${plural(ai.stuck, "AI helper")} stuck` : `${plural(ai.working, "AI helper")} busy`, tone: ai.stuck ? "bad" : undefined },
  ];
}

/** "2 things need you" / "All clear": how many of the four checks are not clear, in words. */
export function needsOf(t) {
  const k = clearOf(t), n = k.of - k.clear;
  return n ? { text: `${n} ${n === 1 ? "thing needs" : "things need"} you`, tone: toneOf(t) } : { text: "All clear", tone: "good" };
}

/** The money pill: what is late, else work done but not billed, else nothing late. */
export function moneyPill(t) {
  const m = t.money; if (!m) return null;
  const late = Number(m.late?.amount ?? 0), unbilled = Number(m.unbilled?.amount ?? 0);
  if (late > 0) return { text: `${money(late)} late`, tone: "bad" };
  if (unbilled > 0) return { text: `${money(unbilled)} not billed`, tone: "warn" };
  return { text: "Nothing late", tone: "good" };
}

/** The page's totals across every card. */
export function totalsOf(cards) {
  let due = 0, risk = 0, late = 0, stuck = 0, clear = 0;
  for (const c of cards ?? []) {
    const t = c.today ?? {};
    due += Number(t.money?.dueWeek?.amount ?? 0); risk += Number(t.money?.late?.amount ?? 0);
    late += Number(t.tasksLate?.count ?? 0); stuck += Number(t.ai?.stuck ?? 0);
    const k = clearOf(t); if (k.clear === k.of) clear += 1;
  }
  return { due, risk, late, stuck, clear, companies: (cards ?? []).length };
}

/** "Owner", "Founder", "Adviser": the founder's own role chip on a card. */
export function myRole(t) {
  return roleWord(t.role, null, t.access === "owner" ? "owner" : "admin");
}
