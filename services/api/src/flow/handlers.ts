/** FLOW-A: the module backends. A module's step works on a record (a meeting, a document, an asset, a review ...): open
 *  makes it the first time the step is opened, actions change it (POST /api/v1/flow/steps/:id/actions/:key), outputs
 *  are the typed values its Makes ports carry when it is done. Modules that collect records (facts, personas, words,
 *  requests) use the records routes directly. Nothing here sends anything outside Pulse. */
import type { PoolClient } from 'pg';
import { fail, type Viewer } from '../routes.js';
import { groundedAssistant, type RecordLite } from '../ai/flow-assist.js';
import { MODULE } from './registry.js';
import { assetId, RECORD_TYPE } from './record-types.js';
import { RECORD_SELECT, recordOut, UUID } from './store.js';
import type { FlowDef, FlowStep, Port } from './types.js';
import { calendarEvent, canSendMail, messageLinks, postWebhook, projectFolder, sendMail } from './apps.js';
import { callAnalysis, xrayStatus } from '../sales-xray.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Body = Record<string, unknown>;
export type Ctx = { c: PoolClient; v: Viewer; step: Row; run: Row; def: FlowStep; flow: FlowDef };
const str = (x: unknown, max = 500) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const day = (x: unknown) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);
const list = (x: unknown, max = 50) => (Array.isArray(x) ? x.map((y) => str(y, 2000)).filter(Boolean).slice(0, max) : []);

export async function loadCtx(c: PoolClient, v: Viewer, stepId: string): Promise<Ctx> {
  if (!UUID.test(stepId)) fail(404, 'Step not found');
  const step = (await c.query('select * from pulse.flow_run_step where id=$1', [stepId])).rows[0] ?? fail(404, 'Step not found');
  const run = (await c.query('select * from pulse.flow_run where id=$1', [step.run_id])).rows[0];
  const flow = run.definition as FlowDef;
  const def = flow.steps.find((x) => x.id === step.step_key) ?? fail(404, 'Step not found');
  return { c, v, step, run, def, flow };
}
const today = async (c: PoolClient) => (await c.query('select pulse.flow_today()::text d')).rows[0].d as string;

/** A record of a run: created with the type's first status, versioned on each change. */
export async function createRecord(c: PoolClient, v: Viewer, p: { type: string; runId: string | null; stepKey: string | null; projectId?: string | null; clientId?: string | null;
  title: string; data: Record<string, unknown>; status?: string; code?: string | null; source?: unknown }) {
  const t = RECORD_TYPE.get(p.type) ?? (await orgType(c, p.type)) ?? fail(400, 'Unknown record type');
  const status = p.status && t.statuses.some((s) => s.key === p.status) ? p.status : t.initial;
  const r = (await c.query(`insert into pulse.flow_record(org_id,type_key,run_id,step_key,project_id,client_id,title,status,code,data,source,created_by,updated_by)
    values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning id`,
    [p.type, p.runId, p.stepKey, p.projectId ?? null, p.clientId ?? null, p.title.slice(0, 300) || t.name, status, p.code ?? null, JSON.stringify(p.data), p.source ? JSON.stringify(p.source) : null, v.person])).rows[0];
  return r.id as string;
}
export async function orgType(c: PoolClient, key: string) {
  const r = (await c.query('select def from pulse.flow_record_type where key=$1 and archived_at is null', [key])).rows[0];
  return r ? { ...(r.def as object), key, builtin: false } as import('./types.js').RecordType : undefined;
}
/** Change a record's data (merged), title or status; the old state is kept as a version. A frozen record does not change. */
export async function updateRecord(c: PoolClient, v: Viewer, id: string, p: { data?: Record<string, unknown>; title?: string; status?: string; note?: string | null; code?: string | null }) {
  const r = (await c.query('select * from pulse.flow_record where id=$1 for update', [id])).rows[0] ?? fail(404, 'Record not found');
  if (r.frozen_at && (p.data || p.title)) fail(409, 'This record is frozen');
  await c.query(`insert into pulse.flow_record_version(org_id,record_id,version,title,status,data,note,saved_by) values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
    [id, r.version, r.title, r.status, JSON.stringify(r.data), p.note ?? null, v.person]);
  await c.query(`update pulse.flow_record set data=data||$2::jsonb,title=coalesce($3,title),status=coalesce($4,status),code=coalesce($5,code),version=version+1,updated_by=$6,updated_at=now() where id=$1`,
    [id, JSON.stringify(p.data ?? {}), p.title?.slice(0, 300) || null, p.status ?? null, p.code ?? null, v.person]);
  return (await c.query(`${RECORD_SELECT} where fr.id=$1`, [id])).rows.map(recordOut)[0];
}

/** The record a step works on, made the first time the step is opened. */
export async function openStep(ctx: Ctx): Promise<{ type: string; id: string } | null> {
  const { c, v, step, run, def } = ctx;
  if (step.record_id) return { type: step.record_type, id: step.record_id };
  const mm = MODULE.get(step.module); if (!mm?.records?.length || (mm.surface === 'board' && step.module !== 'shoot')) return null; // a board collects many records; a shoot plans one
  let type = mm.records[0]; let id: string;
  const s = def.settings as Body;
  if (step.module === 'doc_section') {
    // The run's document: the one the Document step made (settings.docStep), else the run's first document, else a new one.
    type = 'doc';
    const docStep = str(s.docStep, 40);
    const found = (await c.query(`select id from pulse.flow_record where run_id=$1 and type_key='doc' and archived_at is null and ($2='' or step_key=$2) order by created_at limit 1`, [run.id, docStep])).rows[0];
    id = found?.id ?? await createRecord(c, v, { type, runId: run.id, stepKey: docStep || step.step_key, projectId: run.project_id, clientId: run.client_id,
      title: `${str(s.docTitle, 200) || 'Document'} · ${run.name}`, data: { sections: {}, outline: [] } });
  } else if (step.module === 'asset') {
    const kind = str(s.assetType, 60) || 'Asset';
    let code = assetId({ project: str(run.fields?.project_code, 40) || run.name, asset: kind, persona: str(s.persona, 20) || null, angle: str(s.angle, 20) || null, hook: 1, version: 1 });
    for (let n = 2; (await c.query(`select 1 from pulse.flow_record where type_key='asset' and code=$1 and archived_at is null`, [code])).rowCount; n++) code = code.replace(/_H\d+_V\d+$/, `_H${String(n).padStart(2, '0')}_V01`);
    const tabs = list(s.tabs).length ? list(s.tabs) : kind.match(/image|carousel|sica/i) ? ['Copy', 'Designer notes'] : ['Script', 'Videographer notes', 'Editor notes'];
    id = await createRecord(c, v, { type, runId: run.id, stepKey: step.step_key, projectId: run.project_id, clientId: run.client_id, title: step.title, code,
      data: { name: step.title, asset_type: RECORD_TYPE.get('asset')!.fields.find((f) => f.key === 'asset_type')!.options!.includes(kind) ? kind : 'Other', hook: 1,
        tabs: tabs.map((t) => ({ title: t, text: '' })), dates: { draft: await today(c) }, revisions: 0 } });
  } else {
    const data: Record<string, unknown> = { title: step.title };
    // Sections keep their order in `outline` (a JSON object's keys do not keep theirs in the database).
    if (type === 'doc') { data.sections = Object.fromEntries(list(s.sections).map((x) => [x, { text: '' }])); data.outline = list(s.sections); }
    if (type === 'review') { data.rounds = 0; data.items = []; data.tagged = list(s.tag); }
    if (type === 'meeting') data.people = list(s.people);
    if (type === 'pack') data.pack = str(s.pack, 60) || step.title;
    if (type === 'session') data.ritual = str(s.ritual, 120) || step.title;
    id = await createRecord(c, v, { type, runId: run.id, stepKey: step.step_key, projectId: run.project_id, clientId: run.client_id, title: step.title, data });
  }
  await c.query('update pulse.flow_run_step set record_type=$2,record_id=$3,updated_at=now() where id=$1', [step.id, type, id]);
  step.record_type = type; step.record_id = id;
  return { type, id };
}

/** The values a step's Makes ports carry when it is done: its record, or the records it collected. */
export async function outputsOf(ctx: Ctx, given: Body = {}): Promise<Body> {
  const { c, step, run } = ctx; const mm = MODULE.get(step.module); const out: Body = {};
  for (const port of (mm?.makes ?? []) as Port[]) {
    if (given[port.key] !== undefined) { out[port.key] = given[port.key]; continue; }
    if (port.kind === 'list') {
      const type = port.recordType ?? str((ctx.def.settings as Body).recordType, 40);
      const ids = (await c.query(`select id,title from pulse.flow_record where run_id=$1 and step_key=$2 and archived_at is null and ($3='' or type_key=$3) order by created_at limit 200`, [run.id, step.step_key, type ?? ''])).rows;
      out[port.key] = { recordType: type || null, ids: ids.map((r) => r.id), titles: ids.map((r) => r.title).slice(0, 20), count: ids.length };
    } else if (step.record_id) out[port.key] = { recordType: step.record_type, recordId: step.record_id };
  }
  return out;
}

async function recordsOfRun(c: PoolClient, runId: string): Promise<RecordLite[]> {
  return (await c.query(`select type_key type,title,status,data from pulse.flow_record where run_id=$1 and archived_at is null order by updated_at desc limit 400`, [runId])).rows;
}
async function stepRecord(ctx: Ctx) { const r = await openStep(ctx); return r ? (await ctx.c.query(`${RECORD_SELECT} where fr.id=$1`, [r.id])).rows.map(recordOut)[0] : null; }
const finish = (ctx: Ctx, outputs: Body) => ctx.c.query('select pulse.flow_step_finish($1,$2,$3)', [ctx.step.id, JSON.stringify(outputs), ctx.v.person]);
const move = (ctx: Ctx, to: string, note: string | null = null) => ctx.c.query('select pulse.flow_step_move($1,$2,$3,$4)', [ctx.step.id, to, ctx.v.person, note]);
const verdict = (ctx: Ctx, answer: string, note: string | null = null) => ctx.c.query('select pulse.flow_step_verdict($1,$2,$3,$4)', [ctx.step.id, answer, note, ctx.v.person]);
/** What reached one of a step's needs (the latest value on that port). */
const needValue = async (c: PoolClient, runId: string, stepKey: string, port: string) =>
  (await c.query(`select value from pulse.flow_value where run_id=$1 and step_key=$2 and port=$3 and side='needs' order by set_at desc limit 1`, [runId, stepKey, port])).rows[0]?.value ?? null;
const startIfOpen = async (ctx: Ctx) => { if (ctx.step.state === 'open') { await move(ctx, 'in_progress'); ctx.step.state = 'in_progress'; } };

/** A step setting that may differ per value of the run's variant ({ starter: 'sent', sellout: 'confirmed' }). */
export function settingFor(ctx: Ctx, key: string): string {
  const x = (ctx.def.settings as Body)[key];
  if (x && typeof x === 'object' && !Array.isArray(x)) { const v = ctx.run.fields?.[ctx.run.compiled?.variant ?? '']; return str((x as Body)[String(v)], 40); }
  return str(x, 40);
}

/** The actions of each module (manifest.actions lists them in words). */
export async function runAction(ctx: Ctx, action: string, b: Body): Promise<unknown> {
  const { c, v, step, run } = ctx; const mod = step.module;
  if (['waiting', 'skipped', 'done'].includes(step.state) && !['agenda', 'write'].includes(action)) fail(409, step.state === 'waiting' ? 'This step is waiting for its data' : 'This step is closed');
  const key = `${mod}.${action}`;
  switch (key) {
    case 'intake.receive': {
      const item = str(b.item, 40); const on = b.on === null ? null : day(b.on) ?? await today(c);
      await startIfOpen(ctx);
      await c.query('select pulse.flow_intake_set($1,$2,$3,$4,$5,$6)', [run.id, step.step_key, item, on, str(b.note) || null, v.person]); return { ok: true };
    }
    case 'assign.name': {
      const role = str(b.role, 40); if (!ctx.flow.roles.some((r) => r.key === role)) fail(400, 'Choose a role of this process');
      const pid = UUID.test(String(b.personId)) ? String(b.personId) : fail(400, 'Choose someone');
      if (!(await c.query(`select 1 from pulse.person where id=$1 and side='staff' and status='active'`, [pid])).rowCount) fail(400, 'Choose someone in the team');
      await c.query(`update pulse.flow_run set people=people||jsonb_build_object($2::text,$3::text) where id=$1`, [run.id, role, pid]);
      await c.query(`select pulse.flow_event($1,$2,'assign',null,null,$3,$4)`, [run.id, step.step_key, v.person, JSON.stringify({ role, personId: pid })]);
      // Open steps of that role that nobody has yet go to them (they open again, now with a person and a task).
      const keys = ctx.flow.steps.filter((s) => s.who.by === 'role' && s.who.role === role).map((s) => s.id);
      await c.query(`update pulse.flow_run_step set state='waiting',opened_at=null where run_id=$1 and step_key=any($2) and state='open' and person_id is null and task_id is null`, [run.id, keys]);
      await c.query('select pulse.flow_run_settle($1)', [run.id]);
      return { ok: true };
    }
    case 'schedule.slot': {
      const on = day(b.on) ?? fail(400, 'Choose the date');
      const slot = { on, time: str(b.time, 20) || null, place: str(b.place, 500) || null, people: list(b.people, 20) };
      const field = str((ctx.def.settings as Body).field, 40);
      if (field && ctx.flow.fields.some((f) => f.key === field)) {
        await c.query(`update pulse.flow_run set fields=fields||jsonb_build_object($2::text,$3::text) where id=$1`, [run.id, field, on]);
        await c.query('select pulse.flow_clock($1),pulse.flow_recompute_due($1)', [run.id]);
      }
      await finish(ctx, { slot }); return { ok: true, slot };
    }
    case 'meeting.transcript': case 'transcribe.transcript': case 'sales_xray.transcript': {
      const rec = (await stepRecord(ctx))!; await startIfOpen(ctx);
      const transcript = typeof b.transcript === 'string' ? b.transcript.slice(0, 200000) : '';
      if (!transcript.trim() && !str(b.recordingUrl)) fail(400, 'Paste the transcript or link the recording');
      const url = /^https:\/\//.test(str(b.recordingUrl, 2000)) ? str(b.recordingUrl, 2000) : undefined;
      return { record: await updateRecord(c, v, rec.id, { data: { ...(transcript ? { transcript } : {}), ...(url ? { recording_url: url } : {}) }, status: transcript ? 'transcribed' : 'held', note: 'Transcript saved' }) };
    }
    case 'meeting.summarise': case 'transcribe.summarise': case 'sales_xray.summarise': {
      const rec = (await stepRecord(ctx))!; const transcript = String(rec.data.transcript ?? '');
      if (!transcript.trim()) fail(400, 'Save the transcript first');
      const res = await groundedAssistant.assist({ action: 'summarise', step: { title: step.title, module: mod, checklist: ctx.def.checklist ?? [], qualityTest: [] }, sop: null, text: transcript,
        drafts: [], records: [], fields: run.fields, today: await today(c) });
      const record = await updateRecord(c, v, rec.id, { data: { summary: (res.summary ?? []).join('\n'), followups: res.followups ?? [], tags: res.tags ?? [] }, status: 'summarised', note: 'Pip summary' });
      if (b.keep === true) for (const f of (res.followups ?? []).slice(0, 30))
        await createRecord(c, v, { type: 'open_item', runId: run.id, stepKey: step.step_key, projectId: run.project_id, title: f.slice(0, 200), data: { question: f, tag: /conflict/i.test(f) ? 'CONFLICT' : 'FOLLOW-UP' } });
      return { record, suggestion: res, assistant: { name: groundedAssistant.name, version: groundedAssistant.version, model: groundedAssistant.model } };
    }
    case 'meeting.score': case 'transcribe.score': case 'score.score': {
      const score = { info: Math.max(1, Math.min(5, Number(b.info) || 0)) || null, behaviour: Math.max(1, Math.min(5, Number(b.behaviour) || 0)) || null, note: str(b.note, 1000) || null, by: v.person, on: await today(c) };
      if (mod === 'score') { await finish(ctx, { score }); return { ok: true, score }; }
      const rec = (await stepRecord(ctx))!; return { record: await updateRecord(c, v, rec.id, { data: { score }, note: 'Scored' }) };
    }
    case 'session.agenda': return { agenda: await sessionAgenda(c, str((ctx.def.settings as Body).agenda, 20) || 'rough_cut') };
    case 'session.note': {
      const rec = (await stepRecord(ctx))!;
      const requests = list(b.requests, 20);
      for (const t of requests) await createRecord(c, v, { type: 'request', runId: run.id, stepKey: step.step_key, title: t.slice(0, 200), data: { title: t, raised_on: await today(c), raised_by: v.person } });
      return { record: await updateRecord(c, v, rec.id, { data: { notes: str(b.notes, 20000), decisions: list(b.decisions, 40), requests, on: await today(c) }, status: 'held', note: 'Session held' }) };
    }
    case 'doc.section': case 'doc_section.section': case 'pip_draft.section': case 'pack.section': {
      const rec = (await stepRecord(ctx))!; await startIfOpen(ctx);
      const section = mod === 'doc_section' ? str((ctx.def.settings as Body).section, 80) || step.step_key : str(b.section, 80) || 'main';
      const text = typeof b.text === 'string' ? b.text.slice(0, 100000) : '';
      const sections = { ...((rec.data.sections ?? {}) as Body), [section]: { text, updatedAt: new Date().toISOString(), by: v.person, step: step.step_key, final: b.final === true } };
      const outline = [...new Set([...(Array.isArray(rec.data.outline) ? rec.data.outline as string[] : []), section])];
      const record = await updateRecord(c, v, rec.id, { data: { sections, outline }, note: `Section ${section}` });
      if (b.final === true && mod === 'doc_section') await finish(ctx, await outputsOf(ctx, { section: { recordType: 'doc', recordId: rec.id, section } }));
      return { record };
    }
    case 'doc.final': case 'pip_draft.final': {
      const rec = (await stepRecord(ctx))!;
      await updateRecord(c, v, rec.id, { status: 'final', note: 'Final' });
      // FLOW-D: a document later steps still write their sections into (EA's Project Blueprint) is not frozen yet.
      const writers = ctx.flow.steps.filter((x) => x.module === 'doc_section' && (str((x.settings as Body).docStep, 40) || step.step_key) === step.step_key).map((x) => x.id);
      const open = writers.length ? (await c.query(`select count(*)::int n from pulse.flow_run_step where run_id=$1 and step_key=any($2) and state not in ('done','skipped')`, [run.id, writers])).rows[0].n : 0;
      if (!open) await c.query('update pulse.flow_record set frozen_at=now(),frozen_by=$2 where id=$1', [rec.id, v.person]);
      await finish(ctx, await outputsOf(ctx)); return { ok: true, frozen: !open };
    }
    case 'asset.tab': {
      const rec = (await stepRecord(ctx))!; await startIfOpen(ctx);
      const title = str(b.tab, 60) || 'Script'; const text = typeof b.text === 'string' ? b.text.slice(0, 100000) : '';
      const old = Array.isArray(rec.data.tabs) ? rec.data.tabs as { title: string; text: string }[] : [];
      const tabs = old.some((t) => t.title === title) ? old.map((t) => (t.title === title ? { title, text } : t)) : [...old, { title, text }];
      return { record: await updateRecord(c, v, rec.id, { data: { tabs }, note: `Tab ${str(b.tab, 60)}` }) };
    }
    case 'asset.version': {
      const rec = (await stepRecord(ctx))!; const code = String(rec.code ?? '');
      const next = code.replace(/_V(\d+)$/, (_m, n) => `_V${String(Number(n) + 1).padStart(2, '0')}`);
      return { record: await updateRecord(c, v, rec.id, { code: next, note: `Version ${next.slice(-3)}` }) };
    }
    case 'asset.status': {
      const rec = (await stepRecord(ctx))!; const to = str(b.status, 40);
      const t = RECORD_TYPE.get('asset')!; const cur = t.statuses.find((s) => s.key === rec.status);
      if (!cur?.next.includes(to)) fail(400, `An asset goes from ${cur?.label ?? rec.status} to ${cur?.next.map((n) => t.statuses.find((s) => s.key === n)?.label).join(' or ') || 'nothing else'}`);
      const dates = { ...((rec.data.dates ?? {}) as Body), [to]: await today(c) };
      const revisions = Number(rec.data.revisions ?? 0) + (to === 'changes' || (to === 'rough_cut' && rec.status === 'rough_cut') ? 1 : 0);
      const record = await updateRecord(c, v, rec.id, { status: to, data: { dates, revisions }, note: `Asset ${to}` });
      if (to === 'final') await c.query('update pulse.flow_record set frozen_at=now(),frozen_by=$2 where id=$1', [rec.id, v.person]);
      return { record };
    }
    case 'pack.ready': await startIfOpen(ctx); await move(ctx, 'confirmed', 'Written'); await stepRecord(ctx); return { ok: true };
    case 'share_review.send': {
      const rec = (await stepRecord(ctx))!;
      const links = list(b.links, 20).filter((l) => /^(https:\/\/|\/)/.test(l));
      const rounds = Number(rec.data.rounds ?? 0) + 1;
      const record = await updateRecord(c, v, rec.id, { status: 'sent', data: { message: str(b.message, 4000), items: links, rounds, sent_on: await today(c) }, note: `Round ${rounds}` });
      await move(ctx, 'in_review');
      if (settingFor(ctx, 'finishWhen') === 'sent') await finish(ctx, await outputsOf(ctx, { shared: { recordType: 'review', recordId: rec.id, links } }));
      return { record };
    }
    case 'share_review.changes': {
      const rec = (await stepRecord(ctx))!;
      const changes = [...((rec.data.changes ?? []) as unknown[]), ...list(b.changes, 50).map((t) => ({ text: t, round: rec.data.rounds ?? 1, on: new Date().toISOString().slice(0, 10) }))];
      const record = await updateRecord(c, v, rec.id, { status: 'changes', data: { changes }, note: 'Changes asked' });
      await verdict(ctx, 'changes', list(b.changes, 50).join('; ').slice(0, 500) || null); return { record };
    }
    case 'share_review.confirm': {
      const rec = (await stepRecord(ctx))!;
      await updateRecord(c, v, rec.id, { status: 'confirmed', data: { confirmed_on: await today(c) }, note: 'Confirmed' });
      await verdict(ctx, 'confirmed', str(b.note) || null); return { ok: true };
    }
    case 'check.run': {
      const rec = (await stepRecord(ctx))!; await startIfOpen(ctx);
      const drafts = await draftsOf(c, run.id, step.step_key);
      const res = await groundedAssistant.assist({ action: 'check', step: { title: step.title, module: mod, checklist: ctx.def.checklist ?? [], qualityTest: ctx.def.qualityTest ?? [] },
        sop: null, text: typeof b.text === 'string' ? b.text : '', drafts, records: await recordsOfRun(c, run.id), fields: run.fields, today: await today(c) });
      const record = await updateRecord(c, v, rec.id, { data: { findings: res.findings ?? [], tests: ctx.def.qualityTest ?? [] }, note: 'Pre-checked' });
      return { record, findings: res.findings, drafts: drafts.map((d) => d.title), assistant: { name: groundedAssistant.name, version: groundedAssistant.version, model: groundedAssistant.model } };
    }
    case 'media_review.comment': {
      const rec = (await stepRecord(ctx))!;
      const body = str(b.text, 4000) || fail(400, 'Write the comment');
      const id = (await c.query(`insert into pulse.flow_comment(org_id,record_id,section,anchor,kind,body,owner_id,due_on,created_by) values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [rec.id, str(b.version, 60) || null, str(b.at, 60) || null, b.change === true ? 'change' : 'comment', body, UUID.test(String(b.ownerId)) ? b.ownerId : null, day(b.due), v.person])).rows[0].id;
      if (b.change === true && rec.status !== 'changes') await updateRecord(c, v, rec.id, { status: 'in_review', note: 'In review' });
      return { id };
    }
    case 'media_review.version': case 'upload.version': case 'edit.version': {
      const rec = (await stepRecord(ctx))!; await startIfOpen(ctx);
      const url = /^https:\/\//.test(str(b.url, 2000)) ? str(b.url, 2000) : fail(400, 'Link the file (https)');
      const versions = [...((rec.data.versions ?? []) as unknown[]), { url, note: str(b.note, 500) || null, at: new Date().toISOString(), by: v.person }];
      const record = await updateRecord(c, v, rec.id, { data: { versions }, status: rec.status === 'changes' ? 'uploaded' : rec.status, note: `Version ${versions.length}` });
      if (mod !== 'media_review' && b.done === true) await finish(ctx, await outputsOf(ctx));
      return { record };
    }
    case 'media_review.freeze': {
      const rec = (await stepRecord(ctx))!;
      await updateRecord(c, v, rec.id, { status: 'final', note: 'Frozen' });
      await c.query('update pulse.flow_record set frozen_at=now(),frozen_by=$2 where id=$1', [rec.id, v.person]);
      await finish(ctx, await outputsOf(ctx)); return { ok: true };
    }
    case 'shoot.plan': {
      const rec = (await stepRecord(ctx))!; await startIfOpen(ctx);
      const data: Body = { on: day(b.on), call_time: str(b.call_time, 20) || null, place: str(b.place, 300) || null, people: list(b.people, 40), needs: list(b.needs, 60), shot_list: list(b.shot_list, 100), equipment: list(b.equipment, 60) };
      return { record: await updateRecord(c, v, rec.id, { data: Object.fromEntries(Object.entries(data).filter(([, x]) => x !== null && !(Array.isArray(x) && !x.length))), status: day(b.on) ? 'scheduled' : undefined, note: 'Planned' }) };
    }
    case 'shoot.callsheet': {
      const rec = (await stepRecord(ctx))!; const d = rec.data as Body;
      const sheet = [`CALL SHEET · ${rec.title}`, `Date: ${d.on ?? 'to fix'}   Call: ${d.call_time ?? 'to fix'}`, `Place: ${d.place ?? 'to fix'}`, '', 'People:', ...list(d.people).map((x) => `• ${x}`), '',
        'Needs:', ...list(d.needs).map((x) => `• ${x}`), '', 'Shot list:', ...list(d.shot_list).map((x, i) => `${i + 1}. ${x}`), '', 'Equipment:', ...list(d.equipment).map((x) => `• ${x}`), '',
        'Before formatting any card: two verified backups.'].join('\n');
      return { record: await updateRecord(c, v, rec.id, { data: { call_sheet: sheet }, note: 'Call sheet' }), callSheet: sheet };
    }
    case 'request.raise': {
      const title = str(b.title, 200) || fail(400, 'Say what is asked');
      const id = await createRecord(c, v, { type: 'request', runId: run.id, stepKey: step.step_key, projectId: run.project_id, title,
        data: { title, client: str(b.client, 200) || run.name, kind: str(b.kind, 80), why: str(b.why, 2000), raised_on: await today(c), raised_by: v.person } });
      return { id };
    }
    case 'request.answer': {
      const id = UUID.test(String(b.recordId)) ? String(b.recordId) : fail(400, 'Choose the request');
      const drop = day(b.firstDrop) ?? fail(400, 'Give the first-drop date');
      return { record: await updateRecord(c, v, id, { status: 'answered', data: { first_drop: drop, owner: v.person }, note: 'Answered' }) };
    }
    case 'daily_update.write': {
      const mine = (await c.query(`select s.title,r.name run,s.state,s.due_on::text due from pulse.flow_run_step s join pulse.flow_run r on r.id=s.run_id
        where s.person_id=$1 and r.status='running' and s.state in ('open','in_progress','in_review','confirmed') order by s.due_on nulls last limit 12`, [v.person])).rows;
      const text = mine.length ? `Working on today:\n${mine.map((m) => `• ${m.title} (${m.run})${m.due ? ` · due ${m.due}` : ''}`).join('\n')}` : 'Nothing open for me today.';
      const id = await createRecord(c, v, { type: 'daily_update', runId: run.id, stepKey: step.step_key, title: `${v.name} · ${await today(c)}`, data: { title: v.name, on: await today(c), person: v.person, text } });
      return { id, text };
    }
    // Sales X-Ray: the person picks one of their calls (the page reads them live: GET /api/v0/sales-xray/calls); the step
    // keeps the call's id and the analysis they saw, each on its own port.
    case 'sales_xray.pick': {
      const callId = str(b.callId, 80) || fail(400, 'Choose the call');
      // FLOW-E: the call's analysis is read from Sales X-Ray as the person (their own connection), not taken from the page.
      if (UUID.test(callId) && (await xrayStatus(c)).connected) Object.assign(b, await callAnalysis(c, v, callId));
      const lines = (x: unknown) => (Array.isArray(x) ? x.map((y) => (typeof y === 'string' ? y : JSON.stringify(y)).slice(0, 500)).slice(0, 50) : []);
      const rec = (await stepRecord(ctx))!;
      await updateRecord(c, v, rec.id, { data: { recording_url: /^https:\/\//.test(str(b.url, 2000)) ? str(b.url, 2000) : undefined, summary: str(b.summary, 8000) || undefined,
        followups: lines(b.promises) }, status: 'summarised', note: `Sales X-Ray call ${callId}` });
      await finish(ctx, { summary: { callId, text: str(b.summary, 8000), recordType: 'meeting', recordId: rec.id }, items: { items: lines(b.items) }, objections: { items: lines(b.objections) },
        promises: { items: lines(b.promises) }, score: { score: typeof b.score === 'number' ? b.score : str(b.score, 40) || null } });
      return { ok: true };
    }
    // Money: the step is done with a Billing document chosen on it (made in Billing, /erp/new?type=…).
    case 'quotation.candidates': case 'tax_invoice.candidates': {
      const types = mod === 'quotation' ? ['quotation'] : ['invoice', 'proforma'];
      return { documents: (await c.query(`select id,doc_type "type",number,status,total,issue_date::text "issueDate",buyer->>'name' buyer from pulse.erp_document
        where doc_type=any($1) and status<>'cancelled' and ($2::uuid is null or client_id=$2 or project_id=$3) order by created_at desc limit 30`, [types, run.client_id, run.project_id])).rows };
    }
    case 'quotation.pick': case 'tax_invoice.pick': {
      const did = UUID.test(String(b.documentId)) ? String(b.documentId) : fail(400, 'Choose the document');
      const d = (await c.query(`select id,doc_type,number,status,total,client_id,buyer->>'name' buyer from pulse.erp_document where id=$1`, [did])).rows[0] ?? fail(404, 'Choose a document you can open in Billing');
      if (mod === 'quotation' ? d.doc_type !== 'quotation' : !['invoice', 'proforma'].includes(d.doc_type)) fail(400, mod === 'quotation' ? 'Choose a quotation' : 'Choose an invoice');
      const value = { erpId: d.id, type: d.doc_type, number: d.number, status: d.status, total: Number(d.total), buyer: d.buyer, href: `/erp/${d.id}` };
      await finish(ctx, { [mod === 'quotation' ? 'quote' : 'invoice']: value }); return { ok: true, document: value };
    }
    // Field: the step is done with a form sent from the phone (camera photos carry their place and time).
    case 'site_visit.candidates': case 'data_capture.candidates': {
      const formId = str((ctx.def.settings as Body).formId, 40);
      return { submissions: (await c.query(`select s.id,s.form_name "form",s.submitted_at "at",p.display_name "by",s.location
        from pulse.form_submission s left join pulse.person p on p.id=s.submitted_by where s.status='submitted' and ($1='' or s.form_id::text=$1) and ($2::uuid is null or s.project_id=$2)
        order by s.submitted_at desc nulls last limit 30`, [formId, run.project_id])).rows };
    }
    case 'site_visit.pick': case 'data_capture.pick': {
      const sid = UUID.test(String(b.submissionId)) ? String(b.submissionId) : fail(400, 'Choose the form that was sent');
      const sub = (await c.query(`select id,form_id,form_name,answers,location,status from pulse.form_submission where id=$1`, [sid])).rows[0] ?? fail(404, 'Form not found');
      if (sub.status !== 'submitted') fail(400, 'This form has not been sent yet');
      const formId = str((ctx.def.settings as Body).formId, 40); if (formId && sub.form_id !== formId) fail(400, 'Choose a submission of this step\'s form');
      const value = { submissionId: sub.id, formId: sub.form_id, form: sub.form_name, answers: sub.answers, location: sub.location, href: `/sops/forms/${sub.form_id}` };
      await finish(ctx, { [mod === 'site_visit' ? 'photos' : 'answers']: value }); return { ok: true, submission: value };
    }
    // FLOW-D: Message (a WhatsApp or e-mail to send): the text with the run's values; Sent finishes it. FLOW-E: with the
    // link that opens it in WhatsApp or the mail app, and whether Pulse may send the e-mail itself here.
    case 'message.text': {
      const text = (await c.query('select pulse.flow_fill($1::text,r) t from pulse.flow_run r where r.id=$2', [str((ctx.def.settings as Body).text, 4000) || step.title, run.id])).rows[0].t as string;
      return { text, ...messageLinks(str((ctx.def.settings as Body).channel, 20), str(b.to, 200) || str((ctx.def.settings as Body).to, 200), step.title, text), canSend: await canSendMail(c, v, str((ctx.def.settings as Body).channel, 20)) };
    }
    case 'message.send': {
      const text = (await c.query('select pulse.flow_fill($1::text,r) t from pulse.flow_run r where r.id=$2', [str((ctx.def.settings as Body).text, 4000) || step.title, run.id])).rows[0].t as string;
      const sent = await sendMail(c, v, { to: str(b.to, 250) || str((ctx.def.settings as Body).to, 250), subject: str(b.subject, 200) || `${step.title} · ${run.name}`, body: text, channel: str((ctx.def.settings as Body).channel, 20) });
      await finish(ctx, { sent: { answer: 'sent', text, channel: 'email', to: sent.to, by: 'pulse', messageId: sent.id ?? null } }); return { ok: true, sent: true };
    }
    // FLOW-E: apps as App actions (apps.ts lists them in Settings → Apps).
    case 'calendar_event.event': {
      const slot = await needValue(c, run.id, step.step_key, 'slot') as Body | null;
      const on = day(b.on) ?? day(slot?.on) ?? fail(400, 'Choose the day');
      const time = /^\d{1,2}:\d{2}$/.test(str(b.time, 5)) ? str(b.time, 5) : /^\d{1,2}:\d{2}$/.test(str(slot?.time, 5)) ? str(slot?.time, 5) : fail(400, 'Choose the time');
      const minutes = Math.max(5, Math.min(600, Math.round(Number(b.minutes ?? (ctx.def.settings as Body).minutes ?? 30)) || 30));
      const title = (await c.query('select pulse.flow_fill($1::text,r) t from pulse.flow_run r where r.id=$2', [str((ctx.def.settings as Body).title, 300) || `${step.title} · {run}`, run.id])).rows[0].t as string;
      const people = list(b.people ?? slot?.people, 30); const place = str(b.place, 300) || str(slot?.place, 300);
      const zone = (await c.query('select pulse.org_time_zone() z')).rows[0].z as string;
      const event = calendarEvent({ title, on, time, minutes, people, place, zone, details: `${run.name}\n${step.title}` });
      await finish(ctx, { event: { ...event, meet: b.meet === true || (ctx.def.settings as Body).meet === true } }); return { ok: true, event };
    }
    case 'drive_folder.folder': {
      const url = str(b.url, 2000); const given = url.match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/)?.[1] ?? null;
      if (url && !given) fail(400, 'Paste the folder’s Google Drive link (drive.google.com/drive/folders/…)');
      const found = given ? null : await projectFolder(c, run.project_id);
      const folderId = given ?? found ?? fail(409, 'This project has no Drive folder yet: paste its link');
      const value = { folderId, url: `https://drive.google.com/drive/folders/${folderId}`, name: given ? null : run.name, from: given ? 'named on the step' : 'the project' };
      await finish(ctx, { folder: value }); return { ok: true, folder: value };
    }
    case 'drive_file.candidates': {
      const fromNeed = await needValue(c, run.id, step.step_key, 'folder') as Body | null;
      const folderId = str(fromNeed?.folderId, 100) || await projectFolder(c, run.project_id);
      const q = str(b.q, 80).replace(/[%_]/g, '');
      const files = (await c.query(`select id,store_id "storeId",name,mime,created_at "at" from pulse.file where trashed_at is null and store='gdrive' and ($1::text is null or parent_store_id=$1)
        and ($2='' or name ilike '%'||$2||'%') and ($1::text is not null or $2<>'') order by created_at desc nulls last limit 30`, [folderId || null, q])).rows;
      return { folderId: folderId || null, files, upload: process.env.PULSE_DRIVE_UPLOAD_ENABLED === '1' && !!folderId && !!run.project_id };
    }
    case 'drive_file.pick': {
      const fid = UUID.test(String(b.fileId)) ? String(b.fileId) : null;
      const f = fid ? (await c.query(`select id,store_id,name,mime from pulse.file where id=$1`, [fid])).rows[0] ?? fail(404, 'Choose a file from the list') : null;
      const url = f ? `https://drive.google.com/file/d/${f.store_id}/view` : /^https:\/\//.test(str(b.url, 2000)) ? str(b.url, 2000) : fail(400, 'Choose a file, or paste its link');
      const value = { fileId: f?.id ?? null, name: f?.name ?? (str(b.name, 300) || 'A file'), mime: f?.mime ?? null, url };
      await finish(ctx, { file: value }); return { ok: true, file: value };
    }
    case 'webhook.send': {
      const values = (await c.query(`select step_key step,port,side,kind,value from pulse.flow_value where run_id=$1 and side='makes' order by set_at limit 200`, [run.id])).rows;
      const reply = await postWebhook(c, str((ctx.def.settings as Body).url, 2000), { event: 'flow.step', at: new Date().toISOString(),
        run: { id: run.id, name: run.name, fields: run.fields, mode: run.mode }, step: { key: step.step_key, title: step.title }, values });
      if (run.mode !== 'live' && !reply.ok) return { ok: false, reply };
      if (!reply.ok) fail(502, `The app answered ${reply.status || 'nothing'}: nothing was finished`);
      await finish(ctx, { reply }); return { ok: true, reply };
    }
    case 'message.sent': {
      const text = (await c.query('select pulse.flow_fill($1::text,r) t from pulse.flow_run r where r.id=$2', [str((ctx.def.settings as Body).text, 4000) || step.title, run.id])).rows[0].t;
      await finish(ctx, { sent: { answer: 'sent', text, channel: str((ctx.def.settings as Body).channel, 20) || null, note: str(b.note) || null } }); return { ok: true };
    }
    // Wait until something arrives: someone marks it arrived, with what came (a note or a link).
    case 'wait.arrived': {
      const url = /^https:\/\//.test(str(b.url, 2000)) ? str(b.url, 2000) : null;
      await finish(ctx, { after: { note: str(b.note, 2000) || null, url } }); return { ok: true };
    }
    default: return fail(404, `${MODULE.get(mod)?.name ?? mod} has no action “${action}”`);
  }
}

/** The drafts a Check step checks: the documents and assets that reached its needs, with their text. */
export async function draftsOf(c: PoolClient, runId: string, stepKey: string): Promise<{ title: string; text: string }[]> {
  const vals = (await c.query(`select value from pulse.flow_value where run_id=$1 and step_key=$2 and side='needs'`, [runId, stepKey])).rows;
  const ids = vals.flatMap((x) => (Array.isArray(x.value) ? x.value : [x.value])).map((x: Row) => x?.recordId).filter((x: unknown): x is string => typeof x === 'string' && UUID.test(x));
  if (!ids.length) return [];
  const recs = (await c.query(`select title,code,data from pulse.flow_record where id=any($1)`, [ids])).rows;
  const textOf = (d: Row) => [...(Array.isArray(d.tabs) ? d.tabs : []).map((t: Row) => t?.text), ...Object.values((d.sections ?? {}) as Row).map((x: Row) => x?.text)].filter((x) => typeof x === 'string' && x).join('\n\n');
  return recs.map((r) => ({ title: r.code ?? r.title, text: textOf(r.data) }));
}

/** A session's agenda across every running run: the work waiting for this review (deliverables at their rough cut and
 *  cuts handed in but not frozen), deliverables live 10–15 days (for their verdict), or every open step. */
export async function sessionAgenda(c: PoolClient, kind: string) {
  if (kind === 'live') return (await c.query(`select fr.id,fr.code,fr.title,fr.run_id "runId",r.name run,(fr.data->'dates'->>'live') live,fr.data->>'verdict' verdict from pulse.flow_record fr join pulse.flow_run r on r.id=fr.run_id
     where fr.type_key='asset' and fr.status='live' and r.status='running' and (fr.data->'dates'->>'live')::date between pulse.flow_today()-15 and pulse.flow_today()-10 and fr.archived_at is null order by 6`)).rows;
  if (kind === 'open') return (await c.query(`select s.id,s.title,r.name run,s.run_id "runId",s.state,s.due_on::text due from pulse.flow_run_step s join pulse.flow_run r on r.id=s.run_id
     where r.status='running' and s.state in ('open','in_progress','in_review') order by s.due_on nulls last limit 100`)).rows;
  return (await c.query(`select fr.id,fr.code,fr.title,fr.run_id "runId",r.name run,fr.type_key "type",fr.updated_at since,
       (select s.id from pulse.flow_run_step s where s.run_id=fr.run_id and s.step_key=fr.step_key) "stepId"
     from pulse.flow_record fr join pulse.flow_run r on r.id=fr.run_id
     where r.status='running' and fr.archived_at is null and fr.frozen_at is null
       and ((fr.type_key='asset' and fr.status='rough_cut') or (fr.type_key='media_set' and jsonb_array_length(coalesce(fr.data->'versions','[]'::jsonb))>0))
     order by fr.updated_at limit 100`)).rows;
}
