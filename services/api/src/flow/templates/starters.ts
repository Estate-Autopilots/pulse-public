/** FLOW-E (owner, 21 Oct 2026: "customise an account to any industry, role or anything"): the starter processes the
 *  industry packs bring, built from the primitives (each step a block with its kind's module, the order as "Starts
 *  after"). Same engine, each company's own words: a creative agency's campaign, a consulting engagement, a clinic
 *  visit and a real-estate developer's booking. Data only; nothing here is special-cased anywhere in the code. */
import { stepPorts } from '../blocks.js';
import type { AlertRule, BlockKey, FlowDef, FlowStep, FlowWire, RoleDef, ScoreMetric, Stage, VariantField } from '../types.js';

type S = [id: string, stage: string, block: BlockKey, module: string, title: string, role: string, more?: Partial<FlowStep>];
type Spec = { fields?: VariantField[]; roles: RoleDef[]; stages: Stage[]; steps: S[]; after: [string, string][]; rules?: AlertRule[]; scorecard?: ScoreMetric[]; terms: { run: string; runs: string } };
const who = (role: string) => (role === 'starter' ? { by: 'starter' as const } : { by: 'role' as const, role });

/** A definition from steps and "b starts after a" pairs ("d:no" names a Decide's way). */
function build(x: Spec): FlowDef {
  const steps: FlowStep[] = x.steps.map(([id, stage, block, module, title, role, more], i) => ({ id, stage, block, module, title, who: who(role), settings: {}, pos: { x: 40, y: 40 + i * 160 },
    checklist: [], qualityTest: [], inputs: [], when: [], due: null, hours: null, note: null, sop: null, ...more }));
  const by = new Map(steps.map((s) => [s.id, s]));
  const wires: FlowWire[] = x.after.map(([a, b]) => {
    const [from, way] = a.split(':'); const s = by.get(from); if (!s || !by.has(b)) throw new Error(`starter template: no step ${from} or ${b}`);
    const port = way ?? stepPorts(s).makes[0]?.key; if (!port) throw new Error(`starter template: ${from} makes nothing`);
    return { from: { step: from, port }, to: { step: b, port: 'in' } };
  });
  return { version: 2, fields: x.fields ?? [], roles: x.roles, stages: x.stages, steps, wires, rules: x.rules ?? [], scorecard: x.scorecard ?? [], clock: { from: 'start' }, terms: x.terms };
}
const days = (n: number, from: 'start' | `step:${string}` = 'start') => ({ due: { from, days: n, workdays: true } });

export type Starter = { key: string; name: string; summary: string; definition: FlowDef };

export const AGENCY_CAMPAIGN: Starter = {
  key: 'agency_campaign', name: 'Client campaign',
  summary: 'A brief comes in, a kick-off call, the creative brief, the client approves it, the work is made and checked, the client signs off, then the invoice.',
  definition: build({
    roles: [{ key: 'account', label: 'Account manager' }, { key: 'strategist', label: 'Strategist' }, { key: 'designer', label: 'Designer' }, { key: 'writer', label: 'Copywriter' }],
    stages: [{ key: 'brief', label: 'Brief' }, { key: 'make', label: 'Make' }, { key: 'deliver', label: 'Deliver' }],
    steps: [
      ['a1', 'brief', 'start', 'start', 'New brief', 'account'],
      ['a2', 'brief', 'meet', 'meeting', 'Kick-off call with the client', 'account', days(2)],
      ['a3', 'brief', 'write', 'doc', 'Creative brief', 'strategist', { ...days(2, 'step:a2'), settings: { sections: ['Goal', 'Audience', 'Message', 'Deliverables', 'Dates'] } }],
      ['a4', 'brief', 'review', 'share_review', 'The client approves the brief', 'account', { settings: { finishWhen: 'confirmed', slaDays: 2 } }],
      ['a5', 'make', 'write', 'asset', 'Make the deliverables', 'designer', days(5, 'step:a4')],
      ['a6', 'make', 'review', 'check', 'Copy and brand check', 'writer', { qualityTest: ['Every claim has a source', 'The brand words are used', 'Spelling and dates checked'] }],
      ['a7', 'deliver', 'review', 'share_review', 'The client signs off', 'account', { settings: { finishWhen: 'confirmed', slaDays: 3 } }],
      ['a8', 'deliver', 'app', 'tax_invoice', 'Invoice', 'account'],
      ['a9', 'deliver', 'end', 'end', 'Campaign delivered', 'account'],
    ],
    after: [['a1', 'a2'], ['a2', 'a3'], ['a3', 'a4'], ['a4', 'a5'], ['a5', 'a6'], ['a6', 'a7'], ['a7', 'a8'], ['a8', 'a9']],
    rules: [{ key: 'brief_late', name: 'Creative brief late', when: 'not-done-by-due', steps: ['a3'], notify: ['strategist', 'account'] },
      { key: 'signoff_waiting', name: 'Sign-off waiting on the client', when: 'in-state-longer', steps: ['a7'], state: 'in_review', waitDays: 3, notify: ['account'] }],
    scorecard: [{ key: 'brief_on_time', label: 'Briefs on time', kind: 'on-time', steps: ['a3'] }, { key: 'first_time', label: 'Signed off first time', kind: 'first-time', steps: ['a7'] }],
    terms: { run: 'Project', runs: 'Projects' },
  }),
};

export const CONSULTING_ENGAGEMENT: Starter = {
  key: 'consulting_engagement', name: 'Consulting engagement',
  summary: 'An enquiry, a discovery call, the proposal and its fee, the client signs, kick-off, data in, findings, the report reviewed by a partner, the presentation, then the invoice.',
  definition: build({
    roles: [{ key: 'partner', label: 'Engagement partner' }, { key: 'manager', label: 'Engagement manager' }, { key: 'consultant', label: 'Consultant' }, { key: 'analyst', label: 'Analyst' }],
    stages: [{ key: 'win', label: 'Win the work' }, { key: 'discover', label: 'Discover' }, { key: 'deliver', label: 'Deliver' }, { key: 'close', label: 'Close' }],
    steps: [
      ['c1', 'win', 'start', 'lead_capture', 'New enquiry', 'manager'],
      ['c2', 'win', 'meet', 'meeting', 'Discovery call', 'manager', days(2)],
      ['c3', 'win', 'write', 'doc', 'Proposal', 'manager', { ...days(3, 'step:c2'), settings: { sections: ['Situation', 'Objectives', 'Approach', 'Team', 'Fees', 'Timeline'] } }],
      ['c4', 'win', 'review', 'approval', 'The partner reviews the proposal', 'partner'],
      ['c5', 'win', 'app', 'quotation', 'Fee quotation', 'manager'],
      ['c6', 'win', 'review', 'share_review', 'The client signs the proposal', 'manager', { settings: { finishWhen: 'confirmed', slaDays: 5 } }],
      ['c7', 'win', 'decide', 'decision', 'Did they sign?', 'manager', { settings: { yes: 'Signed', no: 'Not this time' } }],
      ['c8', 'discover', 'meet', 'meeting', 'Kick-off with the client', 'manager', days(3, 'step:c7')],
      ['c9', 'discover', 'collect', 'upload', 'The client’s data and documents', 'analyst'],
      ['c10', 'deliver', 'write', 'records', 'Findings', 'consultant', { settings: { recordType: 'finding' } }],
      ['c11', 'deliver', 'write', 'doc', 'Findings report', 'consultant', { ...days(10, 'step:c9'), settings: { sections: ['Summary', 'Findings', 'Recommendations', 'Next steps'] } }],
      ['c12', 'deliver', 'review', 'approval', 'The partner reviews the report', 'partner'],
      ['c13', 'deliver', 'meet', 'meeting', 'Present to the client', 'manager'],
      ['c14', 'close', 'app', 'tax_invoice', 'Invoice', 'manager'],
      ['c15', 'close', 'message', 'message', 'A thank-you note', 'manager', { settings: { channel: 'email', text: 'Thank you for your time, {client}. We would be glad to help when the moment is right.' } }],
      ['c16', 'close', 'end', 'end', 'Engagement closed', 'partner'],
    ],
    after: [['c1', 'c2'], ['c2', 'c3'], ['c3', 'c4'], ['c4', 'c5'], ['c5', 'c6'], ['c6', 'c7'], ['c7:yes', 'c8'], ['c8', 'c9'], ['c9', 'c10'], ['c10', 'c11'], ['c11', 'c12'], ['c12', 'c13'],
      ['c13', 'c14'], ['c7:no', 'c15'], ['c14', 'c16'], ['c15', 'c16']],
    rules: [{ key: 'proposal_late', name: 'Proposal late', when: 'not-done-by-due', steps: ['c3'], notify: ['manager', 'partner'] },
      { key: 'report_late', name: 'Findings report late', when: 'not-done-by-due', steps: ['c11'], notify: ['consultant', 'manager'] }],
    scorecard: [{ key: 'proposal_on_time', label: 'Proposals on time', kind: 'on-time', steps: ['c3'] }, { key: 'report_on_time', label: 'Reports on time', kind: 'on-time', steps: ['c11'] }],
    terms: { run: 'Engagement', runs: 'Engagements' },
  }),
};

export const CLINIC_VISIT: Starter = {
  key: 'clinic_visit', name: 'Patient visit',
  summary: 'A request for an appointment, the slot, the intake form, the consultation, the visit notes, the bill and a follow-up reminder to send.',
  definition: build({
    roles: [{ key: 'desk', label: 'Front desk' }, { key: 'nurse', label: 'Nurse' }, { key: 'doctor', label: 'Doctor' }, { key: 'billing', label: 'Billing' }],
    stages: [{ key: 'book', label: 'Book' }, { key: 'visit', label: 'Visit' }, { key: 'after', label: 'After the visit' }],
    steps: [
      ['k1', 'book', 'start', 'start', 'Appointment request', 'desk'],
      ['k2', 'book', 'meet', 'schedule', 'Book the appointment', 'desk', days(1)],
      ['k3', 'visit', 'collect', 'data_capture', 'Intake form', 'nurse', { checklist: ['Reason for the visit', 'Allergies', 'Current medicines'] }],
      ['k4', 'visit', 'meet', 'meeting', 'Consultation', 'doctor'],
      ['k5', 'visit', 'write', 'doc', 'Visit notes and advice', 'doctor', { settings: { sections: ['Complaint', 'Findings', 'Advice', 'Medicines', 'Next visit'] } }],
      ['k6', 'after', 'app', 'tax_invoice', 'Bill', 'billing'],
      ['k7', 'after', 'message', 'message', 'Follow-up reminder', 'desk', { settings: { channel: 'whatsapp', text: 'Hello {client}, a reminder of your follow-up visit. Reply here to change the time.' } }],
      ['k8', 'after', 'end', 'end', 'Visit closed', 'desk'],
    ],
    after: [['k1', 'k2'], ['k2', 'k3'], ['k3', 'k4'], ['k4', 'k5'], ['k5', 'k6'], ['k5', 'k7'], ['k6', 'k8'], ['k7', 'k8']],
    rules: [{ key: 'notes_late', name: 'Visit notes not written', when: 'value-missing-after', after: 'k4', missing: 'k5', waitDays: 1, notify: ['doctor'] }],
    scorecard: [{ key: 'booked_on_time', label: 'Booked within a day', kind: 'on-time', steps: ['k2'] }],
    terms: { run: 'Visit', runs: 'Visits' },
  }),
};

export const DEVELOPER_BOOKING: Starter = {
  key: 'developer_booking', name: 'Enquiry to booking',
  summary: 'An enquiry, the first call analysed by Sales X-Ray, the site visit with GPS photos, the cost sheet and follow-up, the booking form, the agreement and its legal check, then the booking-amount demand.',
  definition: build({
    roles: [{ key: 'sales', label: 'Sales manager' }, { key: 'site', label: 'Site manager' }, { key: 'crm', label: 'CRM executive' }, { key: 'legal', label: 'Legal' }, { key: 'accounts', label: 'Accounts' }],
    stages: [{ key: 'enquiry', label: 'Enquiry' }, { key: 'visit', label: 'Site visit' }, { key: 'booking', label: 'Booking' }, { key: 'agreement', label: 'Agreement' }],
    steps: [
      ['d1', 'enquiry', 'start', 'lead_capture', 'New enquiry', 'sales'],
      ['d2', 'enquiry', 'app', 'sales_xray', 'First call (Sales X-Ray)', 'sales', days(1)],
      ['d3', 'visit', 'meet', 'schedule', 'Fix the site visit', 'sales', days(2)],
      ['d4', 'visit', 'collect', 'site_visit', 'Site visit · GPS photos with the buyer', 'site'],
      ['d5', 'booking', 'app', 'quotation', 'Cost sheet', 'sales', days(1, 'step:d4')],
      ['d6', 'booking', 'task', 'follow_up', 'Follow up until they decide', 'sales'],
      ['d7', 'booking', 'collect', 'data_capture', 'Booking form and signature', 'crm'],
      ['d8', 'agreement', 'write', 'doc', 'Agreement for sale', 'legal', { settings: { sections: ['Parties', 'Unit', 'Price and payment schedule', 'Terms'] } }],
      ['d9', 'agreement', 'review', 'approval', 'Legal check', 'legal'],
      ['d10', 'agreement', 'app', 'tax_invoice', 'Booking-amount demand', 'accounts'],
      ['d11', 'agreement', 'end', 'end', 'Booked', 'sales'],
    ],
    after: [['d1', 'd2'], ['d2', 'd3'], ['d3', 'd4'], ['d4', 'd5'], ['d5', 'd6'], ['d6', 'd7'], ['d7', 'd8'], ['d8', 'd9'], ['d9', 'd10'], ['d10', 'd11']],
    rules: [{ key: 'visit_late', name: 'Site visit not fixed', when: 'not-done-by-due', steps: ['d3'], notify: ['sales'] },
      { key: 'cost_sheet_late', name: 'Cost sheet late', when: 'not-done-by-due', steps: ['d5'], notify: ['sales'] }],
    scorecard: [{ key: 'call_on_time', label: 'First calls within a day', kind: 'on-time', steps: ['d2'] }, { key: 'cost_on_time', label: 'Cost sheets on time', kind: 'on-time', steps: ['d5'] }],
    terms: { run: 'Booking', runs: 'Bookings' },
  }),
};

export const STARTERS: Starter[] = [AGENCY_CAMPAIGN, CONSULTING_ENGAGEMENT, CLINIC_VISIT, DEVELOPER_BOOKING];
