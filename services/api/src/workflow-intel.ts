/** SOP-WORKFLOW part 2: Pip while a workflow is designed. For every step: who could do it (load, skill, history), how
 *  long it usually takes (finished tasks of the same kind), what to watch (one person holding a role, someone on many
 *  workflows, an SLA shorter than the usual time); for a chosen person, the effect of putting them there; for the whole
 *  workflow, management steps it lacks and earlier workflows or SOPs it repeats. Transparent rules on Pulse's own data
 *  (no model, no calls out); `advise` is pure so a model-backed adviser could take its place. */
import type { PoolClient } from 'pg';
import type { Viewer } from './routes.js';
import { edges } from './sop-model.js';
import type { WorkflowDef, WorkflowStep } from './workflow-model.js';

export type Person = { id: string; name: string; role: string | null; pod: string | null; photoAt: string | null; open: number; workflows: number; activeSteps: number;
  categories: string[]; history: Record<string, { n: number; days: number | null; late: number }> };
export type Facts = {
  people: Person[]; holders: Record<string, string[]>; categories: Record<string, string>;
  similar: Record<string, { n: number; minutes: number | null; cycleDays: number | null }>;
  past: { kind: 'workflow' | 'sop'; id: string; name: string; titles: string[] }[];
  modes: Record<string, string>;
};
export type Candidate = { id: string; name: string; photoAt: string | null; pod: string | null; role: string | null; score: number; reasons: string[] };
export type Effect = { personId: string; name: string; lines: string[]; warn: boolean };
export type StepAdvice = { stepId: string; category: string | null; categoryLabel: string | null; estimate: { days: number | null; minutes: number | null; n: number; basis: string } | null;
  candidates: Candidate[]; flags: { level: 'warn' | 'info'; text: string }[]; effect: Effect | null };
export type Suggestion = { key: string; text: string; why: string; after: string | null; step: Partial<WorkflowStep> };
export type Reuse = { kind: 'workflow' | 'sop'; id: string; name: string; shared: number; of: number; similarity: number; titles: string[] };
export type Advice = { steps: StepAdvice[]; suggestions: Suggestion[]; reuse: Reuse[]; summary: string[] };

const OUTSIDE = /^(the )?(client|customer|vendor|supplier|partner|developer)s?$/i;
const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'for', 'with', 'in', 'on', 'by', 'from', 'it', 'all', 'step', 'client', 'project']);
const first = (name: string) => name.replace(/^(mr|mrs|ms|dr)\.?\s+/i, '').split(' ')[0];
const days = (d: number | null) => d == null ? null : d < 1 ? `${Math.max(1, Math.round(d * 24))} h` : `${Math.round(d * 10) / 10} d`;
/** A step title as a key for comparing workflows: its first meaningful words, lower case, singular-ish. */
export const titleKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|es|s)$/, '')).slice(0, 3).join(' ');

function holdersOf(step: WorkflowStep, f: Facts): string[] {
  // A step given to a named person still lists the others who hold its role, as alternatives.
  const role = step.assign.by === 'role' ? step.assign.role ?? step.role : step.role;
  if (step.assign.by === 'domain') { const cat = step.assign.category ?? step.category; return f.people.filter((p) => cat && p.categories.includes(cat)).map((p) => p.id); }
  return role ? f.holders[role] ?? [] : [];
}

/** The effect of putting one person on a step. */
export function effectOf(person: Person, step: WorkflowStep, category: string | null, f: Facts, def: WorkflowDef): Effect {
  const name = first(person.name), lines: string[] = []; let warn = false;
  const already = def.steps.filter((s) => s.id !== step.id && s.assign.by === 'person' && s.assign.personId === person.id).length;
  lines.push(`${name} has ${person.open} open task${person.open === 1 ? '' : 's'}; each run adds this one${already ? ` and ${already} more step${already === 1 ? '' : 's'} of this workflow` : ''}`);
  if (person.workflows) { lines.push(`${name} already has steps in ${person.workflows} running workflow${person.workflows === 1 ? '' : 's'}`); if (person.workflows >= 4) warn = true; }
  const h = category ? person.history[category] : undefined, team = category ? f.similar[step.id] : undefined;
  if (h?.n) {
    lines.push(`${name} finished ${h.n} ${f.categories[category!] ?? category} task${h.n === 1 ? '' : 's'} in six months${h.days != null ? `, usually in ${days(h.days)}` : ''}${team?.cycleDays != null ? ` (the team: ${days(team.cycleDays)})` : ''}`);
    if (h.n >= 3 && h.late / h.n >= 0.4) { lines.push(`${Math.round((h.late / h.n) * 100)}% of them finished after their due date`); warn = true; }
  } else if (category) lines.push(`${name} has not done ${f.categories[category] ?? category} work in Pulse yet`);
  const mode = f.modes[person.id];
  if (mode === 'request') { lines.push(`Outside ${name}'s domains: each run asks them to take it, and they may decline`); warn = true; }
  else if (mode === 'direct') lines.push(`Inside ${name}'s domains: theirs at once`);
  if (step.slaHours && h?.days != null && h.days * 24 > step.slaHours * 1.2) { lines.push(`${name}'s usual time is longer than the SLA (${days(step.slaHours / 24)})`); warn = true; }
  if (person.open >= 15) warn = true;
  return { personId: person.id, name: person.name, lines, warn };
}

export function advise(def: WorkflowDef, f: Facts, focus?: { stepId?: string; personId?: string }): Advice {
  const byId = new Map(f.people.map((p) => [p.id, p]));
  const E = edges(def);
  const steps: StepAdvice[] = def.steps.map((s) => {
    const category = s.category ?? s.assign.category ?? null;
    const sim = f.similar[s.id];
    const estimate = sim?.n ? { days: sim.cycleDays, minutes: sim.minutes, n: sim.n, basis: `${sim.n} finished ${category ? (f.categories[category] ?? category) : 'similar'} task${sim.n === 1 ? '' : 's'}` } : null;
    const flags: StepAdvice['flags'] = [];
    const role = s.assign.by === 'role' ? s.assign.role ?? s.role : null;
    const holders = holdersOf(s, f);
    // Who could do it: holders of the role (or whose domains cover it), else people who did this kind of work.
    let pool = holders.map((id) => byId.get(id)).filter((p): p is Person => !!p);
    if (!pool.length && category) pool = f.people.filter((p) => p.history[category]?.n);
    const candidates = s.kind === 'wait' || s.kind === 'end' || s.assign.by === 'pool' || (role && OUTSIDE.test(role)) ? [] : pool.map((p) => {
      const h = category ? p.history[category] : undefined; const reasons: string[] = [];
      let score = 50 - Math.min(24, p.open * 1.5) - p.workflows * 4;
      if (holders.includes(p.id)) { score += 15; reasons.push(role ? `Holds ${role}` : 'Their domains cover it'); }
      if (category && p.categories.includes(category)) { score += 10; if (!reasons.length || !reasons[0].startsWith('Their domains')) reasons.push('In their domains'); }
      if (h?.n) { score += Math.min(25, 8 + h.n * 2); reasons.push(`${h.n} done${h.days != null ? `, usually ${days(h.days)}` : ''}`); if (h.n >= 3 && h.late / h.n >= 0.4) { score -= 10; reasons.push('often late'); } }
      reasons.push(`${p.open} open`); if (p.workflows) reasons.push(`on ${p.workflows} workflow${p.workflows === 1 ? '' : 's'}`);
      return { id: p.id, name: p.name, photoAt: p.photoAt, pod: p.pod, role: p.role, score: Math.round(score), reasons };
    }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 3);
    // What to watch.
    if (s.kind !== 'wait' && s.kind !== 'end') {
      if (s.assign.by === 'role' && role && !OUTSIDE.test(role) && holders.length === 0) flags.push({ level: 'warn', text: `Nobody holds “${role}”: runs will wait for someone to be chosen` });
      else if (s.assign.by === 'role' && holders.length === 1) flags.push({ level: 'warn', text: `Only ${first(byId.get(holders[0])?.name ?? 'one person')} holds “${role}”: a bottleneck when they are away` });
      if (s.assign.by === 'domain' && !holders.length) flags.push({ level: 'warn', text: 'Nobody\'s domains cover this kind of work yet' });
      const named = s.assign.by === 'person' && s.assign.personId ? byId.get(s.assign.personId) : null;
      const likely = named ?? (candidates[0] ? byId.get(candidates[0].id) : null);
      if (likely && likely.workflows >= 4) flags.push({ level: 'warn', text: `${first(likely.name)} is on ${likely.workflows} running workflows` });
      if (likely && likely.open >= 15) flags.push({ level: 'warn', text: `${first(likely.name)} has ${likely.open} open tasks` });
      if (!s.slaHours) flags.push({ level: 'info', text: 'No SLA: Pulse cannot tell when this step is late' });
      else if (estimate?.days != null && estimate.days * 24 > s.slaHours * 1.3) flags.push({ level: 'warn', text: `Usually takes ${days(estimate.days)}; the SLA is ${days(s.slaHours / 24)}` });
      if (s.kind === 'approval' && E.filter((e) => e.from === s.id).length < 2) flags.push({ level: 'info', text: 'An approval with one way out: add “Send back” to the step it returns to' });
    }
    const focusPerson = focus?.stepId === s.id && focus.personId ? byId.get(focus.personId) : s.assign.by === 'person' && s.assign.personId ? byId.get(s.assign.personId) : null;
    return { stepId: s.id, category, categoryLabel: category ? f.categories[category] ?? null : null, estimate, candidates, flags, effect: focusPerson ? effectOf(focusPerson, s, category, f, def) : null };
  });
  return { steps, suggestions: suggestions(def), reuse: reuse(def, f), summary: summary(def, steps, f) };
}

/** Management steps a workflow lacks: a handover, a review before the client sees work, a close-out, check-ins on long steps. */
export function suggestions(def: WorkflowDef): Suggestion[] {
  const out: Suggestion[] = []; const s = def.steps; if (!s.length) return out;
  const roles = new Set(s.map((x) => x.role).filter(Boolean));
  const t = (x: WorkflowStep) => `${x.title} ${x.outputs.join(' ')}`.toLowerCase();
  if (roles.size >= 3 && !/hand ?over|kick-?off|brief|onboard/.test(t(s[0]))) out.push({ key: 'handover', text: 'Start with a handover', why: `${roles.size} roles share this work: one step where the owner briefs everyone on what was promised`,
    after: null, step: { title: 'Handover and brief', kind: 'task', assign: { by: 'project_owner' }, slaHours: 24, outputs: ['Brief'] } });
  const outgoing = s.findIndex((x) => /\b(client|send|deliver|publish|go live|launch|share)\b/.test(t(x)) && x.kind === 'task');
  if (outgoing > 0 && !s.slice(0, outgoing).some((x) => x.kind === 'approval')) out.push({ key: 'review', text: `Review before “${s[outgoing].title}”`, why: 'Nothing is checked before it reaches the client',
    after: s[outgoing - 1].id, step: { title: `Review before: ${s[outgoing].title}`, kind: 'approval', assign: { by: 'project_owner' }, slaHours: 24 } });
  const last = s[s.length - 1];
  if (s.length >= 4 && !/close|report|feedback|wrap|hand ?over|done/.test(t(last))) out.push({ key: 'close', text: 'End with a close-out', why: 'A run should end with the client told and feedback asked',
    after: last.id, step: { title: 'Close out: report and ask for feedback', kind: 'task', assign: { by: 'project_owner' }, slaHours: 48 } });
  for (const x of s) if ((x.slaHours ?? 0) > 72 || (x.minutes ?? 0) > 8 * 60) { out.push({ key: `checkin-${x.id}`, text: `A check-in during “${x.title}”`, why: 'A long step: a midway check catches problems before the deadline',
    after: x.id, step: { title: `Check in: ${x.title}`, kind: 'task', assign: { by: 'project_owner' }, slaHours: 24 } }); break; }
  const noSla = s.filter((x) => x.kind !== 'wait' && x.kind !== 'end' && !x.slaHours).length;
  if (noSla >= 2) out.push({ key: 'sla', text: `Set SLAs on ${noSla} steps`, why: 'Without them nothing shows as late on the run', after: null, step: {} });
  return out;
}

/** Earlier workflows and SOPs with mostly the same steps: reuse them instead of starting again. */
export function reuse(def: WorkflowDef, f: Facts): Reuse[] {
  const mine = new Set(def.steps.map((x) => titleKey(x.title)).filter(Boolean)); if (mine.size < 2) return [];
  return f.past.map((p) => { const theirs = new Set(p.titles.map(titleKey).filter(Boolean)); const shared = [...mine].filter((k) => theirs.has(k)).length;
    return { kind: p.kind, id: p.id, name: p.name, shared, of: theirs.size, similarity: shared / new Set([...mine, ...theirs]).size, titles: p.titles.slice(0, 8) }; })
    .filter((x) => x.shared >= 2 && x.similarity >= 0.25).sort((a, b) => b.similarity - a.similarity).slice(0, 3);
}

function summary(def: WorkflowDef, steps: StepAdvice[], f: Facts) {
  const out: string[] = [];
  const est = steps.reduce((t, s) => t + (s.estimate?.days ?? 0), 0);
  if (est) out.push(`Similar finished work suggests about ${days(est)} end to end if each step waits for the one before`);
  const people = new Map<string, number>();
  for (const s of def.steps) { const id = s.assign.by === 'person' ? s.assign.personId : null; if (id) people.set(id, (people.get(id) ?? 0) + 1); }
  for (const [id, n] of people) if (n >= 3) out.push(`${first(f.people.find((p) => p.id === id)?.name ?? 'One person')} does ${n} of the steps: a single point of failure`);
  const warns = steps.reduce((t, s) => t + s.flags.filter((x) => x.level === 'warn').length, 0);
  if (warns) out.push(`${warns} thing${warns === 1 ? '' : 's'} to look at on the steps`);
  return out;
}

/** The facts the adviser needs, read with the viewer's rights. */
export async function loadFacts(c: PoolClient, _v: Viewer, def: WorkflowDef, opts: { projectId?: string | null; exclude?: string[]; focusPerson?: string | null; focusStep?: string | null }): Promise<Facts> {
  const people = (await c.query(`select p.id,p.display_name name,pp.role,pp.pod,(select ph.updated_at from pulse.person_photo ph where ph.person_id=p.id) "photoAt",pulse.workflow_open_load(p.id) open
   from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.side='staff' and p.status='active' order by p.display_name`)).rows as Person[];
  const running = (await c.query(`select coalesce(t.assignee_person_id,t.owner_id) pid,count(distinct r.workflow_id)::int workflows,count(*)::int steps
   from pulse.workflow_run_step s join pulse.workflow_run r on r.id=s.run_id join pulse.task t on t.id=s.task_id where s.status='active' and r.status='running' group by 1`)).rows;
  const doms = (await c.query(`select person_id,categories from pulse.work_domain where status='active'`)).rows;
  const hist = (await c.query(`select coalesce(assignee_person_id,owner_id) pid,category,count(*)::int n,
     percentile_cont(0.5) within group(order by extract(epoch from done_at-coalesce(started_at,assigned_at,created_at))/86400) filter(where done_at>coalesce(started_at,assigned_at,created_at)) days,
     count(*) filter(where due_at is not null and done_at>due_at)::int late
   from pulse.task where status in ('done','accepted') and done_at>now()-interval '180 days' and deleted_at is null and category is not null and coalesce(assignee_person_id,owner_id) is not null group by 1,2`)).rows;
  for (const p of people) {
    const r = running.find((x) => x.pid === p.id); p.workflows = r?.workflows ?? 0; p.activeSteps = r?.steps ?? 0;
    p.categories = [...new Set(doms.filter((d) => d.person_id === p.id).flatMap((d) => d.categories as string[]))];
    p.history = Object.fromEntries(hist.filter((h) => h.pid === p.id).map((h) => [h.category, { n: h.n, days: h.days == null ? null : Number(h.days), late: h.late }]));
  }
  const roles = [...new Set(def.steps.flatMap((s) => [s.assign.by === 'role' ? s.assign.role ?? s.role : null, s.role]).filter((r): r is string => !!r))];
  const holders: Record<string, string[]> = {};
  for (const r of roles) holders[r] = (await c.query('select pulse.workflow_role_people($1) id', [r])).rows.map((x) => x.id);
  const categories = Object.fromEntries((await c.query('select key,label from pulse.work_category where active')).rows.map((r) => [r.key, r.label]));
  const similar: Facts['similar'] = {};
  for (const s of def.steps.slice(0, 40)) {
    if (s.kind === 'wait' || s.kind === 'end') continue;
    const cat = s.category ?? s.assign.category ?? (await c.query('select pulse.work_category_guess($1) k', [s.title])).rows[0].k;
    if (!s.category && cat) s.category = cat;
    const sim = (await c.query('select pulse.work_similar_effort($1,$2) s', [cat, s.title])).rows[0].s;
    if (sim?.n) similar[s.id] = { n: sim.n, minutes: sim.minutes == null ? null : Math.round(Number(sim.minutes)), cycleDays: sim.cycleDays == null ? null : Number(sim.cycleDays) };
  }
  const skip = (opts.exclude ?? []).filter(Boolean);
  const past = [...(await c.query(`select 'workflow' kind,id,name,definition doc from pulse.workflow where status<>'archived' and not (id=any($1::uuid[]))`, [skip])).rows,
    ...(await c.query(`select 'sop' kind,id,title "name",doc from pulse.sop where status='active' and not (id=any($1::uuid[]))`, [skip])).rows]
    .map((r) => ({ kind: r.kind, id: r.id, name: r.name, titles: ((r.doc?.steps ?? []) as { title: string }[]).map((x) => x.title) }));
  // Inside or outside their domains, for the people the steps name (and the one being tried).
  const modes: Record<string, string> = {};
  const tried = new Set([...def.steps.filter((s) => s.assign.by === 'person' && s.assign.personId).map((s) => `${s.assign.personId}|${s.id}`), ...(opts.focusPerson && opts.focusStep ? [`${opts.focusPerson}|${opts.focusStep}`] : [])]);
  for (const k of tried) { const [pid, sid] = k.split('|'); const s = def.steps.find((x) => x.id === sid);
    modes[pid] = (await c.query('select pulse.work_assign_mode($1,$2,$3,$4) m', [pid, opts.projectId ?? null, s?.category ?? null, []])).rows[0].m?.mode ?? 'none'; }
  return { people, holders, categories, similar, past, modes };
}
