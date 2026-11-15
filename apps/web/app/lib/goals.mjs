// FOUNDATIONS (owner, 6 Nov 2026): goals on the screens (services/api/src/goals.ts, migration 1569). The words a goal
// card says, in one place so the goals page, a goal's page and My day say the same thing (goals.test.mjs).
import { say } from "./words.mjs";

/** @typedef {{ progress: number; measure: number | null; work: number | null; tasks: number; tasksDone: number; projects: number; subGoals: number; late: boolean; basis: "measure" | "work" | "done" | "none" }} GoalProgress */
/** @typedef {{ id: string; level: "person" | "team" | "company"; title: string; why: string | null; ownerId: string | null; owner: string | null; teamId: string | null; team: string | null; parentId: string | null; parent: string | null; targetOn: string | null; measure: { label: string; start: number; target: number; current: number } | null; status: "active" | "done" | "dropped"; createdBy: string; createdAt: string; updatedAt: string; doneAt: string | null; canEdit: boolean; progress: GoalProgress }} Goal */

/** Progress as a whole percent, 0 to 100. @param {number | null | undefined} p */
export const percent = (p) => Math.max(0, Math.min(100, Math.round(Number(p ?? 0) * 100)));

/** A number as people write it: no trailing ".00", thousands grouped the Indian way. @param {number} n */
const NUMBER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
export const plainNumber = (n) => NUMBER.format(n);

/** What the progress counts, in a few words. @param {Goal} g */
export function progressWords(g) {
  const p = g.progress;
  if (g.status === "done") return "Done";
  if (g.status === "dropped") return "Dropped";
  if (g.measure) return `${plainNumber(g.measure.current)} of ${plainNumber(g.measure.target)} ${g.measure.label}`;
  if (p.tasks === 0 && p.subGoals === 0) return "No work under it yet";
  const parts = [];
  if (p.tasks > 0) parts.push(`${p.tasksDone} of ${p.tasks} ${p.tasks === 1 ? "task" : "tasks"} done`);
  if (p.subGoals > 0) parts.push(`${p.subGoals} ${p.subGoals === 1 ? "smaller goal" : "smaller goals"}`);
  return parts.join(" · ");
}

/** Whose goal it is, in the company's own words. @param {Goal} g @param {Record<string, string> | null} [words] */
export function levelWords(g, words) {
  if (g.level === "company") return "Company goal";
  if (g.level === "team") return g.team ? `${g.team} goal` : say("{Team} goal", words);
  return g.owner ? `${g.owner}'s goal` : "Personal goal";
}

/** When it is due, from today (both YYYY-MM-DD, the company's days). @param {string | null} targetOn @param {string} today @param {string} [status] */
export function dueWords(targetOn, today, status = "active") {
  if (!targetOn) return null;
  const days = Math.round((Date.parse(`${targetOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const date = new Date(`${targetOn}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  if (status !== "active") return `Target ${date}`;
  if (days < 0) return `${-days === 1 ? "1 day" : `${-days} days`} past ${date}`;
  if (days === 0) return "Due today";
  if (days <= 31) return `${days === 1 ? "1 day" : `${days} days`} left · ${date}`;
  return `By ${date}`;
}

/** The goals page's sections: the company's, the teams', yours, then the people you look after.
 *  @template {Goal} G @param {G[]} goals @param {string | null} me */
export function groupGoals(goals, me) {
  /** @type {{ company: G[]; team: G[]; mine: G[]; people: G[] }} */
  const out = { company: [], team: [], mine: [], people: [] };
  for (const g of goals) {
    if (g.level === "company") out.company.push(g);
    else if (g.level === "team") out.team.push(g);
    else if (g.ownerId && g.ownerId === me) out.mine.push(g);
    else out.people.push(g);
  }
  return out;
}

/** A tone for the progress bar: done, behind (late), or on its way. @param {Goal} g */
export const tone = (g) => g.status === "done" ? "done" : g.status === "dropped" ? "muted" : g.progress.late ? "late" : "active";

// ------------------------------------------------------------------------------------------------ GOALS-2 (1855)
// Owner, 8 Nov 2026: "adding goals is a very huge deal … if money is involved, show the numbers … everything visualised".
// What the new goals screens say and draw, in one place (goals.test.mjs): money in lakh and crore, health from plain
// rules (no AI), the pace, the next thing to do, the streak, and the lists sorted by deadline.

/** @typedef {"money" | "clients" | "count" | "milestone" | "custom"} GoalKind */
/** @typedef {"manual" | "billing_received" | "billing_invoiced" | "clients_paying" | "checkins" | "tasks_done"} GoalSource */
/** @typedef {Goal & { kind: GoalKind; kindSet?: boolean; source: GoalSource; startsOn: string; steps: { id: string; title: string; done: boolean }[];
 *   auto: { value: number; series: { key: string; value: number }[]; items: { id: string; name: string; on: string }[]; from: string; to: string } | null;
 *   history: { on: string; value: number }[]; nextTask: { id: string; title: string; dueOn: string | null } | null; ownerPhotoAt?: string | null; stepsDone?: number }} ScreenGoal */

export const KINDS = /** @type {const} */ (["money", "clients", "count", "milestone", "custom"]);

/** Rupees the Indian way: ₹45,000, ₹16.4 L, ₹1.25 Cr. `full` writes every digit (₹16,40,000). @param {number} n @param {boolean} [full] */
export function rupees(n, full = false) {
  const v = Number(n) || 0, sign = v < 0 ? "-" : "", a = Math.abs(v);
  if (full || a < 100000) return `${sign}₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: a < 100 ? 2 : 0 }).format(a)}`;
  const [d, unit] = a >= 1e7 ? [1e7, "Cr"] : [1e5, "L"];
  const x = a / d, digits = x >= 100 ? 0 : x >= 10 ? 1 : 2;
  return `${sign}₹${Number(x.toFixed(digits)).toString()} ${unit}`;
}

/** A goal's number as people say it: rupees for money, a % for check-ins, otherwise the number. @param {ScreenGoal} g @param {number} n @param {boolean} [full] */
export function amountWords(g, n, full = false) {
  if (g.kind === "money") return rupees(n, full);
  if (g.source === "checkins") return `${plainNumber(Math.round(n))}%`;
  return plainNumber(n);
}

/** The value now: the auto-source's when it fills itself in, otherwise the one typed. @param {ScreenGoal} g */
export const valueNow = (g) => g.auto && g.source !== "manual" ? g.auto.value : g.measure?.current ?? 0;

const DAY = 86400000;
const dayNo = (/** @type {string} */ d) => Math.round(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) / DAY);
/** Days from a to b (YYYY-MM-DD). @param {string} a @param {string} b */
export const daysBetween = (a, b) => dayNo(b) - dayNo(a);
const FMT = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const FMT_Y = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** "31 Mar" this year, "31 Mar 2027" another year. @param {string} d @param {string} today */
export const shortDate = (d, today) => (d.slice(0, 4) === today.slice(0, 4) ? FMT : FMT_Y).format(new Date(`${d.slice(0, 10)}T00:00:00Z`));

/** Share of the goal's time that has gone, 0 to 1 (null without a target date). @param {ScreenGoal} g @param {string} today */
export function timeGone(g, today) {
  if (!g.targetOn) return null;
  const span = daysBetween(g.startsOn, g.targetOn);
  if (span <= 0) return 1;
  return Math.max(0, Math.min(1, daysBetween(g.startsOn, today) / span));
}

// UI-SWEEP (10 Nov 2026): health is pace: where the goal is against where it should be today at an even pace (the same
// speed the pace line projects). A fixed "10 points" allowance called a ₹0-of-₹25 L goal "On track" for its first weeks.
export const HEALTH_RULES = Object.freeze({ onTrack: 0.9, atRisk: 0.6 });
/** The rules in plain words, for the (i) next to a health chip. */
export const HEALTH_HELP = [
  "We work out where the goal should be today if it moved at an even pace, and compare.",
  "On track: at least 90% of where it should be today, or ahead.",
  "At risk: 60% to 90% of where it should be.",
  "Behind: under 60%, or the date has passed.",
  "In its first week nothing is expected yet: a goal with nothing done says Just started.",
  "A goal with no date shows no health.",
];

/** Too early to judge a pace: under a week, or under a tenth of the goal's time (as `pace` says). @param {ScreenGoal} g @param {string} today */
const tooEarly = (g, today) => !!g.targetOn && daysBetween(g.startsOn, today) < Math.max(7, daysBetween(g.startsOn, g.targetOn) / 10);

/** On track / at risk / behind, by rule (HEALTH_HELP), never by a guess. `gap` is how many points of the goal it is
 *  short of where it should be today.
 *  @param {ScreenGoal} g @param {string} today @returns {{ key: "done" | "hit" | "on" | "risk" | "behind" | "start" | "none"; label: string; gap: number | null }} */
export function health(g, today) {
  const p = Math.max(0, Math.min(1, Number(g.progress?.progress ?? 0)));
  if (g.status === "done") return { key: "done", label: "Done", gap: null };
  if (g.status === "dropped") return { key: "none", label: "Dropped", gap: null };
  if (p >= 1) return { key: "hit", label: "Hit!", gap: 0 };
  const gone = timeGone(g, today);
  if (gone === null) return { key: "none", label: "No date", gap: null };
  if (g.targetOn && today > g.targetOn) return { key: "behind", label: "Behind", gap: 1 - p };
  if (tooEarly(g, today)) return p > 0 ? { key: "on", label: "On track", gap: 0 } : { key: "start", label: "Just started", gap: null };
  const gap = Math.max(0, Math.round((gone - p) * 1000) / 1000);
  const share = gone > 0 ? p / gone : 1;
  if (share >= HEALTH_RULES.onTrack) return { key: "on", label: "On track", gap };
  if (share >= HEALTH_RULES.atRisk) return { key: "risk", label: "At risk", gap };
  return { key: "behind", label: "Behind", gap };
}

/** Where the number is heading at today's speed, and how much is needed each week to hit it.
 *  @param {ScreenGoal} g @param {string} today @returns {{ projected: number; perWeek: number; hits: boolean; sentence: string } | null} */
export function pace(g, today) {
  if (!g.measure || !g.targetOn || g.status !== "active") return null;
  const start = g.measure.start, target = g.measure.target, now = valueNow(g);
  const gone = Math.max(1, daysBetween(g.startsOn, today)), span = Math.max(1, daysBetween(g.startsOn, g.targetOn));
  const left = daysBetween(today, g.targetOn);
  // Too early to say where today's speed ends up (under a week, or under a tenth of the goal's time): a goal that
  // started yesterday with 6 already counted is not "on track to hit 504". Then only what a week needs is said.
  const early = daysBetween(g.startsOn, today) < Math.max(7, span / 10);
  const projected = early ? now : start + ((now - start) / gone) * span;
  const up = target >= start, hits = early ? false : up ? projected >= target : projected <= target;
  const perWeek = left > 0 ? Math.max(0, (target - now) * (up ? 1 : -1)) / Math.max(1, left / 7) : 0;
  const when = shortDate(g.targetOn, today);
  const sentence = left < 0 ? `The date passed with ${amountWords(g, now)} of ${amountWords(g, target)}.`
    : now === start || early ? `To hit ${amountWords(g, target)} by ${when}, aim for ${amountWords(g, perWeek)} a week.`
    : hits ? `On track to hit ${amountWords(g, projected)} by ${when}.`
    : `At this pace: ${amountWords(g, projected)} by ${when}. Aim for ${amountWords(g, perWeek)} a week.`;
  return { projected, perWeek, hits, early, sentence };
}

/** The one next thing to do on a goal, by rule. @param {ScreenGoal} g @param {string} today
 *  @returns {{ label: string; href: string } | null} */
export function nextAction(g, today) {
  if (g.status !== "active") return null;
  const step = g.steps?.find((s) => !s.done);
  if (step) return { label: step.title, href: `/goals/${g.id}` };
  if (g.nextTask) return { label: g.nextTask.title, href: `/tasks/${g.nextTask.id}` };
  if (g.progress.progress >= 1) return { label: "Mark it done", href: `/goals/${g.id}` };
  if (g.targetOn && today > g.targetOn) return { label: "Move the date or close it", href: `/goals/${g.id}` };
  if (g.measure && g.source === "manual") {
    const last = g.history?.length ? g.history[g.history.length - 1].on : g.createdAt?.slice(0, 10);
    if (!last || daysBetween(last, today) >= 7) return { label: "Update the number", href: `/goals/${g.id}` };
  }
  if (!g.measure && !g.steps?.length && g.progress.tasks === 0 && g.progress.subGoals === 0) return { label: "Link a project or task", href: `/goals/${g.id}` };
  return null;
}

/** Monday of the week a day falls in (YYYY-MM-DD). @param {string} d */
const weekOf = (d) => { const n = dayNo(d), wd = (n + 3) % 7; return n - wd; };
/** Weeks in a row (up to this week or last week) in which the number went up. @param {ScreenGoal} g @param {string} today */
export function streak(g, today) {
  const h = g.history ?? [];
  const up = new Set();
  for (let i = 1; i < h.length; i++) if (h[i].value > h[i - 1].value) up.add(weekOf(h[i].on));
  if (h.length && g.measure && h[0].value > g.measure.start) up.add(weekOf(h[0].on));
  let w = weekOf(today); if (!up.has(w)) w -= 7;
  let n = 0; while (up.has(w)) { n++; w -= 7; }
  return n;
}

/** Bars for a money goal: money per month from Billing, or how much the typed number grew each month.
 *  @param {ScreenGoal} g @returns {{ key: string; label: string; value: number }[]} */
export function monthBars(g) {
  const MON = new Intl.DateTimeFormat("en-IN", { month: "short", timeZone: "UTC" });
  const label = (/** @type {string} */ k) => MON.format(new Date(`${k}-01T00:00:00Z`));
  if (g.auto && (g.source === "billing_received" || g.source === "billing_invoiced")) return g.auto.series.map((x) => ({ key: x.key, label: label(x.key), value: x.value }));
  /** @type {Map<string, number>} */ const end = new Map();
  for (const h of g.history ?? []) end.set(h.on.slice(0, 7), h.value);
  let prev = g.measure?.start ?? 0; const out = [];
  for (const [k, v] of [...end.entries()].sort()) { out.push({ key: k, label: label(k), value: Math.max(0, v - prev) }); prev = v; }
  return out;
}

/** Points for the pace chart: the number over time, the straight line to the target, and today's forecast.
 *  @param {ScreenGoal} g @param {string} today */
export function paceLine(g, today) {
  if (!g.measure || !g.targetOn) return null;
  const start = g.measure.start, target = g.measure.target;
  /** @type {{ on: string; value: number }[]} */ let actual;
  if (g.auto && (g.source === "billing_received" || g.source === "billing_invoiced")) {
    let sum = start; actual = [{ on: g.startsOn, value: start }];
    for (const m of g.auto.series) { sum += m.value; const end = `${m.key}-28`; actual.push({ on: end > today ? today : end, value: sum }); }
  } else actual = [{ on: g.startsOn, value: start }, ...(g.history ?? []).filter((h) => h.on >= g.startsOn)];
  const now = valueNow(g);
  if (!actual.length || actual[actual.length - 1].on !== today) actual.push({ on: today < g.targetOn ? today : g.targetOn, value: now });
  const p = pace(g, today);
  return { from: g.startsOn, to: g.targetOn, start, target, actual, forecast: p && !p.early && today < g.targetOn ? [{ on: today, value: now }, { on: g.targetOn, value: p.projected }] : [] };
}

/** Company goals (the company's and teams'), my goals, and the goals of the people I look after; each sorted by deadline.
 *  @template {Goal} G @param {G[]} goals @param {string | null} me */
export function splitGoals(goals, me) {
  const g = groupGoals(goals, me);
  return { company: byDeadline([...g.company, ...g.team]), mine: byDeadline(g.mine), people: byDeadline(g.people) };
}

/** Active goals first, then the nearest deadline (no date last), then the title. @template {Goal} G @param {G[]} goals @returns {G[]} */
export function byDeadline(goals) {
  const rank = (/** @type {Goal} */ g) => g.status === "active" ? 0 : g.status === "done" ? 1 : 2;
  return [...goals].sort((a, b) => rank(a) - rank(b) || (a.targetOn ?? "9999").localeCompare(b.targetOn ?? "9999") || a.title.localeCompare(b.title));
}

/** How many active goals are on track, at risk and behind. @param {ScreenGoal[]} goals @param {string} today */
export function healthCount(goals, today) {
  const out = { on: 0, risk: 0, behind: 0 };
  for (const g of goals) {
    if (g.status !== "active") continue;
    const h = health(g, today).key;
    if (h === "on" || h === "hit") out.on++; else if (h === "risk") out.risk++; else if (h === "behind") out.behind++;
  }
  return out;
}

/** The big line on a goal: "₹16.4 L of ₹25 L", "6 of 10 clients", "4 of 6 steps". @param {ScreenGoal} g */
export function headline(g) {
  if (g.measure) {
    const unit = g.kind === "money" || g.source === "checkins" ? "" : ` ${g.measure.label}`;
    return { now: amountWords(g, valueNow(g)), of: `of ${amountWords(g, g.measure.target)}${unit}` };
  }
  if (g.steps?.length) return { now: String(g.steps.filter((s) => s.done).length), of: `of ${g.steps.length} ${g.steps.length === 1 ? "step" : "steps"}` };
  if (g.progress.tasks > 0) return { now: String(g.progress.tasksDone), of: `of ${g.progress.tasks} ${g.progress.tasks === 1 ? "task" : "tasks"} done` };
  return { now: `${percent(g.progress.progress)}%`, of: "done" };
}

/** Where a goal's number comes from, in a few words. @param {GoalSource} s */
export const SOURCE_WORDS = Object.freeze({ manual: "You update it", billing_received: "Money received, from Billing", billing_invoiced: "Invoices raised, from Billing",
  clients_paying: "Clients who paid, from Billing", checkins: "Staff checking in, from Attendance", tasks_done: "Tasks done under it" });

/** A rough number typed in the add-goal flow ("25 L", "1.2 cr", "25,00,000", "50k") as a number, or null.
 *  @param {string} text */
export function readAmount(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/[₹,\s]/g, "").replace(/rs\.?/, "");
  const m = /^(\d+(?:\.\d+)?)(k|l|lakh|lakhs|lac|cr|crore|crores)?$/.exec(t);
  if (!m) return null;
  const mult = { k: 1e3, l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, cr: 1e7, crore: 1e7, crores: 1e7 }[m[2] ?? ""] ?? 1;
  return Math.round(Number(m[1]) * mult * 100) / 100;
}

/** A goal from the API with every GOALS-2 field filled in (an older API, or a goal made before 1855, leaves some out):
 *  its kind read from what it counts, "manual", the day it was made, no steps, no history.
 *  @param {Goal & Partial<ScreenGoal>} g @returns {ScreenGoal} */
export function screenGoal(g) {
  const steps = Array.isArray(g.steps) ? g.steps : [];
  const label = g.measure?.label ?? "";
  const kind = g.kind && KINDS.includes(g.kind) ? g.kind : steps.length ? "milestone" : !g.measure ? "custom"
    : /₹|rupee|\binr\b|revenue|collect|amount|lakh|crore/i.test(label) ? "money" : /client|customer/i.test(label) ? "clients" : "count";
  return { ...g, kind, source: g.source ?? "manual", startsOn: g.startsOn ?? (g.createdAt || "").slice(0, 10), steps, auto: g.auto ?? null,
    history: Array.isArray(g.history) ? g.history : [], nextTask: g.nextTask ?? null, ownerPhotoAt: g.ownerPhotoAt ?? null };
}
