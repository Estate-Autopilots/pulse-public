/** FLOW-A: "EA · Client project (Creative Strategy)", exactly as Kazuk's master doc (EA Creative Strategist Workflow V1,
 *  confirmed 17 Oct 2026) and the Package-Wise Sprint: Stages 0–6 with the doc's step IDs, owners (the Pod roles),
 *  variants (Package, Segment, Pre-launch), Day-N due dates per package from Day 1 (the day the last critical input is
 *  in), the same-day alerts and the CS scorecard. Data, not permission: a step's gates are only the hard data (the
 *  research meet, project data, footage, the client's confirmation before the shoot); every other wire is context.
 *  Each step names its SOP; the SOP texts are the process write-up, imported read-only from the Drive export by the seed
 *  (seed.ts), not kept in git. Stage 6 has no step IDs in the doc: 6.1 and 6.2 are this template's. */
import type { AlertRule, DueRule, FlowDef, FlowStep, FlowWire, ScoreMetric } from '../types.js';

type Pkg = { starter: number; growth: number; sellout: number };
const byPkg = (s: number, g: number, so: number): Pkg => ({ starter: s, growth: g, sellout: so });
const day = (d: number | Pkg): DueRule => ({ from: 'day1', days: d, ...(typeof d === 'object' ? { field: 'package' } : {}), workdays: true });
const calendar = (d: number): DueRule => ({ from: 'day1', days: d, workdays: false });
const after = (step: string, d: number): DueRule => ({ from: `step:${step}`, days: d, workdays: true });
const role = (r: string) => ({ by: 'role' as const, role: r });
const SO = [{ field: 'package', op: 'eq' as const, value: 'sellout' }];
const GSO = [{ field: 'package', op: 'in' as const, values: ['growth', 'sellout'] }];

const COL: Record<string, number> = { s0: 0, s1: 1, s2: 2, s3: 3, s4: 4, s5: 5, s6: 6 };
const rows: Record<string, number> = {};
function step(id: string, stage: string, module: string, title: string, who: string, more: Partial<FlowStep> = {}): FlowStep {
  const row = rows[stage] = (rows[stage] ?? -1) + 1;
  return { id, stage, module, title, who: role(who), settings: {}, pos: { x: 40 + COL[stage] * 340, y: 90 + row * 150 }, checklist: [], qualityTest: [], inputs: [], when: [], due: null, hours: null, note: null, sop: null, ...more };
}
const sop = (section: string) => ({ processId: null, section });
const w = (from: string, fromPort: string, to: string, toPort: string, notify?: string[], label?: string): FlowWire =>
  ({ from: { step: from, port: fromPort }, to: { step: to, port: toPort }, ...(notify ? { notify } : {}), ...(label ? { label } : {}) });

/** The SOP corpus as the process write-up: key, title, and the exported file it is read from (seed.ts). */
export const EA_WRITEUP: { key: string; title: string; file: string; parent?: string }[] = [
  { key: 'cs-workflow', title: 'EA Creative Strategist Workflow — A to Z (V1)', file: 'EA Creative Strategist Workflow' },
  { key: 'sprint', title: 'EA Project Sprint — Package-Wise', file: 'EA Project Sprint — Package-Wise' },
  { key: 'dr1-initial-study', title: 'Deep Research #1 — Initial Study Before Client Meeting', file: '#1 EA DEEP RESEARCH__#1 - Initial Study Before Client Meeting', parent: 'deep-research' },
  { key: 'dr2-meeting-questions', title: 'Deep Research #2 — Client Meeting Questions', file: '#1 EA DEEP RESEARCH__#2 - EA Deep Research — Client Meeting Questions', parent: 'deep-research' }, // gitleaks:allow (a template step key, not a secret)
  { key: 'dr3-deep-research', title: 'Deep Research #3 — EA Deep Research', file: '#1 EA DEEP RESEARCH__#3 - EA DEEP RESEARCH', parent: 'deep-research' },
  { key: 'dr4-pre-launch', title: 'Deep Research #4 — Pre-Launch Notes', file: '#1 EA DEEP RESEARCH__#4 - Pre-Launch Notes — Deep Research', parent: 'deep-research' }, // gitleaks:allow (a template step key, not a secret)
  { key: 'competitor-philosophy', title: 'Competitor Philosophy', file: '#2 Competitor Philosophy__EA Competitor Philosophy' },
  { key: 'competitor-pre-launch', title: 'Pre-Launch Notes — Competitor Philosophy', file: '#2 Competitor Philosophy__PRE-LAUNCH NOTES — COMPETITOR PHILOSOPHY', parent: 'competitor-philosophy' },
  { key: 'usp-map', title: 'Project USP Map — CS Defined', file: '#3 USP Map — CS Defined__PROJECT USP MAP — CS DEFINED' },
  { key: 'buyer-persona', title: 'Buyer Persona Strategy', file: '#4 Buyer Persona Strategy__#4 — Buyer Persona Strategy' },
  { key: 'positioning', title: 'Positioning', file: '#5 positioning__EA POSITIONING' },
  { key: 'swipe-premium', title: 'Positioning swipe file 01 — Premium residential', file: '#5 positioning__PROJECT POSITIONING SWIPE FILE__01 — PREMIUM RESIDENTIAL', parent: 'positioning' },
  { key: 'swipe-lux', title: 'Positioning swipe file 02 — Lux residential', file: '#5 positioning__PROJECT POSITIONING SWIPE FILE__02 — LUX RESIDENTIAL', parent: 'positioning' },
  { key: 'swipe-affordable', title: 'Positioning swipe file 03 — Affordable residential', file: '#5 positioning__PROJECT POSITIONING SWIPE FILE__03 — AFFORDABLE RESIDENTIAL', parent: 'positioning' },
  { key: 'swipe-plotting', title: 'Positioning swipe file 04 — Plotting', file: '#5 positioning__PROJECT POSITIONING SWIPE FILE__04 — PLOTTING', parent: 'positioning' },
  { key: 'swipe-commercial', title: 'Positioning swipe file 05 — Commercial', file: '#5 positioning__PROJECT POSITIONING SWIPE FILE__05 — COMMERCIAL', parent: 'positioning' },
  { key: 'swipe-villas', title: 'Positioning swipe file 06 — Villas, bungalows & row houses', file: '#5 positioning__PROJECT POSITIONING SWIPE FILE__06 — VILLAS, BUNGALOWS & ROW HOUSES', parent: 'positioning' },
  { key: 'segmentwise-tips', title: 'Segment-wise tips', file: '#5 positioning__SegmentWise Tips', parent: 'positioning' },
  { key: 'word-library', title: 'Project Word Library', file: '#6 Project Word Library__#6 — Project Word Library' },
  { key: 'big-idea-1', title: 'Big Idea #1 — Understanding & Examples', file: '#7 Big Idea__#1 — EA Big Idea — Understanding & Examples', parent: 'big-idea' },
  { key: 'big-idea-2', title: 'Big Idea #2 — Working Framework & AI Assistance', file: '#7 Big Idea__#2 — EA Big Idea — Working Framework & AI Assistance', parent: 'big-idea' },
  { key: 'big-idea-pre-launch', title: 'Pre-Launch Notes — Big Idea', file: '#7 Big Idea__Pre-Launch Notes — Big Idea', parent: 'big-idea' },
  { key: 'cma-map', title: 'Creative Message Architecture #0 — The Map', file: '#8 Creative Message Architecture__#0 - Creative Message Architecture — The Map' },
  { key: 'sica-1', title: '#1 SICA Philosophy (single image / carousel)', file: '#8 Creative Message Architecture__#1 - SICA Philosophy__#1 - SICA Philosophy', parent: 'cma-map' },
  { key: 'vov-2', title: '#2 VOV Philosophy', file: '#8 Creative Message Architecture__#2 - EA VOV Philosophy__#2 - EA VOV Philosophy', parent: 'cma-map' },
  { key: 'model-video-3a', title: '#3A Model Video: Affordable & Mid', file: '#8 Creative Message Architecture__#3 - EA Model-Led Video__#3A — EA Model Video: Affordable & Mid', parent: 'cma-map' },
  { key: 'model-video-3b', title: '#3B Model Video: Premium & Luxury', file: '#8 Creative Message Architecture__#3 - EA Model-Led Video__#3B — EA Model Video: Premium & Luxury', parent: 'cma-map' },
  { key: 'model-video-3c', title: '#3C Multi-Persona Model Video', file: '#8 Creative Message Architecture__#3 - EA Model-Led Video__#3C — EA Multi-Persona Model Video', parent: 'cma-map' },
  { key: 'landing-page-4', title: '#4 Landing Page SOPs', file: '#8 Creative Message Architecture__#4 — EA LANDING PAGE__#4 — EA Landing Page SOPs', parent: 'cma-map' },
  { key: 'founder-5', title: '#5 Founder Video', file: '#8 Creative Message Architecture__#5 - EA Founder Video__#5 — EA Founder Video', parent: 'cma-map' },
  { key: 'walkthrough-6', title: '#6 Model-Led Walkthrough', file: '#8 Creative Message Architecture__#6 - EA Model-Led Walkthrough__#6 - EA Model-Led Walkthrough', parent: 'cma-map' }, // gitleaks:allow (a template step key, not a secret)
  { key: 'testimonial-7', title: '#7 Client Video Testimonial', file: '#8 Creative Message Architecture__#7 - EA Client Video Testimonial__#7 - EA Client Video Testimonial', parent: 'cma-map' },
  { key: 'testimonial-system-0', title: 'Testimonials system #0', file: '#8 Creative Message Architecture__#7 - EA Client Video Testimonial__Client Video Testimonials System__#0 - This System alone 2X Your Site Visit & Book', parent: 'testimonial-7' },
  { key: 'micro-event-1', title: 'Testimonials system #1 — Micro event', file: '#8 Creative Message Architecture__#7 - EA Client Video Testimonial__Client Video Testimonials System__#1 - MICRO EVENT SYSTEM – CLIENT TESTIMONIAL COL', parent: 'testimonial-7' },
  { key: 'testimonial-method-2', title: 'Testimonials system #2 — Collection method 2', file: '#8 Creative Message Architecture__#7 - EA Client Video Testimonial__Client Video Testimonials System__#2 - CLIENT TESTIMONIAL COLLECTION – METHOD 2', parent: 'testimonial-7' },
  { key: 'brand-film-10-1', title: 'Brand Film #10.1 — Discovery & Research', file: '#8 Creative Message Architecture__#8 - Brand Film__#10.1 — EA Brand Film: Discovery & Research', parent: 'cma-map' },
  { key: 'brand-film-10-2', title: 'Brand Film #10.2 — Big Idea & Scripting', file: '#8 Creative Message Architecture__#8 - Brand Film__#10.2 — EA Brand Film: Big Idea & Scripting', parent: 'brand-film-10-1' }, // gitleaks:allow (a template step key, not a secret)
  { key: 'brand-film-10-3', title: 'Brand Film #10.3 — Casting', file: '#8 Creative Message Architecture__#8 - Brand Film__#10.3 — EA Brand Film: Casting', parent: 'brand-film-10-1' }, // gitleaks:allow (a template step key, not a secret)
  { key: 'brand-film-10-4', title: 'Brand Film #10.4 — Rehearsal & Shoot', file: '#8 Creative Message Architecture__#8 - Brand Film__#10.4 — EA Brand Film: Rehearsal & Shoot ', parent: 'brand-film-10-1' }, // gitleaks:allow (a template step key, not a secret)
  { key: 'brand-film-10-5', title: 'Brand Film #10.5 — Edit & Approvals', file: '#8 Creative Message Architecture__#8 - Brand Film__#10.5 — EA Brand Film: Edit & Approvals', parent: 'brand-film-10-1' }, // gitleaks:allow (a template step key, not a secret)
  { key: 'lead-nurture-9', title: '#9 Lead Nurture Sequence: WhatsApp & Email', file: '#8 Creative Message Architecture__#9 - EA Lead Nurture Sequence: WhatsApp & Email__#9 - EA Lead Nurture Sequence: WhatsApp & Email', parent: 'cma-map' },
  { key: 'sales-opener-10', title: '#10 Sales Opener', file: '#8 Creative Message Architecture__#10 - EA Sales Opener__#10 — EA Sales Opener', parent: 'cma-map' },
];

const WCC = ['Every claim has a confirmed fact with its source', 'No word the Word Library says to avoid', 'Nothing against a Known Product Constraint', 'Figures agree across the three drafts', 'Offers are approved for ads and inside their dates', 'Pre-launch: an EOI is never called a booking; provisional facts are not ad facts'];
const SPRINT_INPUTS = [
  { key: 'brochure', label: 'Brochure, renders, master plan, floor plans for every configuration' },
  { key: 'pricing', label: 'Latest price sheet, payment plan, verified offers with end dates' },
  { key: 'rera', label: 'MahaRERA registration details' },
  { key: 'location', label: 'Location pin, nearby landmarks, any approved distance data' },
  { key: 'past_creatives', label: 'Existing creatives and past ad results, if any' },
  { key: 'sales_access', label: 'Sales team access for buyer insights (Deep Research)' },
  { key: 'ad_access', label: 'Ad account and page access (for the PGS)' },
  { key: 'brand_assets', label: 'Brand assets (logo, colours, fonts); Sell-Out: existing brand assets, if any' },
  { key: 'founder_dates', label: 'Founder availability dates', when: SO },
  { key: 'past_buyers', label: 'List of past buyers for testimonials', when: SO },
  { key: 'brand_decider', label: 'Brand identity decision-maker', when: SO },
].map((x) => ({ ...x, critical: true, owner: 'gs' }));

const steps: FlowStep[] = [
  // Stage 0 — Client assigned & set up (before the CS starts)
  step('0.1', 's0', 'assign', 'Assign the client to a GS (or keep it)', 'gs_head', { settings: { roles: ['gs', 'cs'] }, sop: sop('cs-workflow'),
    checklist: ['Name the GS in Pulse (or keep it)', 'Name the CS'] }),
  step('0.2', 's0', 'intake', 'Intro call; invite to the onboarding call; ask for the basic project details (Sprint checklist)', 'gs', { settings: { items: SPRINT_INPUTS }, sop: sop('sprint'),
    checklist: ['Intro call with the client', 'Invite to the onboarding + research meet', 'Ask for every critical input', 'One approver per client, named on Day 1'] }),
  step('0.3', 's0', 'workspace', 'Create the client Drive folder + subfolders (incl. Research & Scripting and Project Blueprint) and the WhatsApp group', 'ac', { sop: sop('cs-workflow'),
    settings: { folders: ['Research & Scripting', 'Project Blueprint', 'Brand Film / Legal'], group: 'Client WhatsApp group' },
    checklist: ['Client folder with Research & Scripting and Project Blueprint', 'WhatsApp group with the client and the pod', 'Access for the pod'] }),
  step('0.4', 's0', 'schedule', 'Fix the onboarding + research meet slot: client time and CS time aligned', 'gs', { sop: sop('dr2-meeting-questions'),
    settings: { field: 'research_meet', people: ['gs', 'cs'], length: 75 }, checklist: ['One calendar slot: onboarding (5–10 min intro) then the research meet', 'The CS\'s time is aligned'] }),
  // Stage 1 — Study & research meet
  step('1.1', 's1', 'doc', 'Create the Project Blueprint doc in the Project Blueprint folder', 'cs', { sop: sop('dr1-initial-study'),
    settings: { template: 'Project Blueprint', title: 'Project Blueprint', sections: ['Initial Observations', 'Deep Research', 'Competitor', 'USP Map', 'Persona', 'Positioning', 'Word Library'] } }),
  step('1.2', 's1', 'doc_section', 'Initial study: brochure, plans, location, reviews, EA\'s past work. Write Initial Observations + extra questions', 'cs', { sop: sop('dr1-initial-study'),
    settings: { docStep: '1.1', section: 'Initial Observations' }, hours: byPkg(2, 2, 2.5), checklist: ['Brochure and plans', 'Location on Google Maps', 'Reviews', 'EA\'s past work (Test & Learning Log, Evidence Library)', 'Initial Observations + extra questions', 'Done before any AI use'] }),
  step('1.3', 's1', 'meeting', 'Onboarding + research meet (Google Meet; recorded)', 'cs', { sop: sop('dr2-meeting-questions'), due: day(1), hours: byPkg(1, 1.5, 2),
    settings: { tags: ['ARCHITECT / DEVELOPER FOLLOW-UP REQUIRED', 'PENDING', 'CONFLICT'], people: ['gs', 'cs'] }, note: 'The GS runs the onboarding; the CS runs the research.',
    checklist: ['Record the meeting', 'GS runs the onboarding (5–10 min)', 'CS runs the research questions', 'Offers stay PENDING until approved for ads'] }),
  step('1.4', 's1', 'transcribe', 'Save the transcript (own laptop recording or Wispr Flow) as Client Research Meet Details; score the client in Pulse', 'cs', { sop: sop('dr2-meeting-questions'), due: day(1),
    settings: { score: true }, checklist: ['Transcript saved as Client Research Meet Details in Research & Scripting', 'Client scored: information quality and behaviour'] }),
  step('1.5', 's1', 'open_items', 'Log follow-ups (ARCHITECT / DEVELOPER FOLLOW-UP REQUIRED) and missing inputs', 'cs', { sop: sop('dr3-deep-research'), due: day(1),
    checklist: ['Every follow-up with its tag and owner', 'Missing inputs listed', 'The GS chases the client'] }),
  // Stage 2 — Project Blueprint (drafts in Research & Scripting; only checked, final content in the Blueprint)
  step('2.1', 's2', 'doc_section', 'Deep Research 1.1–1.5 (+1.6 if pre-launch); Known Product Constraints → GS → client', 'cs', { sop: sop('dr3-deep-research'), due: day(byPkg(2, 2, 3)), hours: byPkg(5.5, 6.5, 7.5),
    settings: { docStep: '1.1', section: 'Deep Research', recordType: 'fact' },
    checklist: ['1.1 overview table', '1.2 intelligence', '1.3 location and buyer table', '1.4 sales / CP', '1.5 Known Product Constraints and attention drivers', '1.6 pre-launch additions (pre-launch only)', 'A source label on every point; PENDING / CONFLICT / FOLLOW-UP tags', 'The 2-minute test'] }),
  step('2.2', 's2', 'doc_section', 'Competitor Philosophy (3–5)', 'cs', { sop: sop('competitor-philosophy'), due: day(byPkg(3, 3, 4)), hours: byPkg(2.5, 3, 3.5), settings: { docStep: '1.1', section: 'Competitor', recordType: 'competitor' },
    checklist: ['3–5 competitors within ~3 km and the same ticket band', '11 fields each, with sources and the date checked', 'No comparisons or positioning in this stage'] }),
  step('2.3', 's2', 'doc_section', 'USP Map (5–6, priority + proof)', 'cs', { sop: sop('usp-map'), due: day(byPkg(3, 4, 5)), hours: byPkg(2, 2, 2.5), settings: { docStep: '1.1', section: 'USP Map', recordType: 'usp' },
    checklist: ['5–6 USPs: strength → meaning → proof (source)', 'Proof exists; no Known Product Constraint conflict', '"To Verify" items stay out of the top 3', 'CS only (no AI)'] }),
  step('2.4', 's2', 'doc_section', 'Buyer Persona Strategy (+ Persona Immersion for ₹3 Cr+ / NRI)', 'cs', { sop: sop('buyer-persona'), due: day(byPkg(4, 4, 5)), hours: byPkg(2.5, 3, 4), settings: { docStep: '1.1', section: 'Persona', recordType: 'persona' },
    checklist: ['3–5 personas, fields 1–5 required', 'Overall and stage priority P1 / P2 / P3', 'Persona Language Bank with source and status'] }),
  step('2.5', 's2', 'doc_section', 'Positioning (common + persona-wise + Why-Now Lever)', 'cs', { sop: sop('positioning'), due: day(byPkg(4, 5, 6)), hours: byPkg(3, 3.5, 4), settings: { docStep: '1.1', section: 'Positioning', recordType: 'positioning' },
    qualityTest: ['Segment fit', 'Proof', 'Constraints', 'Specificity', 'Durability'] }),
  step('2.6', 's2', 'word_library', 'Word Library V1 → GS shares it with the client\'s Sales + CPs; Blueprint + Word Library to the SME (G, SO)', 'cs', { sop: sop('word-library'), due: day(byPkg(4, 5, 6)), hours: byPkg(1.5, 2, 2.5),
    checklist: ['10–20 rows: use / avoid / scope / why', 'Every change versioned and dated', 'GS shares it with Sales and CPs', 'Blueprint + Word Library to the SME (Growth, Sell-Out)'] }),
  step('2.7', 's2', 'share_review', 'Blueprint done: client informed (package-wise; Sell-Out: Blueprint call + approval)', 'gs', { sop: sop('sprint'), due: day(byPkg(4, 5, 6)), hours: byPkg(1.5, 2, 2),
    settings: { finishWhen: { starter: 'sent', growth: 'sent', sellout: 'confirmed' }, tag: ['client', 'gs'], slaDays: 3 },
    note: 'Starter / Growth: the GS tells the client the Blueprint is done; the client sees the strategy through the creatives. Sell-Out: the CS explains the whole Blueprint one-on-one (GS joins), takes the client\'s guidelines, then gets final approval. Nobody waits for it: copywriting starts as soon as Positioning and the Word Library are ready.' }),
  // Stage 3 — First curiosity set (every package): one Google Doc per creative, named by Asset ID, three tabs
  step('3.1', 's3', 'big_idea', 'Big Idea per creative + hook plan', 'cs', { sop: sop('big-idea-2'), due: day(byPkg(6, 7, 9)), hours: byPkg(3.5, 3.5, 4.5),
    qualityTest: ['Rule of One', 'Specific', 'Believable', 'Proof exists', 'Persona fit', 'Stage valid', 'Buyer voice'], checklist: ['Several directions with AI, then step away before choosing', 'A hook plan with the lead type per hook'] }),
  step('3.2', 's3', 'asset', 'Model Video doc (3 tabs), #3A or #3B by segment (#3C if multi-persona)', 'cs', { sop: sop('model-video-3a'), hours: byPkg(7, 7, 8.5),
    settings: { assetType: 'Model Video', hooks: 4, tabs: ['Script', 'Videographer notes', 'Editor notes'] }, note: '#3A for Affordable / Mid, #3B for Premium / Luxury, #3C when the video speaks to 2–3 personas.' }),
  step('3.3', 's3', 'asset', 'First VOV teaser doc (3 tabs)', 'cs', { sop: sop('vov-2'), hours: byPkg(3.5, 3.5, 3.5), settings: { assetType: 'VOV', hooks: 4, tabs: ['Script', 'Videographer notes', 'Editor notes'] } }),
  step('3.4', 's3', 'asset', 'First image ad set doc (Copy + Designer Notes)', 'cs', { sop: sop('sica-1'), hours: byPkg(3.5, 3.5, 3.5), settings: { assetType: 'Image set', tabs: ['Copy', 'Designer notes'] } }),
  step('3.5', 's3', 'check', 'Words, Claims & Constraints check on all three', 'cs', { sop: sop('dr3-deep-research'), qualityTest: WCC }),
  step('3.6', 's3', 'share_review', 'First drop: draft links for all three posted in the client WhatsApp group, tagging the client and the GS. Sales Opener Brief draft ready', 'cs', { sop: sop('sales-opener-10'),
    due: day(byPkg(8, 10, 14)), settings: { finishWhen: 'sent', tag: ['client', 'gs'], channel: 'Client WhatsApp group' }, checklist: ['Draft links for all three', 'Tag the client and the GS', 'Sales Opener Brief draft ready'] }),
  step('3.7', 's3', 'meeting', 'Client review meeting (when needed). Covers the scripts, the Sales Opener and, in Sell-Out, the whole Blueprint. Whether the client\'s team adopts the Sales Opener is recorded', 'gs', {
    sop: sop('sales-opener-10'), settings: { optional: true, people: ['gs', 'cs'] }, inputs: [{ port: 'slot', owner: role('gs'), label: 'The review meeting\'s time (when one is needed)' }],
    note: 'The GS arranges it with the client, or the CS arranges it directly. Record "Sales Opener adopted: Y/N".' }),
  step('3.8', 's3', 'share_review', 'CS makes all the changes and sends the updated drafts in the group → the GS secures the client\'s final confirmation', 'cs', { sop: sop('sprint'), due: after('3.6', 3),
    settings: { finishWhen: 'confirmed', tag: ['client', 'gs'], slaDays: 3 }, note: 'The CS makes the changes; the GS secures the confirmation (3 working days).' }),
  step('3.9', 's3', 'pack', 'Finals into the Project Blueprint folder, arranged for the client\'s sales team. The GS sends the Sales Opener Brief doc', 'cs', { sop: sop('sales-opener-10'), due: after('3.8', 1),
    hours: byPkg(1.5, 1.5, 1.5), settings: { pack: 'Sales Opener Brief', sections: ['Campaign / Creative', 'Persona Hypothesis', 'Positioning', 'What to Validate', 'Suggested Opener', 'Key Discovery Question', 'If Confirmed', 'If Rejected'] }, checklist: ['Finals in the Project Blueprint folder', 'Sales Opener Brief written (one doc per project)', 'The GS sends it within 1 working day'] }),
  step('3.10', 's3', 'shoot', 'Shoot scheduled by the Project Coordinator (model, videographer, location); shoot (Model Video, VOV) and design (image set)', 'pc', { sop: sop('vov-2'),
    checklist: ['Model, videographer and location booked', 'Call sheet out', 'Designer has the Copy + Designer Notes'] }),
  step('3.11', 's3', 'edit', 'First edit', 've', { sop: sop('model-video-3a'), checklist: ['From the Editor Notes tab', 'Rough cut linked to its Asset ID'] }),
  step('3.12', 's3', 'session', '2 PM Creative Brainstorming Session on the rough cut: is the intended emotion landing in the shoot and edit; what to improve', 'cs', { sop: sop('vov-2'),
    settings: { ritual: '2 PM Creative Brainstorming Session', every: 'day', at: '14:00', agenda: 'rough_cut', people: ['cs', 'gs', 've'] },
    note: 'A brainstorming session, not a review: everyone contributes, and nobody sits in judgement of the editor.', checklist: ['Change list against the Asset ID', 'Owner and date for each change'] }),
  step('3.13', 's3', 'media_review', 'Final edit → CS freezes → final link', 've', { sop: sop('model-video-3a'), checklist: ['Changes from the 2 PM session done', 'The CS freezes it', 'Final link on the asset'] }),
  step('3.14', 's3', 'sequence', 'Launch handoff: Asset IDs + WhatsApp (± email) Sequence Pack', 'cs', { sop: sop('lead-nurture-9'), due: calendar(30), hours: byPkg(2.5, 4.5, 4.5),
    checklist: ['Asset IDs for every final', 'Sequence Pack: Msg ID, track, day, channel, Asset ID, text, buttons, sent-by', 'Pack to the GS 3 working days before launch'] }),
  // Stage 4 — Landing page (Growth, Sell-Out), GS-owned; CS supports
  step('4.1', 's4', 'doc', 'Landing page copy + build', 'gs', { sop: sop('landing-page-4'), when: GSO, settings: { template: 'Landing page', sections: ['Strategic brief', 'Message Match Map', 'Page copy', 'Thank-you page', 'Forms'] } }),
  step('4.2', 's4', 'check', 'CS check: positioning, message match with the live creatives, Word Library, claims', 'cs', { sop: sop('landing-page-4'), when: GSO, hours: 1.5,
    qualityTest: ['Positioning holds', 'Message match with the live creatives', 'Word Library', 'Claims'] }),
  step('4.3', 's4', 'checklist', 'Page live', 'gs', { sop: sop('landing-page-4'), when: GSO, checklist: ['Deployed', 'Every form tested after deploy', 'UTM on every link'] }),
  // Stage 5 — Trust assets (Sell-Out, after the first curiosity set)
  step('5.1', 's5', 'asset', 'Walkthrough: Configuration Thesis, brief, cue sheet, Presenter Brief Pack', 'cs', { sop: sop('walkthrough-6'), when: SO, due: calendar(28), hours: 5.5,
    settings: { assetType: 'Walkthrough', tabs: ['Configuration Thesis', 'Brief', 'Cue sheet', 'Presenter Brief Pack'] }, note: 'To the Project Coordinator (Brief Pack 2–3 days before the shoot), the presenter and the videographer.' }),
  step('5.2', 's5', 'asset', 'Founder Video: Trust Objective, speaker, questions + instructions', 'cs', { sop: sop('founder-5'), when: SO, due: calendar(42), hours: 5,
    settings: { assetType: 'Founder Video', tabs: ['Trust Objective', 'Question plan', 'Instructions'] }, note: 'To the Project Coordinator (arranges the founder, setting, archival material).' }),
  step('5.3', 's5', 'asset', 'Client Testimonials: Coverage Matrix, Testimonial Thesis, questions + instructions', 'cs', { sop: sop('testimonial-7'), when: SO, due: calendar(42), hours: 7,
    settings: { assetType: 'Testimonial', tabs: ['Coverage Matrix', 'Testimonial Thesis', 'Questions', 'Instructions'] }, note: 'To the Project Coordinator (invites, micro-event, consent forms). Signed consent per channel is a gate before anything is used.' }),
  step('5.4', 's5', 'media_review', 'Interviews / shoots → edit → 2 PM session → approvals', 'cs', { sop: sop('founder-5'), when: SO, due: calendar(49),
    inputs: [{ port: 'media', owner: role('pc'), label: 'Interview and shoot footage' }], note: 'CS + videographer + editor; the speaker or developer approves the cut.' }),
  step('5.5', 's5', 'pack', 'Activation Packs + update the Sequence Pack and Sales Opener routes', 'cs', { sop: sop('lead-nurture-9'), when: SO, due: after('5.4', 2), hours: 3.5, settings: { pack: 'Activation Pack' } }),
  step('5.6', 's5', 'asset', 'Brand Film (5 stages with the outsourced director)', 'cs', { sop: sop('brand-film-10-1'), when: SO, due: calendar(70), hours: 30,
    settings: { assetType: 'Brand Film', tabs: ['Discovery Brief', 'Script (scene table)', 'Casting', 'Shoot', 'Edit + approvals'] },
    checklist: ['10.1 Discovery & research (Gate 1: client approves the brief)', '10.2 Big Idea & scripting (Gate 2: max 2 revision rounds)', '10.3 Casting', '10.4 Rehearsal & shoot', '10.5 Edit & approvals (Gates 3 and 4)'] }),
  // Stage 6 — The weekly rhythm (ongoing). The 2 PM session runs per creative (3.12); the daily update is each person's.
  step('6.1', 's6', 'session', 'Monday Pod Meeting (10:30): performance on creatives launched 10–15 days earlier; decides the next batch', 'gs', { sop: sop('cs-workflow'),
    settings: { ritual: 'Pod Meeting', every: 'week', at: 'Mon 10:30', agenda: 'live', optional: true, people: ['cs', 'gs', 've'] }, checklist: ['Verdict per Asset ID', 'Sales feedback: were the personas right? which objections came up?', 'Next batch decided'] }),
  step('6.2', 's6', 'request', 'New creative requests (month 2+, Growth top-ups, extra Model Videos): the GS raises them, the CS answers with a first-drop date', 'gs', { sop: sop('cs-workflow'),
    settings: { optional: true }, checklist: ['GS raises it: client, creative type, why', 'CS replies with availability and the first-drop date', 'GS tells the client', 'The work runs Stage 3 from 3.1, without rebuilding the Blueprint'] }),
];

const wires: FlowWire[] = [
  w('0.1', 'team', '0.2', 'in'), w('0.1', 'team', '0.3', 'in'), w('0.1', 'team', '0.4', 'in', ['cs']),
  w('0.4', 'slot', '1.1', 'in', ['cs'], 'Slot fixed'), w('0.4', 'slot', '1.3', 'slot', ['cs', 'gs']), w('0.3', 'workspace', '1.1', 'context'),
  w('1.1', 'doc', '1.2', 'in'), w('0.2', 'inputs', '1.2', 'context', undefined, 'Basic details'),
  w('1.3', 'talk', '1.4', 'talk'), w('1.4', 'transcript', '1.5', 'in'), w('1.3', 'followups', '1.5', 'context'),
  // The research meet is the CS's hard block; everything else in the Blueprint is context.
  ...['2.1', '2.2', '2.3', '2.4', '2.5'].map((s) => w('1.4', 'transcript', s, 'in', undefined, 'Research meet done')), w('1.4', 'transcript', '2.6', 'in', undefined, 'Research meet done'),
  w('1.2', 'section', '2.1', 'context'), w('1.5', 'items', '2.1', 'context', ['gs'], 'Follow-ups for the GS to chase'),
  w('2.1', 'section', '2.2', 'context', ['gs'], 'Known Product Constraints → GS'), w('2.1', 'section', '2.3', 'context'), w('2.2', 'section', '2.3', 'context'),
  w('2.1', 'section', '2.4', 'context'), w('2.3', 'section', '2.4', 'context'), w('2.3', 'section', '2.5', 'context'), w('2.4', 'section', '2.5', 'context'), w('2.5', 'section', '2.6', 'context'),
  w('2.5', 'section', '2.7', 'drafts'), w('2.6', 'words', '2.7', 'drafts', ['gs', 'sme'], 'Word Library → Sales, CPs, SME'),
  w('2.5', 'section', '3.1', 'basis', ['cs'], 'Positioning locked'), w('2.4', 'section', '3.1', 'context'), w('2.6', 'words', '3.1', 'context'),
  w('3.1', 'ideas', '3.2', 'idea'), w('3.1', 'ideas', '3.3', 'idea'), w('3.1', 'ideas', '3.4', 'idea'),
  w('3.2', 'asset', '3.5', 'draft'), w('3.3', 'asset', '3.5', 'draft'), w('3.4', 'asset', '3.5', 'draft'),
  w('3.5', 'draft', '3.6', 'drafts'), w('3.6', 'shared', '3.7', 'context', ['gs']), w('3.6', 'shared', '3.8', 'drafts', ['gs'], 'First drop'), w('3.7', 'talk', '3.8', 'context'),
  w('3.8', 'confirmed', '3.9', 'in', ['gs']), w('3.8', 'confirmed', '3.10', 'brief', ['pc'], 'Client confirmed the scripts'),
  w('3.10', 'footage', '3.11', 'raw', ['ve']), w('3.11', 'cut', '3.12', 'items', ['cs', 'gs'], 'Rough cut ready'), w('3.11', 'cut', '3.13', 'media'), w('3.12', 'changes', '3.13', 'changes', ['ve']),
  w('3.13', 'final', '3.14', 'assets', ['gs']), w('3.9', 'pack', '3.14', 'context'),
  w('2.5', 'section', '4.1', 'in'), w('2.6', 'words', '4.1', 'in'), w('3.2', 'asset', '4.1', 'in', ['gs'], 'First Model Video script ready'), w('4.1', 'doc', '4.2', 'draft', ['cs']), w('4.2', 'checked', '4.3', 'in', ['gs']),
  w('3.6', 'shared', '5.1', 'idea', undefined, 'After the first set'), w('3.6', 'shared', '5.2', 'idea'), w('3.6', 'shared', '5.3', 'idea'), w('3.6', 'shared', '5.6', 'idea'),
  w('5.1', 'asset', '5.4', 'context', ['pc']), w('5.2', 'asset', '5.4', 'context', ['pc']), w('5.3', 'asset', '5.4', 'context', ['pc']), w('5.4', 'final', '5.5', 'in', ['gs']),
  w('3.14', 'pack', '6.1', 'items', ['cs', 'gs', 've']), w('3.14', 'pack', '6.2', 'in'),
];

const rules: AlertRule[] = [
  { key: 'inputs_missing', name: 'Inputs missing', when: 'field-missing-by', field: 'research_meet', missing: '0.2', notify: ['gs', 'gs_head'] },
  { key: 'transcript_not_saved', name: 'Transcript not saved', when: 'not-done-by-due', steps: ['1.4'], notify: ['cs', 'gs_head'] },
  { key: 'blueprint_late', name: 'Blueprint late', when: 'not-done-by-due', steps: ['2.7'], notify: ['cs', 'gs', 'gs_head'] },
  { key: 'client_approval_late', name: 'Client approval late', when: 'value-missing-after', after: '3.6', missing: '3.8', waitDays: 3, notify: ['gs', 'cs'] },
  { key: 'blueprint_approval_late', name: 'Client approval late (Blueprint)', when: 'in-state-longer', steps: ['2.7'], state: 'in_review', waitDays: 3, when2: SO, notify: ['gs', 'cs'] },
  { key: 'sales_opener_not_sent', name: 'Sales Opener not sent', when: 'in-state-longer', steps: ['3.9'], state: 'confirmed', waitDays: 1, notify: ['gs', 'cs'] },
  { key: 'first_drop_late', name: 'First drop late', when: 'not-done-by-due', steps: ['3.6'], notify: ['cs', 'gs', 'gs_head'] },
  { key: 'demand_unanswered', name: 'Demand unanswered', when: 'record-in-status-longer', recordType: 'request', status: 'raised', waitDays: 1, notify: ['cs', 'gs_head'] },
  { key: 'blocked_on_data', name: 'Blocked on data', when: 'blocked-longer', waitDays: 1, notify: ['data-owner'] },
  { key: 'rough_cut_waiting', name: 'Rough cut waiting', when: 'value-missing-after', after: '3.11', missing: '3.12', waitDays: 1, notify: ['cs', 'gs', 've'] },
  { key: 'launch_handoff_missing', name: 'Launch handoff missing', when: 'value-missing-after', after: '3.13', missing: '3.14', waitDays: 0, notify: ['cs', 'gs'] },
  { key: 'foundation_at_risk', name: 'Foundation at risk', when: 'not-done-by-day', steps: ['3.14'], days: 30, workdays: false, notify: ['gs_head', 'gs', 'cs'] },
  { key: 'trust_asset_slipping', name: 'Trust asset slipping', when: 'not-done-by-due', steps: ['5.1', '5.2', '5.3', '5.4', '5.5', '5.6'], when2: SO, notify: ['cs', 'gs_head'] },
];

const scorecard: ScoreMetric[] = [
  { key: 'on_time_blueprint', label: 'On-time Blueprint', kind: 'on-time', steps: ['2.7'], note: '2.7 date vs due' },
  { key: 'on_time_first_drop', label: 'On-time first drop', kind: 'on-time', steps: ['3.6'], note: '3.6 date vs due' },
  { key: 'first_time_confirmation', label: 'First-time client confirmation', kind: 'first-time', steps: ['3.8'], note: '3.8 without a second round of changes' },
  { key: 'changes_after_2pm', label: 'Changes per creative after the 2 PM session', kind: 'revisions', recordType: 'asset', field: 'revisions' },
  { key: 'creative_results', label: 'Creative results (Monday verdict)', kind: 'verdict', recordType: 'asset', field: 'verdict' },
  { key: 'persona_accuracy', label: 'Persona accuracy (Sales confirms the persona)', kind: 'count', recordType: 'persona', field: 'confirmed_by_sales' },
];

export const EA_CREATIVE: { key: string; name: string; summary: string; definition: FlowDef } = {
  key: 'ea_creative', name: 'Client project (creative strategy)',
  summary: 'From the client being assigned to the weekly performance meeting: the Project Blueprint, the first curiosity set, the landing page (Growth, Sell-Out) and the trust assets (Sell-Out). Data, not permission.',
  definition: {
    version: 2,
    fields: [
      { key: 'package', label: 'Package', type: 'choice', variant: true, required: true, options: [{ value: 'starter', label: 'Starter' }, { value: 'growth', label: 'Growth' }, { value: 'sellout', label: 'Sell-Out' }] },
      { key: 'segment', label: 'Segment', type: 'choice', variant: true, options: [{ value: 'affordable', label: 'Affordable' }, { value: 'mid', label: 'Mid' }, { value: 'premium', label: 'Premium' }, { value: 'luxury', label: 'Luxury' }] },
      { key: 'prelaunch', label: 'Pre-launch', type: 'boolean', variant: true },
      { key: 'research_meet', label: 'Onboarding + research meet', type: 'date', help: 'Day 1, if the critical inputs are in' },
      { key: 'approver', label: 'Client approver', type: 'text', help: 'One approver per client, named on Day 1' },
      { key: 'project_code', label: 'Project code (for Asset IDs)', type: 'text' },
    ],
    roles: [
      { key: 'gs_head', label: 'GS Head', note: 'The Pod Head: assigns each client to a GS, settles CS–GS disputes' },
      { key: 'gs', label: 'Growth Strategist', note: 'Owns the client relationship and campaigns' },
      { key: 'cs', label: 'Creative Strategist', note: 'Owns the Project Blueprint and all creative strategy, scripts and notes' },
      { key: 've', label: 'Video Editor' }, { key: 'gd', label: 'Graphic Designer' },
      { key: 'ac', label: 'Access Coordinator', note: 'Drive folders, WhatsApp group, access' },
      { key: 'pc', label: 'Project Coordinator', note: 'Shoots, presenters, founder and buyer logistics, consent' },
      { key: 'vg', label: 'Videographer' }, { key: 'sme', label: 'Social Media Executive' },
      { key: 'client', label: 'Client', note: 'The client\'s own steps are followed up by the GS' },
    ],
    stages: [
      { key: 's0', label: 'Stage 0 · Client assigned & set up' }, { key: 's1', label: 'Stage 1 · Study & research meet' }, { key: 's2', label: 'Stage 2 · Project Blueprint' },
      { key: 's3', label: 'Stage 3 · First curiosity set' }, { key: 's4', label: 'Stage 4 · Landing page (Growth, Sell-Out)' }, { key: 's5', label: 'Stage 5 · Trust assets (Sell-Out)' },
      { key: 's6', label: 'Stage 6 · The weekly rhythm' },
    ],
    steps, wires, rules, scorecard, clock: { from: 'intake', step: '0.2' }, terms: { run: 'Project', runs: 'Projects' },
  },
};

/** FLOW-D: EA's own blocks ("Your company's blocks"): named presets of the primitives, taken from this template's
 *  steps (title, kind, checklist, quality test, write-up part, who, due). The palette itself names no EA work. */
export const EA_BLOCKS: { key: string; name: string; summary: string; step: FlowStep }[] = ([
  ['0.2', 'Sprint inputs (critical inputs)'], ['0.3', 'Client folder and WhatsApp group'], ['0.4', 'Research meet slot'], ['1.1', 'Project Blueprint doc'],
  ['1.2', 'Initial study'], ['1.3', 'Research meet'], ['1.4', 'Research meet transcript + client score'], ['1.5', 'Follow-ups log'],
  ['2.1', 'Deep Research section'], ['2.2', 'Competitor Philosophy'], ['2.3', 'USP Map'], ['2.4', 'Buyer Persona Strategy'], ['2.5', 'Positioning'],
  ['2.6', 'Word Library V1'], ['2.7', 'Blueprint to the client'], ['3.1', 'Big Idea + hook plan'], ['3.2', 'Model Video doc'], ['3.3', 'VOV teaser doc'],
  ['3.4', 'Image ad set doc'], ['3.5', 'Words, Claims & Constraints check'], ['3.6', 'First drop to the client'], ['3.7', 'Client review meeting'],
  ['3.8', 'Changes → client confirmation'], ['3.9', 'Sales Opener Brief'], ['3.10', 'Shoot'], ['3.11', 'First edit'], ['3.12', '2 PM Creative Brainstorming Session'],
  ['3.13', 'Final edit + freeze'], ['3.14', 'Sequence Pack (launch handoff)'], ['4.1', 'Landing page'], ['4.2', 'Landing page check'], ['5.1', 'Walkthrough'],
  ['5.2', 'Founder Video'], ['5.3', 'Client Testimonials'], ['5.4', 'Trust asset edit + approvals'], ['5.5', 'Activation Pack'], ['5.6', 'Brand Film'],
  ['6.1', 'Monday Pod Meeting'], ['6.2', 'New creative requests'],
] as const).map(([id, name]) => {
  const s = steps.find((x) => x.id === id)!;
  return { key: `ea-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, name, summary: s.title, step: { ...s, when: [] } };
});
