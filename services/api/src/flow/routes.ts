/** FLOW-A: the Flow API (/api/v1/flow/* in the browser; the web proxy forwards to /v1/flow/* here). The contract, with
 *  shapes and examples, is ~/ea-research/flow/CONTRACT.md and services/api/openapi/flow.yaml. Leadership and admins design
 *  processes; leadership, HR, pod heads and a project's managers start runs (as workflows, 0241); the people of a run
 *  act on its steps; every staff member reads processes that are live and every run (Kazuk: everyone sees the whole picture). */
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from '../routes.js';
import { groundedAssistant } from '../ai/flow-assist.js';
import { createRecord, draftsOf, loadCtx, openStep, orgType, outputsOf, runAction, sessionAgenda, updateRecord } from './handlers.js';
import { builderIntel, capacity, scorecard } from './intel.js';
import { compile, legacyDef, normalizeFlow, normalizeWriteup, problems } from './model.js';
import { parseSop } from '../sop-parse.js';
import { normalizeDoc } from '../sop-model.js';
import { orgRoles } from '../sops.js';
import { cleanData, normalizeRecordType, RECORD_TYPE, RECORD_TYPES } from './record-types.js';
import { MODULE, MODULES } from './registry.js';
import { PRIMITIVES, toBlocks, withData } from './blocks.js';
import { draftFromText } from './describe.js';
import { companyBlocks, saveBlock, seedBlocks, updateBlock } from './company-blocks.js';
import { canActOn, canDesign, legacyProcess, listProcesses, mySteps, parseId, persons, readProcess, RECORD_SELECT, recordOut, runDetail, runSummaries, stepDetail, today, UUID } from './store.js';
import { TEMPLATES, template } from './templates/index.js';
import { PACK, PACKS } from './packs.js';
import { ALERT_WHEN, CATEGORIES, KIND_HELP, KIND_LABELS, KINDS, PIP_ACTIONS, STEP_STATE_LABELS, type FlowDef, type RecordType } from './types.js';

type Body = Record<string, unknown>;
const body = { type: 'object' } as const;
const str = (x: unknown, max = 200) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const id = (x: unknown, what = 'record') => (UUID.test(String(x)) ? String(x) : fail(400, `Choose a valid ${what}`));
const optId = (x: unknown) => (x === undefined || x === null || x === '' ? null : id(x));
const designer = (v: Viewer) => { if (!canDesign(v)) fail(403, 'Leadership and admins design processes'); };
const staff = async (c: PoolClient) => { if (!(await c.query('select pulse.flow_staff() ok')).rows[0].ok) fail(403, 'Flow is for the team'); };

/** The fields a run starts with, kept to the process's fields (a choice is one of its options, a date a date). */
function runFields(def: FlowDef, raw: unknown) {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Body; const out: Body = {};
  for (const f of def.fields) {
    const x = b[f.key];
    if (x === undefined || x === null || x === '') { if (f.required) fail(400, `Choose the ${f.label.toLowerCase()}`); continue; }
    if (f.type === 'choice') { if (!f.options?.some((o) => o.value === x)) fail(400, `Choose a ${f.label.toLowerCase()} from the list`); out[f.key] = x; }
    else if (f.type === 'boolean') out[f.key] = x === true || x === 'true' || x === 'yes';
    else if (f.type === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x))) fail(400, `Give the ${f.label.toLowerCase()} as a date`); out[f.key] = String(x); }
    else if (f.type === 'number') { const n = Number(x); if (!Number.isFinite(n)) fail(400, `Give the ${f.label.toLowerCase()} as a number`); out[f.key] = n; }
    else if (f.type === 'person') out[f.key] = id(x, 'person');
    else out[f.key] = String(x).trim().slice(0, 500);
  }
  return out;
}

async function saveProcess(c: PoolClient, v: Viewer, pid: string | null, b: Body) {
  const name = str(b.name); const def = b.definition !== undefined ? normalizeFlow(b.definition) : null; const writeup = b.writeup !== undefined ? normalizeWriteup(b.writeup) : null;
  if (pid === null) {
    if (!name) fail(400, 'Name the process');
    return (await c.query(`insert into pulse.flow_process(org_id,name,summary,writeup,definition,template_key,sop_id,workflow_id,board_id,created_by,updated_by)
      values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id`, [name, str(b.summary, 2000) || null, JSON.stringify(writeup ?? []), JSON.stringify(def ?? normalizeFlow({})),
      str(b.templateKey, 60) || null, optId(b.sopId), optId(b.workflowId), optId(b.boardId), v.person])).rows[0].id as string;
  }
  const cur = (await c.query('select status from pulse.flow_process where id=$1 for update', [pid])).rows[0] ?? fail(404, 'Process not found');
  if (cur.status === 'archived') fail(409, 'Restore the process before changing it');
  await c.query(`update pulse.flow_process set name=coalesce(nullif($2,''),name),summary=case when $3::boolean then $4 else summary end,writeup=coalesce($5::jsonb,writeup),definition=coalesce($6::jsonb,definition),
    updated_by=$7,updated_at=now() where id=$1`, [pid, name, b.summary !== undefined, str(b.summary, 2000) || null, writeup ? JSON.stringify(writeup) : null, def ? JSON.stringify(def) : null, v.person]);
  await c.query(`select pulse.audit_write('update','flow_process',$1)`, [pid]);
  return pid;
}

/** Publish: no errors, compile, keep a version when the definition changed; the process is live (a paused one stays paused). */
async function publish(c: PoolClient, v: Viewer, pid: string) {
  const f = (await c.query('select definition,status,version from pulse.flow_process where id=$1 for update', [pid])).rows[0] ?? fail(404, 'Process not found');
  const def = normalizeFlow(f.definition); const probs = problems(def); const errors = probs.filter((p) => p.level === 'error');
  if (errors.length) fail(400, errors[0].text);
  // FLOW-D: runs get the data wires too (what each step uses reaches it by itself); the draft keeps only the order.
  const run = withData(def);
  // Compared as jsonb (the database keeps its own key order).
  const last = (await c.query('select version,definition=$2::jsonb same from pulse.flow_process_version where process_id=$1 order by version desc limit 1', [pid, JSON.stringify(run)])).rows[0];
  let version = last?.version ?? 0;
  if (!last || !last.same) {
    version += 1;
    await c.query(`insert into pulse.flow_process_version(org_id,process_id,version,definition,compiled,published_by) values(pulse.current_org(),$1,$2,$3,$4,$5)`, [pid, version, JSON.stringify(run), JSON.stringify(compile(run)), v.person]);
  }
  await c.query(`update pulse.flow_process set definition=$2,version=$3,status=case when status='paused' then 'paused' else 'live' end,published_by=$4,published_at=now(),updated_at=now() where id=$1`, [pid, JSON.stringify(def), version, v.person]);
  await c.query(`select pulse.audit_write('publish','flow_process',$1)`, [pid]);
  return { version, problems: probs };
}

/** Start a run on the live version (or, for a demo by leadership, on the definition as it is now). */
export async function startRun(c: PoolClient, v: Viewer, pid: string, b: Body) {
  const f = (await c.query('select id,name,status,version,definition from pulse.flow_process where id=$1', [pid])).rows[0] ?? fail(404, 'Process not found');
  const mode = b.mode === 'demo' ? 'demo' : b.mode === 'try' ? 'try' : 'live';
  if (mode !== 'live') designer(v);
  const projectId = optId(b.projectId), clientId = optId(b.clientId);
  if (mode === 'live' && !canDesign(v) && !(await c.query('select pulse.workflow_can_start($1) ok', [projectId])).rows[0].ok) fail(403, 'Leadership, HR, pod heads and the project\'s owner start runs');
  let def: FlowDef; let version: number; let compiled: unknown;
  const ver = (await c.query('select version,definition,compiled from pulse.flow_process_version where process_id=$1 and version=$2', [pid, f.version])).rows[0];
  // FLOW-D: Try it runs the draft as it is now (that is what is being tried), even when an older version is live.
  if (f.status === 'live' && ver && mode !== 'try') { def = ver.definition; version = ver.version; compiled = ver.compiled; }
  else if (mode !== 'live') { def = withData(normalizeFlow(f.definition)); const errs = problems(def).filter((p) => p.level === 'error'); if (errs.length) fail(400, errs[0].text); version = f.version; compiled = compile(def); }
  else return fail(400, f.status === 'paused' ? 'This process is paused' : 'Publish the process before starting a run');
  const fields = runFields(def, b.fields);
  const people: Body = {};
  const raw = (b.people && typeof b.people === 'object' ? b.people : {}) as Body;
  for (const r of def.roles) {
    const x = raw[r.key]; if (x === undefined || x === null || x === '') continue;
    if (mode !== 'live' && typeof x === 'object' && typeof (x as Body).name === 'string') { people[r.key] = { name: str((x as Body).name, 80), demo: true }; continue; }
    const pidx = id(x, 'person');
    if (!(await c.query(`select 1 from pulse.person where id=$1 and side='staff' and status='active'`, [pidx])).rowCount) fail(400, `Choose someone in the team for ${r.label}`);
    people[r.key] = pidx;
  }
  const name = str(b.name, 300) || (projectId ? (await c.query('select coalesce(title,name) n from pulse.project where id=$1', [projectId])).rows[0]?.n : null)
    || (clientId ? (await c.query('select display_name n from pulse.client where id=$1', [clientId])).rows[0]?.n : null) || `${f.name} · ${await today(c)}`;
  const values = (Array.isArray(b.values) ? b.values : []).slice(0, 40).map((x) => x as Body).filter((x) => def.steps.some((s) => s.id === x.step)).map((x) => ({ step: String(x.step), port: str(x.port, 40), kind: 'any', value: x.value ?? {} }));
  const rid = (await c.query('select pulse.flow_start($1) id', [JSON.stringify({ processId: pid, version, definition: def, compiled, name, projectId, clientId, fields, people, mode, startedBy: v.person, values })])).rows[0].id as string;
  return rid;
}

async function recordInput(c: PoolClient, typeKey: string): Promise<RecordType> {
  return RECORD_TYPE.get(typeKey) ?? (await orgType(c, typeKey)) ?? fail(400, 'Choose a record type');
}

export function registerFlowRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // ------------------------------------------------------------------ modules, kinds, record types, templates
  app.get('/v1/flow/modules', (req) => tx(req, async (c) => {
    await staff(c);
    const own = (await c.query('select key,def from pulse.flow_record_type where archived_at is null order by key')).rows.map((r) => ({ ...r.def, key: r.key, builtin: false }));
    return { modules: MODULES, primitives: PRIMITIVES, blocks: await companyBlocks(c), kinds: KINDS.map((k) => ({ key: k, label: KIND_LABELS[k], help: KIND_HELP[k] })), categories: CATEGORIES, recordTypes: [...RECORD_TYPES, ...own],
      stepStates: Object.entries(STEP_STATE_LABELS).map(([key, label]) => ({ key, label })), alertKinds: ALERT_WHEN, pipActions: PIP_ACTIONS };
  }));
  app.get('/v1/flow/record-types', (req) => tx(req, async (c) => { await staff(c);
    const own = (await c.query('select key,def from pulse.flow_record_type where archived_at is null order by key')).rows.map((r) => ({ ...r.def, key: r.key, builtin: false }));
    return { recordTypes: [...RECORD_TYPES, ...own] }; }));
  app.post<{ Body: Body }>('/v1/flow/record-types', { schema: { body } }, (req) => tx(req, async (c, v) => {
    designer(v); const n = normalizeRecordType(req.body); if ('error' in n) return fail(400, n.error);
    await c.query(`insert into pulse.flow_record_type(org_id,key,def,created_by) values(pulse.current_org(),$1,$2,$3) on conflict(org_id,key) do update set def=excluded.def,updated_at=now(),archived_at=null`,
      [n.type.key, JSON.stringify(n.type), v.person]);
    return { recordType: n.type };
  }));
  // FLOW-E: each template says which industry pack brings it; the company's own pack's come first ("Your industry").
  app.get('/v1/flow/templates', (req) => tx(req, async (c) => { await staff(c);
    const own = PACK.get((await c.query('select pack_key from pulse.org_pack where org_id=pulse.current_org()')).rows[0]?.pack_key ?? '');
    const list = TEMPLATES.map((t) => { const p = PACKS.find((x) => x.key !== 'neutral' && x.templates.includes(t.key));
      return { key: t.key, name: t.name, summary: t.summary, steps: t.definition.steps.length, terms: t.definition.terms ?? null, pack: p ? { key: p.key, name: p.name, icon: p.icon } : null, ours: !!own?.templates.includes(t.key) }; });
    return { templates: [...list.filter((t) => t.ours), ...list.filter((t) => !t.ours)] }; }));
  // ------------------------------------------------------------------ FLOW-D: the primitives and the company's own blocks
  app.get('/v1/flow/blocks', (req) => tx(req, async (c) => { await staff(c); return { primitives: PRIMITIVES, blocks: await companyBlocks(c) }; }));
  app.post<{ Body: Body }>('/v1/flow/blocks', { schema: { body } }, (req) => tx(req, async (c, v) => {
    designer(v); return { block: await saveBlock(c, v, { name: req.body.name, summary: req.body.summary, step: req.body.step, key: str(req.body.key, 60) || undefined }) };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/blocks/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    designer(v); const r = await updateBlock(c, v, id(req.params.id, 'block'), req.body); return 'archived' in r ? { ok: true } : { block: r };
  }));

  // ------------------------------------------------------------------ processes
  app.get<{ Querystring: { status?: string } }>('/v1/flow/processes', (req) => tx(req, async (c, v) => {
    await staff(c);
    return { processes: await listProcesses(c, v, req.query), canEdit: canDesign(v), canStart: (await c.query('select pulse.workflow_can_start(null) ok')).rows[0].ok as boolean,
      templates: TEMPLATES.map((t) => ({ key: t.key, name: t.name, summary: t.summary, steps: t.definition.steps.length })) };
  }));
  app.post<{ Body: Body }>('/v1/flow/processes', { schema: { body } }, (req) => tx(req, async (c, v) => {
    designer(v); const b = req.body;
    if (b.template) { const t = template(str(b.template, 60)) ?? fail(400, 'Choose a template');
      // FLOW-D: the template's own blocks join the company's (the ones it does not have yet).
      if (t.blocks?.length) await seedBlocks(c, v, t.blocks, `template:${t.key}`);
      return { id: await saveProcess(c, v, null, { name: str(b.name) || t.name, summary: str(b.summary, 2000) || t.summary, definition: t.definition, writeup: b.writeup ?? t.writeup ?? [], templateKey: b.keepTemplateKey ? t.key : null }) }; }
    if (b.from && typeof b.from === 'string') { const { source, id: lid } = parseId(b.from); if (source === 'flow') fail(400, 'Choose an SOP, workflow or board');
      const l = await legacyProcess(c, source, lid);
      return { id: await saveProcess(c, v, null, { name: str(b.name) || l.name, summary: l.summary, definition: l.def, writeup: l.writeup, [`${source}Id`]: lid }) }; }
    return { id: await saveProcess(c, v, null, b) };
  }));
  app.get<{ Params: { id: string } }>('/v1/flow/processes/:id', (req) => tx(req, async (c, v) => { await staff(c); return readProcess(c, v, req.params.id); }));
  // Save. An SOP, workflow or board saved here becomes a Flow process (the old one stays as it was, linked).
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/processes/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    designer(v); const { source, id: pid } = parseId(req.params.id);
    if (source !== 'flow') { const l = await legacyProcess(c, source, pid);
      const nid = await saveProcess(c, v, null, { name: str(req.body.name) || l.name, summary: req.body.summary ?? l.summary, definition: req.body.definition ?? l.def, writeup: req.body.writeup ?? l.writeup, [`${source}Id`]: pid });
      return readProcess(c, v, nid); }
    await saveProcess(c, v, pid, req.body); return readProcess(c, v, pid);
  }));
  app.post<{ Params: { id: string } }>('/v1/flow/processes/:id/publish', (req) => tx(req, async (c, v) => {
    designer(v); const { source, id: pid } = parseId(req.params.id); if (source !== 'flow') fail(400, 'Save it as a process first');
    return publish(c, v, pid);
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/processes/:id/status', { schema: { body } }, (req) => tx(req, async (c, v) => {
    designer(v); const { source, id: pid } = parseId(req.params.id); if (source !== 'flow') fail(400, 'Save it as a process first');
    const status = str(req.body.status, 10); if (!['live', 'paused', 'draft', 'archived'].includes(status)) fail(400, 'Choose live, paused, draft or archived');
    if (status === 'live') { const cur = (await c.query('select status from pulse.flow_process where id=$1', [pid])).rows[0];
      if (cur?.status !== 'paused') return { status, ...(await publish(c, v, pid)) }; }
    await c.query('update pulse.flow_process set status=$2,updated_by=$3,updated_at=now() where id=$1', [pid, status, v.person]);
    await c.query(`select pulse.audit_write($2,'flow_process',$1)`, [pid, status]);
    return { status };
  }));
  // The builder's live check: problems in words, converters for wires that do not fit, people by load, suggestions.
  app.post<{ Body: Body }>('/v1/flow/check', { schema: { body } }, (req) => tx(req, async (c, v) => {
    designer(v); const def = normalizeFlow(req.body.definition);
    return { definition: def, compiled: compile(def), ...(await builderIntel(c, def, str(req.body.stepId, 40) || null)) };
  }));

  // Start from a write-up: Pip reads an SOP (its steps, or the write-up's text through the SOP parser) and proposes steps
  // and wires; the builder shows them and the person keeps what is right (nothing is saved here).
  app.post<{ Body: Body }>('/v1/flow/propose', { schema: { body } }, (req) => tx(req, async (c, v) => {
    designer(v); const b = req.body; let steps: Parameters<typeof legacyDef>[0] = []; let phases: string[] = []; let source = '';
    if (typeof b.from === 'string' && b.from.startsWith('sop:')) {
      const s0 = (await c.query('select title,doc from pulse.sop where id=$1', [parseId(b.from).id])).rows[0] ?? fail(404, 'SOP not found');
      const n = normalizeDoc(s0.doc); if ('error' in n) fail(400, n.error);
      ({ steps, phases } = (n as { doc: { steps: typeof steps; phases: string[] } }).doc); source = `The steps of the SOP “${s0.title}”`;
    } else {
      let title = str(b.title) || 'Write-up'; let text = typeof b.text === 'string' ? b.text.slice(0, 200000) : '';
      if (!text && b.processId) { const f = (await c.query('select name,writeup from pulse.flow_process where id=$1', [id(b.processId, 'process')])).rows[0] ?? fail(404, 'Process not found');
        title = f.name; text = (f.writeup as { title: string; body: string }[]).map((x) => `${x.title}\n${x.body}`).join('\n\n').slice(0, 200000); }
      if (!text.trim()) fail(400, 'Give the write-up to read');
      const parts = parseSop({ title, text, knownRoles: (await orgRoles(c)).map((r) => r.role) });
      const best = parts.sort((a, z) => z.doc.steps.length - a.doc.steps.length)[0];
      if (!best?.doc.steps.length) fail(400, 'Pip found no steps in that write-up: add them on the canvas');
      ({ steps, phases } = best.doc as { steps: typeof steps; phases: string[] }); source = `Steps read from “${best.title}” (${Math.round(best.confidence * 100)}% sure)`;
    }
    const { def: old, dropped } = legacyDef(steps, phases);
    const def = normalizeFlow(toBlocks(old));   // FLOW-D: proposed as primitives
    return { definition: def, problems: problems(def), source, dropped, steps: def.steps.length };
  }));
  // FLOW-D "Describe it": how the work goes in someone's own words → Pip's draft of the steps (primitives), who does
  // each and when it is due. Nothing is saved here; the person edits the draft. An SOP goes through propose.
  app.post<{ Body: Body }>('/v1/flow/describe', { schema: { body } }, (req) => tx(req, async (c, v) => {
    designer(v); const text = typeof req.body.text === 'string' ? req.body.text.slice(0, 100000) : '';
    if (text.trim().length < 8) fail(400, 'Write how the work goes: who does what, one step after another');
    const known = (await orgRoles(c)).map((r) => r.role);
    const d = draftFromText(text, str(req.body.title) || 'what you wrote', known);
    const def = normalizeFlow(d.definition);
    return { definition: def, problems: problems(def), notes: d.notes, steps: d.steps };
  }));

  // ------------------------------------------------------------------ runs
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/processes/:id/runs', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const { source, id: pid } = parseId(req.params.id); if (source !== 'flow') fail(400, 'Save it as a process and publish it first');
    return { id: await startRun(c, v, pid, req.body) };
  }));
  app.get<{ Querystring: { processId?: string; status?: string; mine?: string; mode?: string } }>('/v1/flow/runs', (req) => tx(req, async (c, v) => {
    await staff(c); const q = req.query; const where = ['true']; const params: unknown[] = [];
    if (q.processId) { params.push(id(q.processId, 'process')); where.push(`r.process_id=$${params.length}`); }
    if (q.status === 'running' || q.status === 'done' || q.status === 'cancelled') { params.push(q.status); where.push(`r.status=$${params.length}`); }
    if (q.mode === 'live' || q.mode === 'demo' || q.mode === 'try') { params.push(q.mode); where.push(`r.mode=$${params.length}`); } else where.push(`r.mode<>'try'`);
    if (q.mine === '1' && v.person) { params.push(v.person); where.push(`(r.started_by=$${params.length} or exists(select 1 from jsonb_each_text(r.people) x where x.value=$${params.length}::text) or exists(select 1 from pulse.flow_run_step s where s.run_id=r.id and s.person_id=$${params.length}))`); }
    const runs = await runSummaries(c, where.join(' and '), params, 300);
    const running = runs.filter((r) => r.status === 'running');
    return { runs, counts: { running: running.length, late: running.reduce((n, r) => n + r.counts.late, 0), alerts: running.reduce((n, r) => n + r.alertCount, 0), done: runs.filter((r) => r.status === 'done').length } };
  }));
  app.get<{ Params: { id: string } }>('/v1/flow/runs/:id', (req) => tx(req, async (c, v) => { await staff(c); return runDetail(c, v, req.params.id); }));
  // FLOW-D: Try it moves in time (its due dates go late, its alerts fire on the tick run here), and is thrown away.
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/runs/:id/later', { schema: { body } }, (req) => tx(req, async (c, v) => {
    designer(v); const rid = id(req.params.id, 'run'); const days = Math.round(Number(req.body.days) || 1);
    await c.query('select pulse.flow_try_later($1,$2)', [rid, days]); await c.query('select pulse.flow_tick()');
    return runDetail(c, v, rid);
  }));
  // FLOW-D: Try it is thrown away with everything it made.
  app.post<{ Params: { id: string } }>('/v1/flow/runs/:id/discard', (req) => tx(req, async (c, v) => {
    designer(v); await c.query('select pulse.flow_try_discard($1)', [id(req.params.id, 'run')]); return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/runs/:id/cancel', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const rid = id(req.params.id, 'run'); if (!(await canActOn(c, v, rid))) fail(403, 'Whoever started the run, its people or leadership stop it');
    await c.query('select pulse.flow_run_cancel($1,$2,$3)', [rid, str(req.body.note, 500) || null, v.person]); return { ok: true };
  }));
  // Name someone for a role on a run (their open steps of that role move to them).
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/runs/:id/people', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const rid = id(req.params.id, 'run'); if (!(await canActOn(c, v, rid))) fail(403, 'The run\'s people or leadership name its people');
    const s = (await c.query(`select id from pulse.flow_run_step where run_id=$1 and state not in ('skipped') order by position limit 1`, [rid])).rows[0] ?? fail(404, 'Run not found');
    const ctx = await loadCtx(c, v, s.id); ctx.step.module = 'assign'; ctx.step.state = 'open';
    await runAction(ctx, 'name', req.body); return runDetail(c, v, rid);
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/runs/:id/fields', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const rid = id(req.params.id, 'run'); if (!(await canActOn(c, v, rid))) fail(403, 'The run\'s people or leadership change its fields');
    const r = (await c.query('select definition,fields from pulse.flow_run where id=$1', [rid])).rows[0] ?? fail(404, 'Run not found');
    const fields = runFields(r.definition as FlowDef, { ...r.fields, ...(req.body.fields as Body ?? {}) });
    await c.query('update pulse.flow_run set fields=$2 where id=$1', [rid, JSON.stringify(fields)]);
    await c.query('select pulse.flow_clock($1),pulse.flow_recompute_due($1)', [rid]);
    return runDetail(c, v, rid);
  }));

  // ------------------------------------------------------------------ steps
  app.get('/v1/flow/my-steps', (req) => tx(req, async (c, v) => { await staff(c); return mySteps(c, v); }));
  app.get<{ Params: { id: string } }>('/v1/flow/steps/:id', (req) => tx(req, async (c, v) => { await staff(c); return stepDetail(c, v, req.params.id); }));
  const act = async (c: PoolClient, v: Viewer, sid: string) => { const ctx = await loadCtx(c, v, sid);
    if (!(await canActOn(c, v, ctx.run.id, ctx.step.person_id))) fail(403, 'The step\'s person, the run\'s people or leadership act on it');
    if (ctx.run.status !== 'running') fail(409, 'This run has finished'); return ctx; };
  // Open the step's work: its record is made the first time.
  app.post<{ Params: { id: string } }>('/v1/flow/steps/:id/open', (req) => tx(req, async (c, v) => { const ctx = await act(c, v, req.params.id);
    if (ctx.step.state !== 'waiting' && ctx.step.state !== 'skipped') await openStep(ctx); return stepDetail(c, v, ctx.step.id); }));
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/steps/:id/move', { schema: { body } }, (req) => tx(req, async (c, v) => { const ctx = await act(c, v, req.params.id);
    const to = str(req.body.to, 20); if (!['open', 'in_progress', 'in_review', 'confirmed'].includes(to)) fail(400, 'Choose in progress, sent for review or confirmed');
    await c.query('select pulse.flow_step_move($1,$2,$3,$4)', [ctx.step.id, to, v.person, str(req.body.note, 500) || null]); return stepDetail(c, v, ctx.step.id); }));
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/steps/:id/finish', { schema: { body } }, (req) => tx(req, async (c, v) => { const ctx = await act(c, v, req.params.id);
    if (ctx.step.state === 'waiting') fail(409, 'This step is waiting for its data'); if (['done', 'skipped'].includes(ctx.step.state)) fail(409, 'This step is closed');
    await openStep(ctx);
    const given = (req.body.outputs && typeof req.body.outputs === 'object' ? req.body.outputs : {}) as Body;
    await c.query('select pulse.flow_step_finish($1,$2,$3)', [ctx.step.id, JSON.stringify(await outputsOf(ctx, given)), v.person]);
    return runDetail(c, v, ctx.run.id); }));
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/steps/:id/verdict', { schema: { body } }, (req) => tx(req, async (c, v) => { const ctx = await act(c, v, req.params.id);
    const answer = str(req.body.answer, 80) || fail(400, 'Choose an answer');
    await c.query('select pulse.flow_step_verdict($1,$2,$3,$4)', [ctx.step.id, answer, str(req.body.note, 500) || null, v.person]); return runDetail(c, v, ctx.run.id); }));
  // What a step needs, typed in or uploaded by whoever owns it.
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/steps/:id/input', { schema: { body } }, (req) => tx(req, async (c, v) => { const ctx = await act(c, v, req.params.id);
    const port = str(req.body.port, 40); const need = MODULE.get(ctx.step.module)?.needs.find((n) => n.key === port) ?? fail(400, 'This step does not need that');
    const value = req.body.value && typeof req.body.value === 'object' ? req.body.value : { text: str(req.body.value as string, 20000) };
    if (JSON.stringify(value).length > 200000) fail(413, 'Too large: link the file instead');
    await c.query('select pulse.flow_input_put($1,$2,$3,$4,$5,$6)', [ctx.run.id, ctx.step.step_key, port, need.kind, JSON.stringify(value), v.person]); return runDetail(c, v, ctx.run.id); }));
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/steps/:id/block', { schema: { body } }, (req) => tx(req, async (c, v) => { const ctx = await act(c, v, req.params.id);
    const on = req.body.blocked !== false;
    await c.query('update pulse.flow_run_step set blocked_at=case when $2 then coalesce(blocked_at,now()) end,blocked_note=case when $2 then $3 end,updated_at=now() where id=$1', [ctx.step.id, on, str(req.body.note, 500) || null]);
    await c.query(`select pulse.flow_event($1,$2,$3,null,null,$4,$5)`, [ctx.run.id, ctx.step.step_key, on ? 'blocked' : 'unblocked', v.person, JSON.stringify({ note: str(req.body.note, 500) || null })]);
    return runDetail(c, v, ctx.run.id); }));
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/steps/:id/check', { schema: { body } }, (req) => tx(req, async (c, v) => { const ctx = await act(c, v, req.params.id);
    const i = Number(req.body.index); if (!Number.isInteger(i) || i < 0 || i > 200) fail(400, 'Choose a checklist line');
    await c.query(`update pulse.flow_run_step set checks=case when $3 then (select array_agg(distinct x order by x) from unnest(array_append(checks,$2)) x) else array_remove(checks,$2) end,updated_at=now() where id=$1`, [ctx.step.id, i, req.body.done !== false]);
    if (ctx.step.state === 'open') await c.query('select pulse.flow_step_move($1,$2,$3,null)', [ctx.step.id, 'in_progress', v.person]);
    return { checks: (await c.query('select checks from pulse.flow_run_step where id=$1', [ctx.step.id])).rows[0].checks }; }));
  // A step marked "only when needed" is skipped when it is not needed this time.
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/steps/:id/skip', { schema: { body } }, (req) => tx(req, async (c, v) => { const ctx = await act(c, v, req.params.id);
    if (!(ctx.def.settings as Body).optional && !canDesign(v)) fail(403, 'Only a step marked “only when needed” is skipped');
    if (['done', 'skipped'].includes(ctx.step.state)) fail(409, 'This step is closed');
    await c.query(`update pulse.flow_run_step set state='skipped',skipped_why=$2,updated_at=now() where id=$1`, [ctx.step.id, str(req.body.why, 300) || 'Not needed this time']);
    if (ctx.step.task_id) await c.query(`update pulse.task set status='cancelled',updated_at=now() where id=$1 and status not in ('done','accepted','cancelled')`, [ctx.step.task_id]);
    await c.query(`select pulse.flow_event($1,$2,'state',$3,'skipped',$4,'{}'),pulse.flow_run_settle($1)`, [ctx.run.id, ctx.step.step_key, ctx.step.state, v.person]);
    return runDetail(c, v, ctx.run.id); }));
  // Nudge whoever owes a waiting step its data (inside Pulse only).
  app.post<{ Params: { id: string } }>('/v1/flow/steps/:id/nudge', (req) => tx(req, async (c, v) => { const ctx = await act(c, v, req.params.id);
    const who = (await c.query(`select pulse.flow_alert_targets(r,'["data-owner"]'::jsonb,$2) ids from pulse.flow_run r where r.id=$1`, [ctx.run.id, ctx.step.step_key])).rows[0]?.ids ?? [];
    const sent: string[] = [];
    for (const p of who as string[]) { const n = (await c.query(`select pulse.notification_emit($1,'flow.wire','flow_run',$2,$3,$4,$5,'task') id`,
      [p, ctx.run.id, `nudge:${ctx.step.id}:${Date.now()}`, `${v.name.split(' ')[0]} is waiting on you for ${ctx.step.title} · ${ctx.run.name}`.slice(0, 160), `/runs/${ctx.run.id}?step=${ctx.step.id}`])).rows[0].id;
      if (n && ctx.run.mode === 'live') sent.push(p); }
    await c.query(`select pulse.flow_event($1,$2,'nudge',null,null,$3,$4)`, [ctx.run.id, ctx.step.step_key, v.person, JSON.stringify({ to: who })]);
    const names = await persons(c, who as string[]);
    return { nudged: [...names.values()].map((p) => p.name), sent: sent.length, demo: ctx.run.mode === 'demo' }; }));
  app.post<{ Params: { id: string; action: string }; Body: Body }>('/v1/flow/steps/:id/actions/:action', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const ctx = await act(c, v, req.params.id); return runAction(ctx, str(req.params.action, 40), req.body); }));
  // Pip on a step: what it is, what it needs and from whom, its SOP part, and the module's assist.
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/steps/:id/pip', { schema: { body } }, (req) => tx(req, async (c, v) => {
    await staff(c); const d = await stepDetail(c, v, req.params.id); const mm = d.module;
    const action = str(req.body.action, 20) || 'summarise';
    if (!(PIP_ACTIONS as readonly string[]).includes(action)) fail(400, 'Choose draft, critique, summarise, extract, check or suggest');
    if (mm && mm.pip.length && !mm.pip.includes(action as never) && action !== 'suggest') fail(400, `Pip does not ${action} in ${mm.name}: ${mm.pip.join(', ')}`);
    const records = (await c.query('select type_key type,title,status,data from pulse.flow_record where run_id=$1 and archived_at is null order by updated_at desc limit 400', [(d.run as { id: string }).id])).rows;
    const rec = d.record; const recText = rec ? [rec.data.transcript, ...Object.values((rec.data.sections ?? {}) as Body).map((x) => (x as Body)?.text), ...(Array.isArray(rec.data.tabs) ? rec.data.tabs as Body[] : []).map((t) => t?.text)].filter((x) => typeof x === 'string').join('\n\n') : '';
    let text = typeof req.body.text === 'string' ? req.body.text : recText;
    if (!text && (action === 'summarise' || action === 'extract' || action === 'suggest')) {
      // The run's transcripts and documents are what there is to read.
      text = (await c.query(`select string_agg(coalesce(data->>'transcript',''),E'\n\n') t from pulse.flow_record where run_id=$1 and type_key='meeting' and archived_at is null`, [(d.run as { id: string }).id])).rows[0].t ?? '';
    }
    const result = await groundedAssistant.assist({ action: action === 'suggest' ? 'extract' : action as 'draft', step: { title: d.step.title, module: d.step.module, checklist: d.step.checklist, qualityTest: d.qualityTest },
      sop: d.sop ? { title: d.sop.title, body: d.sop.body } : null, text, drafts: action === 'check' ? await draftsOf(c, (d.run as { id: string }).id, d.step.key) : [], records, fields: (d.run as { fields: Body }).fields, today: await today(c) });
    return { about: { step: d.step.title, what: mm?.summary ?? null, state: d.step.stateText, who: d.step.who, due: d.step.due, needs: d.step.needs, waitingFor: d.step.waitingFor,
        sop: d.sop ? { title: d.sop.title, excerpt: d.sop.body.slice(0, 1500) } : null, checklist: d.step.checklist },
      action, result, assistant: { name: groundedAssistant.name, version: groundedAssistant.version, model: groundedAssistant.model,
        note: 'Pulse has no language model connected: Pip works from the SOP text and this run\'s records, and you decide.' } };
  }));
  // The Flow step a Work task belongs to (the task page links to it).
  app.get<{ Params: { id: string } }>('/v1/flow/task/:id', (req) => tx(req, async (c) => {
    const s = (await c.query(`select s.id,s.run_id "runId",s.step_key key,s.title,s.state,r.name run,p.name process from pulse.flow_run_step s join pulse.flow_run r on r.id=s.run_id join pulse.flow_process p on p.id=r.process_id where s.task_id=$1`, [id(req.params.id, 'task')])).rows[0];
    return { step: s ? { ...s, stateText: STEP_STATE_LABELS[s.state as keyof typeof STEP_STATE_LABELS], href: `/runs/${s.runId}?step=${s.id}` } : null };
  }));

  // ------------------------------------------------------------------ records + links
  app.get<{ Querystring: { type?: string; runId?: string; q?: string; status?: string; library?: string } }>('/v1/flow/records', (req) => tx(req, async (c) => {
    await staff(c); const q = req.query; const where = ['fr.archived_at is null']; const params: unknown[] = [];
    if (q.type) { params.push(str(q.type, 40)); where.push(`fr.type_key=$${params.length}`); }
    if (q.runId) { params.push(id(q.runId, 'run')); where.push(`fr.run_id=$${params.length}`); }
    if (q.library === '1') where.push('fr.run_id is null');
    if (q.status) { params.push(str(q.status, 40)); where.push(`fr.status=$${params.length}`); }
    if (q.q) { params.push(`%${str(q.q, 80).replace(/[%_]/g, '')}%`); where.push(`(fr.title ilike $${params.length} or fr.code ilike $${params.length})`); }
    return { records: (await c.query(`${RECORD_SELECT} where ${where.join(' and ')} order by fr.updated_at desc limit 500`, params)).rows.map(recordOut) };
  }));
  app.get<{ Params: { id: string } }>('/v1/flow/records/:id', (req) => tx(req, async (c) => {
    await staff(c); const rid = id(req.params.id);
    const rec = (await c.query(`${RECORD_SELECT} where fr.id=$1`, [rid])).rows.map(recordOut)[0] ?? fail(404, 'Record not found');
    const links = (await c.query(`select l.id,l.kind,case when l.from_id=$1 then 'out' else 'in' end direction,o.id "recordId",o.type_key type,o.title from pulse.flow_link l
       join pulse.flow_record o on o.id=case when l.from_id=$1 then l.to_id else l.from_id end where (l.from_id=$1 or l.to_id=$1) and o.archived_at is null order by l.created_at`, [rid])).rows;
    const versions = (await c.query(`select v.version,v.title,v.status,v.note,v.saved_at "savedAt",p.display_name "savedBy" from pulse.flow_record_version v left join pulse.person p on p.id=v.saved_by where v.record_id=$1 order by v.version desc limit 50`, [rid])).rows;
    const comments = (await c.query(`select cm.id,cm.section,cm.anchor,cm.kind,cm.body,cm.owner_id "ownerId",o.display_name owner,cm.due_on::text "dueOn",cm.done_at "doneAt",cm.created_at "at",p.display_name "by",cm.resolved_at "resolvedAt"
       from pulse.flow_comment cm left join pulse.person p on p.id=cm.created_by left join pulse.person o on o.id=cm.owner_id where cm.record_id=$1 order by cm.created_at`, [rid])).rows;
    return { record: { ...rec, links }, type: RECORD_TYPE.get(rec.type) ?? (await orgType(c, rec.type)) ?? null, versions, comments };
  }));
  // FLOW-C: one earlier version of a record, as it was (a document's section text to read or put back).
  app.get<{ Params: { id: string; version: string } }>('/v1/flow/records/:id/versions/:version', (req) => tx(req, async (c) => {
    await staff(c); const rid = id(req.params.id); const n = Number(req.params.version);
    if (!Number.isInteger(n) || n < 1) fail(404, 'Version not found');
    const r = (await c.query(`select v.version,v.title,v.status,v.data,v.note,v.saved_at "savedAt",p.display_name "savedBy" from pulse.flow_record_version v left join pulse.person p on p.id=v.saved_by where v.record_id=$1 and v.version=$2`, [rid, n])).rows[0];
    return r ?? fail(404, 'Version not found');
  }));
  app.post<{ Body: Body }>('/v1/flow/records', { schema: { body } }, (req) => tx(req, async (c, v) => {
    await staff(c); const b = req.body; const t = await recordInput(c, str(b.type, 40));
    const runId = optId(b.runId); let projectId: string | null = null, clientId: string | null = null;
    if (runId) { if (!(await canActOn(c, v, runId))) fail(403, 'The run\'s people or leadership add its records');
      const r = (await c.query('select project_id,client_id,status from pulse.flow_run where id=$1', [runId])).rows[0] ?? fail(404, 'Run not found'); projectId = r.project_id; clientId = r.client_id; }
    else if (!canDesign(v) && !['library_item', 'request', 'daily_update'].includes(t.key)) fail(403, 'Leadership keeps the libraries');
    const { data, missing } = cleanData(t, b.data); if (missing.length) fail(400, `Fill in: ${missing.join(', ')}`);
    const title = str(b.title, 300) || String(data[t.titleField] ?? '').slice(0, 300) || t.name;
    const rid = await createRecord(c, v, { type: t.key, runId, stepKey: str(b.stepKey, 40) || null, projectId, clientId, title, data, status: str(b.status, 40) || undefined,
      code: str(b.code, 120) || null, source: b.source && typeof b.source === 'object' ? b.source : undefined });
    return { record: (await c.query(`${RECORD_SELECT} where fr.id=$1`, [rid])).rows.map(recordOut)[0] };
  }));
  const recordFor = async (c: PoolClient, v: Viewer, rid: string) => {
    const r = (await c.query('select id,type_key,run_id,status,frozen_at from pulse.flow_record where id=$1 and archived_at is null', [rid])).rows[0] ?? fail(404, 'Record not found');
    if (r.run_id ? !(await canActOn(c, v, r.run_id)) : !canDesign(v) && !['request', 'daily_update'].includes(r.type_key)) fail(403, 'The run\'s people or leadership change its records');
    return r;
  };
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/records/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const rid = id(req.params.id); const r = await recordFor(c, v, rid); const t = await recordInput(c, r.type_key);
    const { data } = cleanData(t, { ...((await c.query('select data from pulse.flow_record where id=$1', [rid])).rows[0].data), ...(req.body.data as Body ?? {}) });
    return { record: await updateRecord(c, v, rid, { data, title: str(req.body.title, 300) || undefined, note: str(req.body.note, 300) || null }) };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/records/:id/status', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const rid = id(req.params.id); const r = await recordFor(c, v, rid); const t = await recordInput(c, r.type_key);
    const to = str(req.body.status, 40); const cur = t.statuses.find((s) => s.key === r.status);
    if (!t.statuses.some((s) => s.key === to)) fail(400, 'Choose a status of this record type');
    if (cur && !cur.next.includes(to) && !canDesign(v)) fail(400, `${cur.label} goes to ${cur.next.map((n) => t.statuses.find((s) => s.key === n)?.label).join(' or ') || 'nothing else'}`);
    return { record: await updateRecord(c, v, rid, { status: to, note: str(req.body.note, 300) || null }) };
  }));
  app.post<{ Params: { id: string } }>('/v1/flow/records/:id/freeze', (req) => tx(req, async (c, v) => {
    const rid = id(req.params.id); await recordFor(c, v, rid);
    await c.query('update pulse.flow_record set frozen_at=coalesce(frozen_at,now()),frozen_by=coalesce(frozen_by,$2),updated_at=now() where id=$1', [rid, v.person]);
    return { record: (await c.query(`${RECORD_SELECT} where fr.id=$1`, [rid])).rows.map(recordOut)[0] };
  }));
  app.post<{ Params: { id: string } }>('/v1/flow/records/:id/archive', (req) => tx(req, async (c, v) => {
    const rid = id(req.params.id); await recordFor(c, v, rid);
    await c.query('update pulse.flow_record set archived_at=now(),updated_by=$2,updated_at=now() where id=$1', [rid, v.person]); return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/records/:id/links', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const rid = id(req.params.id); await recordFor(c, v, rid); const to = id(req.body.toId);
    const kind = str(req.body.kind, 40).toLowerCase().replace(/[^a-z0-9_]/g, '') || 'related'; if (to === rid) fail(400, 'A record does not link to itself');
    if (!(await c.query('select 1 from pulse.flow_record where id=$1 and archived_at is null', [to])).rowCount) fail(404, 'Record not found');
    if (req.body.remove === true) await c.query('delete from pulse.flow_link where from_id=$1 and to_id=$2 and kind=$3', [rid, to, kind]);
    else await c.query(`insert into pulse.flow_link(org_id,from_id,to_id,kind,created_by) values(pulse.current_org(),$1,$2,$3,$4) on conflict do nothing`, [rid, to, /^[a-z]/.test(kind) ? kind : `k${kind}`, v.person]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/records/:id/comments', { schema: { body } }, (req) => tx(req, async (c, v) => {
    const rid = id(req.params.id); await staff(c);
    if (!(await c.query('select 1 from pulse.flow_record where id=$1 and archived_at is null', [rid])).rowCount) fail(404, 'Record not found');
    const text = str(req.body.body, 4000) || fail(400, 'Write the comment');
    const due = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.dueOn)) ? String(req.body.dueOn) : null;
    const cid = (await c.query(`insert into pulse.flow_comment(org_id,record_id,section,anchor,kind,body,owner_id,due_on,created_by) values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [rid, str(req.body.section, 60) || null, str(req.body.anchor, 60) || null, req.body.kind === 'change' ? 'change' : 'comment', text, optId(req.body.ownerId), due, v.person])).rows[0].id;
    return { id: cid };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/v1/flow/comments/:id/resolve', { schema: { body } }, (req) => tx(req, async (c) => {
    await staff(c); const cid = id(req.params.id);
    await c.query(`update pulse.flow_comment set resolved_at=case when $2 then now() end,done_at=case when kind='change' and $2 then now() end where id=$1`, [cid, req.body.resolved !== false]); return { ok: true };
  }));

  // ------------------------------------------------------------------ leadership views
  app.get<{ Querystring: { processId?: string; personId?: string; from?: string; to?: string } }>('/v1/flow/scorecard', (req) => tx(req, async (c, v) => {
    await staff(c); const q = req.query; const t = await today(c);
    const personId = canDesign(v) || v.role === 'manager' || v.role === 'pgs' ? optId(q.personId) : v.person;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(q.from)) ? String(q.from) : new Date(Date.parse(`${t}T00:00:00Z`) - 90 * 86400000).toISOString().slice(0, 10);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(q.to)) ? String(q.to) : t;
    return scorecard(c, { processId: optId(q.processId), personId, from, to });
  }));
  // A person's "working on today", written from their open steps (for the pod group: copied, never posted by Pulse).
  app.get('/v1/flow/daily-update', (req) => tx(req, async (c, v) => { await staff(c);
    const mine = (await c.query(`select s.title,r.name run,s.state,s.due_on::text due from pulse.flow_run_step s join pulse.flow_run r on r.id=s.run_id
      where s.person_id=$1 and r.status='running' and s.state in ('open','in_progress','in_review','confirmed') order by s.due_on nulls last limit 12`, [v.person])).rows;
    return { text: mine.length ? `Working on today:\n${mine.map((m) => `• ${m.title} (${m.run})${m.due ? ` · due ${m.due}` : ''}`).join('\n')}` : 'Nothing open for me today.', steps: mine.length };
  }));
  app.get('/v1/flow/capacity', (req) => tx(req, async (c) => { await staff(c); return capacity(c); }));
  app.get<{ Querystring: { kind?: string } }>('/v1/flow/sessions/agenda', (req) => tx(req, async (c) => { await staff(c); return { agenda: await sessionAgenda(c, str(req.query.kind, 20) || 'rough_cut') }; }));
  // Library records (no run) for the libraries screen: swipe files, Word Library templates, testimonials.
  app.post<{ Body: Body }>('/v1/flow/records/import', { schema: { body } }, (req) => tx(req, async (c, v) => {
    designer(v); const t = await recordInput(c, str(req.body.type, 40)); const rows = Array.isArray(req.body.records) ? req.body.records.slice(0, 500) : [];
    let n = 0; for (const x of rows) { const { data } = cleanData(t, x); const title = String(data[t.titleField] ?? '').slice(0, 300); if (!title) continue;
      await createRecord(c, v, { type: t.key, runId: null, stepKey: null, title, data }); n++; }
    return { created: n };
  }));
}
