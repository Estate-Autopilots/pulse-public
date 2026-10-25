/** UX-TASKS-2: what a company calls its clients and the work it sells, by business model (a company setting).
 *  An agency sells client projects (packages or engagements) to clients; a product or IT company ships releases of
 *  its products to customers; an internal team has no clients at all. */
export type BusinessModel = 'agency' | 'product' | 'internal';
export type WorkLabels = {
  model: BusinessModel;
  section: string | null;           // the rail's group: Clients, Products, or none
  clients: string | null;           // the directory
  client: string;                   // one of them, in a sentence
  clientProjects: string | null;    // what was sold
  clientProject: string;            // one, in a sentence
  packageChip: string;              // the identity chip on what was sold
  fulfilmentChip: string;           // the identity chip on the work that delivers it
  fulfilmentHint: string;           // + Create's line for that choice
  team: string;                     // TASKS-4A: what the company calls a team (EA: Pod); pods are the team type
  teams: string;
};
/** "Pod" → "Pods", "Squad" → "Squads", "Team" → "Teams". */
export const plural = (word: string) => /(s|x|ch|sh)$/i.test(word) ? `${word}es` : /[^aeiou]y$/i.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`;
export const MODELS: Record<BusinessModel, { label: string; hint: string }> = {
  agency: { label: 'Agency or services', hint: 'Clients buy client projects (packages or engagements); the team delivers them.' },
  product: { label: 'Product or IT', hint: 'Products ship in releases to customers.' },
  internal: { label: 'Internal only', hint: 'No clients: only the company’s own projects.' },
};
/** FLOW-E: a company's own words (Settings → Industry & roles: "Customer", "Site", "Crew") name its clients, what it
 *  sells and its teams over the business model's defaults. */
export type CompanyWords = Partial<Record<'client' | 'clients' | 'project' | 'projects' | 'team' | 'teams', string>>;
export function workLabels(model: unknown, teamLabel?: unknown, words?: CompanyWords | null): WorkLabels {
  const w = words ?? {};
  const team = w.team || (typeof teamLabel === 'string' && teamLabel.trim() ? teamLabel.trim() : 'Pod');
  const base = modelLabels(model);
  const own = base.model === 'internal' ? {} : {
    ...(w.clients ? { section: w.clients, clients: w.clients } : {}), ...(w.client ? { client: w.client.toLowerCase() } : {}),
    ...(w.projects ? { clientProjects: w.projects } : {}), ...(w.project ? { clientProject: w.project.toLowerCase() } : {}),
  };
  return { ...base, ...own, team, teams: w.teams || plural(team) };
}
function modelLabels(model: unknown): Omit<WorkLabels, 'team' | 'teams'> {
  const m: BusinessModel = model === 'product' || model === 'internal' ? model : 'agency';
  if (m === 'product') return { model: m, section: 'Products', clients: 'Customers', client: 'customer', clientProjects: 'Releases', clientProject: 'release',
    packageChip: 'Release', fulfilmentChip: 'Release work', fulfilmentHint: 'Delivers a release' };
  if (m === 'internal') return { model: m, section: null, clients: null, client: 'client', clientProjects: null, clientProject: 'client project',
    packageChip: 'Client package', fulfilmentChip: 'Fulfilment', fulfilmentHint: 'Delivers a client package' };
  return { model: m, section: 'Clients', clients: 'Clients', client: 'client', clientProjects: 'Client projects', clientProject: 'client project',
    packageChip: 'Client package', fulfilmentChip: 'Fulfilment', fulfilmentHint: 'Delivers a client package' };
}
