import type { Step, Template } from './project-plan.js';

/** PROJECTS-STAGES (owner, 4 Nov 2026; Kazuk, 3 Nov: "build it so it replicates from the start"): starter delivery
 *  templates by industry, as pack data. A company without a delivery template takes one (pulse.delivery_template_adopt,
 *  1485) and Pulse lays its stages and steps out on a project from the kick-off, exactly as for the first company's own
 *  template: stages, phases, owners and status are the engine's; only the names, packages and categories change per
 *  business. Every word here is a starting point the company can rename. Stage 0 is the hand-over into delivery. */
export type Starter = { key: string; name: string; industry: string; summary: string; packs: string[]; template: Omit<Template, 'key' | 'name'> };

type Row = [id: string, stage: number, title: string, owner: string, start: number, end: number | null, more?: Partial<Step> & { only?: 'full' | 'optional' }];
const LEAD = 'Project lead';
const PACKAGES = [{ key: 'standard', label: 'Standard' }, { key: 'full', label: 'Full service' }];
const CATEGORIES = [{ key: 'small', label: 'Small', units: 0.5 }, { key: 'standard', label: 'Standard', units: 1 }, { key: 'large', label: 'Large', units: 2 }];

function starter(key: string, name: string, industry: string, summary: string, packs: string[], stages: string[], rows: Row[],
  extra: Partial<Omit<Template, 'key' | 'name' | 'stages' | 'steps'>> = {}): Starter {
  const steps: Step[] = rows.map(([id, stage, title, owner, start, end, more = {}]) => {
    const { only, ...rest } = more;
    // A step in both packages unless it is Full service only, or optional in Standard (laid out only when sold).
    const packages = only === 'full' ? { standard: 'no', full: 'yes' } : only === 'optional' ? { standard: 'optional', full: 'yes' } : { standard: 'yes', full: 'yes' };
    return { id, stage, title, kind: id.startsWith('G') ? 'gate' : 'task', start, end, owner, clientInput: false, packages, ...rest };
  });
  return { key, name, industry, summary, packs, template: {
    stages: stages.map((label, n) => ({ n, key: `s${n}`, label })), packages: PACKAGES, categories: CATEGORIES,
    bandwidth: { role: LEAD, short: 'Lead', healthy: [3, 5], max: 6, note: 'A large project counts 2, a small one half' }, milestones: {}, ...extra, steps,
  } };
}
const client = { clientInput: true };

export const STARTERS: Starter[] = [
  starter('simple-project', 'Simple project', 'Any business', 'Kick-off, plan, do the work, review with the client and deliver: five stages for any kind of project.', ['neutral'],
    ['Kick-off', 'Plan', 'Do the work', 'Review', 'Deliver'], [
      ['G0', 0, 'Kick-off: scope and dates agreed', LEAD, 0, 1, { checks: ['What is delivered is written down', 'The client agreed the dates'] }],
      ['P1', 1, 'Plan the work and give each task its doer', LEAD, 1, 3],
      ['W1', 2, 'Do the work', 'Team', 3, 14, { match: ['work', 'make', 'build'] }],
      ['R1', 3, 'Internal review', LEAD, 14, 16],
      ['R2', 3, 'Client review and changes', LEAD, 16, 19, client],
      ['D1', 4, 'Deliver and hand over', LEAD, 19, 21],
      ['D2', 4, 'Close: invoice and feedback', LEAD, 21, 23],
    ]),
  starter('agency-campaign', 'Agency campaign', 'Marketing or creative agency', 'Onboarding, strategy, creative production, launch, optimisation and the monthly report.', ['marketing_agency', 'real_estate_marketing'],
    ['Onboarding', 'Strategy', 'Production', 'Launch', 'Optimise', 'Report'], [
      ['G0', 0, 'Onboarding: brief, access and assets received', LEAD, 0, 2, { checks: ['Brief call done', 'Ad accounts and logins shared', 'Brand assets received'] }],
      ['O1', 0, 'Collect brand assets and logins', 'Account manager', 0, 3, client],
      ['S1', 1, 'Research and competitor scan', 'Strategist', 2, 5, { match: ['research', 'competitor'] }],
      ['S2', 1, 'Strategy and content plan', 'Strategist', 4, 7, { match: ['strategy', 'content plan', 'calendar'] }],
      ['G1', 1, 'Approval: plan signed off by the client', LEAD, 7, 8, client],
      ['C1', 2, 'Scripts and copy', 'Copywriter', 8, 11, { match: ['script', 'copy', 'caption'], asset: 'CP' }],
      ['C2', 2, 'Design the creatives', 'Designer', 9, 14, { match: ['design', 'creative', 'post', 'banner'], asset: 'IMG' }],
      ['C3', 2, 'Edit the videos', 'Video editor', 9, 16, { match: ['video', 'reel', 'edit'], asset: 'VID', only: 'optional' }],
      ['C4', 2, 'Client review of the creatives', 'Account manager', 15, 17, client],
      ['L1', 3, 'Set up campaigns and tracking', 'Performance marketer', 16, 18, { match: ['campaign', 'pixel', 'tracking'] }],
      ['L2', 3, 'Campaign live', 'Performance marketer', 18, 19],
      ['P1', 4, 'Optimise every week', 'Performance marketer', 19, null, { only: 'full' }],
      ['R1', 5, 'Monthly report to the client', 'Account manager', 28, 30, { match: ['report'] }],
    ], { milestones: { adsLive: 'L2', script: 'C1' }, labels: { adsLive: 'Live' }, creativeColumns: ['Script', 'Making', 'Review', 'Ready', 'Live'] }),
  starter('video-production', 'Video production', 'Video and film production', 'Brief, pre-production, shoot, edit, client review and delivery of the final cuts.', ['real_estate_marketing', 'marketing_agency'],
    ['Brief', 'Pre-production', 'Shoot', 'Edit', 'Review', 'Deliver'], [
      ['G0', 0, 'Brief: what, for whom and by when', LEAD, 0, 1, client],
      ['V1', 1, 'Script and storyboard', 'Writer', 1, 4, { match: ['script', 'storyboard'] }],
      ['V2', 1, 'Locations, crew and schedule', 'Producer', 2, 5],
      ['V3', 2, 'Shoot day', 'Director', 6, 7, { match: ['shoot'] }],
      ['V4', 3, 'Rough cut', 'Video editor', 7, 10, { match: ['rough cut', 'edit'], asset: 'VID' }],
      ['V5', 3, 'Colour, sound and graphics', 'Video editor', 10, 12, { only: 'full' }],
      ['G1', 4, 'Review: client approves the cut', LEAD, 12, 14, client],
      ['V6', 5, 'Deliver the final files', LEAD, 14, 15],
    ], { creativeColumns: ['Script', 'Shoot', 'Rough cut', 'Review', 'Ready', 'Delivered'] }),
  starter('interior-fitout', 'Interior design and fit-out', 'Interior design and fit-out', 'Site visit, concept, drawings and bill of quantities, procurement, site work and handover.', ['real_estate_developer'],
    ['Brief', 'Concept', 'Design and BOQ', 'Procurement', 'Site work', 'Handover'], [
      ['G0', 0, 'Brief: site visit and measurements', LEAD, 0, 3, client],
      ['I1', 1, 'Concept and mood boards', 'Designer', 3, 8, { match: ['concept', 'mood'] }],
      ['G1', 1, 'Approval: concept signed off', LEAD, 8, 10, client],
      ['I2', 2, 'Working drawings', 'Designer', 10, 18, { match: ['drawing', 'layout'] }],
      ['I3', 2, 'Bill of quantities and quote', 'Estimator', 15, 20, { match: ['boq', 'quantities', 'estimate'] }],
      ['I4', 3, 'Order materials and book vendors', 'Procurement', 20, 30, { match: ['order', 'vendor', 'material'] }],
      ['I5', 4, 'Civil and carpentry work', 'Site supervisor', 30, 60, { match: ['carpentry', 'civil', 'site'] }],
      ['I6', 4, 'Finishes, lights and furnishing', 'Site supervisor', 55, 70],
      ['G2', 5, 'Handover: snag list closed', LEAD, 70, 75, { clientInput: true, checks: ['Snag list walked with the client', 'Every snag closed', 'Warranty papers handed over'] }],
    ]),
  starter('construction-works', 'Construction works', 'Construction and civil contractors', 'Award, mobilise, foundation, structure, finishing and handover, with gates for approvals.', ['real_estate_developer'],
    ['Award', 'Mobilise', 'Foundation', 'Structure', 'Finishing', 'Handover'], [
      ['G0', 0, 'Award: contract and drawings received', LEAD, 0, 3],
      ['K1', 1, 'Site set-up and permissions', 'Site engineer', 3, 10, { match: ['permission', 'set-up', 'setup'] }],
      ['K2', 1, 'Labour and material plan', 'Planner', 3, 10],
      ['K3', 2, 'Excavation and foundation', 'Site engineer', 10, 30, { match: ['foundation', 'excavation'] }],
      ['G1', 2, 'Inspection: foundation passed', LEAD, 30, 32],
      ['K4', 3, 'Structure and slabs', 'Site engineer', 32, 90, { match: ['slab', 'structure', 'column'] }],
      ['K5', 4, 'Masonry, plumbing and electricals', 'Site engineer', 80, 120],
      ['K6', 4, 'Finishing and painting', 'Site engineer', 110, 140],
      ['G2', 5, 'Handover: completion certificate', LEAD, 140, 150, client],
    ]),
  starter('software-build', 'Software or website build', 'Software, apps and websites', 'Discovery, design, build, test and launch, with the client signing off the design and the release.', ['neutral'],
    ['Kick-off', 'Discovery', 'Design', 'Build', 'Test', 'Launch'], [
      ['G0', 0, 'Kick-off: goals and scope agreed', LEAD, 0, 2, client],
      ['W1', 1, 'Requirements and user journeys', 'Analyst', 2, 7, { match: ['requirement', 'journey', 'spec'] }],
      ['W2', 2, 'Wireframes and design', 'Designer', 7, 14, { match: ['design', 'wireframe', 'mock'] }],
      ['G1', 2, 'Approval: design signed off', LEAD, 14, 15, client],
      ['W3', 3, 'Build', 'Developer', 15, 35, { match: ['build', 'develop', 'code'] }],
      ['W4', 3, 'Content and integrations', 'Developer', 25, 38, { only: 'full' }],
      ['W5', 4, 'Testing and fixes', 'Tester', 35, 42, { match: ['test', 'bug', 'fix'] }],
      ['G2', 4, 'Release: client accepts the build', LEAD, 42, 44, client],
      ['W6', 5, 'Launch and handover', LEAD, 44, 46, { match: ['launch', 'deploy', 'go live'] }],
    ]),
  starter('event', 'Event', 'Events and experiences', 'Brief, plan, vendors, run-up, the day itself and the wrap-up with the numbers.', ['neutral', 'marketing_agency'],
    ['Brief', 'Plan', 'Vendors', 'Run-up', 'Event day', 'Wrap-up'], [
      ['G0', 0, 'Brief: date, guests and budget', LEAD, 0, 2, client],
      ['E1', 1, 'Venue and run of show', 'Planner', 2, 10, { match: ['venue', 'run of show'] }],
      ['E2', 2, 'Book vendors: food, decor, sound', 'Planner', 8, 20, { match: ['vendor', 'decor', 'catering', 'sound'] }],
      ['E3', 2, 'Invitations and registrations', 'Coordinator', 10, 25, { match: ['invite', 'registration'] }],
      ['E4', 3, 'Final walkthrough and briefings', LEAD, 25, 28],
      ['E5', 4, 'Event day', LEAD, 28, 29],
      ['E6', 5, 'Settle vendors and send the wrap-up', LEAD, 29, 33, { match: ['wrap', 'settle'] }],
    ]),
  starter('consulting-engagement', 'Consulting engagement', 'Consulting and professional services', 'Engagement letter, diagnosis, recommendations, implementation support and the close-out review.', ['consulting'],
    ['Engagement', 'Diagnose', 'Recommend', 'Implement', 'Close'], [
      ['G0', 0, 'Engagement: letter signed and data requested', LEAD, 0, 3, client],
      ['A1', 1, 'Interviews and data review', 'Consultant', 3, 12, { match: ['interview', 'data'] }],
      ['A2', 1, 'Findings', 'Consultant', 10, 15, { match: ['finding', 'analysis'] }],
      ['A3', 2, 'Recommendations deck', 'Consultant', 15, 20, { match: ['recommendation', 'deck'] }],
      ['G1', 2, 'Steering review: client agrees the plan', LEAD, 20, 22, client],
      ['A4', 3, 'Implementation support', 'Consultant', 22, 50, { only: 'full' }],
      ['A5', 4, 'Close-out review and invoice', LEAD, 50, 55],
    ]),
  starter('solar-install', 'Solar installation', 'Solar installers', 'Order, site survey, design and approvals, installation, commissioning and handover.', ['solar'],
    ['Order', 'Survey', 'Design and approvals', 'Install', 'Commission', 'Handover'], [
      ['G0', 0, 'Order: advance received and documents collected', LEAD, 0, 2, client],
      ['Y1', 1, 'Site survey and shadow check', 'Surveyor', 2, 5, { match: ['survey'] }],
      ['Y2', 2, 'System design and bill of materials', 'Designer', 5, 9, { match: ['design', 'bom'] }],
      ['Y3', 2, 'Net-metering and subsidy application', 'Liaison', 5, 20, { match: ['net meter', 'subsidy', 'application'] }],
      ['Y4', 3, 'Material dispatch', 'Store', 9, 12],
      ['Y5', 3, 'Installation', 'Install team', 12, 16, { match: ['install'] }],
      ['Y6', 4, 'Commissioning and inspection', 'Site engineer', 16, 25, { match: ['commission', 'inspection'] }],
      ['G1', 5, 'Handover: app, warranty and final invoice', LEAD, 25, 28, client],
    ]),
];

/** The starters for a company's industry pack first, then the rest; `adopted` are the keys it already has. */
export function startersFor(pack: string | null, adopted: string[]) {
  const mine = (s: Starter) => !!pack && s.packs.includes(pack);
  return [...STARTERS].sort((a, b) => Number(mine(b)) - Number(mine(a))).map((s) => ({
    key: s.key, name: s.name, industry: s.industry, summary: s.summary, suggested: mine(s), adopted: adopted.includes(s.key),
    stages: s.template.stages.map((x) => x.label), steps: s.template.steps.length,
  }));
}
