/** FLOW-D (owner, 21 Oct 2026: "can there not be blocks that are just the primitives of all?"): the palette is about a
 *  dozen primitives that any company's work is made of. Each asks one plain question and has a few kinds; a kind picks
 *  the backend module (registry.ts) that does the work, so the engine, records, Pip and alerts of FLOW-A stay as they
 *  are. A company's own steps (EA's Deep Research section, a solar site visit) are company blocks: named presets of a
 *  primitive, saved from any step. Nothing here names an industry.
 *  A step with a block waits for the steps before it (its "Starts after" port, `in`); what it uses from earlier steps
 *  reaches it by itself (data wires added when the process goes live, never holding it up). Pure. */
import { MODULE } from './registry.js';
import type { BlockKey, BlockKind, FlowDef, FlowStep, FlowWire, Kind, Port, Primitive } from './types.js';

const k = (key: string, label: string, help: string, module: string, more: Partial<BlockKind> = {}): BlockKind => ({ key, label, help, module, ...more });

export const PRIMITIVES: Primitive[] = [
  { key: 'start', name: 'Start', icon: 'play', question: 'How does this begin?', summary: 'What starts a run: by hand, a new lead, a form, a schedule or another process.',
    finish: 'Finishes by itself when the run starts.', kinds: [
      k('hand', 'By hand, on a client or project', 'Someone presses Start and picks the client or project.', 'start'),
      k('lead', 'A new lead comes in', 'Each new lead starts a run by itself.', 'lead_capture'),
      k('form', 'A form is sent', 'Each time this form is sent, a run starts with its answers.', 'start', { settings: { trigger: 'form' } }),
      k('schedule', 'On a schedule', 'A run starts every day or every week at the time you choose.', 'start', { settings: { trigger: 'schedule', every: 'week', day: 1, at: '10:00' } }),
      k('handover', 'Another process hands over', 'A “Hand over” step in another process starts it, with the same client and values.', 'handoff_in'),
      k('webhook', 'Another app sends it in', 'A web form, a CRM or any app posts to this process’s own address; each post starts a run with what it sent.', 'start', { settings: { trigger: 'webhook' } }),
      k('meta', 'A Meta lead ad comes in', 'Each lead from your Meta lead ads (through the ads sync) starts a run by itself.', 'lead_capture', { settings: { source: 'meta' }, more: true })] },
  { key: 'task', name: 'Task', icon: 'square-check', question: 'What does someone do?', summary: 'Someone does something: who, what, a checklist, when it is due, what they hand in.',
    finish: 'They say when it is done.', kinds: [
      k('do', 'Do something', 'A to-do with a checklist. They tick it off and say when it is done.', 'checklist'),
      k('make', 'Make something from what came in', 'A cut, a design or a file, handed in as a link with its version.', 'edit'),
      k('follow', 'Follow up until they answer', 'Call or message until there is an answer, then record it.', 'follow_up'),
      k('name', 'Name who does each role', 'Someone names the people for this run; their steps go to them.', 'assign'),
      k('requests', 'Take requests and answer each with a date', 'Requests come in; each gets a committed date.', 'request', { more: true }),
      k('cast', 'Find people for a shoot', 'A shortlist with backups, the client’s pick, agreements and usage dates.', 'casting', { more: true }),
      k('decisions', 'Keep a decision log', 'Each decision with who made it, the options and why.', 'decision_log', { more: true }),
      k('library', 'Keep a library of references', 'References other steps point to.', 'library', { more: true })] },
  { key: 'collect', name: 'Collect', icon: 'clipboard-list', question: 'What information do you need?', summary: 'Get information: answers, files, photos taken on the spot, a signature, from the team or the client.',
    finish: 'Done when it comes in.', kinds: [
      k('answers', 'Answers to questions', 'A form on the phone or the computer: fields, choices, numbers, a signature.', 'data_capture'),
      k('photos', 'Photos on the spot', 'The camera only (no old photos), each with the time and the place.', 'site_visit'),
      k('files', 'Files', 'Documents, footage or plans, with who sent them and when.', 'upload'),
      k('items', 'Things that must come in', 'A list of items, who sends each and the day it came; the clock can start when the critical ones are in.', 'intake'),
      k('signature', 'A signature or consent', 'Consent per person and channel, signed, with its expiry.', 'consent', { more: true }),
      k('score', 'A score', 'Score something after it happened (a client, a vendor, a job).', 'score', { more: true })] },
  { key: 'meet', name: 'Meet', icon: 'video', question: 'Who meets, and what comes out of it?', summary: 'A call or meeting: who and when, the transcript or notes, Pip’s summary and follow-ups.',
    finish: 'Done when the transcript or notes are in.', kinds: [
      k('meeting', 'A meeting or call', 'Who, when, the link; paste the transcript or notes; Pip writes the summary and the follow-ups.', 'meeting'),
      k('slot', 'Fix a time', 'One slot with the right people and a place or link.', 'schedule'),
      k('transcript', 'Save a transcript', 'After a call: the transcript where the team reads it, and a score.', 'transcribe'),
      k('visit', 'Plan a shoot or visit', 'Date, place, people, what is needed, a call sheet.', 'shoot')] },
  { key: 'write', name: 'Write', icon: 'file-pen-line', question: 'What gets written?', summary: 'Make a document from a template with sections: who writes, Pip drafts and checks.',
    finish: 'Done when it is marked final.', kinds: [
      k('doc', 'A document', 'A document with sections from a template; Pip drafts and checks each section.', 'doc'),
      k('section', 'One part of a shared document', 'Writes one section of the run’s document (an earlier Write step makes it).', 'doc_section'),
      k('deliverable', 'A deliverable with its own ID', 'A creative, a design or a report: an ID, tabs, versions and dates.', 'asset'),
      k('pack', 'A pack for another team', 'Everything another team needs, in sections.', 'pack'),
      k('list', 'A list', 'Items of one type (people, facts, ideas …), each with a status.', 'records'),
      k('facts', 'Facts and claims, with sources', 'Each fact with its source, the date checked and whether ads may use it.', 'facts', { more: true }),
      k('words', 'Words to use and to avoid', 'A word list with scope and why, versioned.', 'word_library', { more: true }),
      k('messages', 'Messages to reuse', 'Lines the team reuses: proof, trust, objections.', 'message_bank', { more: true }),
      k('ideas', 'Ideas to choose from', 'Directions, then the chosen one, with what it rests on.', 'big_idea', { more: true }),
      k('open', 'Open questions with owners', 'Pending, conflicting and follow-up points routed to whoever can answer.', 'open_items', { more: true }),
      k('sequence', 'A message sequence', 'Messages by day and channel, for another tool to send.', 'sequence', { more: true })] },
  { key: 'review', name: 'Review', icon: 'stamp', question: 'Who approves it?', summary: 'Someone approves, or sends it back with changes: a person, a role or the client; rounds and a time limit.',
    finish: 'Done when it is approved.', kinds: [
      k('approve', 'Someone approves', 'Approve, or send it back with changes; every round is counted.', 'approval'),
      k('client', 'The client confirms', 'Pulse writes the message to share; record their changes and the day they confirm.', 'share_review'),
      k('check', 'Check it against a test', 'A quality test: Pip pre-checks words, claims and numbers; the person passes it or not.', 'check'),
      k('media', 'Review a cut or photos', 'Comments at a time, a change list with owners, versions, then freeze.', 'media_review')] },
  { key: 'decide', name: 'Decide', icon: 'git-fork', question: 'Which way does it go?', summary: 'Go one way or the other: a person chooses, or a rule on an earlier answer decides.',
    finish: 'Done when the way is chosen; the steps on the other way are skipped.', kinds: [
      k('person', 'A person chooses', 'They pick one way; the other way’s steps are skipped.', 'decision'),
      k('rule', 'A rule on an earlier answer', 'Pulse decides by itself from a field or an answer given earlier.', 'decision', { settings: { rule: { field: '', op: 'eq', value: '' } } })] },
  { key: 'wait', name: 'Wait', icon: 'hourglass', question: 'What are we waiting for?', summary: 'Pause for a time, until a date, or until something arrives.',
    finish: 'Goes on by itself.', kinds: [
      k('time', 'For a while', 'Hours or days, then the run goes on by itself.', 'wait', { settings: { hours: 24 } }),
      k('date', 'Until a date', 'Until a date on the run (the install date, the launch).', 'wait', { settings: { until: 'field' } }),
      k('arrives', 'Until something arrives', 'Someone marks it arrived, with what came.', 'wait', { settings: { until: 'input' } })] },
  { key: 'message', name: 'Message', icon: 'send', question: 'Who should know, and what do they read?', summary: 'Tell someone: in Pulse, or a WhatsApp or e-mail text with the run’s values filled in.',
    finish: 'In Pulse it goes by itself; a WhatsApp or e-mail is done when it is sent.', kinds: [
      k('pulse', 'Tell people in Pulse', 'A notification to the people you choose; it goes by itself.', 'notify'),
      k('send', 'A WhatsApp or e-mail to send', 'Pulse fills in the values; the person copies it or sends it and says it went.', 'message')] },
  { key: 'ai', name: 'AI (Pip)', icon: 'sparkles', question: 'What should Pip do?', summary: 'Let Pip do it: summarise, draft, check against rules, pull out fields, score.',
    finish: 'Pip does it; the person keeps what is right.', kinds: [
      k('summarise', 'Summarise', 'A talk or a document becomes a short summary with follow-ups.', 'summarise'),
      k('draft', 'Draft', 'Pip drafts from the write-up and what the run already has; the person edits it.', 'pip_draft'),
      k('check', 'Check against rules', 'Words to avoid, claims without a source, numbers that differ.', 'check', { settings: { pip: true } }),
      k('extract', 'Pull out fields', 'Facts, figures, open points and quotes lifted into a list.', 'extract'),
      k('score', 'Score', 'Each line of a quality test: looks right, check it, or missing.', 'check', { settings: { pip: true, score: true } })] },
  { key: 'app', name: 'App action', icon: 'blocks', question: 'What should another app do?', summary: 'Do something in a Pulse module or another app: a quote, an invoice, a call analysis, a folder, a webhook.',
    finish: 'Done when the app’s work is chosen on the step.', kinds: [
      k('quote', 'Make a quotation', 'In Billing: items, prices from the catalogue; the step keeps the quotation.', 'quotation'),
      k('invoice', 'Make an invoice', 'In Billing, from the accepted quote.', 'tax_invoice'),
      k('xray', 'Analyse a sales call', 'Sales X-Ray: summary, items asked for, objections, promises and a score.', 'sales_xray'),
      k('calendar', 'Put it in the calendar', 'Google Calendar: a time slot becomes an event with its people, place and Meet link.', 'calendar_event'),
      k('drive_folder', 'The project’s Drive folder', 'Google Drive: the project’s folder, found or named, for every later step.', 'drive_folder'),
      k('drive_file', 'A file from Drive', 'Google Drive: pick a file from the project’s folder (or upload it there).', 'drive_file'),
      k('email', 'Send an e-mail', 'Gmail: the text with the run’s values; sent from the person’s own Gmail where the company allows it.', 'message', { settings: { channel: 'email' } }),
      k('whatsapp', 'Send a WhatsApp', 'WhatsApp: the text with the run’s values, opened in WhatsApp to send.', 'message', { settings: { channel: 'whatsapp' } }),
      k('webhook', 'Send to another app', 'A webhook: the run’s values posted to the company’s address, signed; the reply comes back.', 'webhook'),
      k('folder', 'Set up a folder and a group', 'The client’s folders, group chat and access, as a checklist.', 'workspace', { more: true }),
      k('process', 'Hand over to another process', 'Starts that process’s run with the same client and values.', 'handoff')] },
  { key: 'repeat', name: 'Repeat', icon: 'repeat', question: 'What happens every day or week?', summary: 'A meeting rhythm: a daily session or a weekly review whose agenda is the work in a given state.',
    finish: 'Done when the session is recorded.', kinds: [
      k('session', 'A meeting that repeats', 'Every day or week at a time; its agenda is the work in a state you choose.', 'session'),
      k('daily', 'Everyone’s daily update', 'Each person’s “working on today”, written from their open steps.', 'daily_update')] },
  { key: 'end', name: 'End', icon: 'flag', question: 'Done.', summary: 'The run ends here.', finish: 'The run is done when every step is done or skipped.',
    kinds: [k('end', 'The end', 'The run is done when every step is done or skipped.', 'end')] },
];
export const PRIMITIVE = new Map(PRIMITIVES.map((x) => [x.key, x]));
export const isBlock = (x: unknown): x is BlockKey => typeof x === 'string' && PRIMITIVE.has(x as BlockKey);

/** The primitive an older module belongs to (the first kind that uses it). */
const MODULE_BLOCK = new Map<string, BlockKey>();
for (const pr of PRIMITIVES) for (const kd of pr.kinds) if (!MODULE_BLOCK.has(kd.module)) MODULE_BLOCK.set(kd.module, pr.key);
export const blockOfModule = (module: string): BlockKey => MODULE_BLOCK.get(module) ?? 'task';

/** The kind a step is: its module, then the settings that tell kinds with the same module apart. */
export function kindOf(step: Pick<FlowStep, 'block' | 'module' | 'settings'>): BlockKind | null {
  const pr = step.block ? PRIMITIVE.get(step.block as BlockKey) : undefined; if (!pr) return null;
  const same = pr.kinds.filter((x) => x.module === step.module); if (same.length <= 1) return same[0] ?? null;
  const s = step.settings ?? {};
  // Settings that only tune a kind (how long, when) do not tell kinds apart; the most specific kind that matches wins.
  const marks = (x: BlockKind) => Object.keys(x.settings ?? {}).filter((key) => !['hours', 'every', 'day', 'at'].includes(key));
  const hit = same.filter((x) => marks(x).length).sort((a, z) => marks(z).length - marks(a).length)
    .find((x) => marks(x).every((key) => key === 'rule' ? !!s.rule : JSON.stringify(s[key] ?? null) === JSON.stringify(x.settings![key])));
  return hit ?? same.find((x) => !marks(x).length) ?? same[0];
}

/** "Starts after": every step with a block (except Start) waits on this port for the steps before it. */
export const IN: Port = { key: 'in', label: 'Starts after', kind: 'any', many: true };
const words = (x: unknown, max = 40) => (typeof x === 'string' ? x.trim().slice(0, max) : '');

/** A step's ports. With a block: Starts after, then the module's own needs as what it uses (they never hold it up);
 *  a Decide names its two ways from its settings. Without one (older processes): the module's ports as they are. */
export function stepPorts(s: Pick<FlowStep, 'block' | 'module' | 'settings'>): { needs: Port[]; makes: Port[] } {
  const mm = MODULE.get(s.module); const needs = mm?.needs ?? [], makes = mm?.makes ?? [];
  if (!s.block) return { needs, makes };
  const out = s.block === 'decide' || s.module === 'decision'
    ? [{ key: 'yes', label: words(s.settings?.yes) || 'Yes', kind: 'verdict' as Kind }, { key: 'no', label: words(s.settings?.no) || 'Otherwise', kind: 'verdict' as Kind }] : makes;
  if (s.block === 'start' || mm?.category === 'Start' && !needs.length) return { needs: [], makes: out };
  return { needs: [IN, ...needs.filter((n) => n.key !== 'in').map((n) => ({ ...n, required: false }))], makes: out };
}

/** The wires that decide when a step opens: into `in` for a block step, into a required need otherwise. */
export function gates(def: Pick<FlowDef, 'steps' | 'wires'>): FlowWire[] {
  const by = new Map(def.steps.map((s) => [s.id, s]));
  return def.wires.filter((w) => {
    const b = by.get(w.to.step); if (!b || !by.has(w.from.step)) return false;
    if (b.block) return w.to.port === 'in';
    const need = (MODULE.get(b.module)?.needs ?? []).find((n) => n.key === w.to.port); return !!need && need.required !== false;
  });
}

/** Every step that comes before a step (by the wires that open it). */
export function ancestors(def: Pick<FlowDef, 'steps' | 'wires'>, id: string, gated = gates(def)): Set<string> {
  const up = new Map<string, string[]>(); for (const w of gated) up.set(w.to.step, [...(up.get(w.to.step) ?? []), w.from.step]);
  const seen = new Set<string>(); const todo = [...(up.get(id) ?? [])];
  while (todo.length) { const x = todo.pop()!; if (seen.has(x)) continue; seen.add(x); todo.push(...(up.get(x) ?? [])); }
  seen.delete(id); return seen;
}

/** The nearest earlier step that makes a kind, and its port (the closest first, by how many steps back). */
export function nearestMaker(def: Pick<FlowDef, 'steps' | 'wires'>, id: string, kind: Kind, gated = gates(def)): { step: string; port: string } | null {
  const up = new Map<string, string[]>(); for (const w of gated) up.set(w.to.step, [...(up.get(w.to.step) ?? []), w.from.step]);
  const by = new Map(def.steps.map((s) => [s.id, s]));
  let ring = up.get(id) ?? []; const seen = new Set<string>([id]);
  while (ring.length) {
    const next: string[] = [];
    for (const x of ring) {
      if (seen.has(x)) continue; seen.add(x);
      const s = by.get(x); const port = s ? stepPorts(s).makes.find((p) => kind === 'any' || p.kind === kind) : undefined;
      if (port) return { step: x, port: port.key };
      next.push(...(up.get(x) ?? []));
    }
    ring = next;
  }
  return null;
}

/** What a process gives its runs: the definition plus the data wires a block step's uses need (the nearest earlier
 *  step that makes that kind, and every `uses` named on the step). They carry values; they never hold a step up. */
export function withData(def: FlowDef): FlowDef {
  const gated = gates(def); const wires = [...def.wires];
  const has = (w: FlowWire) => wires.some((x) => x.from.step === w.from.step && x.from.port === w.from.port && x.to.step === w.to.step && x.to.port === w.to.port);
  for (const s of def.steps) {
    if (!s.block) continue;
    const { needs } = stepPorts(s); const before = ancestors(def, s.id, gated);
    for (const n of needs) {
      if (n.key === 'in' || n.kind === 'any' || wires.some((w) => w.to.step === s.id && w.to.port === n.key)) continue;
      const from = nearestMaker(def, s.id, n.kind, gated); if (from) { const w = { from, to: { step: s.id, port: n.key }, label: 'Uses' }; if (!has(w)) wires.push(w); }
    }
    for (const u of s.uses ?? []) {
      const src = def.steps.find((x) => x.id === u.step); if (!src || !before.has(src.id)) continue;
      const out = stepPorts(src).makes.find((p) => p.key === u.port) ?? stepPorts(src).makes[0]; if (!out) continue;
      const into = needs.find((n) => n.key !== 'in' && (n.kind === out.kind || n.kind === 'any') && !wires.some((w) => w.to.step === s.id && w.to.port === n.key && n.many !== true))
        ?? needs.find((n) => n.key === 'context') ?? needs.find((n) => n.key === 'in');
      if (!into) continue;
      const w = { from: { step: src.id, port: out.key }, to: { step: s.id, port: into.key }, label: u.label ? `Uses ${u.label}` : 'Uses' }; if (!has(w)) wires.push(w);
    }
  }
  return { ...def, wires };
}

/** An older definition (typed wires that gate) as primitives: each step keeps its module under the primitive it
 *  belongs to; a wire that held a step up now also feeds its "Starts after"; every wire still carries its value. */
export function toBlocks(def: FlowDef): FlowDef {
  const steps = def.steps.map((s) => (s.block ? s : { ...s, block: blockOfModule(s.module) }));
  const by = new Map(def.steps.map((s) => [s.id, s]));
  const wires: FlowWire[] = [];
  const push = (w: FlowWire) => { if (!wires.some((x) => x.from.step === w.from.step && x.from.port === w.from.port && x.to.step === w.to.step && x.to.port === w.to.port)) wires.push(w); };
  for (const w of def.wires) {
    const b = by.get(w.to.step); if (!b) continue;
    if (b.block || w.to.port === 'in') { push(w); continue; }
    const need = (MODULE.get(b.module)?.needs ?? []).find((n) => n.key === w.to.port);
    const gating = !!need && need.required !== false && blockOfModule(b.module) !== 'start';
    if (gating) push({ ...w, to: { step: w.to.step, port: 'in' } });
    push({ from: w.from, to: w.to, ...(!gating && w.notify ? { notify: w.notify } : {}), ...(!gating && w.label ? { label: w.label } : {}) });
  }
  return { ...def, steps, wires };
}

/** What a primitive kind of an earlier step makes, in words, for "Add a … step?" ("a document" → Write). */
export const MAKER: Record<Kind, { block: BlockKey; kind: string; words: string } | null> = {
  contact: { block: 'start', kind: 'hand', words: 'a Start' }, talk: { block: 'meet', kind: 'meeting', words: 'a Meet step' }, doc: { block: 'write', kind: 'doc', words: 'a Write step' },
  media: { block: 'collect', kind: 'photos', words: 'a Collect step (photos or files)' }, answers: { block: 'collect', kind: 'answers', words: 'a Collect step' },
  money: { block: 'app', kind: 'quote', words: 'an App action (a quotation)' }, verdict: { block: 'review', kind: 'approve', words: 'a Review step' },
  slot: { block: 'meet', kind: 'slot', words: 'a Meet step (fix a time)' }, list: { block: 'write', kind: 'list', words: 'a Write step (a list)' }, any: null,
};
