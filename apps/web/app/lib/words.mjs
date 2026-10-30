// DE-EA (owner, 28 Oct 2026): the company's ONE vocabulary, as /api/v0/me returns it (services/api/src/work-model.ts
// orgVocabulary). Screens say "team", "client" and "project" in the company's own words, never a word hard-wired for one
// company. Client components read it with useWords() (org-code.tsx); server components with vocabulary() (lib/api.ts).
/** @type {{ client: string; clients: string; project: string; projects: string; run: string; runs: string; team: string; teams: string; lead: string; leads: string }} */
export const NEUTRAL_VOCABULARY = Object.freeze({ client: "Client", clients: "Clients", project: "Project", projects: "Projects", run: "Run", runs: "Runs",
  team: "Team", teams: "Teams", lead: "Lead", leads: "Leads" });
/** The word as it reads mid-sentence ("Pod" → "pod"); a word that is an acronym stays as it is.
 *  @param {string} word */
export const lower = (word) => /^[A-Z]{2,}$/.test(word) ? word : word.charAt(0).toLowerCase() + word.slice(1);
