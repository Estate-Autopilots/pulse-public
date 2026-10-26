/** FLOW-D "Describe it": someone types or pastes how the work goes ("When a lead comes in, the sales person calls them
 *  within a day. Then the surveyor visits the site and takes photos …") and Pip drafts the steps as primitives, with who
 *  does each and when it is due, one after the other; the person edits the draft. Pulse has no language model (FLOW-A):
 *  these are grounded rules on the words, and Pip says what it could not tell. Pure. */
import { PRIMITIVE, stepPorts } from './blocks.js';
import { slug } from './model.js';
import type { BlockKey, DueRule, FlowDef, FlowStep, FlowWire, RoleDef, Stage } from './types.js';

type Pick = { block: BlockKey; kind: string };
/** Words → the primitive and kind, first match wins (the order matters: "approve the quote" is a Review). */
const RULES: [RegExp, Pick][] = [
  [/\b(wait|pause)\b|\buntil\b/i, { block: 'wait', kind: 'time' }],
  [/\b(sales x-?ray|analy[sz]e the call)\b/i, { block: 'app', kind: 'xray' }],
  [/\b(approv\w*|sign[- ]?off|signs off|sign(s)? the quote)\b/i, { block: 'review', kind: 'approve' }],
  [/\b(client|customer)\b.*\b(confirm\w*|agree\w*|okay|ok)\b|\b(confirm\w*)\b.*\b(client|customer)\b/i, { block: 'review', kind: 'client' }],
  [/\b(invoice|bill(ing)?)\b/i, { block: 'app', kind: 'invoice' }],
  [/\b(quot(e|ation|es)|estimate|proposal price)\b/i, { block: 'app', kind: 'quote' }],
  [/\b(photos?|pictures?|site visit|visits? the site|survey\w*|on site|gps|measure\w*)\b/i, { block: 'collect', kind: 'photos' }],
  [/\b(quality check|check\w* (it|the|that|for)|qa|proof-?read)\b/i, { block: 'review', kind: 'check' }],
  [/\b(review\w*)\b/i, { block: 'review', kind: 'approve' }],
  [/\b(summari[sz]e|pip|ai)\b/i, { block: 'ai', kind: 'summarise' }],
  [/\b(whatsapp|e-?mail|sms|text message)\b/i, { block: 'message', kind: 'send' }],
  [/\b(tell|notify|inform|let \w+( \w+)? know|remind|alert)\b/i, { block: 'message', kind: 'pulse' }],
  [/\b(upload\w*|files?|footage|recordings?|documents? (are|is) sent|send (us|over) the)\b/i, { block: 'collect', kind: 'files' }],
  [/\b(schedule|book (a|the) (slot|time|meeting)|fix (a|the) (time|date)|set up a call)\b/i, { block: 'meet', kind: 'slot' }],
  [/\b(meet\w*|calls?|kick-?off|interview\w*|discuss\w*|talk\w* to)\b/i, { block: 'meet', kind: 'meeting' }],
  [/\b(collect\w*|gather\w*|ask (for|them)|get the (details|information|requirements)|fill\w*|forms?|details|requirements|information)\b/i, { block: 'collect', kind: 'answers' }],
  [/\b(write\w*|draft\w*|document\w*|report|brief|script\w*|copy|deck|plan)\b/i, { block: 'write', kind: 'doc' }],
  [/\b(folder|drive|group chat|whatsapp group)\b/i, { block: 'app', kind: 'folder' }],
  [/\b(every (day|week|monday|tuesday|wednesday|thursday|friday|saturday)|daily|weekly)\b/i, { block: 'repeat', kind: 'session' }],
];
const START_RULES: [RegExp, Pick][] = [
  [/\b(new )?(lead|enquiry|inquiry)\b.*\b(comes? in|arrives?|comes)\b|\bnew (lead|enquiry|inquiry)\b/i, { block: 'start', kind: 'lead' }],
  [/\bform\b.*\b(sent|submitted|filled)\b/i, { block: 'start', kind: 'form' }],
  [/\b(every (day|week|monday|tuesday|wednesday|thursday|friday)|daily|weekly)\b/i, { block: 'start', kind: 'schedule' }],
];
const END = /^(that'?s it|done|finish\w*|close (the )?(job|project|case|deal)|the (job|project|case) is (done|closed)|complete\w*)\b/i;
const LEAD = /^(and then|then|next|after that|afterwards|first(ly)?|finally|lastly|also|and|so|once (that is|that's|it is|it's) done,?)\s+/i;

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
const clean = (x: string) => x.replace(/^\s*([-*•·]|\d+[.)]|step \d+[:.)]?)\s*/i, '').replace(/\s+/g, ' ').trim();

/** Who a clause names: a role the company has, or "the <role> <verb>s". */
function whoIn(clause: string, known: string[]): string | null {
  const low = ` ${clause.toLowerCase()} `;
  const hit = known.filter((r) => r.trim().length > 2).sort((a, z) => z.length - a.length).find((r) => low.includes(` ${r.toLowerCase()} `) || low.includes(` ${r.toLowerCase()}s `));
  // "the sales executive calls" names more than a known "Sales": the words in the text win when they hold it.
  const said = whoSaid(clause);
  if (hit && !(said && said.toLowerCase().startsWith(hit.toLowerCase()) && said.length > hit.length)) return hit;
  return said;
}
function whoSaid(clause: string): string | null {
  const m = clause.match(/\b(?:the|our|a|an)\s+([a-z]+(?:\s+[a-z]+)?)\s+(?:calls?|visits?|writes?|sends?|checks?|approves?|makes?|does|takes?|meets?|collects?|reviews?|prepares?|creates?|books?|fills?|uploads?|tells?|asks?|gets?|signs?|installs?|shoots?|edits?|designs?|records?|follows?)\b/i)
    ?? clause.match(/\b(?:by|from)\s+the\s+([a-z]+(?:\s+[a-z]+)?)\b/i);
  const r = m?.[1]?.trim();
  if (!r || /^(client|customer|lead|team|person|same|next|first|project)$/i.test(r)) return null;
  return r.split(' ').length > 2 ? null : r;
}
/** When it is due: "within 2 days", "in 3 working days", "the next day", "the same day". */
function dueIn(clause: string): number | null {
  const m = clause.match(/\b(?:within|in|after)\s+(\d{1,3}|one|two|three|four|five|a)\s+(working\s+)?(days?|weeks?|hours?)\b/i);
  if (m) { const n = { one: 1, two: 2, three: 3, four: 4, five: 5, a: 1 }[m[1].toLowerCase() as 'one'] ?? Number(m[1]); return /week/i.test(m[3]) ? n * 5 : /hour/i.test(m[3]) ? 1 : n; }
  if (/\b(next|following) day\b|\btomorrow\b/i.test(clause)) return 1;
  if (/\bsame day\b|\btoday\b|\bright away\b|\bimmediately\b/i.test(clause)) return 0;
  return null;
}
const pick = (clause: string, first: boolean): Pick => {
  if (first) for (const [re, p] of START_RULES) if (re.test(clause)) return p;
  for (const [re, p] of RULES) if (re.test(clause)) return p;
  return { block: 'task', kind: 'do' };
};
const titleOf = (clause: string) => cap(clause.replace(LEAD, '').replace(/[.;:,\s]+$/, '')).slice(0, 140);

type Draft = { definition: FlowDef; notes: string[]; steps: number };

/** The clauses of a write-up: numbered or bulleted lines are steps (their indented lines a checklist); a paragraph is
 *  cut at sentences and at "then"; a short line ending in ":" or "Stage …" starts a stage. */
function clauses(text: string): { stage: string | null; text: string; checklist: string[] }[] {
  const out: { stage: string | null; text: string; checklist: string[] }[] = [];
  let stage: string | null = null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const listy = lines.filter((l) => /^\s*([-*•·]|\d+[.)])\s+/.test(l)).length >= 2;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  '); const t = line.trim(); if (!t) continue;
    if (/^(#{1,4}\s+|(stage|phase|part)\s+\w+\s*[:.\-–—]?)/i.test(t) || (t.endsWith(':') && t.split(/\s+/).length <= 6 && !/^\s*([-*•·]|\d+[.)])/.test(line))) {
      stage = clean(t.replace(/^#+\s*/, '').replace(/:$/, '').replace(/^(stage|phase|part)\s+\w+\s*[:.\-–—]\s*(?=\S)/i, '')).slice(0, 120) || stage; continue;
    }
    const indent = line.length - line.trimStart().length;
    if (listy && indent >= 2 && out.length && /^\s*([-*•·]|[a-z][.)])\s+/i.test(line)) { out[out.length - 1].checklist.push(clean(t).slice(0, 300)); continue; }
    const body = clean(t);
    const parts = listy && /^\s*([-*•·]|\d+[.)])\s+/.test(line) ? [body]
      : body.split(/(?<=[.!?;])\s+(?=[A-Z0-9])|\s*;\s*|,?\s+(?:and )?then\s+|\s+after that,?\s+|\s*→\s*/i).map((x) => x.trim()).filter((x) => x.length > 2);
    for (const p of parts) out.push({ stage, text: p, checklist: [] });
  }
  return out;
}

export function draftFromText(text: string, title: string, knownRoles: string[]): Draft {
  const notes: string[] = [];
  const roles: RoleDef[] = []; const stages: Stage[] = [];
  const roleKey = (label: string) => { const k = slug(label); if (!roles.some((r) => r.key === k)) roles.push({ key: k, label: cap(label) }); return k; };
  const stageKey = (label: string | null) => { if (!label) return null; const k = slug(label).slice(0, 40); if (!stages.some((s) => s.key === k)) stages.push({ key: k, label }); return k; };
  const steps: FlowStep[] = []; const wires: FlowWire[] = [];
  let n = 0; const id = () => `s${++n}`;
  const make = (p: Pick, title0: string, stage: string | null, extra: Partial<FlowStep> = {}): FlowStep => {
    const kd = PRIMITIVE.get(p.block)!.kinds.find((k) => k.key === p.kind) ?? PRIMITIVE.get(p.block)!.kinds[0];
    return { id: id(), block: p.block, module: kd.module, title: title0, stage, who: { by: 'starter' }, settings: { ...(kd.settings ?? {}) }, pos: { x: 0, y: 0 }, checklist: [], qualityTest: [], inputs: [], when: [], due: null, hours: null, note: null, sop: null, ...extra };
  };
  // Each new step waits for the ends of what came before (one step, or both ways of a Decide).
  let ends: { step: string; port: string }[] = [];
  const follow = (s: FlowStep, from = ends) => { if (s.block !== 'start') for (const e of from) wires.push({ from: e, to: { step: s.id, port: 'in' } }); };
  const out = (s: FlowStep) => stepPorts(s).makes[0]?.key ?? 'done';
  const parts = clauses(text);
  // "When a lead comes in, the sales person calls them": how it starts, then the first step.
  const w0 = parts[0]?.text.match(/^(?:when|whenever|once|every time|each time)\s+(.+?),\s*(.+)$/i);
  if (w0 && START_RULES.some(([re]) => re.test(w0[1]))) parts.splice(0, 1, { ...parts[0], text: `When ${w0[1]}`, checklist: [] }, { ...parts[0], text: w0[2] });
  if (!parts.length) return { definition: { version: 2, fields: [], roles: [], stages: [], steps: [], wires: [], rules: [], clock: { from: 'start' } }, notes: ['Pip found nothing to read: write how the work goes, one step after another.'], steps: 0 };
  let unknownWho = 0; let dues = 0;
  parts.forEach((c, i) => {
    const stage = stageKey(c.stage);
    if (i === parts.length - 1 && END.test(c.text.replace(LEAD, ''))) { const e = make({ block: 'end', kind: 'end' }, titleOf(c.text), stage); steps.push(e); follow(e); ends = []; return; }
    // "If …, A; otherwise B" → a Decide with a step on each way.
    if (i === 0 && !START_RULES.some(([re]) => re.test(c.text))) { const s0 = make({ block: 'start', kind: 'hand' }, 'Start by hand', stage); steps.push(s0); ends = [{ step: s0.id, port: out(s0) }]; }
    const iff = c.text.replace(LEAD, '').match(/^(?:if|whether)\s+(.+?),\s*(.+?)(?:[;,.]?\s*(?:otherwise|else|if not|if they don'?t|if no),?\s*(.+))?$/i);
    if (iff) {
      const d = make({ block: 'decide', kind: 'person' }, `${cap(iff[1].replace(/[?.]$/, ''))}?`, stage); steps.push(d); follow(d);
      const yes = make(pick(iff[2], false), titleOf(iff[2]), stage); steps.push(yes); follow(yes, [{ step: d.id, port: 'yes' }]);
      const whoY = whoIn(iff[2], [...knownRoles, ...roles.map((r) => r.label)]); if (whoY) yes.who = { by: 'role', role: roleKey(whoY) };
      ends = [{ step: yes.id, port: out(yes) }];
      if (iff[3]) { const no = make(pick(iff[3], false), titleOf(iff[3]), stage); steps.push(no); follow(no, [{ step: d.id, port: 'no' }]); ends.push({ step: no.id, port: out(no) });
        const whoN = whoIn(iff[3], [...knownRoles, ...roles.map((r) => r.label)]); if (whoN) no.who = { by: 'role', role: roleKey(whoN) }; }
      else ends.push({ step: d.id, port: 'no' });
      return;
    }
    const p = pick(c.text, i === 0);
    const s = make(p, titleOf(c.text), stage, { checklist: c.checklist });
    const who = p.block === 'start' || p.block === 'wait' || (p.block === 'message' && p.kind === 'pulse') ? null : whoIn(c.text, [...knownRoles, ...roles.map((r) => r.label)]);
    if (who) s.who = { by: 'role', role: roleKey(who) }; else if (!['start', 'wait', 'message', 'end', 'ai'].includes(p.block)) unknownWho++;
    const days = dueIn(c.text);
    if (p.block === 'wait') { const w = c.text.match(/\b(\d{1,3}|one|two|three|four|five|a)\s+(working\s+)?(days?|weeks?|hours?)\b/i);
      if (w) { const k = { one: 1, two: 2, three: 3, four: 4, five: 5, a: 1 }[w[1].toLowerCase() as 'one'] ?? Number(w[1]); s.settings = { ...s.settings, hours: /hour/i.test(w[3]) ? k : (/week/i.test(w[3]) ? k * 7 : k) * 24 }; } }
    else if (days !== null && p.block !== 'start') { const prev = ends[0]?.step; s.due = { from: prev && steps.find((x) => x.id === prev)?.block !== 'start' ? `step:${prev}` : 'start', days, workdays: true } as DueRule; dues++; }
    if (p.block === 'message' && p.kind === 'pulse') s.settings = { ...s.settings, roles: ['starter'], text: titleOf(c.text) };
    if (p.block === 'repeat') s.settings = { ...s.settings, every: /week|monday|tuesday|wednesday|thursday|friday/i.test(c.text) ? 'week' : 'day' };
    steps.push(s); follow(s);
    ends = [{ step: s.id, port: out(s) }];
  });
  if (!steps.some((s) => s.block === 'end')) { const e = make({ block: 'end', kind: 'end' }, 'Done', steps[steps.length - 1]?.stage ?? null); steps.push(e); follow(e); }
  const people = roles.length;
  notes.push(`${steps.length} steps${stages.length ? ` in ${stages.length} stages` : ''}, ${people ? `${people} ${people === 1 ? 'role' : 'roles'} (${roles.map((r) => r.label).join(', ')})` : 'no roles named'}${dues ? `, ${dues} due ${dues === 1 ? 'date' : 'dates'}` : ''}.`);
  if (unknownWho) notes.push(`I could not tell who does ${unknownWho} ${unknownWho === 1 ? 'step' : 'steps'}: ${unknownWho === 1 ? 'it goes' : 'they go'} to whoever starts the run until you choose.`);
  if (steps.some((s) => s.block === 'decide')) notes.push('Each “if” is a Decide: a person chooses the way; you can make it decide by itself from an answer.');
  notes.push(`Read from “${title}”. Nothing runs until you press Go live.`);
  return { definition: { version: 2, fields: [], roles, stages, steps, wires, rules: [], clock: { from: 'start' }, terms: null }, notes, steps: steps.length };
}
