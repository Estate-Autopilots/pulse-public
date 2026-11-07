/** WORKFLOW BUILDER (owner, 18 Oct 2026): the blocks a workflow is built from, like n8n or Zapier but for people as
 *  well as software. A block is a workflow step with a module; its ports say what goes in and what comes out (a lead, a
 *  call's analysis, a quote, photos with their place, a form's answers). A wire joins an output to an input only when
 *  their types match; otherwise the builder offers an adapter block that turns one into the other. The engine runs
 *  every block as the step kind it names (0241, 0530); `engine` says honestly how much of the module is built.
 *  Pure: the API checks definitions with it and hands it to the builder (GET /api/v0/workflows/blocks). */
import type { StepKind } from './sop-model.js';

export const PORT_TYPES = { lead: 'Lead', call: 'Call analysis', quote: 'Quote', photo: 'Photo + location', form: 'Form data', hand: 'Hand-off', any: 'Anything' } as const;
export type PortType = keyof typeof PORT_TYPES;
export type Port = { key: string; label: string; type: PortType };
/** live: runs on the engine as it is; auto: finishes by itself; partial: a task that opens the module's own page;
 *  stub: the block holds its place with the right ports, and its module is not built yet. */
export type Engine = 'live' | 'auto' | 'partial' | 'stub';
export type BlockSpec = {
  module: string; label: string; group: 'Start' | 'Sales' | 'Field' | 'Billing' | 'Flow' | 'Apps'; kind: StepKind;
  inputs: Port[]; outputs: Port[]; engine: Engine; what: string; status: string; checklist: string[];
  slaHours?: number; waitHours?: number; needsForm?: boolean; link?: string;
};

const p = (key: string, label: string, type: PortType): Port => ({ key, label, type });
const IN_ANY = [p('in', 'In', 'any')];

export const BLOCKS: BlockSpec[] = [
  { module: 'lead_capture', label: 'Lead capture', group: 'Start', kind: 'task', inputs: [], outputs: [p('lead', 'Lead', 'lead')], engine: 'auto',
    what: 'Where a run starts: the lead, client or project it is for.',
    status: 'Finishes by itself when the run starts. Runs start by hand on a project or client today; starting by itself when a new lead arrives is not built yet.',
    checklist: ['The lead lands in one inbox', 'It is routed to the right person'] },
  { module: 'handoff_in', label: 'From a hand-off', group: 'Start', kind: 'task', inputs: [], outputs: [p('lead', 'Lead and its values', 'lead')], engine: 'auto',
    what: 'The first block of a tab that another tab hands work to: the client, project and values arrive together.',
    status: 'Finishes by itself when the other tab hands over.', checklist: ['The client, quote and address arrive together'] },
  { module: 'sales_xray', label: 'Sales X-Ray', group: 'Sales', kind: 'task', inputs: [p('lead', 'Lead', 'lead')],
    outputs: [p('summary', 'Summary', 'call'), p('items', 'Items asked for', 'call'), p('objections', 'Objections', 'call'), p('promises', 'Promises', 'call'), p('score', 'Score', 'call')],
    engine: 'stub', what: 'Call analysis: a summary, the items asked for, objections, promises and a score. Each is its own port.',
    status: 'Stub: a task to call and upload the recording; the analysis is typed in by hand until the Sales X-Ray app is installed in Pulse (EST-1272 to 1274).',
    checklist: ['Call the lead from Pulse', 'Upload the recording', 'Check the summary, the items asked for and the promises'], slaHours: 24 },
  { module: 'quotation', label: 'Quotation', group: 'Billing', kind: 'task', inputs: [p('lead', 'Lead', 'lead'), p('items', 'Items asked for', 'call')], outputs: [p('quote', 'Quote', 'quote')],
    engine: 'partial', what: 'A quotation in Billing: items from the call, prices from the catalogue.', link: '/erp/new?type=quotation',
    status: 'A task that opens Billing to make the quotation; the run moves on when the task is done.',
    checklist: ['Items from the call, prices from the catalogue', 'Fill install and transport, or mark them not needed', 'Ask for approval of any price below the catalogue', 'Send it to the client'], slaHours: 24 },
  { module: 'follow_up', label: 'Follow-up', group: 'Sales', kind: 'task', inputs: [p('quote', 'Quote', 'quote')], outputs: [p('reply', 'Reply', 'quote')], engine: 'live',
    what: 'Follow the quote up until the client answers.', status: 'A task due two days later. The 09:00 quote reminders come with EST-1238.',
    checklist: ['Call or message at 09:00', 'Log the reply', 'Repeat until won or closed'], slaHours: 48 },
  { module: 'approval', label: 'Approval', group: 'Flow', kind: 'approval', inputs: IN_ANY, outputs: [p('approved', 'Approved', 'any'), p('back', 'Send back', 'any')], engine: 'live',
    what: 'Someone approves, or sends the work back to an earlier block.', status: 'Live: answered on the task or the run.', checklist: ['Check the work against the brief'] },
  { module: 'decision', label: 'Decision', group: 'Flow', kind: 'decision', inputs: IN_ANY, outputs: [p('yes', 'Yes', 'any'), p('no', 'Otherwise', 'any')], engine: 'live',
    what: 'The run goes one way or the other: by a condition on the run’s values, or by someone’s choice.', status: 'Live: a condition decides by itself, otherwise someone chooses.', checklist: [] },
  { module: 'site_visit', label: 'Site visit · GPS camera', group: 'Field', kind: 'task', inputs: [p('lead', 'Lead', 'lead')], outputs: [p('photos', 'Photos with place and time', 'photo')],
    engine: 'live', needsForm: true, what: 'A visit with photos taken by the camera, stamped with the time and place.',
    status: 'Live with a form that has a camera photo: the phone opens the camera and Pulse refuses old gallery photos.',
    checklist: ['Photo with location and time', 'Works offline and uploads later', 'Attached to the client'], slaHours: 48 },
  { module: 'data_capture', label: 'Data capture form', group: 'Field', kind: 'task', inputs: IN_ANY, outputs: [p('answers', 'Answers', 'form')], engine: 'live', needsForm: true,
    what: 'A form the person fills on the phone: numbers, choices, checklists, a signature, a location.', status: 'Live with a form: its answers join the run’s values.',
    checklist: ['Fill every required field', 'The person confirms or corrects'] },
  { module: 'checklist', label: 'Checklist (SOP)', group: 'Flow', kind: 'task', inputs: IN_ANY, outputs: [p('done', 'Done', 'any')], engine: 'live',
    what: 'A step of an SOP: the checklist the person follows inside it.', status: 'Live: a task with its checklist.', checklist: [] },
  { module: 'handoff', label: 'Hand-off to person', group: 'Flow', kind: 'task', inputs: IN_ANY, outputs: [], engine: 'auto',
    what: 'Passes the work to another tab: its run starts with the same client, project and values.',
    status: 'Live: starts the other tab’s run at once (in a test run, a test run).', checklist: ['The next person gets the client, quote and address together'] },
  { module: 'wait', label: 'Wait / timer', group: 'Flow', kind: 'wait', inputs: IN_ANY, outputs: [p('after', 'After the wait', 'any')], engine: 'live', waitHours: 24,
    what: 'The run waits, then goes on by itself.', status: 'Live: the run goes on when the time is up.', checklist: [] },
  { module: 'notify', label: 'Notify', group: 'Apps', kind: 'task', inputs: IN_ANY, outputs: [p('then', 'Then', 'any')], engine: 'stub',
    what: 'Tells someone that the work reached this point.', status: 'Stub: it records the message and sends nothing yet.', checklist: [] },
  { module: 'tax_invoice', label: 'Tax invoice', group: 'Billing', kind: 'task', inputs: [p('quote', 'Accepted quote', 'quote'), p('record', 'Install record', 'form')],
    outputs: [p('invoice', 'Invoice', 'quote')], engine: 'partial', link: '/erp/new?type=invoice',
    what: 'The GST invoice made from the accepted quote.', status: 'A task that opens Billing to make the invoice; the run moves on when the task is done.',
    checklist: ['Made from the accepted quote', 'Serial numbers and e-way bill when needed', 'Record the payment'] },
  { module: 'webhook', label: 'App or webhook', group: 'Apps', kind: 'task', inputs: IN_ANY, outputs: [p('reply', 'Reply', 'any')], engine: 'stub',
    what: 'Hands the run’s values to another app.', status: 'Stub: nothing is sent; connecting apps comes with the Apps page.', checklist: [] },
  { module: 'end', label: 'End', group: 'Flow', kind: 'end', inputs: IN_ANY, outputs: [], engine: 'live', what: 'The run ends here.', status: 'Live: the run is marked done here.', checklist: [] },
];
export const BLOCK = new Map(BLOCKS.map((b) => [b.module, b]));

/** A step without a module (an SOP step, older workflows) is a plain block of its kind. */
export function specOf(step: { module?: string | null; kind: StepKind }): BlockSpec {
  const b = step.module ? BLOCK.get(step.module) : undefined;
  if (b) return b;
  const kind = step.kind;
  if (kind === 'approval') return BLOCK.get('approval')!;
  if (kind === 'decision') return BLOCK.get('decision')!;
  if (kind === 'wait') return BLOCK.get('wait')!;
  if (kind === 'end') return BLOCK.get('end')!;
  return BLOCK.get('checklist')!;
}

export const fits = (from: PortType, to: PortType) => from === to || from === 'any' || to === 'any';

type Wire = { to: string; label: string | null; port?: string | null; in?: string | null };
type StepLike = { id: string; title: string; kind: StepKind; module?: string | null; next: Wire[] | null };

/** What an output port really carries: a pass-through port ("Anything") carries what came into its block. */
export function outType(steps: StepLike[], stepId: string, portKey: string | null | undefined, seen = new Set<string>()): PortType {
  const s = steps.find((x) => x.id === stepId); if (!s) return 'any';
  const spec = specOf(s); const port = spec.outputs.find((o) => o.key === portKey) ?? spec.outputs[0];
  if (port && port.type !== 'any') return port.type;
  if (seen.has(stepId)) return 'any';
  seen.add(stepId);
  for (const from of steps) for (const w of from.next ?? []) if (w.to === stepId) { const t = outType(steps, from.id, w.port, seen); if (t !== 'any') return t; }
  return 'any';
}

/** The first wire whose types do not match, in words, or null. */
export function portProblem(steps: StepLike[]): string | null {
  for (const s of steps) for (const w of s.next ?? []) {
    if (!w.port && !w.in && !s.module) continue;
    const to = steps.find((x) => x.id === w.to); if (!to) continue;
    const t = outType(steps, s.id, w.port);
    const ins = specOf(to).inputs; const target = w.in ? ins.filter((i) => i.key === w.in) : ins;
    if (!ins.length) return `“${to.title}” starts a run: nothing can be wired into it`;
    if (!target.some((i) => fits(t, i.type))) return `“${s.title}” gives ${PORT_TYPES[t]}, and “${to.title}” takes ${[...new Set(target.map((i) => PORT_TYPES[i.type]))].join(' or ')}: put an adapter block between them`;
  }
  return null;
}

/** Blocks that turn one type into another: what the builder offers when a wire's types do not match. */
export function adapters(from: PortType, to: PortType): string[] {
  return BLOCKS.filter((b) => b.inputs.some((i) => fits(from, i.type)) && b.outputs.some((o) => o.type !== 'any' && fits(o.type, to)) && b.module !== 'handoff').map((b) => b.module);
}
