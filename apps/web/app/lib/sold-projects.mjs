// KAZUK-V2 G13 (R42, R55): the words of a sold project, read only (/sales/projects and the Sales Agent's project
// status). Pure; unit-tested in sold-projects.test.mjs.

/**
 * @typedef {{ id: string, name: string, client: string | null, clientId: string | null, status: string, pgs: string | null, category: string | null,
 *   renewalOn: string | null, tasks: { total: number, done: number, overdue: number }, next: { title: string, dueOn: string | null } | null,
 *   clientGroup: boolean, recent?: { title: string, at: string }[] | null, upcoming?: { title: string, dueOn: string | null, late: boolean }[] | null }} SoldProject
 * @typedef {{ person: { id: string, self: boolean }, today: string, projects: SoldProject[] }} SoldProjects
 */

const STATUS = { onboarding: ["Starting", "accent"], active: ["Running", "success"], paused: ["Paused", "warning"], done: ["Finished", "neutral"], cancelled: ["Stopped", "neutral"] };

/** "9 Nov" from a date or a time (UTC date part). @param {string | null | undefined} iso */
export function shortDay(iso) {
  if (!iso) return "";
  return new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** @param {SoldProject} p @param {string} today */
export function projectFacts(p, today) {
  const total = Number(p.tasks?.total ?? 0), done = Number(p.tasks?.done ?? 0);
  const share = total ? done / total : 0;
  const [status, tone] = STATUS[p.status] ?? [p.status, "neutral"];
  const days = p.renewalOn ? Math.round((Date.parse(`${p.renewalOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000) : null;
  return {
    share, percent: Math.round(share * 100), status, tone,
    renewal: p.renewalOn ? `${shortDay(p.renewalOn)}${days !== null && days >= 0 && days <= 60 ? ` (in ${days} day${days === 1 ? "" : "s"})` : ""}` : "",
    nextDue: p.next?.dueOn ? shortDay(p.next.dueOn) : "",
  };
}
