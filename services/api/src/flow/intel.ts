/** FLOW-A: Pip in the builder (converters for wires that do not fit, people for each role by load, "this person is on
 *  5 processes"), the scorecard (numbers derived from step events: on time, confirmed first time, revisions, verdicts;
 *  per person) and capacity (focused hours of open steps per person, by variant, against a weekly budget). */
import type { PoolClient } from 'pg';
import { roleHolders } from '../sops.js';
import { converters, problems } from './model.js';
import { MODULE } from './registry.js';
import { KIND_LABELS, type FlowDef, type ScoreMetric } from './types.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** A weekly focused-hours budget per person (the Sprint's ~25 h per strategist): a setting of each process later. */
export const WEEK_HOURS = 25;

export async function builderIntel(c: PoolClient, def: FlowDef, focusStep: string | null) {
  const probs = problems(def);
  const holders = await roleHolders(c, def.roles.map((r) => r.label));
  const ids = [...new Set(Object.values(holders).flat().map((p) => p.id))];
  const load = ids.length ? (await c.query(`select p.id,pulse.workflow_open_load(p.id) tasks,
     (select count(*)::int from pulse.flow_run_step s join pulse.flow_run r on r.id=s.run_id where s.person_id=p.id and r.status='running' and r.mode='live' and s.state in ('open','in_progress','in_review','confirmed')) steps,
     (select coalesce(sum(s.hours),0)::float from pulse.flow_run_step s join pulse.flow_run r on r.id=s.run_id where s.person_id=p.id and r.status='running' and r.mode='live' and s.state not in ('done','skipped')) hours,
     (select count(distinct r.process_id)::int from pulse.flow_run r where r.status='running' and r.mode='live' and exists(select 1 from jsonb_each_text(r.people) x where x.value=p.id::text)) processes
   from pulse.person p where p.id=any($1)`, [ids])).rows : [];
  const L = new Map(load.map((x) => [x.id, x]));
  const people = Object.fromEntries(def.roles.map((r) => [r.key, (holders[r.label] ?? []).map((p) => { const x = L.get(p.id) as Row | undefined;
    const warn = x && x.processes >= 5 ? `${p.name.split(' ')[0]} is on ${x.processes} running processes` : x && x.hours > WEEK_HOURS * 2 ? `${p.name.split(' ')[0]} has ${Math.round(x.hours)} focused hours open` : null;
    return { id: p.id, name: p.name, photoAt: p.photoAt, tasks: x?.tasks ?? 0, steps: x?.steps ?? 0, hours: Math.round((x?.hours ?? 0) * 10) / 10, processes: x?.processes ?? 0, warning: warn }; })
    .sort((a, b) => a.hours - b.hours || a.tasks - b.tasks)]));
  const suggestions: { step?: string; text: string; modules?: string[] }[] = [];
  for (const p of probs) if (p.fix?.kind === 'converter' && p.fix.modules.length) suggestions.push({ step: p.step, text: `${p.text.split(':')[0]}: add ${MODULE.get(p.fix.modules[0])?.name ?? p.fix.modules[0]} between them?`, modules: p.fix.modules });
  for (const r of def.roles) if (!(holders[r.label] ?? []).length) suggestions.push({ text: `Nobody in the team holds “${r.label}” yet: name someone when a run starts` });
  const focus = focusStep ? def.steps.find((s) => s.id === focusStep) : null;
  // FLOW-D: a block step's uses are checked in words by problems(); the older wiring hints are for steps without one.
  if (focus && !focus.block) {
    const mm = MODULE.get(focus.module);
    for (const need of mm?.needs ?? []) if (need.required !== false && !def.wires.some((w) => w.to.step === focus.id && w.to.port === need.key)) {
      const makers = def.steps.filter((s) => s.id !== focus.id && (MODULE.get(s.module)?.makes ?? []).some((m) => m.kind === need.kind));
      suggestions.push({ step: focus.id, text: makers.length ? `“${focus.title}” needs a ${KIND_LABELS[need.kind].toLowerCase()}: wire it from ${makers.slice(0, 2).map((s) => `“${s.title}”`).join(' or ')}`
        : `“${focus.title}” needs a ${KIND_LABELS[need.kind].toLowerCase()}: add ${converters('any', need.kind).slice(0, 2).map((k) => MODULE.get(k)?.name).join(' or ')} before it?`, modules: converters('any', need.kind) });
    }
  }
  return { problems: probs, people, suggestions };
}

const DEFAULT_METRICS: ScoreMetric[] = [
  { key: 'on_time', label: 'Steps done on time', kind: 'on-time' },
  { key: 'first_time', label: 'Confirmed in the first round', kind: 'first-time' },
];

/** The scorecard: each metric of the processes (or the defaults), per person who did the steps. */
export async function scorecard(c: PoolClient, q: { processId?: string | null; personId?: string | null; from: string; to: string }) {
  const procs = (await c.query(`select id,name,definition from pulse.flow_process where ($1::uuid is null or id=$1) and status<>'archived'`, [q.processId ?? null])).rows;
  const out: { processId: string; process: string; metrics: { key: string; label: string; kind: string; note: string | null; total: { n: number; value: number | null }; people: { personId: string; name: string; n: number; value: number | null }[] }[] }[] = [];
  for (const p of procs) {
    const def = p.definition as FlowDef; const metrics = def.scorecard?.length ? def.scorecard : DEFAULT_METRICS;
    const rows: Row[] = (await c.query(`select s.step_key,s.person_id,pe.display_name name,s.due_on,(s.done_at at time zone pulse.org_time_zone())::date done_on,s.rounds,s.state
       from pulse.flow_run_step s join pulse.flow_run r on r.id=s.run_id left join pulse.person pe on pe.id=s.person_id
       where r.process_id=$1 and r.mode='live' and s.state='done' and s.done_at>=$2::date and s.done_at<$3::date+1 and ($4::uuid is null or s.person_id=$4)`, [p.id, q.from, q.to, q.personId ?? null])).rows;
    const recs: Row[] = (await c.query(`select fr.type_key,fr.data,fr.created_by person_id,pe.display_name name from pulse.flow_record fr join pulse.flow_run r on r.id=fr.run_id left join pulse.person pe on pe.id=fr.created_by
       where r.process_id=$1 and r.mode='live' and fr.archived_at is null and fr.updated_at>=$2::date and fr.updated_at<$3::date+1 and ($4::uuid is null or fr.created_by=$4)`, [p.id, q.from, q.to, q.personId ?? null])).rows;
    const ms = metrics.map((m) => {
      const sel = rows.filter((r) => !m.steps?.length || m.steps.includes(r.step_key));
      let calc: (xs: Row[]) => { n: number; value: number | null };
      if (m.kind === 'on-time') { const ys = (xs: Row[]) => xs.filter((r) => r.due_on); calc = (xs) => { const d = ys(xs); return { n: d.length, value: d.length ? Math.round((100 * d.filter((r) => r.done_on <= r.due_on).length) / d.length) : null }; }; }
      else if (m.kind === 'first-time') calc = (xs) => ({ n: xs.length, value: xs.length ? Math.round((100 * xs.filter((r) => r.rounds <= 1).length) / xs.length) : null });
      else {
        const rs = recs.filter((r) => !m.recordType || r.type_key === m.recordType);
        const val = (xs: Row[]) => xs.map((r) => r.data?.[m.field ?? '']).filter((x) => x !== undefined && x !== null && x !== '');
        const recCalc = (xs: Row[]) => { const v = val(xs);
          if (m.kind === 'revisions') return { n: v.length, value: v.length ? Math.round((10 * v.reduce((a, b) => a + Number(b || 0), 0)) / v.length) / 10 : null };
          if (m.kind === 'verdict') return { n: v.length, value: v.length ? Math.round((100 * v.filter((x) => /^(winning|working)$/i.test(String(x))).length) / v.length) : null };
          return { n: v.length, value: v.filter((x) => x === true || /^yes$/i.test(String(x))).length }; };
        const byP = new Map<string, Row[]>(); for (const r of rs) if (r.person_id) { if (!byP.has(r.person_id)) byP.set(r.person_id, []); byP.get(r.person_id)!.push(r); }
        return { key: m.key, label: m.label, kind: m.kind, note: m.note ?? null, total: recCalc(rs), people: [...byP].map(([id, xs]) => ({ personId: id, name: xs[0].name, ...recCalc(xs) })) };
      }
      const byP = new Map<string, Row[]>(); for (const r of sel) if (r.person_id) { if (!byP.has(r.person_id)) byP.set(r.person_id, []); byP.get(r.person_id)!.push(r); }
      return { key: m.key, label: m.label, kind: m.kind, note: m.note ?? null, total: calc(sel), people: [...byP].map(([id, xs]) => ({ personId: id, name: xs[0].name, ...calc(xs) })) };
    });
    out.push({ processId: p.id, process: p.name, metrics: ms });
  }
  return { from: q.from, to: q.to, processes: out };
}

/** Capacity: each person's open focused hours (steps not done in running runs), by the run's main variant value. */
export async function capacity(c: PoolClient) {
  const rows = (await c.query(`select s.person_id,pe.display_name name,coalesce(r.fields->>(r.compiled->>'variant'),'—') variant,count(*)::int steps,coalesce(sum(s.hours),0)::float hours,
     count(*) filter(where s.due_on<pulse.flow_today())::int late
   from pulse.flow_run_step s join pulse.flow_run r on r.id=s.run_id join pulse.person pe on pe.id=s.person_id
   where r.status='running' and r.mode='live' and s.state not in ('done','skipped') group by 1,2,3 order by 2`)).rows;
  type Load = { personId: string; name: string; steps: number; hours: number; late: number; byVariant: Record<string, number> };
  const people = new Map<string, Load>();
  for (const r of rows) { const p: Load = people.get(r.person_id) ?? { personId: r.person_id, name: r.name, steps: 0, hours: 0, late: 0, byVariant: {} };
    p.steps += r.steps; p.hours += r.hours; p.late += r.late; p.byVariant[r.variant] = (p.byVariant[r.variant] ?? 0) + r.hours; people.set(r.person_id, p); }
  return { weekHours: WEEK_HOURS, people: [...people.values()].map((p) => ({ ...p, hours: Math.round(p.hours * 10) / 10, weeks: Math.round((p.hours / WEEK_HOURS) * 10) / 10 })).sort((a, b) => b.hours - a.hours) };
}
