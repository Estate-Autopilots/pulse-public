/** FLOW-A: how a run reads, in words. Pure: due dates ("Due tomorrow", "2 working days late", "Day 4 · waits for the
 *  inputs"), what a waiting step waits for and from whom, and Pip's one line on a run ("2 steps late · Blueprint due
 *  tomorrow · waiting on the transcript from Rila"). store.ts feeds them from the database. */
import { MODULE } from './registry.js';
import { stepPorts } from './blocks.js';
import { KIND_LABELS, OPEN_STATES, STEP_STATE_LABELS, type Due, type FlowDef, type FlowStep, type PersonRef, type StepState, type WaitingFor } from './types.js';

const DAY = 86400000;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayWords = (d: string) => { const x = new Date(`${d}T00:00:00Z`); return `${WEEKDAY[x.getUTCDay()]} ${x.getUTCDate()} ${MONTH[x.getUTCMonth()]}`; };

/** A step's due date in words. `dayN` is its Day-N rule when it counts from Day 1 (shown while the clock has not started). */
export function dueOf(on: string | null, today: string, state: StepState, dayN: number | null, clockStarted: boolean): Due {
  const finished = state === 'done' || state === 'skipped';
  if (!on) return { on: null, text: dayN !== null && !clockStarted ? `Day ${dayN} · the clock starts when the inputs are in` : dayN !== null ? `Day ${dayN}` : '', late: false, days: null };
  const n = days(today, on);
  if (finished) return { on, text: `Was due ${dayWords(on)}`, late: false, days: n };
  const text = n < 0 ? `${-n} day${n === -1 ? '' : 's'} late` : n === 0 ? 'Due today' : n === 1 ? 'Due tomorrow' : n < 7 ? `Due ${dayWords(on).split(' ')[0]}` : `Due ${dayWords(on)}`;
  return { on, text: dayN !== null ? `${text} · Day ${dayN}` : text, late: n < 0, days: n };
}

/** The Day N a step's due rule names for this run's variant, when it counts from Day 1. */
export function dayNOf(step: FlowStep, fields: Record<string, unknown>): number | null {
  const d = step.due; if (!d || d.from !== 'day1') return null;
  if (typeof d.days === 'number') return d.days;
  const v = d.field ? fields[d.field] : null; const n = typeof v === 'string' ? d.days[v] : undefined;
  return typeof n === 'number' ? n : null;
}

/** A step's title short enough for a sentence: up to its first bracket, colon, semicolon or arrow ("First drop", "Big
 *  Idea per creative + hook plan"), at most 60 characters. */
export function shortTitle(t: string) {
  const cut = t.split(/ \(|: |; | → |\. /)[0].trim();
  const x = cut.length >= 8 ? cut : t;
  return x.length > 60 ? `${x.slice(0, 57).trimEnd()}…` : x;
}

type StepRow = { key: string; title: string; state: StepState; personId: string | null; person: PersonRef | null };
/** What a waiting step waits for, and whose it is: each required need not yet filled (for a many need, each step still to
 *  give it), the step that makes it (and who has it, or the role named for it) or the person who types it in. */
export function waitingFor(def: FlowDef, stepKey: string, rows: Map<string, StepRow>, filled: Set<string>, people: Record<string, PersonRef | null>,
  required: (port: string) => boolean): WaitingFor[] {
  const s = def.steps.find((x) => x.id === stepKey); if (!s) return [];
  if (!MODULE.get(s.module)) return [];
  const roleLabel = (k: string | null | undefined) => (k ? def.roles.find((r) => r.key === k)?.label ?? k : null);
  const out: WaitingFor[] = [];
  for (const need of stepPorts(s).needs) {
    if (!required(need.key)) continue;
    const wires = def.wires.filter((w) => w.to.step === stepKey && w.to.port === need.key);
    const pending = wires.map((w) => rows.get(w.from.step)).filter((r): r is StepRow => !!r && r.state !== 'skipped' && r.state !== 'done');
    if (filled.has(need.key) && !(need.many && pending.length)) continue;
    const direct = (s.inputs ?? []).find((i) => i.port === need.key);
    const ownerRole = direct?.owner.by === 'role' ? direct.owner.role ?? null : null;
    const from = pending.length ? pending : wires.map((w) => rows.get(w.from.step)).filter((r): r is StepRow => !!r).slice(0, 1);
    if (!from.length) out.push({ port: need.key, label: direct?.label ?? need.label, kind: need.kind, from: null,
      owner: direct ? (direct.owner.by === 'role' && direct.owner.role ? people[direct.owner.role] ?? null : null) : null, ownerRole: roleLabel(ownerRole) });
    for (const src of from) { const srcDef = def.steps.find((x) => x.id === src.key);
      out.push({ port: need.key, label: need.label, kind: need.kind,
        from: { step: src.key, title: shortTitle(src.title), who: src.person ?? (srcDef?.who.by === 'role' && srcDef.who.role ? people[srcDef.who.role] ?? null : null), role: roleLabel(srcDef?.who.by === 'role' ? srcDef.who.role : null) },
        owner: null, ownerRole: null }); }
  }
  return out;
}

/** "the transcript from Rila (Creative Strategist)" */
export function waitWords(w: WaitingFor) {
  const who = w.from?.who?.name?.split(' ')[0] ?? w.owner?.name?.split(' ')[0] ?? null;
  const role = w.from?.role ?? w.ownerRole;
  const what = w.from ? w.from.title : `the ${w.label.replace(/^the /i, '').replace(/^./, (c) => c.toLowerCase())}`;
  return `${what}${who ? ` from ${who}` : role ? ` from the ${role}` : ''}`;
}
export const stateText = (s: StepState, waiting: WaitingFor[]) => s === 'waiting' && waiting.length ? `Waiting for ${waitWords(waiting[0])}${waiting.length > 1 ? ` and ${waiting.length - 1} more` : ''}` : STEP_STATE_LABELS[s];
export const kindWords = (k: keyof typeof KIND_LABELS) => KIND_LABELS[k].toLowerCase();

/** Pip's one line on a run: what is late, who is on what, what is due next and what it waits on. */
export function pipLine(steps: { title: string; state: StepState; due: Due; waitingFor: WaitingFor[]; blocked: unknown; who: PersonRef | null }[], status: string, day1: string | null, missingInputs: number): string {
  if (status === 'done') return 'Done: every step is finished or not part of this run.';
  if (status === 'cancelled') return 'Stopped.';
  const parts: string[] = [];
  const first = (p: PersonRef | null) => p?.name?.split(' ')[0] ?? null;
  const late = steps.filter((s) => s.due.late);
  if (late.length) parts.push(`${late.length} step${late.length === 1 ? '' : 's'} late (${late.slice(0, 2).map((s) => shortTitle(s.title)).join(', ')}${late.length > 2 ? '…' : ''})`);
  if (!day1 && missingInputs) parts.push(`the clock starts when ${missingInputs} more input${missingInputs === 1 ? ' is' : 's are'} in`);
  const working = steps.filter((s) => OPEN_STATES.includes(s.state) && !s.due.late);
  if (working.length) parts.push(working.slice(0, 2).map((s) => `${first(s.who) ?? 'someone'} is on ${shortTitle(s.title)}`).join(', ') + (working.length > 2 ? ` (+${working.length - 2})` : ''));
  const named = new Set(working.slice(0, 2));
  const next = steps.filter((s) => s.state !== 'done' && s.state !== 'skipped' && s.due.on && !s.due.late && !named.has(s)).sort((a, b) => (a.due.on! < b.due.on! ? -1 : 1))[0];
  if (next) parts.push(`${shortTitle(next.title)} ${next.due.text.split(' · ')[0].replace(/^Due/, 'due')}${next.state === 'waiting' && next.waitingFor.length ? `, waiting on ${waitWords(next.waitingFor[0])}` : ''}`);
  const blocked = steps.find((s) => s.state === 'waiting' && (s.blocked || s.due.late) && s.waitingFor.length);
  if (blocked) parts.push(`${shortTitle(blocked.title)} is blocked on ${waitWords(blocked.waitingFor[0])}`);
  if (!parts.length) return 'Nothing open: waiting for data.';
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1) + '.';
}
