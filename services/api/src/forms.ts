import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, leadership, type Tx, type Viewer } from './routes.js';
import { sendFile } from './tasks.js';
import { checkAnswers, fileNeeds, normalizeFields, TEMPLATES, TYPE_LABEL, type Field } from './forms-model.js';
import { normalizeWorkflow } from './workflow-model.js';

/** SOP-WORKFLOW part 3: field forms (0242). Leadership builds forms (or installs a template) and attaches them to workflow
 *  steps; whoever does a step fills its form on the phone; a sent form finishes the step and its answers go into the run.
 *  Photos come from the camera (the phone app opens it), downscaled and stamped with time and place in the browser,
 *  checked here (type, size, when taken) and kept in pulse_priv.form_file. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const optId = (x: unknown) => x === undefined || x === null || x === '' ? null : id(x);
const body = { type: 'object' } as const;
const editor = (v: Viewer) => leadership(v);
const str = (x: unknown, max = 200) => typeof x === 'string' ? x.trim().slice(0, max) : '';
const PHOTO = (a: string) => `(select ph.updated_at from pulse.person_photo ph where ph.person_id=${a}.id)`;
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE = 5_000_000, MAX_FILES = 24;

/** The viewer's own form steps waiting now (the phone's list of what to fill). */
async function toFill(c: PoolClient, v: Viewer) {
  if (!v.person) return [];
  const rows = (await c.query(`select s.id "stepId",s.title,s.due_at "dueAt",s.due_at<now() late,r.id "runId",r.name run,w.name workflow,coalesce(pr.title,pr.name) project,r.definition,s.step_key "key"
   from pulse.workflow_run_step s join pulse.workflow_run r on r.id=s.run_id join pulse.workflow w on w.id=r.workflow_id join pulse.task t on t.id=s.task_id left join pulse.project pr on pr.id=r.project_id
   where s.status='active' and r.status='running' and $1::uuid in (t.assignee_person_id,t.owner_id) order by s.due_at nulls last,s.started_at`, [v.person])).rows;
  const out = [];
  for (const r of rows) {
    const formId = ((r.definition?.steps ?? []) as { id: string; formId?: string | null }[]).find((s) => s.id === r.key)?.formId;
    if (!formId) continue;
    const f = (await c.query('select name from pulse.field_form where id=$1', [formId])).rows[0];
    out.push({ stepId: r.stepId, title: r.title, dueAt: r.dueAt, late: r.late, runId: r.runId, run: r.run, workflow: r.workflow, project: r.project, form: f?.name ?? 'Form' });
  }
  return out;
}

async function listForms(c: PoolClient, v: Viewer) {
  const forms = (await c.query(`select f.id,f.name,f.purpose,f.status,f.version,f.fields,f.updated_at "updatedAt",cl.display_name "clientName",
     (select count(*)::int from pulse.form_submission s where s.form_id=f.id and s.status='submitted') sent,(select max(submitted_at) from pulse.form_submission s where s.form_id=f.id) "lastAt",
     (select count(*)::int from pulse.workflow w where w.status<>'archived' and (w.trigger->>'formId'=f.id::text or exists(select 1 from jsonb_array_elements(w.definition->'steps') x where x->>'formId'=f.id::text))) "usedIn"
   from pulse.field_form f left join pulse.client cl on cl.id=f.client_id where f.status<>'archived' or $1 order by f.status='live' desc,f.updated_at desc`, [editor(v)])).rows;
  return { canEdit: editor(v), toFill: await toFill(c, v),
    forms: forms.map(({ fields, ...f }) => ({ ...f, fieldCount: (fields as Field[]).length, photos: (fields as Field[]).filter((x) => x.type === 'photo').length, types: [...new Set((fields as Field[]).map((x) => TYPE_LABEL[x.type]))],
      fields: (fields as Field[]).map((x) => ({ key: x.key, label: x.label, type: x.type })) })),
    templates: editor(v) ? TEMPLATES.map((t) => ({ key: t.key, name: t.name, purpose: t.purpose, forms: t.forms.map((x) => ({ name: x.name, fields: x.fields.length })), workflow: !!t.workflow })) : [] };
}

export async function submissionRows(c: PoolClient, where: string, params: unknown[], limit = 60) {
  return (await c.query(`select s.id,s.form_id "formId",s.form_name "form",s.status,s.submitted_at "submittedAt",p.id "personId",p.display_name "person",${PHOTO('p')} "photoAt",
     coalesce(pr.title,pr.name) project,s.project_id "projectId",cl.display_name client,s.run_id "runId",r.name run,
     (select count(*)::int from pulse.form_files(s.id)) files,s.location is not null "located"
   from pulse.form_submission s left join pulse.person p on p.id=s.submitted_by left join pulse.project pr on pr.id=s.project_id left join pulse.client cl on cl.id=s.client_id
   left join pulse.workflow_run r on r.id=s.run_id where s.status<>'open' and ${where} order by s.submitted_at desc limit ${limit}`, params)).rows;
}

async function readForm(c: PoolClient, v: Viewer, fid: string) {
  const f = (await c.query(`select f.*,cl.display_name "clientName" from pulse.field_form f left join pulse.client cl on cl.id=f.client_id where f.id=$1`, [fid])).rows[0] ?? fail(404, 'Form not found');
  const usedIn = (await c.query(`select w.id,w.name,w.status,array(select x->>'title' from jsonb_array_elements(w.definition->'steps') x where x->>'formId'=$1) steps,w.trigger->>'formId'=$1 starts
   from pulse.workflow w where w.status<>'archived' and (w.trigger->>'formId'=$1 or exists(select 1 from jsonb_array_elements(w.definition->'steps') x where x->>'formId'=$1))`, [fid])).rows;
  return { canEdit: editor(v), form: { id: f.id, name: f.name, purpose: f.purpose, status: f.status, version: f.version, fields: f.fields, clientId: f.client_id, clientName: f.clientName, templateKey: f.template_key, updatedAt: f.updated_at },
    usedIn, submissions: await submissionRows(c, 's.form_id=$1', [fid]) };
}

/** What a run step asks to fill, and whether the viewer may. */
async function stepToFill(c: PoolClient, sid: string) {
  const s = (await c.query(`select s.id,s.step_key,s.title,s.status,s.due_at "dueAt",s.task_id "taskId",r.id "runId",r.name run,r.definition,r.project_id "projectId",coalesce(pr.title,pr.name) project,
     cl.display_name client,w.name workflow,pulse.form_step_fillable(s.id) "canFill",(select max(fs.submitted_at) from pulse.form_submission fs where fs.step_id=s.id and fs.status='submitted') "sentAt"
   from pulse.workflow_run_step s join pulse.workflow_run r on r.id=s.run_id join pulse.workflow w on w.id=r.workflow_id left join pulse.project pr on pr.id=r.project_id left join pulse.client cl on cl.id=r.client_id
   where s.id=$1`, [sid])).rows[0] ?? fail(404, 'Step not found');
  const formId = ((s.definition?.steps ?? []) as { id: string; formId?: string | null }[]).find((x) => x.id === s.step_key)?.formId;
  if (!formId) fail(404, 'This step has no form');
  const f = (await c.query('select id,name,purpose,fields,status from pulse.field_form where id=$1', [formId])).rows[0] ?? fail(404, 'The form is no longer there');
  const { definition, step_key, ...step } = s; void definition; void step_key;
  return { step, form: { id: f.id, name: f.name, purpose: f.purpose, fields: f.fields, live: f.status === 'live' } };
}

export function registerFormRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/forms', (req) => tx(req, (c, v) => listForms(c, v)));
  app.get<{ Params: { id: string } }>('/api/v0/forms/:id', (req) => tx(req, (c, v) => readForm(c, v, id(req.params.id))));
  app.post<{ Body: Body }>('/api/v0/forms', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins build forms');
    const n = normalizeFields(req.body.fields ?? []); if ('error' in n) fail(400, n.error);
    const name = str(req.body.name) || 'New form';
    return { id: (await c.query('select pulse.field_form_save(null,$1) id', [JSON.stringify({ name, purpose: str(req.body.purpose, 1000) || null, clientId: optId(req.body.clientId), fields: (n as { fields: Field[] }).fields })])).rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/forms/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins build forms');
    const fid = id(req.params.id); const n = normalizeFields(req.body.fields); if ('error' in n) fail(400, n.error);
    const name = str(req.body.name); if (!name) fail(400, 'Name the form');
    await c.query('select pulse.field_form_save($1,$2)', [fid, JSON.stringify({ name, purpose: str(req.body.purpose, 1000) || null, clientId: optId(req.body.clientId), fields: (n as { fields: Field[] }).fields })]);
    return readForm(c, v, fid);
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/forms/:id/status', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins publish forms');
    const status = str(req.body.status, 10); if (!['draft', 'live', 'archived'].includes(status)) fail(400, 'Choose draft, live or archived');
    await c.query('select pulse.field_form_set_status($1,$2)', [id(req.params.id), status]); return { status };
  }));
  // Install a template: its forms (live), and for the solar installation its workflow with each step's form (a draft to check).
  app.post<{ Params: { key: string }; Body: Body }>('/api/v0/forms/templates/:key', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins add forms');
    const t = TEMPLATES.find((x) => x.key === req.params.key) ?? fail(404, 'No such template');
    const clientId = optId(req.body.clientId); const ids: Record<string, string> = {};
    for (const f of t.forms) ids[f.ref] = (await c.query('select pulse.field_form_save(null,$1) id', [JSON.stringify({ name: f.name, purpose: f.purpose, clientId, fields: f.fields, templateKey: t.key, status: 'live' })])).rows[0].id;
    let workflowId: string | null = null;
    if (t.workflow) {
      const n = normalizeWorkflow({ steps: t.workflow.steps.map((s) => ({ ...s, formId: s.form ? ids[String(s.form)] : null })) });
      if ('error' in n) fail(500, n.error);
      workflowId = (await c.query('select pulse.workflow_save(null,$1) id', [JSON.stringify({ name: t.workflow.name, purpose: t.workflow.purpose, clientId, definition: (n as { def: unknown }).def, trigger: t.workflow.trigger })])).rows[0].id;
    }
    return { formIds: Object.values(ids), workflowId };
  }));

  app.get<{ Params: { id: string } }>('/api/v0/forms/fill/:id', (req) => tx(req, (c) => stepToFill(c, id(req.params.id))));
  app.get<{ Params: { id: string } }>('/api/v0/forms/:id/blank', (req) => tx(req, async (c) => {
    const f = (await c.query(`select id,name,purpose,fields,status from pulse.field_form where id=$1`, [id(req.params.id)])).rows[0] ?? fail(404, 'Form not found');
    return { form: { id: f.id, name: f.name, purpose: f.purpose, fields: f.fields, live: f.status === 'live' } };
  }));
  // Send a form: the answers (checked against the form), photos and signatures as base64 (already downscaled on the
  // phone), where it was sent from. One transaction: the step is finished, or the form's workflows start, or nothing.
  // FLOW-D: a form filled on a process step (Collect, flowStepId) finishes that step with its answers, place and time.
  app.post<{ Body: Body }>('/api/v0/forms/submit', { schema: { body }, bodyLimit: 16_000_000 }, (req) => tx(req, async (c) => {
    const b = req.body; const formId = id(b.formId);
    const f = (await c.query('select id,fields,status from pulse.field_form where id=$1', [formId])).rows[0] ?? fail(404, 'Form not found');
    const checked = checkAnswers(f.fields as Field[], b.answers); if ('error' in checked) fail(400, checked.error);
    const files = Array.isArray(b.files) ? b.files as Body[] : [];
    if (files.length > MAX_FILES) fail(400, `Send at most ${MAX_FILES} photos at once`);
    const needs = fileNeeds(f.fields as Field[]);
    for (const n of needs) {
      const k = files.filter((x) => x.field === n.key).length;
      if (k < n.min) fail(400, n.type === 'signature' ? `Sign “${n.label}”` : `“${n.label}” needs ${n.min} photo${n.min === 1 ? '' : 's'}`);
      if (k > n.max) fail(400, `“${n.label}” takes at most ${n.max}`);
    }
    const decoded = files.map((x) => {
      const need = needs.find((n) => n.key === x.field) ?? fail(400, 'A photo for a field the form does not have');
      const mime = str(x.mime, 40); if (!MIME.has(mime)) fail(400, 'Photos are JPEG, PNG or WebP');
      const bytes = Buffer.from(typeof x.data === 'string' ? x.data : '', 'base64');
      if (!bytes.length || bytes.length > MAX_FILE) fail(400, 'A photo is too large: up to 5 MB');
      // Photos come from the camera on this visit: the phone app opens the camera, and a picture taken more than
      // twelve hours ago (an old one from the gallery) is refused. The time is the file's own, as the camera wrote it.
      const source = need.type === 'signature' ? 'signature' : x.source === 'camera' ? 'camera' : 'upload';
      const taken = typeof x.capturedAt === 'string' && Number.isFinite(Date.parse(x.capturedAt)) ? new Date(x.capturedAt) : null;
      if (need.type === 'photo' && (!taken || Date.now() - taken.getTime() > 12 * 3600000 || taken.getTime() - Date.now() > 5 * 60000)) fail(400, `Take “${need.label}” with the camera on this visit: older photos from the gallery are not accepted`);
      const lat = Number(x.lat), lng = Number(x.lng);
      return { meta: { field: need.key, name: str(x.name, 200) || `${need.key}.jpg`, mime, source, capturedAt: taken?.toISOString() ?? null, width: Number(x.width) || null, height: Number(x.height) || null,
        ...(Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng, accuracy: Number(x.accuracy) || null } : {}) }, bytes };
    });
    const loc = b.location && typeof b.location === 'object' ? b.location as Body : null;
    const location = loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng)) ? { lat: Number(loc.lat), lng: Number(loc.lng), accuracy: Number(loc.accuracy) || null, at: new Date().toISOString() } : null;
    const sid = (await c.query('select pulse.form_submission_open($1) id', [JSON.stringify({ formId, stepId: optId(b.stepId), flowStepId: optId(b.flowStepId), projectId: optId(b.projectId), answers: (checked as { answers: unknown }).answers,
      location, device: b.device === 'app' || String(req.headers['user-agent'] ?? '').includes('PulseShell') ? 'Pulse phone app' : 'Browser', note: str(b.note, 1000) || null })])).rows[0].id;
    for (const d of decoded) await c.query('select pulse.form_file_add($1,$2,$3)', [sid, JSON.stringify(d.meta), d.bytes]);
    return (await c.query('select pulse.form_submission_send($1) r', [sid])).rows[0].r;
  }));

  app.get<{ Querystring: { formId?: string; projectId?: string; runId?: string } }>('/api/v0/forms/submissions', (req) => tx(req, async (c) => {
    const q = req.query; const where = ['true']; const params: unknown[] = [];
    for (const [k, col] of [['formId', 's.form_id'], ['projectId', 's.project_id'], ['runId', 's.run_id']] as const) if (q[k]) { params.push(id(q[k])); where.push(`${col}=$${params.length}`); }
    return { submissions: await submissionRows(c, where.join(' and '), params, 200) };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/forms/submissions/:id', (req) => tx(req, async (c, v) => {
    const sid = id(req.params.id);
    const s = (await c.query(`select s.*,p.display_name "personName",${PHOTO('p')} "photoAt",coalesce(pr.title,pr.name) project,cl.display_name client,r.name run,w.name workflow,st.title "stepTitle",vb.display_name "voidedByName"
     from pulse.form_submission s left join pulse.person p on p.id=s.submitted_by left join pulse.project pr on pr.id=s.project_id left join pulse.client cl on cl.id=s.client_id
     left join pulse.workflow_run r on r.id=s.run_id left join pulse.workflow w on w.id=r.workflow_id left join pulse.workflow_run_step st on st.id=s.step_id left join pulse.person vb on vb.id=s.voided_by
     where s.id=$1 and s.status<>'open'`, [sid])).rows[0] ?? fail(404, 'Not found');
    await c.query('select pulse.form_submission_viewed($1)', [sid]);
    const files = (await c.query('select * from pulse.form_files($1)', [sid])).rows;
    const events = (await c.query(`select e.kind,e.at,e.note,p.display_name who from pulse.form_event e left join pulse.person p on p.id=e.actor_id where e.submission_id=$1 order by e.at`, [sid])).rows;
    return { canVoid: editor(v) && s.status === 'submitted', submission: { id: s.id, formId: s.form_id, form: s.form_name, version: s.form_version, fields: s.fields, answers: s.answers, status: s.status,
      submittedAt: s.submitted_at, person: s.personName, personId: s.submitted_by, photoAt: s.photoAt, project: s.project, projectId: s.project_id, client: s.client, clientId: s.client_id,
      runId: s.run_id, run: s.run, workflow: s.workflow, step: s.stepTitle, taskId: s.task_id, location: s.location, device: s.device, note: s.note, startedRuns: s.started_runs,
      voidedBy: s.voidedByName, voidedAt: s.voided_at, voidReason: s.void_reason },
      files: files.map((f) => ({ id: f.id, field: f.field_key, name: f.name, mime: f.mime, size: f.size, width: f.width, height: f.height, source: f.source, capturedAt: f.captured_at,
        lat: f.lat == null ? null : Number(f.lat), lng: f.lng == null ? null : Number(f.lng), accuracy: f.accuracy == null ? null : Number(f.accuracy), receivedAt: f.received_at })), events };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/forms/files/:id', async (req, reply) => {
    const file = await tx(req, async (c) => (await c.query('select * from pulse.form_file_read($1)', [id(req.params.id)])).rows[0]);
    if (!file) fail(404, 'Photo unavailable');
    return sendFile(reply, file, true);
  });
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/forms/submissions/:id/void', { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!editor(v)) fail(403, 'Leadership and admins void a sent form');
    await c.query('select pulse.form_submission_void($1,$2)', [id(req.params.id), str(req.body.reason, 500)]); return { ok: true };
  }));
}
