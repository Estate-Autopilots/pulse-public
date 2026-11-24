import { ORG_TZ } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, work, type Tx, type Viewer } from './routes.js';
import { bandwidth, planState, plansFor, roleOf, rolesOf, templateOf, templates, type ClockKey, type Plan, type PlanTask, type Step, type Template } from './project-plan.js';
import { screenFacts, type MoneyAtRisk } from './kazuk-gaps.js';

const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const rupees = (paise: number) => `₹${INR.format(Math.round(paise / 100))}`;

/** KAZUK (27 Oct 2026): the Projects tab Kazuk designed ("EA Projects TAB under Pulse": PGS "My projects" and CEO
 *  "All projects"). It answers "which project needs me first", from the work itself, not from Drive delivery counts:
 *  - each project with open work: its stage (the live process step when a run exists), the next step and who has it,
 *    the Day-N clock from kick-off, open and late tasks, and a health word with the reason it is there;
 *  - "Needs you today": the viewer's own late and due-today tasks across projects;
 *  - leadership and HR see every pod with a pod switcher (Kazuk's CEO screen); a pod head their pods; everyone else
 *    the projects they lead or hold work in. Tasks are read under the viewer's row security, so nobody sees a task
 *    they could not open.
 *  The per-person table ("People this week") belongs to WORK-TAB's Work → People and is linked, not rebuilt. */
const person = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own staff account to use Projects');
const OPEN = `t.status in ('open','in_progress','blocked','in_review')`;
const DUE = `(t.due_at at time zone ${ORG_TZ})::date`;

export type Health = 'blocked' | 'waiting' | 'at_risk' | 'watch' | 'on_track';
export type HealthRow = {
  id: string; title: string; location: string | null; segment?: string | null; client: string | null; clientId: string | null; pod: string | null;
  leadId: string | null; lead: string | null; status: string; kind: string; startsOn: string | null; dueOn: string | null;
  open: number; late: number; blocked: number; dueToday: number; soon: number; noOwner: number; noDue: number; review: number;
  waitingClient: number; mine: boolean; stage: string | null; stageDone: number | null; stageOf: number | null;
  next: { id: string; title: string; who: string | null; due: string | null; late: boolean } | null;
  lastActivity: string | null; health: Health; why: string; score: number;
  /** PROJECTS-CREATE: a project with no stage plan that the viewer may plan (its lead, its manager, leadership). */
  canPlan?: boolean;
  /** WORK-SPINE: started by an AI employee or an automation, not kept by a person, under no goal (listed apart). */ aiStarted?: boolean;
  plan?: (ReturnType<typeof planState> & { package: string | null; packageLabel?: string | null; category: string | null; units: number; templateKey: string; stageOwner?: string | null }) | null;
  /** PM-BUILD-3: the project's own colour and icon, the day its oldest late task was due, and the project as one card. */
  color?: string | null; icon?: string | null; lateSince?: string | null; pm?: PmCard;
};

/** Health in one word, with the reason a lead reads beside it. Pure, so it is unit-tested. */
export function judge(r: { open: number; late: number; blocked: number; soon: number; noOwner: number; noDue: number; waitingClient: number; dueOn: string | null }, today: string): { health: Health; why: string; score: number } {
  const parts: string[] = [];
  if (r.blocked) parts.push(`${r.blocked} blocked`);
  if (r.waitingClient) parts.push(`${r.waitingClient} waiting on the client`);
  if (r.late) parts.push(`${r.late} late`);
  if (r.dueOn && r.dueOn < today) parts.push('past its end date');
  if (r.noOwner) parts.push(`${r.noOwner} with nobody on it`);
  if (r.soon) parts.push(`${r.soon} due in the next 2 days`);
  if (r.noDue && !parts.length) parts.push(`${r.noDue} with no due day`);
  const health: Health = r.blocked ? 'blocked' : r.waitingClient ? 'waiting' : r.late || (r.dueOn && r.dueOn < today) ? 'at_risk' : r.noOwner || r.soon ? 'watch' : 'on_track';
  // Worst first: blocked, then waiting on the client, then late work (more late is worse), then what is due soon.
  const score = (health === 'blocked' ? 4000 : health === 'waiting' ? 3000 : health === 'at_risk' ? 2000 : health === 'watch' ? 1000 : 0) + r.late * 10 + r.blocked * 10 + r.noOwner * 3 + r.soon * 2 + Math.min(r.open, 50) / 100;
  return { health, why: parts.length ? parts.join(' · ') : 'On track', score };
}

/** PM-BUILD-3 (the Mac's SPEC v1.1, 21 Nov 2026): a project as one card. Health is worked out, first match wins (SPEC
 *  0.5.3): Paused / Done → Needs setup → Not started → Waiting on client → Late → At risk → On track, each with its
 *  reason in words; "On track" never shows at 0 % or with no lead. Lateness counts working days (Monday to Saturday);
 *  a step waiting on the client, or a gate the client holds, is never the team's lateness. A clock that has not
 *  happened has a planned day (2510) and its steps have planned dates, which are shown but are never late. Also the
 *  phase strip (one segment per phase, the current one named), the next step with its owner and due day, the clock
 *  line ("Day 12 of 21 · Ads live in 9 days (30 Nov)") and the project's colour and icon. Pure, so it is unit-tested. */
export type PmHealth = 'paused' | 'done' | 'needs_setup' | 'not_started' | 'waiting_client' | 'late' | 'at_risk' | 'on_track';
export const PM_WORD: Record<PmHealth, string> = { paused: 'Paused', done: 'Done', needs_setup: 'Needs setup', not_started: 'Not started', waiting_client: 'Waiting on client',
  late: 'Late', at_risk: 'At risk', on_track: 'On track' };
/** The Projects list's order: Late, At risk, Waiting on client, On track, then the rest. */
export const PM_RANK: Record<PmHealth, number> = { late: 0, at_risk: 1, waiting_client: 2, on_track: 3, needs_setup: 4, not_started: 5, paused: 6, done: 7 };
export type PmMove = { taskId: string; days: number; side: string | null };
export type PmPhase = { n: number; label: string; state: 'none' | 'todo' | 'active' | 'waiting' | 'late' | 'done'; total: number; done: number };
export type PmNext = { id: string; code: string | null; title: string; who: string | null; whoId: string | null; due: string | null; planned: boolean; late: number; client: boolean; status: string };
export type PmCard = { health: PmHealth; word: string; reason: string | null; color: string; icon: string; quiet: boolean;
  /** 2511: the newest weekly update (when), and "Update missing" (a started plan with none for 8 days). */ updated?: string | null; updateMissing?: boolean;
  phases: PmPhase[]; current: number | null; next: PmNext | null; line: string | null; progress: { done: number; total: number; pct: number };
  clocks: { key: ClockKey; label: string; on: string | null; happened: boolean }[] };
export type PmProject = { id: string; title: string; status: string; kind: string; leadId: string | null; startsOn: string | null; dueOn: string | null;
  lastActivity: string | null; color?: string | null; icon?: string | null; open: number; late: number; lateSince?: string | null; waitingClient: number;
  next: HealthRow['next']; lastUpdate?: string | null };

const P_DONE = new Set(['done', 'accepted']);
const P_SKIP = new Set(['cancelled', 'not_applicable', 'merged']);
const P_OPEN = new Set(['open', 'in_progress', 'blocked', 'in_review', 'unknown']);
const COLORS = ['teal', 'blue', 'green', 'orange', 'pink', 'slate'] as const;
const pd = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dd = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const SHORT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const shortDay = (d: string) => SHORT.format(new Date(`${d}T00:00:00Z`));
/** Working days after `from`, up to and including `to` (Sundays off); 0 when `to` is not after `from`. */
export function workDays(from: string, to: string) {
  let n = 0; const end = dd(from, to);
  for (let i = 1; i <= Math.min(end, 400); i++) if (new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).getUTCDay() !== 0) n++;
  return n;
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** A step's title without its code ("C20 Model-led video drafted" → "Model-led video drafted"), short enough for a chip. */
export const bare = (title: string, code: string | null, max = 40) => { const t = code ? title.replace(new RegExp(`^${code.replace(/[.*+?^$(){}|[\]\\]/g, '')}\\s+`), '') : title;
  const one = t.split(/[:.;—–]\s/)[0].trim(); return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one; };
/** A step's name cut for a reason chip: before a comma, colon or "by/for/with", at most 4 words ("Design confirmed by the
 *  strategist" → "Design confirmed"; "Landing page live, tracking tested" → "Landing page live"). */
export const shortTitle = (title: string, code: string | null) => { const t = bare(title, code, 200).split(/\s*[,;:(—–]\s*|\s+(?:by|for|with|and)\s+/i)[0].trim();
  const w = t.split(/\s+/); return w.length > 4 ? `${w.slice(0, 4).join(' ')}…` : t; };
const minus = (n: number) => n < 0 ? `−${-n}` : String(n);
/** A phase's name without its numbering or marks ("Phase 1 · Project Brand Blueprint™" → "Project Brand Blueprint"). */
export const phaseName = (label: string) => label.replace(/^(stage|phase)\s*\d+\s*·\s*/i, '').replace(/[™®]/g, '').replace(/\s*·\s*outsourced$/i, '').trim();
export const defaultColor = (id: string) => COLORS[[...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % COLORS.length];

/** A plan's clock days: the day each happened, else its planned day (as pulse.plan_clock_day). */
export function pmClocks(t: Template, plan: Plan, tasks: PlanTask[]) {
  const cl = t.clocks ?? []; const stepOf = new Map(t.steps.map((s) => [s.id, s]));
  const endOf = (s: Step) => { const bp = plan.package ? s.byPackage?.[plan.package] : undefined; return (bp ? bp.end : s.end) ?? s.start; };
  const taskDue = (id: string) => tasks.filter((x) => x.step === id && !P_SKIP.has(x.status) && x.due).map((x) => x.due!).sort()[0] ?? null;
  const day = (key: ClockKey, depth = 0): string | null => {
    if (key === 'start') return plan.kickoff;
    if (key === 'day0' && plan.day0On) return plan.day0On;
    if (key === 'live' && plan.liveOn) return plan.liveOn;
    const cp = plan.clockPlan?.[key]; if (cp && /^\d{4}-\d{2}-\d{2}$/.test(cp)) return cp;
    const c = cl.find((x) => x.key === key); if (!c?.step) return null;
    const due = taskDue(c.step); if (due) return due;
    const st = stepOf.get(c.step); if (!st) return null;
    const from = st.from ?? 'start';
    const base = from === 'start' ? plan.kickoff : from === 'day0' && key !== 'day0' && depth < 2 ? day('day0', depth + 1) : null;
    const e = endOf(st); return base && e !== null && e !== undefined ? pd(base, e) : null;
  };
  const on: Record<ClockKey, string | null> = { start: plan.kickoff, day0: day('day0'), live: day('live'), bought: null };
  const happened: Record<ClockKey, boolean> = { start: true, day0: !!plan.day0On, live: !!plan.liveOn, bought: false };
  return { on, happened, list: cl.filter((c) => c.key !== 'bought').map((c) => ({ key: c.key, label: c.label, on: on[c.key], happened: happened[c.key] })),
    label: (k: ClockKey) => cl.find((x) => x.key === k)?.label ?? k, startDay: cl.find((x) => x.key === 'start')?.day ?? 0 };
}

/** A plan step's due day: its stored date, else its planned date from its clock (planned: true). */
export function pmStepDue(t: Template, plan: Plan, clocks: ReturnType<typeof pmClocks>, x: PlanTask): { due: string | null; start: string | null; planned: boolean } {
  if (x.due) return { due: x.due, start: x.start, planned: false };
  const s = x.step ? t.steps.find((y) => y.id === x.step) : null;
  if (!s) return { due: null, start: x.start, planned: false };
  const from = s.from ?? 'start'; const base = from === 'bought' ? null : clocks.on[from];
  const bp = plan.package ? s.byPackage?.[plan.package] : undefined; const a = bp?.start ?? s.start, e = bp ? bp.end : s.end;
  return { due: base && e !== null && e !== undefined ? pd(base, e) : null, start: x.start ?? (base ? pd(base, Math.max(0, a)) : null), planned: !!base && e !== null && e !== undefined };
}

export function pmCard(p: PmProject, today: string, opts: { hasTemplate: boolean; plan?: { t: Template; plan: Plan; tasks: PlanTask[]; moves?: PmMove[] } | null }): PmCard {
  const color = p.color || defaultColor(p.id), icon = p.icon || (p.kind === 'internal' ? 'folder' : 'building');
  const quiet = !!p.lastActivity && dd(p.lastActivity.slice(0, 10), today) >= 14;
  const out = (health: PmHealth, reason: string | null, rest: Partial<PmCard> = {}): PmCard => ({ health, word: PM_WORD[health], reason, color, icon, quiet,
    phases: [], current: null, next: null, line: null, progress: { done: 0, total: 0, pct: 0 }, clocks: [], ...rest });
  const pl = opts.plan;
  if (!pl) {
    // Without a plan: the tasks' own numbers, in the same words.
    const n = p.lateSince ? workDays(p.lateSince, today) : 0;
    const line = p.startsOn && p.dueOn ? `Day ${Math.max(0, dd(p.startsOn, today))} of ${dd(p.startsOn, p.dueOn)} · ${p.dueOn >= today ? `ends in ${plural(dd(today, p.dueOn), 'day')} (${shortDay(p.dueOn)})` : `ended ${shortDay(p.dueOn)}`}`
      : p.dueOn ? `Ends ${shortDay(p.dueOn)}` : null;
    const next: PmNext | null = p.next ? { id: p.next.id, code: null, title: p.next.title, who: p.next.who, whoId: null, due: p.next.due, planned: false,
      late: p.next.late && p.next.due ? workDays(p.next.due, today) : 0, client: false, status: 'open' } : null;
    const rest = { line, next };
    if (['paused', 'on_hold'].includes(p.status)) return out('paused', null, rest);
    if (['done', 'cancelled'].includes(p.status)) return out('done', null, rest);
    if (!p.leadId) return out('needs_setup', 'no lead yet', rest);
    if (p.kind !== 'internal' && opts.hasTemplate) return out('needs_setup', 'no plan yet', rest);
    if (!p.open) return out('not_started', 'no steps yet', rest);
    if (p.waitingClient && !p.late) return out('waiting_client', plural(p.waitingClient, 'item'), rest);
    if (p.late && n > 3) return out('late', `${plural(p.late, 'step')} late`, rest);
    if (p.late) return out('at_risk', `${plural(p.late, 'step')} late`, rest);
    return out('on_track', null, rest);
  }
  const { t, plan, tasks } = pl;
  const stepOf = new Map(t.steps.map((s) => [s.id, s]));
  const typeOf = (x: PlanTask) => (x.step ? stepOf.get(x.step)?.type ?? stepOf.get(x.step)?.kind : null) ?? 'task';
  const clientRole = (t.roles ?? []).find((r) => r.client)?.label ?? 'Client';
  const clocks = pmClocks(t, plan, tasks);
  const stageOf = (x: PlanTask) => x.phase && /^s\d+$/.test(x.phase) ? Number(x.phase.slice(1)) : (x.step ? stepOf.get(x.step)?.stage ?? null : null);
  const steps = tasks.filter((x) => x.step && !P_SKIP.has(x.status) && typeOf(x) !== 'auto');
  const running = (x: PlanTask) => x.status === 'in_progress' && ['ongoing', 'repeating'].includes(typeOf(x));
  const isClient = (x: PlanTask) => { const s = x.step ? stepOf.get(x.step) : null; return !!s?.clientInput || roleOf(s?.owner) === clientRole || (x.notes ?? '').startsWith('Needs the client'); };
  const dated = new Map(steps.map((x) => [x.id, pmStepDue(t, plan, clocks, x)]));
  const open = steps.filter((x) => P_OPEN.has(x.status) && !running(x));
  const lateOf = (x: PlanTask) => x.due && x.due < today ? workDays(x.due, today) : 0;
  // A gate the client holds: one of the steps it waits on is the client's and still open.
  const clientHeld = (x: PlanTask) => { const s = x.step ? stepOf.get(x.step) : null; const ins = [...(s?.gateInputs ?? []), ...(s?.after ?? [])];
    return ins.some((id) => open.some((y) => y.step === id && isClient(y))); };
  const isGate = (x: PlanTask) => ['gate', 'milestone'].includes(typeOf(x));
  const teamLate = open.filter((x) => !isClient(x) && lateOf(x) > 0 && !(isGate(x) && clientHeld(x))).sort((a, b) => lateOf(b) - lateOf(a));
  const clientWaits = open.filter((x) => isClient(x) || (isGate(x) && clientHeld(x) && lateOf(x) > 0))
    .map((x) => { const d = dated.get(x.id)!; const since = x.waitSince ?? (d.due && d.due < today ? d.due : d.start); return { x, since }; })
    .filter((w) => !!w.since && w.since <= today)
    .sort((a, b) => Number(!(dated.get(a.x.id)!.due && dated.get(a.x.id)!.due! < today)) - Number(!(dated.get(b.x.id)!.due && dated.get(b.x.id)!.due! < today)) || a.since!.localeCompare(b.since!));
  const doneN = steps.filter((x) => P_DONE.has(x.status)).length;
  const progress = { done: doneN, total: steps.length, pct: steps.length ? Math.round((doneN / steps.length) * 100) : 0 };
  // The next step: the most late team step, else work under way, else the soonest due.
  const rank = (x: PlanTask) => (teamLate.includes(x) ? (isGate(x) ? -1 : 0) : ['in_review', 'in_progress', 'blocked'].includes(x.status) ? 1 : 2);
  const nx = [...open].sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? lateOf(b) - lateOf(a) : 0)
    || (dated.get(a.id)!.due ?? '9999').localeCompare(dated.get(b.id)!.due ?? '9999') || (stageOf(a) ?? 99) - (stageOf(b) ?? 99) || String(a.step).localeCompare(String(b.step)))[0] ?? null;
  const next: PmNext | null = nx ? { id: nx.id, code: nx.step, title: bare(nx.title, nx.step, 80), who: nx.who, whoId: nx.whoId, due: dated.get(nx.id)!.due, planned: dated.get(nx.id)!.planned,
    late: teamLate.includes(nx) ? lateOf(nx) : 0, client: isClient(nx), status: nx.status } : null;
  const current = nx ? stageOf(nx) : null;
  const phases: PmPhase[] = t.stages.map((s) => {
    const mine = steps.filter((x) => stageOf(x) === s.n); const done = mine.filter((x) => P_DONE.has(x.status)).length;
    const state: PmPhase['state'] = !mine.length ? 'none' : done === mine.length ? 'done' : teamLate.some((x) => stageOf(x) === s.n) ? 'late'
      : clientWaits.some((w) => stageOf(w.x) === s.n) ? 'waiting' : s.n === current || mine.some((x) => P_DONE.has(x.status) || ['in_progress', 'in_review'].includes(x.status)) ? 'active' : 'todo';
    return { n: s.n, label: phaseName(s.label), state, total: mine.length, done };
  });
  // The clock line: day N of the plan's days to going live, and when it goes live.
  const d0 = clocks.on.day0, live = clocks.on.live, liveLabel = clocks.label('live');
  const N = d0 ? dd(d0, today) : dd(plan.kickoff, today) + clocks.startDay;
  const L = d0 && live ? dd(d0, live) : null;
  const dayPart = N < 0 && d0 ? `${clocks.label('day0')} by ${shortDay(d0)}` : `Day ${minus(N)}${L !== null && !plan.liveOn && N <= L ? ` of ${L}` : ''}`;
  const line = plan.liveOn ? `${liveLabel} since ${shortDay(plan.liveOn)} · ${dayPart}`
    : live ? `${dayPart} · ${live > today ? (N < 0 ? `${liveLabel} ${shortDay(live)}` : `${liveLabel} in ${plural(dd(today, live), 'day')} (${shortDay(live)})`) : live === today ? `${liveLabel} today` : `${liveLabel} was planned for ${shortDay(live)}`}`
    : dayPart;
  const startedAny = steps.some((x) => P_DONE.has(x.status) || ['in_progress', 'in_review'].includes(x.status));
  const rest: Partial<PmCard> = { phases, current, next, line, progress, clocks: clocks.list, updated: p.lastUpdate ?? null,
    updateMissing: startedAny && !['paused', 'on_hold', 'done', 'cancelled'].includes(p.status) && dd(plan.kickoff, today) >= 8 && (!p.lastUpdate || dd(p.lastUpdate.slice(0, 10), today) >= 8) };
  if (['paused', 'on_hold'].includes(p.status)) return out('paused', null, rest);
  if (['done', 'cancelled'].includes(p.status)) return out('done', null, rest);
  if (!p.leadId) return out('needs_setup', 'no lead yet', rest);
  // A role with nobody on it whose steps are due in the next 14 days (and not marked "nobody on this project").
  const soon = pd(today, 14);
  const gap = open.find((x) => !x.whoId && !isClient(x) && x.role && !plan.roles?.[x.role]?.none && (dated.get(x.id)!.due ?? '9999') <= soon);
  if (gap) return out('needs_setup', `no ${gap.role} yet`, rest);
  const started = steps.some((x) => P_DONE.has(x.status) || ['in_progress', 'in_review'].includes(x.status));
  if (!started && !teamLate.length) {
    const first = open.map((x) => dated.get(x.id)!.start ?? dated.get(x.id)!.due).filter((d): d is string => !!d).sort()[0] ?? plan.kickoff;
    return out('not_started', first > today ? `starts ${shortDay(first)}` : `first step due ${shortDay(next?.due ?? first)}`, rest);
  }
  if (clientWaits.length && !teamLate.length) {
    const w = clientWaits[0]; const n = workDays(w.since!, today);
    return out('waiting_client', `${shortTitle(w.x.title, w.x.step).toLowerCase()}${n ? `, ${plural(n, 'day')}` : ''}`, rest);
  }
  const gateLate = teamLate.find(isGate);
  if (gateLate) return out('late', `${shortTitle(gateLate.title, gateLate.step)} · ${plural(lateOf(gateLate), 'day')} late`, rest);
  if (teamLate[0] && lateOf(teamLate[0]) > 3) return out('late', `${shortTitle(teamLate[0].title, teamLate[0].step)} · ${plural(lateOf(teamLate[0]), 'day')} late`, rest);
  if (!plan.liveOn && live && live < today && !clientWaits.length) return out('late', `${liveLabel.toLowerCase()} was planned for ${shortDay(live)}`, rest);
  if (teamLate[0]) return out('at_risk', `${shortTitle(teamLate[0].title, teamLate[0].step)} · ${plural(lateOf(teamLate[0]), 'day')} late`, rest);
  const slip = (pl.moves ?? []).filter((m) => m.days > 0 && m.side !== 'client' && open.some((x) => x.id === m.taskId)).sort((a, b) => b.days - a.days)[0];
  if (slip) { const x = open.find((y) => y.id === slip.taskId)!; return out('at_risk', `${shortTitle(x.title, x.step).toLowerCase()} moved ${plural(slip.days, 'day')}`, rest); }
  const lone = open.find((x) => !x.whoId && !isClient(x) && dated.get(x.id)!.due && dated.get(x.id)!.due! >= today && workDays(today, dated.get(x.id)!.due!) <= 3);
  if (lone) return out('at_risk', `${shortTitle(lone.title, lone.step)} has nobody on it`, rest);
  return out('on_track', null, rest);
}

/** A plan step's state in the SPEC's words (3.1), for the person looking: Done, Skipped, Your turn (their review),
 *  In review, Doing, Waiting on client, Waiting on "<step>" (an earlier step is open), To do; and late in working days
 *  (a client's step is "Client late", never the team's). Pure, so it is unit-tested. */
export type PmStepWord = { word: string; tone: 'done' | 'skip' | 'turn' | 'review' | 'doing' | 'client' | 'wait' | 'todo'; late: number; clientLate: number };
export function pmStepState(x: { status: string; whoId: string | null; reviewerId?: string | null }, o: { me: string; today: string; due: string | null; planned: boolean; client: boolean; waitsOn: string | null; running: boolean }): PmStepWord {
  const late = !o.planned && o.due && o.due < o.today && P_OPEN.has(x.status) && !o.running ? workDays(o.due, o.today) : 0;
  const w = (word: string, tone: PmStepWord['tone']): PmStepWord => ({ word, tone, late: o.client ? 0 : late, clientLate: o.client ? late : 0 });
  // Pulse's review: the doer marks it done, its reviewer accepts it. Until then the reviewer sees "Your turn".
  if (x.status === 'done' && x.reviewerId && x.reviewerId !== x.whoId) return x.reviewerId === o.me ? w('Your turn', 'turn') : w('Done', 'done');
  if (P_DONE.has(x.status)) return w('Done', 'done');
  if (P_SKIP.has(x.status)) return w('Skipped', 'skip');
  if (x.status === 'in_review') return x.reviewerId === o.me && x.whoId !== o.me ? w('Your turn', 'turn') : w('In review', 'review');
  if (x.status === 'in_progress') return w(o.running ? 'Running' : 'Doing', 'doing');
  if (o.client) return w('Waiting on client', 'client');
  if (x.status === 'blocked' || o.waitsOn) return w(o.waitsOn ? `Waiting on “${o.waitsOn}”` : 'Waiting', 'wait');
  return w('To do', 'todo');
}

async function today(c: PoolClient) {
  return (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d as string;
}

/** Projects with open work or a running process, with their task numbers. `archived` lists paused, done and cancelled.
 *  PROJECTS-CREATE: also a project made in the last 30 days or given a stage plan, so a new project shows where it was made
 *  before it has any open task. */
export async function projectHealth(c: PoolClient, me: string, day: string, archived: boolean) {
  const rows = (await c.query(`with base as (
      select p.id,coalesce(p.title,p.name) title,p.location,p.segment,cl.display_name client,p.client_id "clientId",coalesce(u.name,nullif(wp.pod,'')) pod,
        coalesce(p.lead_person_id,wp.owner_id) "leadId",coalesce(nullif(wp.status,''),p.status,'active') status,coalesce(p.kind,'client_work') kind,
        coalesce(wp.starts_on,p.starts_on)::text "startsOn",coalesce(wp.due_on,p.ends_on)::text "dueOn",
        coalesce(wp.created_at>now()-interval '30 days',false) or exists(select 1 from pulse.project_plan pl where pl.project_id=p.id) "setUp",
        coalesce(wp.started_by='ai' and not exists(select 1 from pulse.goal_link agl where agl.project_id=p.id),false) "aiStarted",wp.color,wp.icon
      from pulse.project p left join pulse.work_project wp on wp.project_id=p.id and wp.deleted_at is null
      left join pulse.unit u on u.id=p.unit_id left join pulse.client cl on cl.id=p.client_id
      where p.deleted_at is null and not exists(select 1 from pulse.record_merge r where r.entity_type='project' and r.gone_id=p.id and r.undone_at is null)),
    tk as (select t.project_id,count(*)::int open,count(*) filter(where ${DUE}<$2::date)::int late,count(*) filter(where t.status='blocked')::int blocked,
        count(*) filter(where ${DUE}=$2::date)::int "dueToday",count(*) filter(where ${DUE}>$2::date and ${DUE}<=$2::date+2)::int soon,
        count(*) filter(where coalesce(t.assignee_person_id,t.owner_id) is null)::int "noOwner",count(*) filter(where t.due_at is null)::int "noDue",
        count(*) filter(where t.status='in_review')::int review,bool_or(coalesce(t.assignee_person_id,t.owner_id)=$1::uuid) mine,
        max(coalesce(t.updated_at,t.created_at)) touched,min(${DUE}) filter(where ${DUE}<$2::date)::text "lateSince"
      from pulse.task t where t.deleted_at is null and ${OPEN} and t.project_id is not null
        -- PM-BUILD-1 (2262): running plan work (ongoing or repeating, started) is neither open nor late.
        and not (t.status='in_progress' and t.template_step is not null and pulse.plan_step_running(t.project_id,t.template_step,t.status)) group by 1),
    fr as (select distinct on (r.project_id) r.project_id,r.id run from pulse.flow_run r where r.status='running' and r.mode is distinct from 'demo' and r.project_id is not null order by r.project_id,r.started_at desc),
    bl as (select b.project_id,count(*) filter(where b.owner_side='client')::int client from pulse.blocker b where b.closed_at is null and b.project_id is not null group by 1)
    select b.*,(select display_name from pulse.person where id=b."leadId") lead,
      coalesce(tk.open,0) open,coalesce(tk.late,0) late,coalesce(tk.blocked,0) blocked,coalesce(tk."dueToday",0) "dueToday",coalesce(tk.soon,0) soon,
      coalesce(tk."noOwner",0) "noOwner",coalesce(tk."noDue",0) "noDue",coalesce(tk.review,0) review,
      coalesce(tk.mine,false) or b."leadId"=$1::uuid mine,tk.touched::text "lastActivity",tk."lateSince",
      coalesce(bl.client,0)+coalesce((select count(*)::int from pulse.flow_run_step s where s.run_id=fr.run and s.state='in_review' and s.sent_at is not null),0) "waitingClient",
      (select s.stage from pulse.flow_run_step s where s.run_id=fr.run and s.state not in ('done','skipped','confirmed') order by s.position limit 1) stage,
      (select count(*)::int from pulse.flow_run_step s where s.run_id=fr.run and s.state in ('done','confirmed')) "stageDone",
      (select count(*)::int from pulse.flow_run_step s where s.run_id=fr.run and s.state<>'skipped') "stageOf",
      (select jsonb_build_object('id',t.id,'title',t.title,'who',(select display_name from pulse.person where id=coalesce(t.assignee_person_id,t.owner_id)),
          'due',${DUE}::text,'late',coalesce(${DUE}<$2::date,false))
        from pulse.task t where t.project_id=b.id and t.deleted_at is null and ${OPEN} and t.parent_id is null
        order by (t.status='blocked') desc,t.due_at nulls last,t.created_at limit 1) next
    from base b left join tk on tk.project_id=b.id left join fr on fr.project_id=b.id left join bl on bl.project_id=b.id
    where case when $3::boolean then b.status in ('paused','done','cancelled') else b.status not in ('paused','done','cancelled') and (tk.open>0 or fr.run is not null or b."setUp") end`,
  [me, day, archived])).rows as Omit<HealthRow, 'health' | 'why' | 'score'>[];
  return rows.map((r) => ({ ...r, ...judge(r, day) }) as HealthRow).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

export function registerProjectHealthRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Querystring: { scope?: string; pod?: string; started?: string } }>('/api/v0/projects/health', req => tx(req, async (c, v) => {
    work(v); const me = person(v);
    const { role, pods: headPods } = (await c.query('select pulse.work_role() role,pulse.work_head_pods() pods')).rows[0] as { role: string; pods: string[] | null };
    const everyone = role === 'leadership' || role === 'hr';
    const asked = ['mine', 'pod', 'all', 'archived'].includes(String(req.query.scope)) ? String(req.query.scope) : null;
    const scope = asked ?? (everyone ? 'all' : role === 'pod_head' ? 'pod' : 'mine');
    const day = await today(c);
    const all = await projectHealth(c, me, day, scope === 'archived');
    const myPods = (await c.query(`select array_remove(array_agg(distinct x),null) p from (select nullif(pp.pod,'') x from pulse.people_profile pp where pp.person_id=$1
      union all select unnest(coalesce(pulse.work_head_pods(),'{}'))) s`, [me])).rows[0].p as string[] ?? [];
    const pods = [...new Set(all.map((r) => r.pod).filter((p): p is string => !!p))].sort();
    const pod = typeof req.query.pod === 'string' && req.query.pod.length <= 80 && req.query.pod ? req.query.pod : null;
    let rows = all;
    if (scope === 'mine') rows = all.filter((r) => r.mine);
    else if (scope === 'pod') rows = all.filter((r) => r.mine || (!!r.pod && (myPods.includes(r.pod) || (headPods ?? []).includes(r.pod))));
    else if (scope === 'all' && !everyone) rows = all.filter((r) => r.mine || r.open > 0);
    if (pod && scope !== 'mine') rows = rows.filter((r) => r.pod === pod);
    // WORK-SPINE (owner, 10 Nov 2026: "projects started by agents clutter the list"): kept apart, listed with ?started=ai.
    const aiCount = rows.filter((r) => r.aiStarted).length;
    rows = rows.filter((r) => req.query.started === 'ai' ? r.aiStarted : !r.aiStarted);
    // Needs you today: the viewer's own late and due-today work in projects, worst first.
    const today_ = (await c.query(`select t.id,t.title,t.status,${DUE}::text due,coalesce(${DUE}<$2::date,false) late,t.project_id "projectId",coalesce(p.title,p.name) project
      from pulse.task t join pulse.project p on p.id=t.project_id
      where t.deleted_at is null and ${OPEN} and coalesce(t.assignee_person_id,t.owner_id)=$1 and (${DUE}<=$2::date or t.status='blocked')
      order by (t.status='blocked') desc,t.due_at nulls last limit 12`, [me, day])).rows;
    // Delivery plans (1370): the stage, clocks, gates and waiting-on-client of each planned project, and leads' bandwidth.
    const tpls = await templates(c);
    const plans = await plansFor(c, all.map((r) => r.id));
    // PROJECTS-STAGES (1485): who owns the stage each planned project is in (B1's "owner and manager" per phase).
    const owners = plans.size ? (await c.query(`select o.project_id,o.stage,pe.display_name name from pulse.project_stage_owner o join pulse.person pe on pe.id=o.person_id where o.project_id=any($1::uuid[])`, [[...plans.keys()]])).rows as { project_id: string; stage: number; name: string }[] : [];
    for (const r of all) {
      // PM-BUILD-1 (2262): a plan reads with the template version it was laid out from.
      const p = plans.get(r.id); const t = p ? await templateOf(c, tpls, p.plan) : null;
      if (!p || !t) { r.plan = null; continue; }
      const st = planState(t, p.plan, p.tasks, day);
      r.plan = { ...st, package: p.plan.package, packageLabel: t.packages.find((x) => x.key === p.plan.package)?.label ?? null, category: p.plan.category, templateKey: t.key,
        units: t.categories.find((x) => x.key === p.plan.category)?.units ?? 0, stageOwner: owners.find((o) => o.project_id === r.id && o.stage === st.stage)?.name ?? null };
      r.stage = `${st.stage} · ${st.stageLabel ?? ''}`; r.stageDone = st.stepsDone; r.stageOf = st.steps;
      if (st.next) r.next = { id: st.next.id, title: `${st.next.step ?? ''} ${st.next.title}`.trim(), who: st.next.who, due: st.next.due, late: st.next.late };
      if (st.waitingClient) r.waitingClient += st.waitingClient;
      Object.assign(r, judge(r, day));
    }
    // PM-BUILD-3: every project as one card (SPEC health with its reason, phases, next step, clock line). Date moves
    // with the template's reasons say which side moved a step (a client's delay is not the team's slip).
    const moves = plans.size ? (await c.query(`select d.project_id,d.task_id,d.moved,d.reason_kind,(d.to_due-d.from_due)::int days from pulse.project_date_change d
      where d.project_id=any($1::uuid[]) and d.from_due is not null and d.to_due is not null and d.to_due<>d.from_due`, [[...plans.keys()]])).rows as { project_id: string; task_id: string; moved: string[] | null; reason_kind: string; days: number }[] : [];
    const ups = new Map((await c.query(`select project_id,(at at time zone ${ORG_TZ})::date::text d from pulse.project_updates_last($1::uuid[])`, [all.map((r) => r.id)])).rows.map((x) => [x.project_id as string, x.d as string]));
    for (const r of all) {
      const p = plans.get(r.id); const t = p ? await templateOf(c, tpls, p.plan) : null;
      (r as HealthRow & { lastUpdate?: string | null }).lastUpdate = ups.get(r.id) ?? null;
      const side = (k: string) => t?.reasons?.find((x) => x.key === k)?.side ?? (k.startsWith('client') ? 'client' : 'us');
      const pm = moves.filter((m) => m.project_id === r.id).flatMap((m) => [m.task_id, ...(m.moved ?? [])].map((taskId) => ({ taskId, days: m.days, side: side(m.reason_kind) })));
      r.pm = pmCard(r, day, { hasTemplate: tpls.length > 0, plan: p && t ? { t, plan: p.plan, tasks: p.tasks, moves: pm } : null });
    }
    rows.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    // PROJECTS-CREATE (owner, 4 Nov 2026: "No plan yet" said what was missing, not how to fix it): which unplanned projects
    // the viewer may give a stage plan from their row (pulse.project_can_run, the check setting a plan makes).
    const unplanned = rows.filter((r) => !r.plan).map((r) => r.id);
    if (unplanned.length) {
      const can = new Set((await c.query('select x.id from unnest($1::uuid[]) x(id) where pulse.project_can_run(x.id)', [unplanned])).rows.map((x) => x.id as string));
      for (const r of rows) if (!r.plan) r.canPlan = can.has(r.id);
    }
    const t0: Template | null = tpls[0] ?? null;
    const unitsBy = new Map<string, { units: number; projects: number }>();
    for (const r of all) if (r.plan && r.leadId && r.status === 'active') { const u = unitsBy.get(r.leadId) ?? { units: 0, projects: 0 }; u.units += r.plan.units; u.projects++; unitsBy.set(r.leadId, u); }
    const leadIds = [...unitsBy.keys()];
    const names = leadIds.length ? (await c.query(`select p.id,p.display_name name,pp.pod,pp.role from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=any($1::uuid[])`, [leadIds])).rows : [];
    // PM-BUILD-4 (2522): a person's own benchmark (set by leadership) replaces the template's range for them.
    const marks = new Map((leadIds.length ? (await c.query(`select person_id id,healthy_low::float lo,healthy_high::float hi,review_above::float rev from pulse.load_benchmark
      where person_id=any($1::uuid[]) and cleared_at is null`, [leadIds])).rows : []).map((b) => [b.id as string, b as { lo: number; hi: number; rev: number }]));
    const bandOf = (t: Template, id: string, units: number) => { const m = marks.get(id); if (!m) return { ...bandwidth(t, units), benchmark: null };
      const state = units > m.rev ? 'over' : units > m.hi ? 'max' : units >= m.lo ? 'healthy' : 'room'; return { units: Math.round(units * 10) / 10, state, benchmark: { healthy: [m.lo, m.hi], reviewAbove: m.rev } }; };
    const bw = t0 ? {
      role: t0.bandwidth.role, short: t0.bandwidth.short, healthy: t0.bandwidth.healthy, max: t0.bandwidth.max, note: t0.bandwidth.note ?? null,
      categories: t0.categories,
      me: unitsBy.has(me) ? { ...bandOf(t0, me, unitsBy.get(me)!.units), projects: unitsBy.get(me)!.projects } : null,
      canSetBenchmarks: everyone && (await c.query(`select pulse.viewer_is('admin','leadership') ok`)).rows[0].ok as boolean,
      people: (everyone || role === 'pod_head') ? names.filter((n) => everyone || (n.pod && (myPods.includes(n.pod) || (headPods ?? []).includes(n.pod))) || n.id === me)
        .map((n) => ({ id: n.id as string, name: n.name as string, pod: n.pod as string | null, ...bandOf(t0, n.id as string, unitsBy.get(n.id)!.units), projects: unitsBy.get(n.id)!.projects })).sort((a, b) => b.units - a.units) : [],
    } : null;
    const agent = (await c.query(`select am.person_id id,p.display_name name,pp.username from pulse.agent_member am join pulse.person p on p.id=am.person_id
      left join pulse.people_profile pp on pp.person_id=p.id where am.disabled_at is null and p.status='active' order by am.chief desc,am.created_at limit 1`)).rows[0] ?? null;
    const viewer = (await c.query(`select p.display_name name,pp.role,nullif(pp.pod,'') pod from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=$1`, [me])).rows[0] ?? null;
    // The CEO's screen: where the projects are, the headline numbers, money at risk and same-day alerts.
    let ceo = null;
    if (everyone && scope === 'all') {
      const planned = rows.filter((r) => r.plan);
      const inDays = (n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
      const stages = t0 ? t0.stages.map((s) => ({ n: s.n, label: s.label, projects: planned.filter((r) => r.plan!.stage === s.n).length })) : [];
      const money: { title: string; detail: string; projects: { id: string; title: string }[] }[] = [];
      const ending = rows.filter((r) => r.dueOn && r.dueOn >= day && r.dueOn <= inDays(30));
      if (ending.length) money.push({ title: `${ending.length} ${ending.length === 1 ? 'project ends' : 'projects end'} in 30 days`, detail: 'Raise the renewal quotation before the end date', projects: ending.map((r) => ({ id: r.id, title: r.title })) });
      const found = planned.filter((r) => r.plan!.foundationRisk);
      if (found.length) money.push({ title: `${found.length} foundation ${found.length === 1 ? 'check' : 'checks'} at risk`, detail: 'Ads are not live and the foundation check is close or past', projects: found.map((r) => ({ id: r.id, title: r.title })) });
      const resultIds = t0?.milestones.resultCheck ?? [];
      const result = planned.filter((r) => (plans.get(r.id)?.tasks ?? []).some((x) => x.step && resultIds.includes(x.step) && !['done', 'accepted', 'cancelled'].includes(x.status) && !!x.due && x.due <= inDays(10)));
      if (result.length) money.push({ title: `${result.length} result ${result.length === 1 ? 'check' : 'checks'} in the next 10 days`, detail: 'The refund or assurance rule applies', projects: result.map((r) => ({ id: r.id, title: r.title })) });
      const quoted = (await c.query(`select q.project_id id,(pulse.project_scope(q.project_id)->>'outside')::int outside from (select distinct project_id from pulse.project_quote) q where q.project_id=any($1::uuid[])`, [rows.map((r) => r.id)])).rows.filter((x: { id: string; outside: number }) => x.outside > 0) as { id: string; outside: number }[];
      if (quoted.length) money.push({ title: `${quoted.reduce((n, x) => n + x.outside, 0)} tasks outside the signed quote`, detail: 'No add-on quotation raised yet', projects: quoted.map((x) => ({ id: x.id as string, title: rows.find((r) => r.id === x.id)?.title ?? '' })) });
      const alerts: { title: string; detail: string; projectId: string; project: string }[] = [];
      const to = (r: HealthRow) => r.lead ? `To ${r.lead}` : 'No lead yet';
      for (const r of planned) for (const g of r.plan!.gates.filter((g) => g.stuck)) alerts.push({ title: `${g.short} waiting for more than 3 days`, detail: to(r), projectId: r.id, project: r.title });
      for (const r of rows) if (r.blocked) alerts.push({ title: `${r.blocked} blocked`, detail: to(r), projectId: r.id, project: r.title });
      for (const r of rows) if (r.noOwner || r.noDue) alerts.push({ title: `${r.noOwner + r.noDue} ${r.noOwner + r.noDue === 1 ? 'task' : 'tasks'} with no owner or due date`, detail: to(r), projectId: r.id, project: r.title });
      // KAZUK-GAPS (1853): money at risk in rupees (overdue invoices, work not billed yet, quotations with no answer) for
      // Billing readers (null for anyone else), and client-service issues raised today.
      const moneyRisk = (await c.query('select pulse.money_at_risk() m')).rows[0].m as MoneyAtRisk | null;
      const cs = (await c.query('select pulse.cs_alerts_today() a')).rows[0].a as { id: string; kind: string; title: string; client: string | null; clientId: string | null; taskId: string | null; projectId: string | null; at: string }[];
      // PM-BUILD-4 (KAZUK-PM-2 phase 6): going live at risk (a plan's go-live day within 14 days or past, not live yet,
      // and the project late or at risk), date moves of the last 30 days by reason, and what the company waits on clients for.
      const inTwoWeeks = inDays(14);
      const goLive = rows.filter((r) => r.pm && !r.pm.clocks.find((k) => k.key === 'live')?.happened).map((r) => ({ r, live: r.pm!.clocks.find((k) => k.key === 'live')?.on ?? null }))
        .filter(({ r, live }) => live && live <= inTwoWeeks && (live < day || ['late', 'at_risk'].includes(r.pm!.health)))
        .sort((a, b) => a.live!.localeCompare(b.live!)).slice(0, 8)
        .map(({ r, live }) => ({ id: r.id, title: r.title, lead: r.lead, live, health: r.pm!.health, word: r.pm!.word, reason: r.pm!.reason }));
      const lead = (await c.query(`select pulse.viewer_is('admin','leadership') ok`)).rows[0].ok ? (await c.query('select pulse.pm_leadership() d')).rows[0].d : null;
      const delivery = { goLive, moves: lead?.moves ?? [], clientWaits: lead?.clientWaits ?? null };
      ceo = {
        delivery,
        stages, money, moneyRisk, cs, alerts: alerts.slice(0, 8),
        tiles: { adsLive: planned.filter((r) => r.plan!.adsLiveOn).length, foundationRisk: found.length, stuckGate: planned.filter((r) => r.plan!.stuckGate).length },
        decisions: rows.filter((r) => r.health !== 'on_track' && r.health !== 'watch').slice(0, 8)
          .map((r) => ({ id: r.id, title: r.title, pod: r.pod, lead: r.lead, stage: r.plan ? `${r.plan.stage} ${r.plan.stageLabel ?? ''}` : null, daysInStage: r.plan?.daysInStage ?? null, why: r.why, late: r.late })),
      };
    }
    const lateProjects = rows.filter((r) => r.late > 0).length;
    // PERSONAL-WORKSPACE (1640): a personal workspace has no clients, gates or team load; the page says so in its words.
    const ws = (await c.query(`select pulse.org_kind() kind,(select count(*)::int from pulse.person where org_id=pulse.current_org() and side='staff' and status='active') staff,
      (select count(*)::int from pulse.goal where org_id=pulse.current_org() and status='active') goals,
      (select count(*)::int from pulse.task t where t.org_id=pulse.current_org() and t.deleted_at is null and t.status in ('open','in_progress','blocked')
        and coalesce(t.work_on,(t.due_at at time zone pulse.org_time_zone())::date) between $1::date and $1::date+6) week`, [day])).rows[0];
    // KAZUK-GAPS: the CEO's question box sends what this screen shows, so the answer is about these numbers.
    if (ceo) Object.assign(ceo, { facts: screenFacts({ projects: rows.length, late: rows.reduce((n, r) => n + r.late, 0), waiting: rows.filter((r) => r.waitingClient > 0).length,
      blocked: rows.filter((r) => r.health === 'blocked').length, money: ceo.moneyRisk, alerts: ceo.alerts.length, cs: ceo.cs.length, rupees }) });
    return {
      orgKind: ws.kind, staff: ws.staff, goals: ws.goals, week: ws.week,
      today: day, role, everyone, scope, pod, pods, rows, viewer, agent, bandwidth: bw, ceo, labels: t0?.labels ?? {}, templates: tpls.length, ai: aiCount, started: req.query.started === 'ai' ? 'ai' : null,
      totals: {
        active: rows.length, late: rows.reduce((n, r) => n + r.late, 0), lateProjects, blocked: rows.filter((r) => r.health === 'blocked').length,
        waiting: rows.filter((r) => r.waitingClient > 0).length, atRisk: rows.filter((r) => r.health === 'at_risk' || r.health === 'blocked').length,
        noOwner: rows.reduce((n, r) => n + r.noOwner, 0), noDue: rows.reduce((n, r) => n + r.noDue, 0), needYou: today_.length,
      },
      needsYou: today_,
    };
  }));
}

/** PM-BUILD-3: one project as the Mac's project home needs it (screen 02, SPEC §5.2): its card (health with the reason,
 *  phases, next step, clock line), every plan step in the SPEC's words for the viewer, who does what, and its clocks
 *  with their planned or real days. */
export function registerPmRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Params: { id: string } }>('/api/v0/projects/:id/pm', req => tx(req, async (c, v) => {
    work(v); const me = person(v); const id = pid(req.params.id);
    const day = await today(c);
    const p = (await c.query(`select p.id,coalesce(p.title,p.name) title,coalesce(nullif(wp.status,''),p.status,'active') status,coalesce(p.kind,'client_work') kind,
        coalesce(p.lead_person_id,wp.owner_id) "leadId",(select display_name from pulse.person where id=coalesce(p.lead_person_id,wp.owner_id)) lead,
        cl.display_name client,p.client_id "clientId",wp.color,wp.icon,coalesce(wp.starts_on,p.starts_on)::text "startsOn",coalesce(wp.due_on,p.ends_on)::text "dueOn",
        pulse.project_can_run(p.id) "canRun",(select max(coalesce(t.updated_at,t.created_at))::text from pulse.task t where t.project_id=p.id and t.deleted_at is null) "lastActivity"
      from pulse.project p left join pulse.work_project wp on wp.project_id=p.id and wp.deleted_at is null left join pulse.client cl on cl.id=p.client_id
      where p.id=$1 and p.deleted_at is null`, [id])).rows[0] ?? fail(404, 'Project not found');
    const tpls = await templates(c);
    const pl = (await plansFor(c, [id])).get(id) ?? null;
    const t = pl ? await templateOf(c, tpls, pl.plan) : null;
    const base = { ...p, open: 0, late: 0, waitingClient: 0, next: null };
    if (!pl || !t) return { today: day, me, project: p, card: pmCard(base, day, { hasTemplate: tpls.length > 0, plan: null }), plan: false, steps: [], team: [], clocks: [], reasons: null, canMove: false };
    const moves = (await c.query(`select d.task_id,d.moved,d.reason_kind,(d.to_due-d.from_due)::int days from pulse.project_date_change d
      where d.project_id=$1 and d.from_due is not null and d.to_due is not null and d.to_due<>d.from_due`, [id])).rows as { task_id: string; moved: string[] | null; reason_kind: string; days: number }[];
    const side = (k: string) => t.reasons?.find((x) => x.key === k)?.side ?? (k.startsWith('client') ? 'client' : 'us');
    const card = pmCard(base, day, { hasTemplate: true, plan: { t, plan: pl.plan, tasks: pl.tasks, moves: moves.flatMap((m) => [m.task_id, ...(m.moved ?? [])].map((taskId) => ({ taskId, days: m.days, side: side(m.reason_kind) }))) } });
    const rev = new Map((await c.query(`select id,review_owner_id r from pulse.task where project_id=$1 and template_step is not null and deleted_at is null`, [id])).rows.map((x) => [x.id as string, x.r as string | null]));
    const clocks = pmClocks(t, pl.plan, pl.tasks);
    const stepOf = new Map(t.steps.map((x) => [x.id, x]));
    const clientRole = (t.roles ?? []).find((r) => r.client)?.label ?? 'Client';
    const typeOf = (code: string | null) => (code ? stepOf.get(code)?.type ?? stepOf.get(code)?.kind : null) ?? 'task';
    const openCodes = new Set(pl.tasks.filter((x) => x.step && P_OPEN.has(x.status)).map((x) => x.step!));
    const stageOf = (x: PlanTask) => x.phase && /^s\d+$/.test(x.phase) ? Number(x.phase.slice(1)) : (x.step ? stepOf.get(x.step)?.stage ?? null : null);
    const steps = pl.tasks.filter((x) => x.step && !['cancelled', 'merged'].includes(x.status) && typeOf(x.step) !== 'auto' && !x.parentId).map((x) => {
      const s = stepOf.get(x.step!); const d = pmStepDue(t, pl.plan, clocks, x);
      const client = !!s?.clientInput || roleOf(s?.owner) === clientRole || (x.notes ?? '').startsWith('Needs the client');
      const wo = (s?.after ?? []).find((a) => openCodes.has(a)) ?? null;
      const waitsOn = wo ? shortTitle(stepOf.get(wo)?.title ?? wo, wo) : null;
      const running = x.status === 'in_progress' && ['ongoing', 'repeating'].includes(typeOf(x.step));
      const st = pmStepState({ status: x.status, whoId: x.whoId, reviewerId: rev.get(x.id) ?? null }, { me, today: day, due: d.due, planned: d.planned, client, waitsOn, running });
      return { id: x.id, code: x.step, title: bare(x.title, x.step, 90), stage: stageOf(x), status: x.status, ...st, who: x.who, whoId: x.whoId, role: x.role, due: d.due, start: d.start, planned: d.planned,
        mine: x.whoId === me, gate: ['gate', 'milestone'].includes(typeOf(x.step)), client, asked: x.waitSince ?? null };
    }).sort((a, b) => (a.stage ?? 99) - (b.stage ?? 99) || (a.due ?? '9999').localeCompare(b.due ?? '9999') || String(a.code).localeCompare(String(b.code)));
    const roles = rolesOf(t, pl.plan, pl.tasks);
    const names = new Map((await c.query('select id,display_name name from pulse.person where id=any($1::uuid[])', [[...new Set([...roles.map((r) => r.holder), p.leadId].filter(Boolean))]])).rows.map((r) => [r.id as string, r.name as string]));
    // Who stands for a role: the one named for it; for the lead role the project's lead; else whoever holds most of its steps.
    const top = (role: string) => { const n = new Map<string, { name: string; k: number }>(); for (const x of pl.tasks) if (x.role === role && x.whoId && x.who) n.set(x.whoId, { name: x.who, k: (n.get(x.whoId)?.k ?? 0) + (P_OPEN.has(x.status) ? 2 : 1) });
      const best = [...n.entries()].sort((a, b) => b[1].k - a[1].k)[0]; return best ? { id: best[0], name: best[1].name } : null; };
    const team = roles.filter((r) => !r.none).map((r) => { const who = r.holder ? { id: r.holder, name: names.get(r.holder) ?? null } : r.lead && p.leadId ? { id: p.leadId as string, name: p.lead as string | null } : top(r.role);
      return { role: r.role, id: who?.id ?? null, name: who?.name ?? null, lead: r.lead, open: r.open, nobody: r.nobody }; });
    const leadership = (await c.query(`select pulse.viewer_is('admin','leadership') ok`)).rows[0].ok as boolean;
    const canMove = t.moveDates === 'lead' ? me === p.leadId || leadership : !!p.canRun;
    return { today: day, me, project: p, card, plan: true, steps, team, clocks: clocks.list, reasons: t.reasons ?? null, canMove, template: { name: t.name, version: t.version ?? null } };
  }));
  // PM-BUILD-3 (the Mac's screen 09, SPEC §5.9): who has how many hours of open work on each working day of this week and
  // next. A task's hours: its estimate, else its plan step's hours from the template (the middle of the range), else one
  // hour; spread over the working days from its start to its due day (late work sits on today). Over 9 hours a day is
  // overloaded, over 8 is high. One suggestion: a not-started step on the most loaded person's heaviest day, to the
  // person with the most room in the same role. Leadership and HR see everyone, a pod head their pods, others themselves.
  app.get('/api/v0/projects/workload', req => tx(req, async (c, v) => {
    work(v); const me = person(v); const day = await today(c);
    const { role, pods } = (await c.query('select pulse.work_role() role,pulse.work_head_pods() pods')).rows[0] as { role: string; pods: string[] | null };
    const everyone = role === 'leadership' || role === 'hr';
    const days: string[] = []; for (let d = day; days.length < 12; d = pd(d, 1)) if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) days.push(d);
    const end = days[days.length - 1];
    const rows = (await c.query(`select t.id,t.title,t.project_id "projectId",coalesce(pr.title,pr.name) project,t.template_step step,t.status,t.estimate_minutes est,t.work_on::text start,${DUE}::text due,
        coalesce(t.assignee_person_id,t.owner_id) pid,pe.display_name name,nullif(pp.pod,'') pod,pp.role,t.role_key "roleKey"
      from pulse.task t join pulse.person pe on pe.id=coalesce(t.assignee_person_id,t.owner_id) left join pulse.people_profile pp on pp.person_id=pe.id
        left join pulse.project pr on pr.id=t.project_id
      where t.deleted_at is null and t.status in ('open','in_progress','blocked') and pe.side='staff' and pe.status='active'
        and not exists(select 1 from pulse.agent_member am where am.person_id=pe.id) and coalesce(t.work_on,${DUE}) <= $1::date
        and ($2::boolean or pe.id=$3::uuid or ($4::text[] is not null and nullif(pp.pod,'')=any($4::text[])))
        and not (t.status='in_progress' and t.template_step is not null and pulse.plan_step_running(t.project_id,t.template_step,t.status))
      limit 3000`, [end, everyone, me, role === 'pod_head' ? pods ?? [] : null])).rows as { id: string; title: string; projectId: string | null; project: string | null; step: string | null; status: string;
        est: number | null; start: string | null; due: string | null; pid: string; name: string; pod: string | null; role: string | null; roleKey: string | null }[];
    const tpls = await templates(c); const plans = await plansFor(c, [...new Set(rows.filter((r) => r.step && r.projectId).map((r) => r.projectId!))]);
    const hoursOf = new Map<string, number>();
    for (const [pidp, pl] of plans) { const t = await templateOf(c, tpls, pl.plan); if (!t) continue; for (const x of rows.filter((r) => r.projectId === pidp && r.step)) {
      const h = t.steps.find((y) => y.id === x.step)?.hours; if (h) hoursOf.set(x.id, (h[0] + h[1]) / 2); } }
    const people = new Map<string, { id: string; name: string; pod: string | null; role: string | null; cells: Record<string, number>; items: { id: string; title: string; project: string | null; hours: number; days: string[]; started: boolean; roleKey: string | null }[] }>();
    for (const r of rows) {
      const hours = r.est ? r.est / 60 : hoursOf.get(r.id) ?? 1;
      const from = r.start && r.start > day ? r.start : day, to = r.due && r.due > day ? r.due : from < day ? day : from;
      const span = days.filter((d) => d >= from && d <= (to < from ? from : to)); const on = span.length ? span : [days.find((d) => d >= from) ?? day];
      const pr = people.get(r.pid) ?? { id: r.pid, name: r.name, pod: r.pod, role: r.role, cells: {}, items: [] };
      for (const d of on) pr.cells[d] = (pr.cells[d] ?? 0) + hours / on.length;
      pr.items.push({ id: r.id, title: bare(r.title, r.step, 80), project: r.project, hours: Math.round(hours * 10) / 10, days: on, started: r.status === 'in_progress', roleKey: r.roleKey ?? r.role });
      people.set(r.pid, pr);
    }
    const cap = 8 * days.length;
    const list = [...people.values()].map((p) => { const total = Math.round(days.reduce((n, d) => n + (p.cells[d] ?? 0), 0));
      const cells = days.map((d) => ({ day: d, hours: Math.round((p.cells[d] ?? 0) * 10) / 10 }));
      const over = cells.filter((x) => x.hours > 9).length;
      return { id: p.id, name: p.name, pod: p.pod, role: p.role, total, cap, over: Math.max(0, total - cap), state: over || total > cap ? 'over' : cells.some((x) => x.hours > 8) ? 'high' : 'ok', cells, items: p.items }; })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    // One suggestion: the heaviest day of the most loaded person, a step not started there, to the same role's person with most room.
    let suggestion = null as null | { step: { id: string; title: string; project: string | null; hours: number; day: string }; from: { id: string; name: string; hours: number }; to: { id: string; name: string; total: number } };
    const top = list.find((p) => p.state === 'over');
    if (top) {
      const heavy = [...top.cells].sort((a, b) => b.hours - a.hours)[0];
      const item = top.items.filter((x) => !x.started && x.days.includes(heavy.day)).sort((a, b) => b.hours - a.hours)[0];
      const room = item ? list.filter((p) => p.id !== top.id && p.state === 'ok' && (p.role === top.role || p.items.some((x) => x.roleKey && x.roleKey === item.roleKey))).sort((a, b) => a.total - b.total)[0] : null;
      if (item && room) suggestion = { step: { id: item.id, title: item.title, project: item.project, hours: item.hours, day: heavy.day }, from: { id: top.id, name: top.name, hours: heavy.hours }, to: { id: room.id, name: room.name, total: room.total } };
    }
    return { today: day, days, cap, scope: everyone ? 'all' : role === 'pod_head' ? 'pod' : 'mine', people: list.map(({ items, ...p }) => ({ ...p, steps: items.slice(0, 40) })), suggestion };
  }));
  // PM-BUILD-3 (2511, the Mac's screen 13): the weekly update. The draft is worked out from the week's steps (done, coming,
  // needing help); only a person posts it, and only who runs the project.
  app.get<{ Params: { id: string } }>('/api/v0/projects/:id/update', req => tx(req, async (c, v) => {
    work(v); const me = person(v); const id = pid(req.params.id); const day = await today(c);
    const p = (await c.query(`select p.id,coalesce(p.title,p.name) title,coalesce(nullif(wp.status,''),p.status,'active') status,coalesce(p.kind,'client_work') kind,
        coalesce(p.lead_person_id,wp.owner_id) "leadId",pulse.project_can_run(p.id) "canRun"
      from pulse.project p left join pulse.work_project wp on wp.project_id=p.id and wp.deleted_at is null where p.id=$1 and p.deleted_at is null`, [id])).rows[0] ?? fail(404, 'Project not found');
    const tpls = await templates(c); const pl = (await plansFor(c, [id])).get(id) ?? null; const t = pl ? await templateOf(c, tpls, pl.plan) : null;
    const week = pd(day, -6), ahead = pd(day, 7);
    const history = (await c.query(`select c.id,c.body,(c.created_at at time zone ${ORG_TZ})::date::text "on",(select display_name from pulse.person where id=c.author_id) "by",c.meta
      from pulse.work_comment c where c.project_id=$1 and c.kind='update' and c.removed_at is null order by c.created_at desc limit 5`, [id])).rows;
    let done: string[] = [], next: string[] = [], help: string[] = [], card: PmCard;
    if (pl && t) {
      card = pmCard({ ...p, startsOn: null, dueOn: null, lastActivity: null, open: 0, late: 0, waitingClient: 0, next: null }, day, { hasTemplate: true, plan: { t, plan: pl.plan, tasks: pl.tasks } });
      const clocks = pmClocks(t, pl.plan, pl.tasks); const stepOf = new Map(t.steps.map((x) => [x.id, x]));
      const typeOf = (code: string | null) => (code ? stepOf.get(code)?.type ?? stepOf.get(code)?.kind : null) ?? 'task';
      const steps = pl.tasks.filter((x) => x.step && !x.parentId && typeOf(x.step) !== 'auto' && !P_SKIP.has(x.status));
      done = steps.filter((x) => P_DONE.has(x.status) && x.doneOn && x.doneOn >= week).map((x) => bare(x.title, x.step, 90));
      for (const x of steps.filter((y) => P_OPEN.has(y.status) && !(y.status === 'in_progress' && ['ongoing', 'repeating'].includes(typeOf(y.step))))) {
        const d = pmStepDue(t, pl.plan, clocks, x); const s0 = stepOf.get(x.step!);
        const client = !!s0?.clientInput || roleOf(s0?.owner) === ((t.roles ?? []).find((r) => r.client)?.label ?? 'Client');
        if (d.due && !d.planned && d.due < day) help.push(`${bare(x.title, x.step, 70)}: ${client ? 'waiting on the client' : `${workDays(d.due, day)} working ${workDays(d.due, day) === 1 ? 'day' : 'days'} late`}${x.who && !client ? ` (${x.who})` : ''}`);
        else if (d.due && d.due <= ahead) next.push(`${bare(x.title, x.step, 70)}${x.who ? ` (${x.who}, ${shortDay(d.due)})` : ` (${shortDay(d.due)})`}`);
      }
    } else {
      card = pmCard({ ...p, startsOn: null, dueOn: null, lastActivity: null, open: 0, late: 0, waitingClient: 0, next: null }, day, { hasTemplate: tpls.length > 0, plan: null });
      const rows = (await c.query(`select t.title,t.status,${DUE}::text due,(coalesce(t.done_at,t.accepted_at) at time zone ${ORG_TZ})::date::text "doneOn",(select display_name from pulse.person where id=coalesce(t.assignee_person_id,t.owner_id)) who
        from pulse.task t where t.project_id=$1 and t.deleted_at is null and t.parent_id is null limit 400`, [id])).rows as { title: string; status: string; due: string | null; doneOn: string | null; who: string | null }[];
      done = rows.filter((x) => P_DONE.has(x.status) && x.doneOn && x.doneOn >= week).map((x) => x.title);
      help = rows.filter((x) => P_OPEN.has(x.status) && x.due && x.due < day).map((x) => `${x.title}: ${workDays(x.due!, day)} working days late${x.who ? ` (${x.who})` : ''}`);
      next = rows.filter((x) => P_OPEN.has(x.status) && x.due && x.due >= day && x.due <= ahead).map((x) => `${x.title}${x.who ? ` (${x.who}, ${shortDay(x.due!)})` : ''}`);
    }
    return { today: day, canPost: !!p.canRun, system: { health: card.health, word: card.word, reason: card.reason },
      draft: { done: done.slice(0, 8), next: next.slice(0, 8), help: help.slice(0, 6) }, history, me };
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/:id/update', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const id = pid(req.params.id); const b = req.body ?? {};
    const r = await c.query('select pulse.project_update_post($1,$2,$3,$4,$5) id', [id, String(b.body ?? '').slice(0, 4000), String(b.health ?? ''), typeof b.system === 'string' ? b.system : null,
      typeof b.reason === 'string' ? b.reason.slice(0, 400) : null]);
    return { id: r.rows[0].id };
  }));
}

/** PM-BUILD-3 (the Mac's screen 05, SPEC §5.6): what waits for the viewer's OK. Team review is the review queue
 *  (pulse.task_review_queue: the work given to them to accept); Client approval is what the viewer's projects shared for a
 *  client's OK and are still waiting on, with how long and whether the client is late (sent + 2 working days, or the
 *  answer-by day). */
export function registerApprovalRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/approvals', req => tx(req, async (c, v) => {
    work(v); const me = person(v); const day = await today(c);
    const team = (await c.query('select count(*)::int n from pulse.task t where t.id in (select pulse.task_review_queue($1))', [me])).rows[0].n as number;
    const rows = (await c.query('select pulse.pm_client_waiting() r')).rows[0].r as { id: string; title: string; kind: string; version: number; sharedOn: string; answerBy: string | null; clientId: string; client: string | null;
        projectId: string | null; project: string | null; color: string | null; icon: string | null; sharedBy: string | null; owner: string | null; seen: boolean }[];
    // Two working days to answer unless the share named a day.
    const due = (from: string) => { let d = from, n = 0; while (n < 2) { d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10); if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) n++; } return d; };
    const client = rows.map((r) => { const by = r.answerBy ?? due(r.sharedOn); return { ...r, due: by, waiting: workDays(r.sharedOn, day), clientLate: by < day ? workDays(by, day) : 0,
      round: Math.max(1, r.version), rounds: 3, color: r.color ?? (r.projectId ? defaultColor(r.projectId) : 'slate') }; })
      .sort((a, b) => b.clientLate - a.clientLate || a.due.localeCompare(b.due));
    return { today: day, team, client };
  }));
}

/** PM-BUILD-4 (2520, KAZUK-PM-2 phase 3 "the chat moves the board"): the viewer's step cards, read from what they wrote in
 *  a project's group ("M1 first draft done") or asked after a step they finished (back-fill). Only the card's person sees
 *  and answers it, only a person (pulse.pm_step_card_answer); nothing is sent to anyone. */
export function registerStepCardRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // 2520: what the project needs from its client (its open client steps), with a drafted request the lead sends
  // themselves; "Mark as asked" opens each step's wait. Pulse sends nothing to the client.
  app.get<{ Params: { id: string } }>('/api/v0/projects/:id/client-asks', req => tx(req, async (c, v) => {
    work(v); person(v); const id = pid(req.params.id); const day = await today(c);
    const p = (await c.query(`select coalesce(p.title,p.name) title,cl.display_name client,pulse.project_can_run(p.id) "canRun" from pulse.project p left join pulse.client cl on cl.id=p.client_id
      where p.id=$1 and p.deleted_at is null`, [id])).rows[0] ?? fail(404, 'Project not found');
    const rows = (await c.query(`select t.id,t.template_step code,t.title,${DUE}::text due,(select (min(w.since) at time zone ${ORG_TZ})::date::text from pulse.task_wait w where w.task_id=t.id and w.until is null) asked
      from pulse.task t join pulse.plan_steps_of($1) s on s.code=t.template_step and s.client
      where t.project_id=$1 and t.deleted_at is null and t.parent_id is null and t.template_step is not null and t.status in ('open','in_progress','blocked')
      order by t.due_at nulls last,t.template_step limit 40`, [id])).rows as { id: string; code: string | null; title: string; due: string | null; asked: string | null }[];
    const items = rows.map((r) => ({ ...r, title: bare(r.title, r.code, 90), days: r.asked ? workDays(r.asked, day) : 0 }));
    const ask = items.filter((x) => !x.asked);
    const draft = ask.length ? [`Hello${p.client ? ` ${p.client} team` : ''}, to keep ${p.title} on time we need these from you:`, ...ask.map((x) => `• ${x.title}${x.due ? ` (by ${shortDay(x.due)})` : ''}`), 'Could you share them here? Thank you.'].join('\n') : null;
    return { today: day, canAsk: !!p.canRun, client: p.client, items, draft };
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/:id/client-asks', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const id = pid(req.params.id); const b = req.body ?? {};
    const ids = Array.isArray(b.taskIds) ? b.taskIds.slice(0, 40).map((x) => pid(String(x))) : fail(400, 'Choose what you asked for');
    return (await c.query('select pulse.project_client_ask($1,$2::uuid[],$3) r', [id, ids, typeof b.note === 'string' ? b.note.slice(0, 600) : null])).rows[0].r;
  }));
  app.get<{ Querystring: { channel?: string; project?: string } }>('/api/v0/step-cards', req => tx(req, async (c, v) => {
    work(v); person(v);
    const ch = req.query.channel ? pid(req.query.channel) : null, pr = req.query.project ? pid(req.query.project) : null;
    const r = (await c.query('select pulse.pm_step_cards($1,$2) c,pulse.assistant_state() a', [ch, pr])).rows[0];
    return { cards: r.c, assistant: r.a };
  }));
  // 2522: a person's load benchmark (leadership only, decided in the database).
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/load-benchmark/:id', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const b = req.body ?? {};
    const n = (x: unknown) => x === null || x === undefined || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : fail(400, 'Give the numbers as units');
    return (await c.query('select pulse.load_benchmark_set($1,$2,$3,$4,$5) r', [pid(req.params.id), n(b.low), n(b.high), n(b.reviewAbove), typeof b.note === 'string' ? b.note.slice(0, 300) : null])).rows[0].r;
  }));
  // 2521: "Stop checking on me" / "Check on me again" (the person's own end-of-day checks).
  app.post<{ Body: Record<string, unknown> }>('/api/v0/assistant/quiet', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v);
    return (await c.query('select pulse.assistant_quiet_set($1) r', [req.body?.on !== false])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/step-cards/:id/answer', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const b = req.body ?? {};
    const answer = ['yes', 'no', 'undo'].includes(String(b.answer)) ? String(b.answer) : fail(400, 'Answer yes, no or undo');
    const task = b.taskId ? pid(String(b.taskId)) : null;
    return (await c.query('select pulse.pm_step_card_answer($1,$2,$3) r', [pid(req.params.id), answer, task])).rows[0].r;
  }));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (x: unknown, label: string) => x === null || x === undefined || x === '' ? null : typeof x === 'string' && DAY.test(x) ? x : fail(400, `Enter ${label} as a date`);
const pid = (x: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x) ? x : fail(400, 'Choose a valid record');

/** Screens 5 and 6: a project's timeline (its tasks as bars, Day 0 = kick-off), its date changes and its status history. */
export function registerProjectRunRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Params: { id: string } }>('/api/v0/projects/:id/timeline', req => tx(req, async (c, v) => {
    work(v); person(v); const id = pid(req.params.id);
    const p = (await c.query(`select p.id,coalesce(p.title,p.name) title,p.status,coalesce(wp.starts_on,p.starts_on)::text "startsOn",coalesce(wp.due_on,p.ends_on)::text "dueOn",
        (select display_name from pulse.person where id=coalesce(p.lead_person_id,wp.owner_id)) lead,pulse.project_can_run(p.id) "canRun",(now() at time zone ${ORG_TZ})::date::text today
      from pulse.project p left join pulse.work_project wp on wp.project_id=p.id and wp.deleted_at is null where p.id=$1 and p.deleted_at is null`, [id])).rows[0] ?? fail(404, 'Project not found');
    const tasks = (await c.query(`select t.id,t.title,t.status,t.parent_id "parentId",t.template_step step,t.phase_key phase,(select display_name from pulse.person where id=coalesce(t.assignee_person_id,t.owner_id)) who,
        coalesce(t.work_on,(t.started_at at time zone ${ORG_TZ})::date,(t.created_at at time zone ${ORG_TZ})::date)::text start,${DUE}::text due,
        (coalesce(t.done_at,t.accepted_at) at time zone ${ORG_TZ})::date::text "doneOn",
        (select jsonb_build_object('start',d.from_start,'due',d.from_due) from pulse.project_date_change d where d.task_id=t.id order by d.changed_at limit 1) was,
        (select count(*)::int from pulse.task_link l where l.blocker_id=t.id and l.cleared_at is null) waiting,
        (select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'step',b.template_step,'title',b.title,'due',(b.due_at at time zone ${ORG_TZ})::date::text) order by b.due_at),'[]'::jsonb)
           from pulse.task_link l join pulse.task b on b.id=l.blocker_id where l.task_id=t.id and l.cleared_at is null and b.deleted_at is null) "waitsFor"
      from pulse.task t where t.project_id=$1 and t.deleted_at is null and t.status<>'cancelled'
      order by coalesce(t.work_on,(t.started_at at time zone ${ORG_TZ})::date,${DUE},(t.created_at at time zone ${ORG_TZ})::date),t.created_at limit 400`, [id])).rows;
    const changes = (await c.query(`select d.id,t.title,d.from_start::text "fromStart",d.from_due::text "fromDue",d.to_start::text "toStart",d.to_due::text "toDue",d.reason_kind reason,d.note,
        cardinality(d.moved) moved,(select display_name from pulse.person where id=d.changed_by) who,d.changed_at::text at
      from pulse.project_date_change d join pulse.task t on t.id=d.task_id where d.project_id=$1 order by d.changed_at desc limit 50`, [id])).rows;
    const history = (await c.query(`select s.to_status status,s.from_status "from",s.reason,s.starts_on::text "startsOn",s.restart_on::text "restartOn",s.stops,s.shifted_days "shiftedDays",
        (select display_name from pulse.person where id=s.changed_by) who,s.changed_at::text at from pulse.project_status_change s where s.project_id=$1 order by s.changed_at desc limit 20`, [id])).rows;
    // A planned project groups its timeline by stage (Kazuk's screen 5), with the template's stage names.
    // PM-BUILD-2 (2310): the plan's own reasons for moving a date, from the template version it runs on.
    const plan = (await c.query(`select pp.kickoff::text kickoff,d->'stages' stages,d->'labels' labels,d->'reasons' reasons,d->>'moveDates' "moveDates"
      from pulse.project_plan pp cross join lateral (select pulse.plan_definition(pp.project_id) d) x where pp.project_id=$1`, [id])).rows[0] ?? null;
    if (plan?.kickoff) p.startsOn = plan.kickoff;
    return { project: p, tasks, changes, history, stages: plan?.stages ?? null, labels: plan?.labels ?? {}, reasons: plan?.reasons ?? null, moveDates: plan?.moveDates ?? null };
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/:id/status', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const b = req.body ?? {};
    const stops = b.stops && typeof b.stops === 'object' && !Array.isArray(b.stops) ? Object.fromEntries(Object.entries(b.stops as Record<string, unknown>).slice(0, 10).map(([k, x]) => [k.slice(0, 40), !!x])) : {};
    return (await c.query('select pulse.project_set_status($1,$2,$3,$4,$5,$6,$7) r', [pid(req.params.id), String(b.status ?? ''), String(b.reason ?? '').slice(0, 600),
      day(b.from, 'the first day'), day(b.restart, 'the expected restart'), JSON.stringify(stops), b.shift === true])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/:id/reschedule', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); pid(req.params.id); const b = req.body ?? {};
    const task = pid(String(b.taskId ?? ''));
    const inProject = (await c.query('select 1 from pulse.task where id=$1 and project_id=$2', [task, req.params.id])).rows[0];
    if (!inProject) fail(404, 'Task not found');
    return (await c.query('select pulse.project_reschedule($1,$2,$3,$4,$5,$6) r', [task, day(b.start, 'the start'), day(b.due, 'the end'), String(b.reason ?? ''),
      b.note === undefined || b.note === null ? null : String(b.note).slice(0, 400), b.cascade === true])).rows[0].r;
  }));
}

/** Screen 0: quote signed → the project builds itself (pulse.project_from_quote, migration 1301), and sold against delivered. */
export function registerProjectQuoteRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Params: { id: string } }>('/api/v0/projects/from-quote/:id', req => tx(req, async (c, v) => {
    work(v); person(v); const doc = pid(req.params.id);
    const row = (await c.query(`select p.id "projectId",coalesce(p.title,p.name) title from pulse.erp_document d
      left join pulse.project_quote q on q.org_id=d.org_id and q.document_id=d.id join pulse.project p on p.id=coalesce(q.project_id,d.project_id)
      where d.id=$1 and p.deleted_at is null`, [doc])).rows[0];
    return row ?? { projectId: null, title: null };
  }));
  app.post<{ Body: Record<string, unknown> }>('/api/v0/projects/from-quote', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v);
    // Refuse before reading the body, as Billing does (role matrix: a person gets 403, not 400).
    if (!(await c.query('select pulse.erp_can(true) ok')).rows[0].ok) fail(403, 'Starting a project from a quotation is for leadership and the Finance role');
    const b = req.body ?? {};
    const lead = b.leadId === null || b.leadId === undefined || b.leadId === '' ? null : pid(String(b.leadId));
    return (await c.query('select pulse.project_from_quote($1,$2,$3) r', [pid(String(b.documentId ?? '')), lead, day(b.startsOn, 'the kick-off day')])).rows[0].r;
  }));
  // BILLING (owner, 4 Nov 2026; Kazuk, 3 Nov): a project a paid invoice started waits for a project head to choose who owns
  // it (the growth strategist) and the client category; until then it has no owner.
  app.get<{ Params: { id: string } }>('/api/v0/projects/:id/assign', req => tx(req, async (c, v) => {
    work(v); person(v); const project = pid(req.params.id);
    const p = (await c.query(`select p.id,coalesce(p.title,p.name) title,p.location,p.lead_person_id "ownerId",p.client_category category,c.display_name client,
      pulse.project_billing_source(p.id) src from pulse.project p left join pulse.client c on c.id=p.client_id where p.id=$1`, [project])).rows[0];
    if (!p) fail(404, 'Project not found');
    const canAssign = (await c.query('select pulse.project_can_run($1) ok', [project])).rows[0].ok as boolean;
    const { src, ...row } = p as { src: { invoice: string | null; quotation: string | null; fromBilling: boolean } | null } & Record<string, unknown>;
    const fromBilling = !!src?.fromBilling;
    const categories = (await c.query(`select coalesce((select t.definition->'categories' from pulse.delivery_template t order by t.key limit 1),
      '[{"key":"sell_out","label":"Sell-out"},{"key":"competitive","label":"Competitive"},{"key":"normal","label":"Normal"}]'::jsonb) c`)).rows[0].c as { key: string; label: string }[];
    // Growth strategists first (the template's bandwidth role, else PGS), then the rest of the staff.
    const owners = canAssign ? (await c.query(`select p.id,p.display_name name,exists(select 1 from pulse.role_assignment r where r.person_id=p.id and r.role_key=any($1)
        and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) strategist
      from pulse.person p where p.side='staff' and p.status='active' order by 3 desc,2 limit 200`,
      [[(await c.query("select coalesce((select t.definition->'bandwidth'->>'role' from pulse.delivery_template t order by t.key limit 1),'pgs') r")).rows[0].r, 'pgs', 'head_pgs']])).rows : [];
    // KAZUK-FLOW G11 (1688): who should run it (the client's earlier PGS, else the least loaded), for a person to confirm.
    const suggest = canAssign && fromBilling ? (await c.query('select pulse.project_pgs_suggest($1) s', [project])).rows[0].s as { id: string; name: string; pod: string | null; load: number; why: string }[] : [];
    return { ...row, invoice: src?.invoice ?? null, quotation: src?.quotation ?? null, needed: fromBilling && (!p.ownerId || !p.category), fromBilling, canAssign, categories: categories.map((x) => ({ key: x.key, label: x.label ?? x.key })), owners, suggest };
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/:id/assign', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v);
    const b = req.body ?? {};
    // KAZUK-FLOW G11 (1688): the PGS heads the project, joins it, the project takes their pod, the handover is theirs.
    return (await c.query('select pulse.project_assign_pgs($1,$2,$3) r', [pid(req.params.id), typeof b.ownerId === 'string' && b.ownerId ? pid(b.ownerId) : null,
      typeof b.category === 'string' ? b.category.slice(0, 40) : null])).rows[0].r;
  }));
  app.get<{ Params: { id: string } }>('/api/v0/projects/:id/scope', req => tx(req, async (c, v) => {
    work(v); person(v);
    return (await c.query('select pulse.project_scope($1) r', [pid(req.params.id)])).rows[0].r;
  }));
}
