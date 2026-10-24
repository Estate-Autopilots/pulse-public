/** TASKS-P0: "Plan it with Pip". Pip suggests the steps, the fastest path, who to ask and a message ready to copy for
 *  one task. Like the scorer (task-scorer.ts) this sits behind an interface: Pulse has no language-model seam today, so
 *  the planner is a transparent heuristic over the task's own words, its people and the work around it. It reads no
 *  keys, calls nothing and never sends anything; the person copies the message if they want it. */
import { createHash } from 'node:crypto';

export type PlanPerson = { id: string; name: string; role?: string | null; pod?: string | null; department?: string | null };
export type PlanInput = {
  title: string; notes: string | null; valueNote: string | null; dueText: string | null; overdue: boolean; estimateMinutes: number | null;
  doer: PlanPerson | null; reviewer: PlanPerson | null; viewerIsDoer: boolean;
  waiting: { title: string; person: PlanPerson | null }[];          // open tasks that wait on this one
  blockers: { title: string; person: PlanPerson | null }[];         // what this one waits on
  related: { id: string; title: string; dueText: string | null; reviewerId: string | null }[];  // the doer's other open tasks
  staff: PlanPerson[];
};
export type PlanStep = { text: string; minutes: number | null; phone: boolean };
export type Plan = { summary: string; steps: PlanStep[]; fromNotes: boolean; fastest: string[]; ask: { id: string; name: string; why: string }[];
  message: { channel: 'WhatsApp' | 'Message'; to: string | null; toId: string | null; text: string } | null; basis: string[]; planner: string; version: string };
export interface TaskPlanner { readonly name: string; readonly version: string; plan(input: PlanInput): Promise<Plan> }

const first = (name: string | null | undefined) => String(name ?? '').replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, '').split(/\s+/)[0] || 'there';
const PHONE = /\b(whatsapp|message|send|tell|ask|call|approve|reply|remind|share|check with|forward|confirm)\b/i;
const DESK = /\b(upload|export|download|file|sign|review|read|record|write|draft|create|set up|open the|apply|enrol|add)\b/i;
const sentence = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/[.:;,]+$/, '');
/** "The check-in rules" → "the check-in rules"; acronyms ("HR invites…") stay as they are. */
const lowerFirst = (s: string) => s && !/^[A-Z]{2}/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;

/** Numbered lines in the notes, as written. */
export function noteSteps(notes: string | null) {
  return String(notes ?? '').split(/\r?\n/).map((l) => l.trim().match(/^(\d{1,2})[.)]\s+(.+)$/)?.[2]?.trim()).filter((x): x is string => !!x);
}
/** Staff named in the text by first or full name (a unique match only); "HR" names the HR people. */
export function namedPeople(text: string, staff: PlanPerson[]) {
  const out: { person: PlanPerson; via: string }[] = [];
  for (const p of staff) {
    const f = first(p.name);
    if (f.length < 3) continue;
    const same = staff.filter((x) => first(x.name).toLowerCase() === f.toLowerCase());
    if (new RegExp(`\\b${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text) || (same.length === 1 && new RegExp(`\\b${f}\\b`, 'i').test(text))) out.push({ person: p, via: 'named' });
  }
  if (/\bHR\b/.test(text)) for (const p of staff.filter((x) => /\bhr\b/i.test(`${x.role ?? ''} ${x.department ?? ''}`))) if (!out.some((o) => o.person.id === p.id)) out.push({ person: p, via: 'hr' });
  return out;
}

function stepsFor(title: string, to: string): string[] {
  const t = title.trim();
  if (/^send\b/i.test(t)) return ['Get the details ready', `Send them to ${to} (the message below)`, 'Mark this done'];
  if (/^approve\b/i.test(t)) return [`Open and read ${lowerFirst(t.replace(/^approve\s+/i, '').replace(/\s+and\s+send.*$/i, ''))}`, 'Note anything to change', `Tell ${to} you approve (the message below)`, 'Mark this done'];
  if (/^decide\b/i.test(t)) return ['Write down the options', 'Choose one for each', `Tell ${to} (the message below)`, 'Mark this done'];
  if (/^(ask|tell|remind)\b/i.test(t)) return ['Send the message below', 'Note the date they promise', 'Mark this done when they confirm'];
  if (/^make sure\b/i.test(t)) return [`Check with ${to} that it is on track`, 'Fix what is missing', 'Mark this done when it has happened'];
  if (/^(upload|export|download)\b/i.test(t)) return ['Get the files', 'Upload them where the task says', 'Attach a link as proof', 'Mark this done'];
  if (/^(review|read)\b/i.test(t)) return ['Open it', 'Mark your decisions', `Tell ${to} in a comment`, 'Mark this done'];
  return ['Open what you need', 'Do the work', 'Attach a link or file as proof', 'Mark this done'];
}

/** The message, in the person's voice, with blanks (____) where only they know the answer. */
export function draftMessage(input: PlanInput, recipient: PlanPerson | null): Plan['message'] {
  const title = sentence(input.title), me = first(input.doer?.name);
  // "Ask the CA to …" goes to the CA (someone outside Pulse unless a colleague has that name), not to the reviewer.
  const asked = title.match(/^ask\s+(?:the\s+)?(\w+)\s+to\s+(.+)$/i);
  const to = asked ? input.staff.find((p) => first(p.name).toLowerCase() === asked[1].toLowerCase()) ?? null : recipient;
  const hi = to ? `Hi ${first(to.name)},` : 'Hi,';
  const sign = input.doer ? `\n— ${me}` : '';
  const channel: 'WhatsApp' | 'Message' = /whatsapp/i.test(`${input.title} ${input.notes ?? ''}`) || /^(send|tell|ask|remind)\b/i.test(title) ? 'WhatsApp' : 'Message';
  let body: string;
  // "Send HR the office Wi-Fi name and the office public IP": who it goes to (HR, a person's first name) comes off the front.
  const names = new Set(['hr', 'him', 'her', 'them', ...input.staff.map((p) => first(p.name).toLowerCase())]);
  let what = title.replace(/^send\s+/i, '');
  const lead = what.split(/\s+/)[0] ?? '';
  if (names.has(lead.toLowerCase()) && /\s/.test(what)) what = what.slice(lead.length).trim();
  what = what.replace(/^the\s+/i, '').replace(/\s+to\s+(?:hr|the\s+\w+|[A-Z]\w+)(?:\s.*)?$/, '');
  if (/^send\b/i.test(title) && what) {
    const items = what.split(/\s+and\s+(?:the\s+)?/i).map((x) => x.replace(/^the\s+/i, '').trim()).filter(Boolean);
    body = `${hi} here ${items.length > 1 ? 'are the details' : 'is the detail'} you asked for:\n${items.map((i) => `• ${i[0].toUpperCase()}${i.slice(1)}: ____`).join('\n')}`;
  } else if (/^tell\s+\w+\s+(.+)$/i.test(title)) {
    const what = title.match(/^tell\s+\w+\s+(.+)$/i)![1];
    body = `${hi} ${lowerFirst(what).replace(/^who\s+/, 'here is who ').replace(/^the\s+/, 'here is the ')}: ____`;
  } else if (/^approve\b/i.test(title)) {
    const what = title.replace(/^approve\s+(the\s+)?/i, '').replace(/\s+and\s+send.*$/i, '');
    body = `${hi} I have read ${what} and I approve it. Please go ahead.`;
  } else if (/^decide\b/i.test(title)) {
    const steps = noteSteps(input.notes);
    body = `${hi} my decision on ${lowerFirst(title.replace(/^decide\s+(on\s+)?/i, ''))}:\n${(steps.length ? steps : ['____']).map((s, i) => `${i + 1}. ${s.replace(/[.:]+$/, '').split(':')[0]}: ____`).join('\n')}`;
  } else if (asked) {
    body = `${hi} could you please ${lowerFirst(asked[2])}? Thank you.`;
  } else if (/^make sure\b/i.test(title)) {
    body = `${hi} just checking: ${lowerFirst(title.replace(/^make sure\s+/i, ''))}. Is that on track? Anything you need from me?`;
  } else body = `${hi} an update on “${title}”: ____`;
  return { channel, to: to?.name ?? null, toId: to?.id ?? null, text: `${body}${sign}` };
}

export const heuristicPlanner: TaskPlanner = {
  name: 'pip-planner-heuristic',
  version: '1',
  async plan(x: PlanInput): Promise<Plan> {
    const basis: string[] = [];
    const words = `${x.title}\n${x.notes ?? ''}`;
    const named = namedPeople(words, x.staff.filter((p) => p.id !== x.doer?.id));
    // Who the message goes to: someone the task names, else HR when it says HR, else the reviewer.
    const to = named.find((n) => n.via === 'named')?.person ?? named.find((n) => n.via === 'hr' && n.person.id === x.reviewer?.id)?.person ?? named[0]?.person ?? x.reviewer ?? null;
    const fromNotes = noteSteps(x.notes);
    const texts = fromNotes.length ? fromNotes : stepsFor(x.title, to ? first(to.name) : 'them');
    basis.push(fromNotes.length ? `${fromNotes.length} numbered steps in the notes` : 'Steps from what the title asks for');
    const each = x.estimateMinutes ? Math.max(2, Math.round(x.estimateMinutes / texts.length)) : null;
    const steps = texts.map((text) => ({ text, minutes: each, phone: PHONE.test(text) && !DESK.test(text) }));
    const phone = steps.every((s) => s.phone || /mark this done|the message below/i.test(s.text));

    const fastest: string[] = [];
    if (x.blockers.length) fastest.push(`It waits on ${x.blockers.map((b) => `“${b.title}”${b.person ? ` (${first(b.person.name)})` : ''}`).join(' and ')}: ask for that first.`);
    if (x.overdue) fastest.push('It is overdue: send what you have now and say when the rest follows.');
    if (x.estimateMinutes) fastest.push(`About ${x.estimateMinutes < 60 ? `${x.estimateMinutes} min` : `${Math.round(x.estimateMinutes / 6) / 10} h`}${phone ? ', all from your phone' : ''}: do it in one sitting${x.dueText ? ` (${lowerFirst(x.dueText)})` : ''}.`);
    else if (phone) fastest.push('Every step works from your phone.');
    const waitingPeople = [...new Map(x.waiting.filter((w) => w.person).map((w) => [w.person!.id, w.person!])).values()];
    if (x.waiting.length) fastest.push(`Finishing it unlocks ${x.waiting.length === 1 ? 'a task' : `${x.waiting.length} tasks`}${waitingPeople.length ? ` for ${waitingPeople.map((p) => first(p.name)).join(', ')}` : ''}.`);
    const batch = x.related.filter((r) => r.title !== x.title && ((to && x.reviewer && r.reviewerId === x.reviewer.id) || namedPeople(r.title, to ? [to] : []).length)).slice(0, 2);
    if (batch.length && to) fastest.push(`Do it with ${batch.map((b) => `“${b.title}”`).join(' and ')}: ${first(to.name)} needs ${batch.length === 1 ? 'both' : 'all of them'}.`);
    if (!fastest.length) fastest.push('Start with the first step now; the rest follows from it.');
    basis.push(x.estimateMinutes ? 'Time from the estimate on the task' : 'No estimate on the task');

    const ask: Plan['ask'] = [];
    const add = (p: PlanPerson | null | undefined, why: string) => { if (p && p.id !== x.doer?.id && !ask.some((a) => a.id === p.id) && ask.length < 3) ask.push({ id: p.id, name: p.name, why }); };
    for (const n of named) add(n.person, n.via === 'hr' ? 'HR: the task is for them' : 'Named in the task');
    for (const b of x.blockers) add(b.person, `Owns “${b.title}”, which this waits on`);
    add(x.reviewer, 'Reviews this when it is done');
    for (const w of x.waiting) add(w.person, `Waiting on it for “${w.title}”`);

    const minutes = x.estimateMinutes; const message = draftMessage(x, to);
    const summary = `${steps.length} step${steps.length === 1 ? '' : 's'}${minutes ? `, about ${minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 6) / 10} h`}` : ''}${phone ? ', from your phone' : ''}${message?.to ? `; it goes to ${first(message.to)}` : ''}.`;
    return { summary, steps, fromNotes: fromNotes.length > 0, fastest: fastest.slice(0, 4), ask, message, basis, planner: this.name, version: this.version };
  },
};

/** What the cached plan depends on: when any of it changes, Pip plans again. */
export function planHash(parts: unknown) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32); }
