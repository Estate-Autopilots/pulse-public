// DE-EA (owner, 28 Oct 2026): the company's ONE vocabulary, as /api/v0/me returns it (services/api/src/work-model.ts
// orgVocabulary). Screens say "team", "client" and "project" in the company's own words, never a word hard-wired for one
// company. Client components read it with useWords() (org-code.tsx); server components with vocabulary() (lib/api.ts).
/** @type {{ client: string; clients: string; project: string; projects: string; run: string; runs: string; team: string; teams: string; lead: string; leads: string }} */
export const NEUTRAL_VOCABULARY = Object.freeze({ client: "Client", clients: "Clients", project: "Project", projects: "Projects", run: "Run", runs: "Runs",
  team: "Team", teams: "Teams", lead: "Lead", leads: "Leads" });
/** The word as it reads mid-sentence ("Pod" → "pod"); a word that is an acronym stays as it is.
 *  @param {string} word */
export const lower = (word) => /^[A-Z]{2,}$/.test(word) ? word : word.charAt(0).toLowerCase() + word.slice(1);
/** @param {string} team */
const FUNCTION_OF = (team) => team.trim().toLowerCase() === "team" ? "Department" : "Team";
/** DE-EA: a label written once for every company, in this company's words. `{Team}`/`{team}`/`{Teams}`/`{teams}` (and
 *  client, project and function the same way) become its own word, capitalised as the token is, e.g. say("{Teams} &
 *  {functions}", words) → "Pods & teams" for a company that says Pod, "Teams & departments" by default. Constants and
 *  tab lists keep the tokens; the place that shows them says them.
 *  @param {string} text @param {Record<string, string> | null | undefined} [words] @returns {string} */
export function say(text, words) {
  const w = { ...NEUTRAL_VOCABULARY, ...(words ?? {}) };
  const fn = FUNCTION_OF(w.team);
  /** @type {Record<string, string>} */
  const pick = { team: w.team, teams: w.teams, client: w.client, clients: w.clients, project: w.project, projects: w.projects,
    function: fn, functions: fn === "Team" ? "Teams" : "Departments" };
  return String(text).replace(/\{(team|teams|client|clients|project|projects|function|functions)\}/gi, (token, key) => {
    const word = pick[key.toLowerCase()];
    return key[0] === key[0].toUpperCase() ? word.charAt(0).toUpperCase() + word.slice(1) : lower(word);
  });
}
/** The key the API uses for "in no team" (insights, people, budgets); screens compare on it and say it with noTeam(). */
export const NO_TEAM = "No pod"; // tenant-neutral:allow (an API value, never shown as it is)
/** @param {Record<string, string> | null | undefined} [words] */
export const noTeam = (words) => `No ${lower({ ...NEUTRAL_VOCABULARY, ...(words ?? {}) }.team)}`;
