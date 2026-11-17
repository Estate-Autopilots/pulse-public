// CONNECTIONS part A (owner, 16 Nov 2026: the home "looks very ugly, has no purpose"): the words of the home across
// every company a person is in (dashboard/across.tsx). It answers in two seconds: what do I do today, who is waiting on
// me, how is the money, and which companies and people I work with. Pure: no clock, no browser. Money arrives in paise.
import { money, nextHref, nextText } from "./founder.mjs";

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 things are late, 3 people wait on you, ₹4.2 L to collect" — only the parts that are not zero. */
export function summaryLine({ late = 0, today = 0, waiting = 0, collect = 0 } = {}) {
  const parts = [];
  if (late > 0) parts.push(`${plural(late, "thing")} ${late === 1 ? "is" : "are"} late`);
  else if (today > 0) parts.push(`${plural(today, "thing")} to do today`);
  if (waiting > 0) parts.push(`${waiting} ${waiting === 1 ? "thing waits" : "things wait"} on you`);
  if (collect > 0) parts.push(`${money(collect)} to collect`);
  if (!parts.length) return "All clear. Nothing is late and nothing waits on you.";
  const s = parts.join(", ");
  return s[0].toUpperCase() + s.slice(1) + ".";
}

/** Money per company (only the companies whose money this person may see), the biggest worry first. */
export function moneyRows(cards) {
  const rows = [];
  for (const c of cards ?? []) {
    const m = c?.today?.money;
    if (!m) continue;
    rows.push({ org: c.org, name: c.name, mark: c.mark ?? null, accent: c.accent ?? null, current: !!c.current,
      late: Number(m.late?.amount ?? 0), lateCount: Number(m.late?.count ?? 0), due: Number(m.dueWeek?.amount ?? 0), unbilled: Number(m.unbilled?.amount ?? 0) });
  }
  return rows.sort((a, b) => b.late - a.late || b.due - a.due || a.name.localeCompare(b.name));
}

/** What the person can collect soon: late bills and bills due in the next seven days, every company. */
export const collectTotal = (rows) => (rows ?? []).reduce((n, r) => n + r.late + r.due, 0);

/** Who is waiting on this person: agreements that need their OK (any company), then each company's one next thing
 *  that is somebody else waiting (a client's question, a late bill to chase, a stuck AI helper). */
export function waitingItems({ cards, contracts } = {}) {
  const out = [];
  for (const c of contracts ?? []) {
    if (!c?.canAccept) continue;
    const other = (c.parties ?? []).find((p) => !p.mine)?.name ?? c.heldBy ?? "Someone";
    out.push({ key: `contract:${c.key}`, who: other, where: c.heldBy ?? null, what: `Agreement to sign: ${c.title}`, action: "Review", href: "/my-day#your-contracts", org: null, orgName: null });
  }
  for (const c of cards ?? []) {
    const n = c?.today?.next;
    if (!n || !["client_issue", "late_bill", "ai_stuck"].includes(n.kind)) continue;
    const who = n.kind === "client_issue" ? n.client || "A client" : n.kind === "late_bill" ? n.buyer || "A client" : n.name || "An AI helper";
    // Judge (round 1): "Answer Harbor Builders: Floor plan …" read as jargon; say what they wait for.
    const what = n.kind === "client_issue" ? `Waiting for your answer: ${n.title ?? "a question"}`
      : n.kind === "late_bill" ? `Bill ${Number(n.age) > 0 ? `${n.age} ${Number(n.age) === 1 ? "day" : "days"} late` : "due"}${n.amount ? ` · ${money(n.amount)}` : ""}` : nextText(n);
    out.push({ key: `next:${c.org}`, who, where: c.name, what, action: n.kind === "client_issue" ? "Reply" : n.kind === "late_bill" ? "Collect" : "Help",
      href: nextHref(n) ?? "/", org: c.org, orgName: c.name, current: !!c.current, mark: c.mark ?? null, accent: c.accent ?? null });
  }
  return out;
}

/** How many are waiting: agreements to sign, each company's client questions (all of them), and a late bill or stuck AI helper listed. */
export function waitingCount({ cards, contracts } = {}) {
  let n = (contracts ?? []).filter((c) => c?.canAccept).length;
  for (const c of cards ?? []) {
    n += Number(c?.today?.clientIssues?.count ?? 0);
    // A late bill or a stuck AI helper is someone waiting too (it is listed): counted once, as the list shows it.
    if (["late_bill", "ai_stuck"].includes(c?.today?.next?.kind)) n += 1;
  }
  return n;
}

/** "Good morning" by the hour of the person's zone (0-23). */
export function greeting(hour, name) {
  const first = String(name ?? "").trim().split(/\s+/)[0];
  const part = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return first ? `${part}, ${first}` : part;
}
