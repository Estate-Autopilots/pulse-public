/** FLOW-A: what the Flow API reads. Processes (Flow's own, and the older SOPs, workflows and boards read through it so
 *  nothing is lost), runs with each step's state and what it waits for, My steps, one step with its module, record and
 *  SOP part. Writes go through the engine (0800) and handlers.ts. */
import type { PoolClient } from 'pg';
import { fail, leadership, type Viewer } from '../routes.js';
import { roleHolders } from '../sops.js';
import { boardDef, legacyDef, problems, sopWriteup, type Compiled } from './model.js';
import { MODULE } from './registry.js';
import { kindOf } from './blocks.js';
import { RECORD_TYPE } from './record-types.js';
import { dayNOf, dueOf, pipLine, stateText, waitingFor } from './views.js';
import { OPEN_STATES, STEP_STATE_LABELS, type FlowDef, type FlowRecord, type IntakeItem, type MyStep, type PersonRef, type ProcessDetail, type ProcessSource,
  type ProcessStatus, type ProcessSummary, type RunDetail, type RunStep, type RunSummary, type StepState, type WriteupSection, type FlowStep } from './types.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHOTO = (a: string) => `(select ph.updated_at from pulse.person_photo ph where ph.person_id=${a}.id)`;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const canDesign = (v: Viewer) => leadership(v);
/** What a process's runs are called: its own words, else the company's (FLOW-E: Settings → Industry & roles), else Run. */
export const terms = (def: FlowDef | null | undefined, w?: { run: string; runs: string } | null) => ({ run: def?.terms?.run || w?.run || 'Run', runs: def?.terms?.runs || w?.runs || 'Runs' });
/** The company's own words for a run (null when it never chose). */
export async function runWords(c: PoolClient): Promise<{ run: string; runs: string } | null> {
  const w = (await c.query('select pulse.org_words() w')).rows[0].w as Record<string, string>;
  return w.run ? { run: w.run, runs: w.runs || `${w.run}s` } : null;
}
export const today = async (c: PoolClient) => (await c.query('select pulse.flow_today()::text d')).rows[0].d as string;

/** "workflow:<uuid>" → { source: 'workflow', id }; a bare uuid is a Flow process. */
export function parseId(raw: string): { source: ProcessSource; id: string } {
  const m = /^(sop|workflow|board):([0-9a-f-]{36})$/.exec(raw);
  if (m && UUID.test(m[2])) return { source: m[1] as ProcessSource, id: m[2] };
  if (UUID.test(raw)) return { source: 'flow', id: raw };
  return fail(404, 'Process not found');
}
export const publicId = (source: ProcessSource, id: string) => (source === 'flow' ? id : `${source}:${id}`);

export async function persons(c: PoolClient, ids: (string | null | undefined)[]): Promise<Map<string, PersonRef>> {
  const list = [...new Set(ids.filter((x): x is string => !!x && UUID.test(x)))];
  if (!list.length) return new Map();
  const rows = (await c.query(`select p.id,p.display_name name,${PHOTO('p')} "photoAt",pp.role from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=any($1)`, [list])).rows;
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, photoAt: r.photoAt, role: r.role }]));
}

const statusText = (status: ProcessStatus, steps: number, running: number) =>
  status === 'archived' ? 'Archived' : status === 'paused' ? 'Paused' : status === 'live' ? `Live · ${running} running` : steps ? 'Steps drafted' : 'Written only';
const stageCounts = (def: FlowDef) => def.stages.map((s) => ({ key: s.key, label: s.label, steps: def.steps.filter((x) => x.stage === s.key).length }));

// ---------------------------------------------------------------------------------------------------------------------
// Processes
export async function listProcesses(c: PoolClient, v: Viewer, q: { status?: string }): Promise<ProcessSummary[]> {
  const all = q.status === 'archived';
  const flows = (await c.query(`select f.id,f.name,f.summary,f.status,f.definition,f.template_key,f.updated_at,jsonb_array_length(f.writeup) sections,
     (select count(*)::int from pulse.flow_run r where r.process_id=f.id and r.status='running') running,
     (select count(*)::int from pulse.flow_run_step s join pulse.flow_run r on r.id=s.run_id where r.process_id=f.id and r.status='running' and s.state not in ('done','skipped') and s.due_on<pulse.flow_today()) late,
     (select array_agg(distinct s.person_id) from pulse.flow_run_step s join pulse.flow_run r on r.id=s.run_id where r.process_id=f.id and r.status='running' and s.person_id is not null) people
   from pulse.flow_process f where ${all ? "f.status='archived'" : "f.status<>'archived'"} and (f.status in ('live','paused') or $1) order by f.status='live' desc,f.updated_at desc`, [canDesign(v)])).rows;
  const who = await persons(c, flows.flatMap((f) => f.people ?? [])); const w = await runWords(c);
  const out: ProcessSummary[] = flows.map((f) => { const def = f.definition as FlowDef;
    const status: ProcessStatus = f.status === 'draft' && !def.steps.length ? 'written' : f.status;
    return { id: f.id, source: 'flow', name: f.name, summary: f.summary, status, statusText: statusText(status, def.steps.length, f.running), stages: stageCounts(def),
      roles: def.roles.map((r) => r.label), people: (f.people ?? []).map((id: string) => who.get(id)).filter(Boolean).slice(0, 8), steps: def.steps.length,
      running: f.running, late: f.late, template: f.template_key, updatedAt: f.updated_at, readOnly: false, terms: terms(def, w) }; });
  if (all) return out;
  // Older SOPs, workflows and boards no Flow process has taken over.
  const sops = (await c.query(`select s.id,s.title,s.purpose,s.status,s.doc,s.updated_at from pulse.sop s where s.status<>'archived'
     and not exists(select 1 from pulse.flow_process f where f.sop_id=s.id and f.status<>'archived') order by s.updated_at desc limit 300`)).rows;
  for (const s of sops) {
    const roles = [...new Set(((s.doc?.steps ?? []) as { role: string | null }[]).map((x) => x.role).filter((x): x is string => !!x))];
    out.push({ id: publicId('sop', s.id), source: 'sop', name: s.title, summary: s.purpose, status: 'written', statusText: 'Written only', stages: [], roles, people: [], steps: 0, running: 0, late: 0,
      template: null, updatedAt: s.updated_at, readOnly: true, terms: terms(null) });
  }
  const wfs = (await c.query(`select w.id,w.name,w.purpose,w.status,w.definition,w.updated_at,w.board_id,
     (select count(*)::int from pulse.workflow_run r where r.workflow_id=w.id and r.mode='live' and r.status='running') running,
     (select count(*)::int from pulse.workflow_run_step st join pulse.workflow_run r on r.id=st.run_id where r.workflow_id=w.id and r.mode='live' and r.status='running' and st.status='active' and st.due_at<now()) late
   from pulse.workflow w where w.status<>'archived' and not exists(select 1 from pulse.flow_process f where (f.workflow_id=w.id or f.board_id=w.board_id) and f.status<>'archived')
   order by w.updated_at desc limit 300`)).rows;
  for (const w of wfs.filter((x) => !x.board_id)) {
    const steps = (w.definition?.steps ?? []) as { role: string | null; phase: string | null }[];
    const status = w.status as ProcessStatus;
    out.push({ id: publicId('workflow', w.id), source: 'workflow', name: w.name, summary: w.purpose, status, statusText: statusText(status, steps.length, w.running),
      stages: [...new Set(steps.map((x) => x.phase).filter((x): x is string => !!x))].map((p) => ({ key: p, label: p, steps: steps.filter((x) => x.phase === p).length })),
      roles: [...new Set(steps.map((x) => x.role).filter((x): x is string => !!x))], people: [], steps: steps.length, running: w.running, late: w.late, template: null,
      updatedAt: w.updated_at, readOnly: true, terms: terms(null) });
  }
  const boards = (await c.query(`select b.id,b.name,b.purpose,b.updated_at from pulse.workflow_board b where b.status='active'
     and not exists(select 1 from pulse.flow_process f where f.board_id=b.id and f.status<>'archived') order by b.updated_at desc limit 100`)).rows;
  for (const b of boards) {
    const tabs = wfs.filter((w) => w.board_id === b.id);
    const live = tabs.some((t) => t.status === 'live'); const running = tabs.reduce((n, t) => n + t.running, 0);
    out.push({ id: publicId('board', b.id), source: 'board', name: b.name, summary: b.purpose, status: live ? 'live' : 'draft', statusText: statusText(live ? 'live' : 'draft', tabs.length, running),
      stages: tabs.map((t) => ({ key: t.id, label: t.name, steps: (t.definition?.steps ?? []).length })), roles: [], people: [], steps: tabs.reduce((n, t) => n + (t.definition?.steps ?? []).length, 0),
      running, late: tabs.reduce((n, t) => n + t.late, 0), template: null, updatedAt: b.updated_at, readOnly: true, terms: terms(null) });
  }
  return out;
}

/** An older SOP, workflow or board as a process definition and write-up (read-only until someone edits it). */
export async function legacyProcess(c: PoolClient, source: ProcessSource, id: string): Promise<{ name: string; summary: string | null; status: ProcessStatus; def: FlowDef; writeup: WriteupSection[];
  updatedAt: string; dropped: number; running: number }> {
  if (source === 'sop') {
    const s = (await c.query('select title,purpose,status,doc,updated_at from pulse.sop where id=$1', [id])).rows[0] ?? fail(404, 'Process not found');
    return { name: s.title, summary: s.purpose, status: 'written', def: legacyDef([], s.doc?.phases ?? []).def, writeup: sopWriteup(s.title, s.purpose, s.doc?.steps ?? []), updatedAt: s.updated_at, dropped: 0, running: 0 };
  }
  if (source === 'workflow') {
    const w = (await c.query(`select w.name,w.purpose,w.status,w.definition,w.updated_at,s.title sop_title,s.purpose sop_purpose,s.doc sop_doc,
       (select count(*)::int from pulse.workflow_run r where r.workflow_id=w.id and r.mode='live' and r.status='running') running
       from pulse.workflow w left join pulse.sop s on s.id=w.sop_id where w.id=$1`, [id])).rows[0] ?? fail(404, 'Process not found');
    const { def, dropped } = legacyDef(w.definition?.steps ?? [], w.definition?.phases ?? []);
    return { name: w.name, summary: w.purpose, status: w.status, def, writeup: w.sop_doc ? sopWriteup(w.sop_title, w.sop_purpose, w.sop_doc.steps ?? []) : [], updatedAt: w.updated_at, dropped, running: w.running };
  }
  const b = (await c.query('select name,purpose,updated_at from pulse.workflow_board where id=$1', [id])).rows[0] ?? fail(404, 'Process not found');
  const tabs = (await c.query(`select w.id,w.name,w.status,w.definition,(select count(*)::int from pulse.workflow_run r where r.workflow_id=w.id and r.mode='live' and r.status='running') running
     from pulse.workflow w where w.board_id=$1 and w.status<>'archived' order by w.board_position nulls last,w.created_at`, [id])).rows;
  const { def, dropped } = boardDef(tabs.map((t) => ({ id: t.id, name: t.name, steps: t.definition?.steps ?? [] })));
  return { name: b.name, summary: b.purpose, status: tabs.some((t) => t.status === 'live') ? 'live' : 'draft', def, writeup: [], updatedAt: b.updated_at, dropped, running: tabs.reduce((n, t) => n + t.running, 0) };
}

export async function readProcess(c: PoolClient, v: Viewer, raw: string): Promise<ProcessDetail> {
  const { source, id } = parseId(raw);
  const canStart = (await c.query('select pulse.workflow_can_start(null) ok')).rows[0].ok as boolean;
  let base: Omit<ProcessDetail, 'roleHolders' | 'problems' | 'canEdit' | 'canStart'>;
  if (source === 'flow') {
    const f = (await c.query(`select f.*,pb.display_name "publishedByName",
       (select count(*)::int from pulse.flow_run r where r.process_id=f.id and r.status='running') running,
       (select count(*)::int from pulse.flow_run_step s join pulse.flow_run r on r.id=s.run_id where r.process_id=f.id and r.status='running' and s.state not in ('done','skipped') and s.due_on<pulse.flow_today()) late
       from pulse.flow_process f left join pulse.person pb on pb.id=f.published_by where f.id=$1`, [id])).rows[0];
    if (!f || (!['live', 'paused'].includes(f.status) && !canDesign(v))) fail(404, 'Process not found');
    const def = f.definition as FlowDef; const status: ProcessStatus = f.status === 'draft' && !def.steps.length ? 'written' : f.status;
    base = { id: f.id, source, name: f.name, summary: f.summary, status, statusText: statusText(status, def.steps.length, f.running), stages: stageCounts(def), roles: def.roles.map((r) => r.label),
      people: [], steps: def.steps.length, running: f.running, late: f.late, template: f.template_key, updatedAt: f.updated_at, readOnly: false, terms: terms(def, await runWords(c)),
      writeup: f.writeup, definition: def, version: f.version, publishedAt: f.published_at, publishedBy: f.publishedByName,
      legacy: f.sop_id || f.workflow_id || f.board_id ? { sopId: f.sop_id, workflowId: f.workflow_id, boardId: f.board_id } : null };
  } else {
    const l = await legacyProcess(c, source, id);
    base = { id: publicId(source, id), source, name: l.name, summary: l.summary, status: l.status, statusText: statusText(l.status, l.def.steps.length, l.running), stages: stageCounts(l.def),
      roles: l.def.roles.map((r) => r.label), people: [], steps: l.def.steps.length, running: l.running, late: 0, template: null, updatedAt: l.updatedAt, readOnly: true, terms: terms(l.def),
      writeup: l.writeup, definition: l.def, version: 0, publishedAt: null, publishedBy: null,
      legacy: { sopId: source === 'sop' ? id : null, workflowId: source === 'workflow' ? id : null, boardId: source === 'board' ? id : null } };
  }
  const holders = await roleHolders(c, base.definition.roles.map((r) => r.label));
  const roleHoldersByKey = Object.fromEntries(base.definition.roles.map((r) => [r.key, (holders[r.label] ?? []).map((p) => ({ id: p.id, name: p.name, photoAt: p.photoAt }))]));
  const probs = problems(base.definition);
  if (source !== 'flow') { const l = source === 'sop' ? 0 : (await legacyProcess(c, source, id)).dropped;
    if (l) probs.push({ level: 'warning', text: `${l} “send back” or backward connection${l === 1 ? '' : 's'} of the old workflow ${l === 1 ? 'has' : 'have'} no place in a data flow and ${l === 1 ? 'is' : 'are'} left out` }); }
  return { ...base, roleHolders: roleHoldersByKey, problems: probs, canEdit: canDesign(v), canStart: canStart && base.status === 'live' && source === 'flow' };
}

// ---------------------------------------------------------------------------------------------------------------------
// Runs
type BoundPeople = Record<string, PersonRef | { name: string; demo: true } | null>;
async function boundPeople(c: PoolClient, def: FlowDef, people: Record<string, unknown>): Promise<BoundPeople> {
  const who = await persons(c, Object.values(people).filter((x): x is string => typeof x === 'string'));
  return Object.fromEntries(def.roles.map((r) => { const x = people[r.key];
    return [r.key, typeof x === 'string' ? who.get(x) ?? null : x && typeof x === 'object' && typeof (x as Row).name === 'string' ? { name: String((x as Row).name).slice(0, 80), demo: true as const } : null]; }));
}
const asRef = (x: PersonRef | { name: string; demo: true } | null | undefined): PersonRef | null => (x ? ('id' in x ? x : { id: '', name: x.name }) : null);
/** FLOW-D: a step's primitive and kind in words ("Collect", "Photos on the spot"). */
export const blockWords = (d: FlowStep | undefined) => { const k = d?.block ? kindOf(d) : null; return { block: d?.block ?? null, kind: k?.label ?? null }; };

export async function runSummaries(c: PoolClient, where: string, params: unknown[], limit = 200): Promise<RunSummary[]> {
  const runs = (await c.query(`select r.id,r.process_id "processId",p.name process,r.name,r.status,r.mode,r.fields,r.project_id "projectId",r.client_id "clientId",r.started_at "startedAt",r.finished_at "finishedAt",r.day1::text day1,r.definition,
     (select count(*)::int from pulse.flow_alert a where a.run_id=r.id and a.resolved_at is null) alerts
   from pulse.flow_run r join pulse.flow_process p on p.id=r.process_id where ${where} order by r.status='running' desc,r.started_at desc limit ${limit}`, params)).rows;
  if (!runs.length) return [];
  const t = await today(c);
  const steps = (await c.query(`select s.run_id,s.step_key,s.title,s.state,s.due_on::text due_on,s.person_id from pulse.flow_run_step s where s.run_id=any($1) order by s.position`, [runs.map((r) => r.id)])).rows;
  const who = await persons(c, steps.map((s) => s.person_id)); const w = await runWords(c);
  return runs.map((r) => {
    const def = r.definition as FlowDef; const mine = steps.filter((s) => s.run_id === r.id);
    const st = (s: Row) => s.state as StepState;
    const late = mine.filter((s) => !['done', 'skipped'].includes(s.state) && s.due_on && s.due_on < t);
    const next = mine.filter((s) => OPEN_STATES.includes(st(s))).sort((a, b) => (a.due_on ?? '9999') < (b.due_on ?? '9999') ? -1 : 1)[0];
    const dayN = (k: string) => { const d = def.steps.find((x) => x.id === k); return d ? dayNOf(d, r.fields) : null; };
    const fieldsText = def.fields.filter((f) => r.fields[f.key] !== undefined && r.fields[f.key] !== null && r.fields[f.key] !== '').map((f) => { const x = r.fields[f.key];
      return { key: f.key, label: f.label, text: f.type === 'choice' ? f.options?.find((o) => o.value === x)?.label ?? String(x) : f.type === 'boolean' ? (x ? 'Yes' : 'No') : String(x) }; });
    return { id: r.id, processId: r.processId, process: r.process, name: r.name, status: r.status, mode: r.mode, projectId: r.projectId, clientId: r.clientId, fields: r.fields, fieldsText, startedAt: r.startedAt, finishedAt: r.finishedAt, day1: r.day1,
      day: r.day1 ? Math.floor((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${r.day1}T00:00:00Z`)) / 86400000) + 1 : null,
      counts: { open: mine.filter((s) => OPEN_STATES.includes(st(s))).length, waiting: mine.filter((s) => s.state === 'waiting').length, late: late.length,
        done: mine.filter((s) => s.state === 'done').length, skipped: mine.filter((s) => s.state === 'skipped').length, total: mine.length },
      next: next ? { key: next.step_key, title: next.title, due: dueOf(next.due_on, t, next.state, dayN(next.step_key), !!r.day1), who: who.get(next.person_id) ?? null } : null,
      alertCount: r.alerts, terms: terms(def, w) };
  });
}

export async function runDetail(c: PoolClient, v: Viewer, rid: string): Promise<RunDetail> {
  if (!UUID.test(rid)) fail(404, 'Run not found');
  const sum = (await runSummaries(c, 'r.id=$1', [rid], 1))[0] ?? fail(404, 'Run not found');
  const r = (await c.query('select definition,compiled,people,started_by,process_id from pulse.flow_run where id=$1', [rid])).rows[0];
  const def = r.definition as FlowDef; const comp = r.compiled as Compiled;
  const t = await today(c);
  const rows = (await c.query(`select s.id,s.step_key,s.title,s.module,s.stage,s.state,s.skipped_why,s.person_id,s.assign_why,s.task_id,s.record_type,s.record_id,s.due_on::text due_on,
     s.opened_at,s.started_at,s.sent_at,s.confirmed_at,s.done_at,s.rounds,s.checks,s.blocked_at,s.blocked_note,s.note,fr.title record_title
   from pulse.flow_run_step s left join pulse.flow_record fr on fr.id=s.record_id where s.run_id=$1 order by s.position`, [rid])).rows;
  const values = (await c.query(`select step_key,port,side,kind,value,set_by,set_at from pulse.flow_value where run_id=$1 order by set_at`, [rid])).rows;
  const intake = (await c.query(`select step_key,key,label,critical,owner_role,received_on::text received_on,note from pulse.flow_intake where run_id=$1 order by step_key,position`, [rid])).rows;
  const alerts = (await c.query(`select a.id,a.rule_key,a.name,a.step_key,a.fired_at,a.detail,a.notified from pulse.flow_alert a where a.run_id=$1 and a.resolved_at is null order by a.fired_at desc`, [rid])).rows;
  const who = await persons(c, [...rows.map((s) => s.person_id), ...values.map((x) => x.set_by), ...alerts.flatMap((a) => a.notified ?? [])]);
  const people = await boundPeople(c, def, r.people);
  const peopleRefs = Object.fromEntries(Object.entries(people).map(([k, x]) => [k, asRef(x)]));
  const byKey = new Map(rows.map((s) => [s.step_key as string, { key: s.step_key, title: s.title, state: s.state as StepState, personId: s.person_id, person: who.get(s.person_id) ?? null }]));
  const steps: RunStep[] = rows.map((s) => {
    const d = def.steps.find((x) => x.id === s.step_key); const mm = MODULE.get(s.module);
    const cs = comp.steps[s.step_key];
    const filledNeeds = new Set(values.filter((x) => x.step_key === s.step_key && x.side === 'needs').map((x) => x.port as string));
    const filledMakes = new Set(values.filter((x) => x.step_key === s.step_key && x.side === 'makes').map((x) => x.port as string));
    const waiting = s.state === 'waiting' && d ? waitingFor(def, s.step_key, byKey, filledNeeds, peopleRefs, (port) => !!cs?.needs.find((n) => n.key === port)?.required) : [];
    const sec = d?.sop?.section ?? null;
    return { id: s.id, key: s.step_key, title: s.title, module: s.module, moduleName: mm?.name ?? s.module, icon: mm?.icon ?? 'square', surface: mm?.surface ?? 'task', stage: s.stage,
      state: s.state, stateText: s.state === 'skipped' ? s.skipped_why ?? 'Skipped' : stateText(s.state, waiting), waitingFor: waiting, skippedWhy: s.skipped_why,
      who: who.get(s.person_id) ?? (d?.who.by === 'role' && d.who.role ? peopleRefs[d.who.role] ?? null : null), role: d?.who.by === 'role' ? def.roles.find((x) => x.key === d.who.role)?.label ?? d.who.role ?? null : null,
      due: dueOf(s.due_on, t, s.state, d ? dayNOf(d, sum.fields) : null, !!sum.day1),
      openedAt: s.opened_at, startedAt: s.started_at, sentAt: s.sent_at, confirmedAt: s.confirmed_at, doneAt: s.done_at, rounds: s.rounds, taskId: s.task_id,
      record: s.record_id ? { type: s.record_type, id: s.record_id, title: s.record_title } : null, checklist: d?.checklist?.length ? d.checklist : mm?.defaults.checklist ?? [], checks: s.checks ?? [],
      sop: d?.sop ? { processId: d.sop.processId ?? r.process_id, section: sec, title: null } : null,
      blocked: s.blocked_at ? { since: s.blocked_at, note: s.blocked_note } : null,
      alerts: alerts.filter((a) => a.step_key === s.step_key).map((a) => ({ rule: a.rule_key, name: a.name, at: a.fired_at })),
      needs: (cs?.needs ?? mm?.needs ?? []).map((n) => ({ ...n, filled: filledNeeds.has(n.key) })), makes: (cs?.makes ?? mm?.makes ?? []).map((n) => ({ ...n, filled: filledMakes.has(n.key) })),
      href: `/runs/${rid}?step=${s.id}`, ...blockWords(d) };
  });
  const sections = (await c.query('select writeup from pulse.flow_process where id=$1', [r.process_id])).rows[0]?.writeup as WriteupSection[] | undefined;
  for (const s of steps) if (s.sop?.section && s.sop.processId === r.process_id) s.sop.title = sections?.find((x) => x.key === s.sop!.section)?.title ?? null;
  const items: IntakeItem[] = intake.map((i) => ({ step: i.step_key, key: i.key, label: i.label, critical: i.critical, owner: i.owner_role, receivedOn: i.received_on, note: i.note }));
  const missing = intake.filter((i) => i.critical && !i.received_on).length;
  const canEdit = canDesign(v) || r.started_by === v.person || Object.values(r.people ?? {}).includes(v.person);
  const notices = (await c.query(`select at,step_key,meta from pulse.flow_step_event where run_id=$1 and kind='notice' order by at desc limit 200`, [rid])).rows
    .map((e) => ({ at: e.at, step: e.step_key, to: String(e.meta?.to ?? ''), role: e.meta?.role ?? null, title: String(e.meta?.title ?? ''), sent: e.meta?.sent === true, how: String(e.meta?.how ?? 'Pulse') }));
  return { ...sum, stages: def.stages, roles: def.roles, people, steps, intake: items, wires: def.wires, notices,
    values: values.map((x) => ({ step: x.step_key, port: x.port, side: x.side, kind: x.kind, value: x.value, setBy: who.get(x.set_by)?.name ?? null, setAt: x.set_at })),
    alerts: alerts.map((a) => ({ key: a.id, rule: a.rule_key, name: a.name, step: a.step_key || null, at: a.fired_at, notified: (a.notified ?? []).map((id: string) => who.get(id)?.name ?? '').filter(Boolean) })),
    pip: pipLine(steps, sum.status, sum.day1, missing), canEdit };
}

/** May this viewer act on a run's steps? Leadership, whoever started it, the people named on it, the step's person. */
export async function canActOn(c: PoolClient, v: Viewer, runId: string, stepPerson?: string | null) {
  if (canDesign(v)) return true;
  const r = (await c.query('select started_by,people,project_id from pulse.flow_run where id=$1', [runId])).rows[0];
  if (!r || !v.person) return false;
  if (r.started_by === v.person || stepPerson === v.person || Object.values(r.people ?? {}).includes(v.person)) return true;
  // FLOW-E: roles as data: whoever has a step on the run, or holds one of its roles (and nobody else is named for it).
  if ((await c.query(`select 1 from pulse.flow_run fr where fr.id=$1 and (exists(select 1 from pulse.flow_run_step s where s.run_id=fr.id and s.person_id=$2)
    or exists(select 1 from pulse.work_role_holder h join pulse.work_role w on w.id=h.role_id cross join jsonb_array_elements(fr.definition->'roles') x
      where h.person_id=$2 and w.archived_at is null and (lower(w.name)=lower(x->>'label') or w.key=x->>'key') and coalesce(fr.people->>(x->>'key'),'')=''))`, [runId, v.person])).rowCount) return true;
  return r.project_id ? (await c.query('select pulse.work_project_can_manage($1) ok', [r.project_id])).rows[0].ok as boolean : false;
}

// ---------------------------------------------------------------------------------------------------------------------
// My steps: open for me in every run; coming up (my role, still waiting for data); asked of me (a need I type in).
export async function mySteps(c: PoolClient, v: Viewer): Promise<{ steps: MyStep[]; upcoming: MyStep[]; asked: MyStep[] }> {
  if (!v.person) return { steps: [], upcoming: [], asked: [] };
  const rows = (await c.query(`select s.id,s.run_id,s.step_key,s.title,s.module,s.state,s.due_on::text due_on,s.checks,s.person_id,r.name run,p.name process,r.definition,r.compiled,r.fields,r.people,r.mode,r.day1::text day1
   from pulse.flow_run_step s join pulse.flow_run r on r.id=s.run_id join pulse.flow_process p on p.id=r.process_id
   where r.status='running' and s.state not in ('done','skipped') and (s.person_id=$1 or (s.state='waiting' and exists(select 1 from jsonb_each_text(r.people) x where x.value=$1::text))
     or (s.state='waiting' and exists(select 1 from pulse.work_role_holder h join pulse.work_role w on w.id=h.role_id cross join jsonb_array_elements(r.definition->'roles') x
       where h.person_id=$1 and w.archived_at is null and (lower(w.name)=lower(x->>'label') or w.key=x->>'key'))))
   order by s.due_on nulls last,s.position limit 400`, [v.person])).rows;
  const t = await today(c);
  const mk = (s: Row): MyStep => { const def = s.definition as FlowDef; const d = def.steps.find((x) => x.id === s.step_key); const mm = MODULE.get(s.module);
    return { id: s.id, runId: s.run_id, run: s.run, process: s.process, key: s.step_key, title: s.title, module: s.module, icon: mm?.icon ?? 'square', surface: mm?.surface ?? 'task',
      state: s.state, stateText: STEP_STATE_LABELS[s.state as StepState], due: dueOf(s.due_on, t, s.state, d ? dayNOf(d, s.fields) : null, !!s.day1),
      checklist: d?.checklist?.length ? d.checklist : mm?.defaults.checklist ?? [], checks: s.checks ?? [], sop: d?.sop ? { processId: d.sop.processId ?? null, section: d.sop.section ?? null } : null,
      waitingFor: [], href: `/runs/${s.run_id}?step=${s.id}`, demo: s.mode !== 'live', ...blockWords(d),
      role: d?.who.by === 'role' && d.who.role ? def.roles.find((r) => r.key === d.who.role)?.label ?? d.who.role : null }; };
  const steps: MyStep[] = []; const upcoming: MyStep[] = []; const asked: MyStep[] = [];
  // FLOW-E: the roles I hold (Settings → Industry & roles): a waiting step of one of them is coming my way unless the run
  // names someone else for it.
  const held = (await c.query('select lower(w.name) n,w.key from pulse.work_role_holder h join pulse.work_role w on w.id=h.role_id where h.person_id=$1 and w.archived_at is null', [v.person])).rows as { n: string; key: string }[];
  for (const s of rows) {
    const def = s.definition as FlowDef; const d = def.steps.find((x) => x.id === s.step_key);
    if (s.person_id === v.person && s.state !== 'waiting') { steps.push(mk(s)); continue; }
    if (s.state !== 'waiting' || !d) continue;
    const mineRoles = [...Object.entries(s.people ?? {}).filter(([, x]) => x === v.person).map(([k]) => k),
      ...def.roles.filter((r) => !(s.people ?? {})[r.key] && held.some((h) => h.n === r.label.toLowerCase() || h.key === r.key)).map((r) => r.key)];
    if (d.who.by === 'role' && d.who.role && mineRoles.includes(d.who.role)) upcoming.push(mk(s));
    if ((d.inputs ?? []).some((i) => i.owner.by === 'role' && i.owner.role && mineRoles.includes(i.owner.role) || i.owner.by === 'person' && i.owner.personId === v.person)) asked.push(mk(s));
  }
  return { steps, upcoming: upcoming.slice(0, 60), asked: asked.slice(0, 60) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Records
export function recordOut(r: Row): FlowRecord {
  const t = RECORD_TYPE.get(r.type_key);
  return { id: r.id, type: r.type_key, title: r.title, status: r.status, statusLabel: t?.statuses.find((s) => s.key === r.status)?.label ?? r.status, code: r.code,
    runId: r.run_id, stepKey: r.step_key, projectId: r.project_id, clientId: r.client_id, data: r.data ?? {}, source: r.source ?? null, version: r.version,
    frozenAt: r.frozen_at, createdAt: r.created_at, createdBy: r.created_by_name ?? null, updatedAt: r.updated_at };
}
export const RECORD_SELECT = `select fr.*,cb.display_name created_by_name from pulse.flow_record fr left join pulse.person cb on cb.id=fr.created_by`;

/** One step, with what its screen needs: the run, the module, the record, the SOP part, the values that reached it. */
export async function stepDetail(c: PoolClient, v: Viewer, sid: string) {
  if (!UUID.test(sid)) fail(404, 'Step not found');
  const s = (await c.query('select run_id from pulse.flow_run_step where id=$1', [sid])).rows[0] ?? fail(404, 'Step not found');
  const run = await runDetail(c, v, s.run_id);
  const step = run.steps.find((x) => x.id === sid)!;
  const def = (await c.query('select definition,process_id from pulse.flow_run where id=$1', [s.run_id])).rows[0];
  const d = (def.definition as FlowDef).steps.find((x) => x.id === step.key);
  const mm = MODULE.get(step.module);
  const record = step.record ? (await c.query(`${RECORD_SELECT} where fr.id=$1`, [step.record.id])).rows.map(recordOut)[0] ?? null : null;
  const records = (await c.query(`${RECORD_SELECT} where fr.run_id=$1 and fr.step_key=$2 and fr.archived_at is null order by fr.created_at`, [s.run_id, step.key])).rows.map(recordOut);
  let sop: { processId: string; section: string | null; title: string | null; body: string } | null = null;
  if (d?.sop) {
    const pid = d.sop.processId ?? def.process_id;
    const w = (await c.query('select writeup from pulse.flow_process where id=$1', [pid])).rows[0]?.writeup as WriteupSection[] | undefined;
    const sec = w?.find((x) => x.key === d.sop!.section) ?? null;
    sop = { processId: pid, section: d.sop.section ?? null, title: sec?.title ?? null, body: sec?.body ?? '' };
  }
  const canAct = await canActOn(c, v, s.run_id, step.who?.id || null);
  // FLOW-D: what earlier steps made reaches every later step ("use the brochure from step 1.2"); a message's text with
  // the run's values filled in.
  const earlier = run.values.filter((x) => x.side === 'makes' && x.step !== step.key && run.steps.find((y) => y.key === x.step)?.state === 'done')
    .map((x) => ({ ...x, title: run.steps.find((y) => y.key === x.step)?.title ?? x.step }));
  const raw = typeof d?.settings?.text === 'string' ? d.settings.text : '';
  const text = mm && ['message', 'notify'].includes(mm.key) ? (await c.query('select pulse.flow_fill($1::text,r) t from pulse.flow_run r where r.id=$2', [raw || step.title, s.run_id])).rows[0]?.t ?? raw : null;
  // A block step's ports are its own (a Decide's ways are named in the builder: "Go" / "Stop"), so every screen shows them.
  const ports = d?.block && mm ? { ...mm, needs: step.needs.map(({ filled: _f, ...p }) => p), makes: step.makes.map(({ filled: _f, ...p }) => p) } : mm;
  return { run: { ...run, steps: undefined, values: undefined }, step, module: ports ?? null, settings: d?.settings ?? {}, qualityTest: d?.qualityTest?.length ? d.qualityTest : mm?.defaults.qualityTest ?? [],
    inputs: (d?.inputs ?? []), values: run.values.filter((x) => x.step === step.key), record, records,
    intake: run.intake.filter((i) => i.step === step.key), sop, canAct, earlier, text, uses: d?.uses ?? [] };
}
