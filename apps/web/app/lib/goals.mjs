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
 *  @param {Goal[]} goals @param {string | null} me */
export function groupGoals(goals, me) {
  /** @type {{ company: Goal[]; team: Goal[]; mine: Goal[]; people: Goal[] }} */
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
