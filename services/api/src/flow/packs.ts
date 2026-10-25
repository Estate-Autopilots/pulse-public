/** FLOW-E (owner, 21 Oct 2026: "It all feels very specific to EA. Can there not be proper foundational blocks, and we
 *  customise an account to any industry, role or anything?"): industry packs. A pack is data on top of the primitives:
 *  the company's words (what a client, a project and a run are called), its work roles (what each sees: the screens it
 *  uses, its home and the tiles on it), starter processes (templates made of primitives and company blocks) and record
 *  types (sites, findings, units …). Applying a pack adds what the company does not have yet; everything it sets stays
 *  editable in Settings → Industry & roles. "Start neutral" is a pack too. No pack is special-cased in code. */
import { normalizeRecordType } from './record-types.js';
import { presetOf } from './company-blocks.js';
import { template } from './templates/index.js';
import type { RecordType } from './types.js';

export const WORD_KEYS = ['client', 'clients', 'project', 'projects', 'run', 'runs', 'team', 'teams', 'lead', 'leads'] as const;
export type WordKey = (typeof WORD_KEYS)[number];
export type Words = Record<WordKey, string>;
export const WORD_LABELS: Record<WordKey, string> = {
  client: 'One client', clients: 'Clients', project: 'One project', projects: 'Projects', run: 'One run of a process', runs: 'Runs',
  team: 'One team', teams: 'Teams', lead: 'One lead', leads: 'Leads',
};
export const NEUTRAL_WORDS: Words = { client: 'Client', clients: 'Clients', project: 'Project', projects: 'Projects', run: 'Run', runs: 'Runs', team: 'Team', teams: 'Teams', lead: 'Lead', leads: 'Leads' };
const words = (w: Partial<Words>): Words => ({ ...NEUTRAL_WORDS, ...w });

/** A tile on a role's home: a count with up to three items and where it opens.
 *  mine: my open steps (of these modules); role: the role's open steps in every run, whoever has them;
 *  late: open steps past their due date (mine, or the role's); runs: runs going on. */
export type Tile = { key: string; label: string; of: 'mine' | 'role' | 'runs'; modules?: string[]; late?: boolean; href?: string; help?: string };
export type PackRole = { key: string; name: string; note?: string; screens: string[]; home?: 'dashboard' | 'sales' | null; tiles: Tile[] };
export type Pack = { key: string; name: string; summary: string; icon: string; words: Words; roles: PackRole[]; templates: string[]; recordTypes: unknown[]; examples: string };

const t = (key: string, label: string, of: Tile['of'], more: Partial<Tile> = {}): Tile => ({ key, label, of, ...more });
const MY_STEPS = t('mine', 'My steps', 'mine', { href: '/me/steps' });
const MY_LATE = t('late', 'Late', 'mine', { late: true, href: '/me/steps' });
const RUNS = (label: string) => t('runs', label, 'runs', { href: '/runs' });
const role = (key: string, name: string, screens: string[], tiles: Tile[], more: Partial<PackRole> = {}): PackRole => ({ key, name, screens, tiles: [MY_STEPS, ...tiles], ...more });
const ALL = ['work', 'clients', 'acquisition', 'contacts', 'map', 'sops', 'team', 'leadership', 'finance', 'erp'];

export const PACKS: Pack[] = [
  { key: 'neutral', name: 'Start neutral', icon: 'circle-dashed', examples: 'Any business',
    summary: 'Plain words (client, project, run), an owner and team members, and a blank process to build your own.',
    words: words({}), templates: [], recordTypes: [],
    roles: [role('owner', 'Owner', ALL, [t('late_all', 'Late across the company', 'role', { late: true, href: '/runs' }), RUNS('Runs going on')]),
      role('member', 'Team member', ['work', 'clients', 'sops'], [MY_LATE])] },

  { key: 'real_estate_marketing', name: 'Real-estate marketing agency', icon: 'building-2', examples: 'Creative strategy and performance marketing for property developers',
    summary: 'Clients and their projects, pods, the creative-strategy client project (blueprint, first curiosity set, landing page, trust assets) with its company blocks.',
    words: words({ project: 'Client project', projects: 'Client projects', team: 'Pod', teams: 'Pods' }), templates: ['ea_creative'], recordTypes: [],
    roles: [
      role('gs_head', 'GS Head', ALL, [t('assign', 'Clients to assign', 'mine', { modules: ['assign'] }), t('late_all', 'Late in the pod', 'role', { late: true, href: '/runs' }), RUNS('Projects going on')],
        { note: 'The pod head: assigns each client, settles disputes' }),
      role('gs', 'Growth Strategist', ['work', 'clients', 'acquisition', 'contacts', 'sops'], [t('reviews', 'Waiting on the client', 'mine', { modules: ['share_review'] }), MY_LATE],
        { note: 'Owns the client relationship and campaigns' }),
      role('cs', 'Creative Strategist', ['work', 'clients', 'sops'], [t('write', 'To write', 'mine', { modules: ['doc', 'doc_section', 'asset', 'pack', 'big_idea'] }),
        t('check', 'To check', 'mine', { modules: ['check', 'share_review'] }), MY_LATE], { note: 'Owns the blueprint, scripts and notes' }),
      role('ve', 'Video Editor', ['work', 'sops'], [t('cuts', 'Cuts to make', 'mine', { modules: ['edit', 'media_review'] }), MY_LATE]),
      role('gd', 'Graphic Designer', ['work', 'sops'], [t('designs', 'Designs to make', 'mine', { modules: ['edit', 'asset', 'media_review'] }), MY_LATE]),
      role('ac', 'Access Coordinator', ['work', 'clients', 'sops'], [t('setup', 'Set-ups to do', 'mine', { modules: ['workspace', 'intake'] })]),
      role('pc', 'Project Coordinator', ['work', 'clients', 'sops', 'map'], [t('shoots', 'Shoots to plan', 'mine', { modules: ['shoot', 'casting', 'consent', 'schedule'] })]),
      role('vg', 'Videographer', ['work', 'sops', 'map'], [t('shoots', 'Shoots', 'mine', { modules: ['shoot', 'upload'] })]),
      role('sme', 'Social Media Executive', ['work', 'clients', 'sops'], [MY_LATE]),
    ] },

  { key: 'solar', name: 'Solar installer', icon: 'sun', examples: 'Rooftop and ground-mount solar: sales, survey, install, billing',
    summary: 'Customers, sites and jobs; sales, surveyor, installer and accounts roles; the job from a new lead to the tax invoice with GPS site photos.',
    words: words({ client: 'Customer', clients: 'Customers', project: 'Site', projects: 'Sites', run: 'Job', runs: 'Jobs', team: 'Crew', teams: 'Crews', lead: 'Enquiry', leads: 'Enquiries' }),
    templates: ['solar_install'],
    recordTypes: [
      { key: 'site', name: 'Site', plural: 'Sites', icon: 'house', summary: 'A roof or ground where a system goes: its size, roof, meter and the place.', titleField: 'address',
        fields: [{ key: 'address', label: 'Address', type: 'text', required: true }, { key: 'roof', label: 'Roof', type: 'choice', options: ['RCC', 'Tin shed', 'Ground mount'] },
          { key: 'system_kw', label: 'System size (kW)', type: 'number' }, { key: 'sanctioned_load', label: 'Sanctioned load (kW)', type: 'number' }, { key: 'meter', label: 'Meter number', type: 'text' },
          { key: 'shading', label: 'Shading', type: 'longtext' }],
        statuses: [{ key: 'surveyed', label: 'Surveyed', next: ['installed'] }, { key: 'installed', label: 'Installed', next: ['surveyed'], final: true }] },
      { key: 'equipment', name: 'Equipment', plural: 'Equipment', icon: 'cpu', summary: 'A panel, inverter, battery or meter with its serial number and warranty.', titleField: 'serial',
        fields: [{ key: 'serial', label: 'Serial number', type: 'text', required: true }, { key: 'kind', label: 'What it is', type: 'choice', options: ['Panel', 'Inverter', 'Battery', 'Meter'] },
          { key: 'make', label: 'Make and model', type: 'text' }, { key: 'warranty_until', label: 'Warranty until', type: 'date' }],
        statuses: [{ key: 'fitted', label: 'Fitted', next: ['replaced'] }, { key: 'replaced', label: 'Replaced', next: ['fitted'], final: true }] },
    ],
    roles: [
      role('sales', 'Sales executive', ['work', 'clients', 'acquisition', 'contacts', 'sops', 'erp'], [t('calls', 'Calls to make', 'mine', { modules: ['sales_xray', 'lead_capture'] }),
        t('quotes', 'Quotations to send', 'mine', { modules: ['quotation'] }), t('follow', 'Follow-ups', 'mine', { modules: ['follow_up', 'approval'] })], { home: 'sales' }),
      role('surveyor', 'Site surveyor', ['work', 'clients', 'map', 'sops'], [t('visits', 'Site visits to do', 'mine', { modules: ['site_visit'] }), MY_LATE]),
      role('installer', 'Install team lead', ['work', 'clients', 'map', 'sops'], [t('installs', 'Installs to record', 'mine', { modules: ['data_capture'] }), MY_LATE]),
      role('accounts', 'Accounts', ['work', 'clients', 'finance', 'erp', 'sops'], [t('invoices', 'Invoices to make', 'mine', { modules: ['tax_invoice'] }), t('papers', 'Papers to file', 'mine', { modules: ['checklist'] })]),
      role('owner', 'Owner', ALL, [RUNS('Jobs going on'), t('late_all', 'Late across the company', 'role', { late: true, href: '/runs' })]),
    ] },

  { key: 'marketing_agency', name: 'Marketing or creative agency', icon: 'megaphone', examples: 'Brand, content, social and design agencies',
    summary: 'Clients and projects; account managers, strategists, designers and copywriters; a client campaign from the brief to the invoice.',
    words: words({}), templates: ['agency_campaign'], recordTypes: [],
    roles: [
      role('account', 'Account manager', ['work', 'clients', 'contacts', 'sops', 'erp'], [t('client', 'Waiting on the client', 'mine', { modules: ['share_review'] }), MY_LATE]),
      role('strategist', 'Strategist', ['work', 'clients', 'sops'], [t('briefs', 'Briefs to write', 'mine', { modules: ['doc', 'doc_section'] })]),
      role('designer', 'Designer', ['work', 'sops'], [t('make', 'To make', 'mine', { modules: ['asset', 'edit'] }), MY_LATE]),
      role('writer', 'Copywriter', ['work', 'sops'], [t('check', 'To check', 'mine', { modules: ['check'] })]),
    ] },

  { key: 'consulting', name: 'Consulting firm', icon: 'briefcase', examples: 'Management, strategy, finance or technical consulting',
    summary: 'Clients and engagements; partners, engagement managers, consultants and analysts; an engagement from the enquiry to the invoice, with findings as records.',
    words: words({ project: 'Engagement', projects: 'Engagements', run: 'Engagement', runs: 'Engagements', team: 'Practice', teams: 'Practices', lead: 'Enquiry', leads: 'Enquiries' }),
    templates: ['consulting_engagement'],
    recordTypes: [
      { key: 'finding', name: 'Finding', plural: 'Findings', icon: 'search-check', summary: 'What the work found: the insight, its evidence and how much it matters.', titleField: 'insight',
        fields: [{ key: 'insight', label: 'Insight', type: 'text', required: true }, { key: 'evidence', label: 'Evidence', type: 'longtext' },
          { key: 'impact', label: 'Impact', type: 'choice', options: ['High', 'Medium', 'Low'] }, { key: 'recommendation', label: 'Recommendation', type: 'longtext' }],
        statuses: [{ key: 'draft', label: 'Draft', next: ['agreed'] }, { key: 'agreed', label: 'Agreed with the client', next: ['draft'], final: true }] },
      { key: 'stakeholder', name: 'Stakeholder', plural: 'Stakeholders', icon: 'user-round-search', summary: 'Someone on the client side: their role and how much they sway the decision.', titleField: 'name',
        fields: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'title', label: 'Their role', type: 'text' }, { key: 'influence', label: 'Influence', type: 'choice', options: ['Decides', 'Shapes', 'Informed'] }],
        statuses: [{ key: 'open', label: 'Open', next: ['met'] }, { key: 'met', label: 'Met', next: ['open'], final: true }] },
    ],
    roles: [
      role('partner', 'Engagement partner', ALL, [t('reviews', 'To review', 'mine', { modules: ['approval'] }), RUNS('Engagements going on')]),
      role('manager', 'Engagement manager', ['work', 'clients', 'contacts', 'sops', 'erp'], [t('proposals', 'Proposals and meetings', 'mine', { modules: ['doc', 'meeting', 'quotation'] }), MY_LATE]),
      role('consultant', 'Consultant', ['work', 'clients', 'sops'], [t('findings', 'Findings and reports', 'mine', { modules: ['records', 'doc'] }), MY_LATE]),
      role('analyst', 'Analyst', ['work', 'sops'], [t('data', 'Data to gather', 'mine', { modules: ['upload', 'data_capture'] })]),
    ] },

  { key: 'clinic', name: 'Clinic', icon: 'stethoscope', examples: 'Outpatient clinics, dental, physiotherapy, diagnostics',
    summary: 'Patients and visits; front desk, nurse, doctor and billing; a visit from the appointment request to the follow-up reminder.',
    words: words({ client: 'Patient', clients: 'Patients', project: 'Treatment', projects: 'Treatments', run: 'Visit', runs: 'Visits', lead: 'Enquiry', leads: 'Enquiries' }),
    templates: ['clinic_visit'],
    recordTypes: [
      { key: 'treatment_note', name: 'Treatment note', plural: 'Treatment notes', icon: 'notebook-pen', summary: 'What was found and advised at a visit, and when to come back.', titleField: 'complaint',
        fields: [{ key: 'complaint', label: 'Reason for the visit', type: 'text', required: true }, { key: 'findings', label: 'Findings', type: 'longtext' },
          { key: 'advice', label: 'Advice', type: 'longtext' }, { key: 'next_visit', label: 'Next visit', type: 'date' }],
        statuses: [{ key: 'open', label: 'Open', next: ['closed'] }, { key: 'closed', label: 'Closed', next: ['open'], final: true }] },
    ],
    roles: [
      role('desk', 'Front desk', ['work', 'clients', 'contacts', 'sops'], [t('book', 'Appointments to book', 'mine', { modules: ['schedule'] }), t('remind', 'Reminders to send', 'mine', { modules: ['message'] })]),
      role('nurse', 'Nurse', ['work', 'sops'], [t('intake', 'Intake forms', 'mine', { modules: ['data_capture'] })]),
      role('doctor', 'Doctor', ['work', 'clients', 'sops'], [t('consult', 'Consultations', 'mine', { modules: ['meeting', 'doc'] }), MY_LATE]),
      role('billing', 'Billing', ['work', 'finance', 'erp', 'sops'], [t('bills', 'Bills to make', 'mine', { modules: ['tax_invoice'] })]),
    ] },

  { key: 'real_estate_developer', name: 'Real-estate developer', icon: 'building', examples: 'Residential and commercial developers sehubuv units',
    summary: 'Buyers, projects and bookings; sales, site, CRM, legal and accounts; an enquiry to a booking with Sales X-Ray, a GPS site visit, the cost sheet and the agreement.',
    words: words({ client: 'Buyer', clients: 'Buyers', run: 'Booking', runs: 'Bookings', lead: 'Enquiry', leads: 'Enquiries' }),
    templates: ['developer_booking'],
    recordTypes: [
      { key: 'unit', name: 'Unit', plural: 'Units', icon: 'door-open', summary: 'A flat, shop or plot: where it is, its size and price, and whether it is free.', titleField: 'unit_no',
        fields: [{ key: 'unit_no', label: 'Unit', type: 'text', required: true }, { key: 'tower', label: 'Tower or wing', type: 'text' }, { key: 'floor', label: 'Floor', type: 'number' },
          { key: 'carpet_area', label: 'Carpet area (sq ft)', type: 'number' }, { key: 'price', label: 'Price', type: 'money' }],
        statuses: [{ key: 'available', label: 'Available', next: ['held', 'booked'] }, { key: 'held', label: 'Held', next: ['available', 'booked'] }, { key: 'booked', label: 'Booked', next: ['available'], final: true }] },
    ],
    roles: [
      role('sales', 'Sales manager', ['work', 'clients', 'acquisition', 'contacts', 'sops', 'erp'], [t('calls', 'Calls and visits', 'mine', { modules: ['sales_xray', 'schedule'] }),
        t('cost', 'Cost sheets', 'mine', { modules: ['quotation', 'follow_up'] })], { home: 'sales' }),
      role('site', 'Site manager', ['work', 'map', 'sops'], [t('visits', 'Site visits', 'mine', { modules: ['site_visit'] })]),
      role('crm', 'CRM executive', ['work', 'clients', 'contacts', 'sops'], [t('forms', 'Booking forms', 'mine', { modules: ['data_capture'] })]),
      role('legal', 'Legal', ['work', 'sops'], [t('agreements', 'Agreements', 'mine', { modules: ['doc', 'approval'] })]),
      role('accounts', 'Accounts', ['work', 'finance', 'erp', 'sops'], [t('demands', 'Demands to raise', 'mine', { modules: ['tax_invoice'] })]),
    ] },
];
export const PACK = new Map(PACKS.map((p) => [p.key, p]));

/** What a pack looks like before it is applied: its words, roles, processes and record types, in words. */
export function packSummary(p: Pack) {
  return { key: p.key, name: p.name, summary: p.summary, icon: p.icon, examples: p.examples, words: p.words,
    roles: p.roles.map((r) => ({ key: r.key, name: r.name, note: r.note ?? null, screens: r.screens, home: r.home ?? null, tiles: r.tiles })),
    processes: p.templates.map((k) => template(k)).filter((x) => !!x).map((x) => ({ key: x!.key, name: x!.name, summary: x!.summary, steps: x!.definition.steps.length })),
    recordTypes: packTypes(p).map((x) => ({ key: x.key, name: x.name, plural: x.plural })) };
}
const packTypes = (p: Pack): RecordType[] => p.recordTypes.map((x) => normalizeRecordType(x)).flatMap((n) => ('type' in n ? [n.type] : []));

/** The payload pulse.flow_pack_write takes: everything a pack brings, in the shapes the tables keep. */
export function packPayload(p: Pack) {
  const processes = p.templates.map((k) => template(k)).filter((x) => !!x).map((x) => ({ template: x!.key, name: x!.name, summary: x!.summary, definition: x!.definition, writeup: x!.writeup ?? [] }));
  const blocks = p.templates.flatMap((k) => template(k)?.blocks ?? []).map((b) => { const preset = presetOf(b.step); return { key: b.key.slice(0, 60), name: b.name, summary: b.summary, block: preset.block, preset }; });
  return { key: p.key, name: p.name, words: p.words, roles: p.roles, recordTypes: packTypes(p).map((x) => ({ key: x.key, def: x })), blocks, processes };
}

/** The company's words: its own, over the neutral ones. */
export function wordsOf(raw: unknown): Words {
  const b = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return Object.fromEntries(WORD_KEYS.map((k) => [k, typeof b[k] === 'string' && (b[k] as string).trim() ? (b[k] as string).trim().slice(0, 40) : NEUTRAL_WORDS[k]])) as Words;
}
