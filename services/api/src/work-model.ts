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
  team: string;                     // TASKS-4A: what the company calls a team (its own word; "Team" by default)
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
  // DE-EA: the neutral default is "Team"; a company that calls its teams something else (EA: "Pod") says so in its own
  // settings (work_settings.team_label, or its pack's words), never in code.
  const team = w.team || (typeof teamLabel === 'string' && teamLabel.trim() ? teamLabel.trim() : 'Team');
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

/** DE-EA (phase 2): the company's ONE vocabulary. Every word a screen needs, in one object: the neutral words, then the
 *  business model's (a product company's customers), then the team word from Settings → Work, then the pack's or the
 *  company's own words (Settings → Industry & roles), which win. /api/v0/me returns it as `words`; the web reads it with
 *  useWords() (client) or vocabulary() (server). */
export type Vocabulary = Record<'client' | 'clients' | 'project' | 'projects' | 'run' | 'runs' | 'team' | 'teams' | 'lead' | 'leads', string>;
export function orgVocabulary(model: unknown, teamLabel?: unknown, words?: Partial<Vocabulary> | null): Vocabulary {
  const own = Object.fromEntries(Object.entries(words ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, (v as string).trim().slice(0, 40)])) as Partial<Vocabulary>;
  const labels = workLabels(model, teamLabel, own);
  const product = labels.model === 'product';
  const base: Vocabulary = { client: product ? 'Customer' : 'Client', clients: product ? 'Customers' : 'Clients', project: 'Project', projects: 'Projects',
    run: 'Run', runs: 'Runs', team: labels.team, teams: labels.teams, lead: 'Lead', leads: 'Leads' };
  return { ...base, ...own, team: labels.team, teams: labels.teams };
}
