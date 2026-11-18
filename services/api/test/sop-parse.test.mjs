import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSop, readTime } from '../dist/sop-parse.js';
import { edges, handoffs, normalizeDoc } from '../dist/sop-model.js';

// Synthetic SOP texts in the shapes EA's real documents take (as the Drive index exports them), never their content.
const TABLE = `Phase 1 — Project Start
Phase 1 — Project Start
Objective
Get the client ready before any work begins.
Deliverables
* Kick-off notes
* Access checklist
Step
\tPGS Tasks / Responsibility
\tKPIs
\t1. Internal Handover
\t• Review the package and the sales notes.• Ensure required brochures, logos and floor plans are available.
\t• Handover reviewed before the call.
\t2. Client Kick-off Call
\t• Run the kick-off call within 2 days of the handover.• Coordinate the research meeting with the Creative Strategist.
\t• Client knows who their contact is.
\t3. Brand Alignment
\t• Assign the Graphic Designer once positioning is clear.• Share the brand files with the designer.
\t• Brand alignment approved.
Phase 2 — Launch
Step
\tPGS Tasks / Responsibility
\tKPIs
\t1. Final Approval
\t• Get the client's sign-off on every asset before launch.
\t• Pending approvals: 0.
\t2. Go Live
\t• Publish the campaign the same day it is approved.
\t• Live on the planned date.
`;

const LIST = `Client Visit Coordination – Process
1. Site Check
   * Confirm the site is ready before planning the visit.
2. Crew Shortlisting (Coordinator)
   * Share 2–3 crew options in the client group within 24 hours.
   * Check availability before sharing.
3. Client Finalization
   * Client selects one option.
4. Is it an outstation visit?
   * If yes, align the client on a same-day plan.
________________


Common Challenges
1. Client not aligning with the options
2. Crew delays on the day
`;

const MULTI = `SOP: Banner
Senior Marketer Coordination With Intern


1. Objective
This SOP defines how the Senior Marketer assigns and approves banner work.
2. Team Structure
* Team 1
Step 1: Share the Requirement
The Senior Marketer shares the client folder link and the format.
Step 2: Prepare Content First
The intern prepares the headline and the call to action.
Step 3: Senior Marketer Review
The Senior Marketer reviews and approves the content.
SOP: Campaign
Check List Before Setup:
#1: Select the objective
#2: Name the campaign
#3: Choose the budget the Senior Marketer gives
`;

test('a step table reads phases, steps, the owner role from the header, KPIs, inputs, handoff roles and times', () => {
  const [p] = parseSop({ title: 'PGS Workflow & Responsibilities', text: TABLE, knownRoles: ['PGS', 'Creative strategist', 'Graphic Designer'] });
  assert.ok(p, 'one SOP');
  assert.deepEqual(p.doc.steps.map((s) => s.title), ['Internal Handover', 'Client Kick-off Call', 'Brand Alignment', 'Final Approval', 'Go Live']);
  assert.deepEqual(p.doc.phases, ['Phase 1 — Project Start', 'Phase 2 — Launch']);
  assert.equal(p.ownerRole, 'PGS');
  assert.ok(p.doc.steps.every((s) => s.role === 'PGS'), 'every step is the PGS\'s');
  assert.deepEqual(p.doc.steps[0].kpis, ['Handover reviewed before the call.']);
  assert.deepEqual(p.doc.steps[0].inputs, ['brochures', 'logos', 'floor plans']);
  assert.ok(p.doc.steps[1].involves.includes('Creative strategist'), 'the strategist is involved');
  assert.equal(p.doc.steps[1].slaHours, 48);
  assert.equal(p.doc.steps[3].kind, 'approval');
  assert.equal(p.doc.steps[4].slaHours, 8, 'same day');
  assert.deepEqual(p.doc.outputs, ['Kick-off notes', 'Access checklist']);
  assert.equal(p.purpose, 'Get the client ready before any work begins.');
  assert.ok(p.confidence >= 0.75, `high confidence: ${p.confidence}`);
  assert.ok(p.evidence.some((e) => /A table of 3 steps/.test(e)));
});

test('numbered steps with bullets: roles from the title, decisions, SLAs and the challenges kept apart', () => {
  const parts = parseSop({ title: 'Visit SOP', text: LIST, knownRoles: ['Coordinator'] });
  assert.equal(parts.length, 1);
  const p = parts[0];
  assert.equal(p.title, 'Client Visit Coordination Process');
  assert.deepEqual(p.doc.steps.map((s) => s.title), ['Site Check', 'Crew Shortlisting', 'Client Finalization', 'Is it an outstation visit?']);
  assert.equal(p.doc.steps[1].role, 'Coordinator');
  assert.equal(p.doc.steps[1].slaHours, 24);
  assert.equal(p.doc.steps[2].role, 'Client');
  assert.equal(p.doc.steps[3].kind, 'decision');
  assert.deepEqual(p.doc.watch, ['Client not aligning with the options', 'Crew delays on the day']);
  assert.match(p.doc.steps[0].detail, /^• Confirm the site is ready/);
});

test('one file with several SOPs reads as several parts; sections that only describe are not steps', () => {
  const parts = parseSop({ title: 'Marketing SOPs', text: MULTI, knownRoles: ['Senior Marketer', 'Intern'] });
  const byTitle = Object.fromEntries(parts.map((p) => [p.title, p]));
  assert.deepEqual(Object.keys(byTitle).sort(), ['Banner', 'Campaign']);
  const banner = byTitle.Banner;
  assert.deepEqual(banner.doc.steps.map((s) => s.title), ['Share the Requirement', 'Prepare Content First', 'Senior Marketer Review']);
  assert.equal(banner.doc.steps[1].role, 'Intern');
  assert.equal(banner.doc.steps[2].kind, 'approval');
  assert.equal(banner.purpose, 'This SOP defines how the Senior Marketer assigns and approves banner work.');
  assert.deepEqual(byTitle.Campaign.doc.steps.map((s) => s.title), ['Select the objective', 'Name the campaign', 'Choose the budget the Senior Marketer gives']);
  assert.ok(parts.every((p) => p.evidence.includes(`One of 2 SOPs in this document`)));
});

test('prose without steps is not an SOP', () => {
  assert.deepEqual(parseSop({ title: 'Notes', text: 'We met the client today and talked about the brochure. They will send the logo next week.' }), []);
});

test('time words', () => {
  assert.deepEqual(readTime('Reply within 2-3 working days'), { minutes: null, slaHours: 72 });
  assert.deepEqual(readTime('Takes 45 minutes; by EOD'), { minutes: 45, slaHours: 8 });
  assert.deepEqual(readTime('TAT: 4 hours'), { minutes: null, slaHours: 4 });
  assert.deepEqual(readTime('no time here'), { minutes: null, slaHours: null });
});

test('the model keeps limits and drops connections to missing steps; handoffs are lane changes', () => {
  const r = normalizeDoc({ steps: [{ id: 'a', title: ' Brief ', role: 'PGS', next: [{ to: 'b', label: 'ok' }, { to: 'zz' }, { to: 'a' }] }, { id: 'a', title: 'Design', role: 'Designer' }, { title: '' }] });
  assert.equal(r.error, 'Step 3 needs a name');
  const ok = normalizeDoc({ steps: [{ id: 'a', title: ' Brief ', role: 'PGS', next: [{ to: 's1', label: 'ok' }, { to: 'zz' }, { to: 'a' }] }, { id: 'a', title: 'Design', role: 'Designer', links: [{ label: 'x', url: 'javascript:alert(1)' }, { url: 'https://docs.example/t' }] }] });
  assert.deepEqual(ok.doc.steps.map((s) => s.id), ['a', 's1'], 'a duplicate id gets a new one');
  assert.equal(ok.doc.steps[0].title, 'Brief');
  assert.deepEqual(ok.doc.steps[0].next, [{ to: 's1', label: 'ok' }]);
  assert.deepEqual(ok.doc.steps[1].links, [{ label: 'https://docs.example/t', url: 'https://docs.example/t' }]);
  assert.deepEqual(ok.doc.roles, ['PGS', 'Designer']);
  assert.deepEqual(edges(ok.doc).map((e) => `${e.from}>${e.to}`), ['a>s1']);
  assert.equal(handoffs(ok.doc).length, 1);
});

test('a sheet: tabs are stages, "1) | Task | Level | Who" rows are steps with their owner, side-by-side copies are read once', () => {
  const SHEET = `## #1 - Collecting Details
Step By Step | Task complexity | Team Member | Notes | Step By Step | Task complexity | Team Member
1) | Create the project group | Easy | Intern | Same day | 1) | Transcribe the call | Medium | Script Writer
2) | Onboarding call | Hard | Project Coordinator | 2) | First draft | Hard | Script Writer
3) | Send to the script writer | Hard | Project Coordinator
## #2 - Script Writing
Step By Step | Task complexity | Team Member
1) | Transcribe the call | Medium | Script Writer
2) | Review the script with the client | Medium | PC + SW
`;
  const [p] = parseSop({ title: 'Video SOPs', text: SHEET, knownRoles: ['Project coordinator'] });
  assert.deepEqual(p.doc.phases, ['Collecting Details', 'Script Writing']);
  assert.deepEqual(p.doc.steps.map((s) => `${s.title} (${s.role})`), ['Create the project group (Intern)', 'Onboarding call (Project coordinator)', 'Send to the script writer (Project coordinator)',
    'Transcribe the call (Script Writer)', 'Review the script with the client (PC + SW)']);
  assert.equal(p.doc.steps[4].kind, 'approval');
  assert.ok(!p.doc.roles.some((r) => /easy|hard|medium/i.test(r)), 'complexity is not a role');
});

test('who does a step: a role in brackets, or the subject of its first line; never the object', () => {
  const [p] = parseSop({ title: 'Visit', text: 'Site Visit – Process\n1. Confirm the visit date (Coordinator)\n   * Call the client within 24 hours\n2. Prepare the kit\n   * The intern packs the kit\n3. Visit the site\n   * Share photos with the client\n' });
  assert.deepEqual(p.doc.steps.map((s) => [s.title, s.role]), [['Confirm the visit date', 'Coordinator'], ['Prepare the kit', 'Intern'], ['Visit the site', null]]);
});
