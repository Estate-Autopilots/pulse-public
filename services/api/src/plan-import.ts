// AC-PLAN-TOOLS (owner, 13 Nov 2026; the AC handoff's gaps 4-8, 11 and 12): put a whole plan into Pulse in one call
// (goals, projects, tasks with sub-tasks and checklist steps, docs in folders, doc links, blockers, decisions and open
// questions) and read it back as one tree. Everything runs on the caller's one transaction through the screens' own
// functions (saveGoal, work_project_save, task_save, task_block, saveDoc, addLink, plan_item_save), so row security and
// every rule decide exactly what the screens decide. Idempotent: each item carries a key (external_key, unique per
// company and kind), and a second run with the same keys changes what differs and makes nothing twice. A dry run does
// all the work inside a savepoint, reads the tree back and rolls the savepoint back, so nothing stays.
import type { PoolClient } from 'pg';
import { fail } from './routes.js';
import { ORG_TZ } from './org-time.js';
import { getGoal, linkGoal, saveGoal } from './goals.js';
import { getDoc, htmlToMarkdown, listFolders, saveDoc, saveFolder, shareDoc } from './docs.js';
import { addLink, docsFor } from './doc-interactive.js';

export type Row = Record<string, unknown>;
export type KeyKind = 'goal' | 'project' | 'task' | 'doc' | 'folder' | 'decision';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TASKS = 1000, MAX_DEPTH = 3;
const has = (o: Row, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const s = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** The same stable step key as the task page (apps/web/app/lib/task-sense.mjs stepKey), so a step ticked here shows ticked there. */
export function stepKey(text: string): string {
  const norm = String(text).toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  let h = 0x811c9dc5;
  for (const ch of norm) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return `s${h.toString(36)}`;
}

/** A task's notes with its checklist: the words first, then the steps as numbered lines (the task page's checklist). */
export function notesWithSteps(notes: string | null, steps: { label: string }[]): string | null {
  const words = (notes ?? '').split(/\r?\n/).filter(l => !/^\s*\d{1,2}[.)]\s+/.test(l)).join('\n').trim();
  const list = steps.map((x, i) => `${i + 1}. ${x.label}`).join('\n');
  const out = [words, list].filter(Boolean).join('\n\n');
  return out ? out.slice(0, 4000) : null;
}

// ------------------------------------------------------------------------------------------------ external keys
/** The record a key names, as the viewer: null when the key is free; refused when another record the viewer cannot see holds it. */
export async function keyFind(c: PoolClient, kind: KeyKind, key: string): Promise<string | null> {
  const r = (await c.query('select ref_id::text id from pulse.external_key where kind=$1 and key=$2', [kind, key])).rows[0];
  if (r) return String(r.id);
  if ((await c.query('select pulse.external_key_taken($1,$2) v', [kind, key])).rows[0]?.v) fail(409, `The key "${key}" already names a ${kind} you cannot see`);
  return null;
}
/** Give a record its key (once). A record keeps the first key it was given; a different one is refused. */
export async function keySet(c: PoolClient, kind: KeyKind, key: string, id: string) {
  const had = (await c.query('select key from pulse.external_key where kind=$1 and ref_id=$2', [kind, id])).rows[0];
  if (had) { if (had.key !== key) fail(409, `This ${kind} already has the key "${had.key}"`); return; }
  if (!(await c.query('select pulse.external_key_can_set($1,$2) v', [kind, id])).rows[0]?.v) fail(403, `Only someone who may change this ${kind} gives it a key`);
  await c.query('insert into pulse.external_key(org_id,kind,key,ref_id,created_by) values(pulse.current_org(),$1,$2,$3,pulse.current_viewer())', [kind, key, id]);
}
export async function keysOf(c: PoolClient, kind: KeyKind, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const r = (await c.query('select ref_id::text id,key from pulse.external_key where kind=$1 and ref_id=any($2::uuid[])', [kind, ids])).rows;
  return new Map(r.map(x => [String(x.id), String(x.key)]));
}

// ------------------------------------------------------------------------------------------------ people
async function personId(c: PoolClient, cache: Map<string, string>, ref: unknown, what: string): Promise<string | null> {
  if (ref === null || ref === undefined || ref === '') return null;
  const raw = String(ref).trim();
  if (cache.has(raw)) return cache.get(raw)!;
  const q = raw.replace(/^@/, '').toLowerCase();
  const r = (await c.query(`select p.id::text id from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id
      where p.side in ('staff','agent') and p.status='active' and (p.id::text=$1 or lower(pp.username)=$1 or lower(pp.email)=$1) limit 2`, [UUID.test(q) ? q : q])).rows;
  if (r.length !== 1) fail(400, `${what}: no one active in this company is "${raw}" (use a person id, @username or work e-mail)`);
  cache.set(raw, String(r[0].id));
  return String(r[0].id);
}

// ------------------------------------------------------------------------------------------------ folders
/** The folder at a path ("Plans/Sales X-Ray plan"), made where missing, each part inside the one before. */
export async function ensureFolderPath(c: PoolClient, path: string, under: string | null = null): Promise<{ id: string; created: boolean }> {
  const parts = path.split('/').map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!parts.length || parts.length > 8) fail(400, 'A folder path has 1 to 8 parts, split by /');
  let parent = under, created = false;
  for (const name of parts) {
    const found = (await c.query(`select id::text id from pulse.doc_folder where archived_at is null and lower(name)=lower($1) and parent_id is not distinct from $2::uuid
      order by created_at limit 1`, [name.slice(0, 120), parent])).rows[0];
    if (found) { parent = String(found.id); continue; }
    parent = await saveFolder(c, null, { name, parentId: parent });
    created = true;
  }
  return { id: parent!, created };
}

// ------------------------------------------------------------------------------------------------ the plan
type Stats = { created: number; updated: number; unchanged: number };
const stats = (): Stats => ({ created: 0, updated: 0, unchanged: 0 });
export type PlanResult = { dryRun: boolean; counts: Record<KeyKind | 'links' | 'blockers' | 'notified', Stats | number>; keys: Record<string, string>;
  warnings: string[]; goals: GoalTree[]; projects: ProjectTree[] };

type Ctx = { c: PoolClient; people: Map<string, string>; keys: Record<string, string>; warnings: string[]; counts: Record<string, Stats>; links: number; blockers: number;
  docIds: Map<string, string>; taskIds: Map<string, string>; assigned: Set<string>; pendingBlocks: { task: string; title: string; key: string; blockedBy: unknown[]; waitingOn: unknown }[];
  pendingLinks: { doc: unknown; kind: 'task' | 'project' | 'goal'; id: string; role: 'brief' | 'related' }[]; total: number };

const keyOf = (o: Row, what: string): string | null => {
  const k = s(o.key, 200);
  if (!k && !o.id) fail(400, `Each ${what} needs a key (or the id of an existing one), so the plan can be sent again safely`);
  return k || null;
};

/** Find the record by id or key, or null to make it. */
async function locate(x: Ctx, kind: KeyKind, o: Row, key: string | null, check: string): Promise<string | null> {
  if (o.id) {
    const id = UUID.test(String(o.id)) ? String(o.id) : fail(400, `Choose a valid ${kind} id`);
    if (!(await x.c.query(check, [id])).rowCount) fail(404, `That ${kind} (${id}) is not one you can see`);
    if (key) { const byKey = await keyFind(x.c, kind, key); if (byKey && byKey !== id) fail(409, `The key "${key}" already names another ${kind}`); if (!byKey) await keySet(x.c, kind, key, id); }
    return id;
  }
  return key ? keyFind(x.c, kind, key) : null;
}

async function doFolder(x: Ctx, f: Row): Promise<string> {
  const key = keyOf(f, 'folder');
  let id = await locate(x, 'folder', f, key, 'select 1 from pulse.doc_folder where id=$1');
  if (!id) {
    const path = s(f.path, 600) || s(f.name, 120) || fail(400, 'Give each folder a path or a name');
    const made = await ensureFolderPath(x.c, path);
    id = made.id;
    x.counts.folder[made.created ? 'created' : 'unchanged']++;
    if (key) await keySet(x.c, 'folder', key, id);
  } else x.counts.folder.unchanged++;
  if (f.access !== undefined || f.people !== undefined) {
    const people = Array.isArray(f.people) ? await Promise.all((f.people as unknown[]).map(p => personId(x.c, x.people, p, 'Folder people'))) : undefined;
    await saveFolder(x.c, id, { ...(f.access !== undefined ? { access: f.access } : {}), ...(people ? { people } : {}) });
  }
  if (key) x.keys[`folder:${key}`] = id;
  return id;
}

async function folderRef(x: Ctx, ref: unknown): Promise<string | null> {
  if (!ref) return null;
  const r = String(ref);
  if (UUID.test(r)) return r;
  if (x.keys[`folder:${r}`]) return x.keys[`folder:${r}`];
  return (await ensureFolderPath(x.c, r)).id;
}

async function doDoc(x: Ctx, d: Row): Promise<string> {
  const key = keyOf(d, 'doc');
  const id = await locate(x, 'doc', d, key, 'select 1 from pulse.doc where id=$1');
  const fields: Row = {};
  for (const k of ['title', 'markdown', 'html', 'tags', 'category']) if (has(d, k)) fields[k] = d[k];
  if (has(d, 'folder')) fields.folderId = await folderRef(x, d.folder);
  let out: string;
  if (!id) {
    out = await saveDoc(x.c, null, { ...fields, access: d.access ?? 'company' }, 'import');
    x.counts.doc.created++;
    if (key) await keySet(x.c, 'doc', key, out);
  } else {
    const old = await getDoc(x.c, id);
    const same = (!has(fields, 'title') || fields.title === old.title) && (!has(fields, 'markdown') || String(fields.markdown).trim() === htmlToMarkdown(old.html).trim())
      && !has(fields, 'html') && (!has(fields, 'category') || fields.category === old.category)
      && (!has(fields, 'tags') || JSON.stringify([...(fields.tags as string[])].map(t => t.toLowerCase()).sort()) === JSON.stringify([...old.tags].sort()))
      && (!has(fields, 'folderId') || fields.folderId === old.folderId)
      && (!has(d, 'access') || d.access === old.access);
    if (has(d, 'access') && d.access !== old.access) await shareDoc(x.c, id, { access: d.access });
    if (same) { x.counts.doc.unchanged++; out = id; } else { out = await saveDoc(x.c, id, fields, 'import'); x.counts.doc.updated++; }
  }
  if (key) { x.keys[`doc:${key}`] = out; x.docIds.set(key, out); }
  return out;
}

const docRef = (x: Ctx, ref: unknown): string => {
  const r = String(ref ?? '');
  if (UUID.test(r)) return r;
  return x.docIds.get(r) ?? fail(400, `No doc with the key "${r}" in this plan (list it under docs, or use a doc id)`);
};
function queueDocs(x: Ctx, o: Row, kind: 'task' | 'project' | 'goal', id: string) {
  if (o.brief) x.pendingLinks.push({ doc: o.brief, kind, id, role: 'brief' });
  if (o.briefDocId) x.pendingLinks.push({ doc: o.briefDocId, kind, id, role: 'brief' });
  for (const d of Array.isArray(o.docs) ? o.docs : []) x.pendingLinks.push({ doc: d, kind, id, role: 'related' });
}

async function doGoal(x: Ctx, g: Row, parentId: string | null): Promise<string> {
  const key = keyOf(g, 'goal');
  const id = await locate(x, 'goal', g, key, 'select 1 from pulse.goal where id=$1');
  const f: Row = {};
  for (const k of ['title', 'why', 'targetOn', 'level', 'measureLabel', 'startValue', 'targetValue', 'currentValue', 'status']) if (has(g, k)) f[k] = g[k];
  if (has(g, 'owner')) f.ownerId = await personId(x.c, x.people, g.owner, 'Goal owner');
  if (parentId) f.parentId = parentId;
  let out: string;
  if (!id) {
    if (!f.title) fail(400, 'Give each goal a title');
    out = await saveGoal(x.c, null, { level: 'company', ...f });
    x.counts.goal.created++;
    if (key) await keySet(x.c, 'goal', key, out);
  } else {
    const old = await getGoal(x.c, id);
    delete f.level;
    const differs = Object.keys(f).some(k => {
      const was = k === 'ownerId' ? old.ownerId : k === 'parentId' ? old.parentId : (old as unknown as Row)[k];
      return (was ?? null) !== (f[k] ?? null);
    });
    if (differs) { out = await saveGoal(x.c, id, f); x.counts.goal.updated++; } else { out = id; x.counts.goal.unchanged++; }
  }
  if (key) x.keys[`goal:${key}`] = out;
  queueDocs(x, g, 'goal', out);
  for (const p of Array.isArray(g.projects) ? g.projects as Row[] : []) {
    const pid = await doProject(x, p);
    await linkGoal(x.c, out, { projectId: pid });
    x.links++;
  }
  for (const t of Array.isArray(g.tasks) ? g.tasks as Row[] : []) {
    const tid = await doTask(x, t, null, null, 1);
    await linkGoal(x.c, out, { taskId: tid });
    x.links++;
  }
  for (const sub of Array.isArray(g.goals) ? g.goals as Row[] : []) await doGoal(x, sub, out);
  return out;
}

async function doProject(x: Ctx, p: Row): Promise<string> {
  const key = keyOf(p, 'project');
  const id = await locate(x, 'project', p, key, 'select 1 from pulse.project where id=$1');
  const f: Row = {};
  if (has(p, 'name')) f.name = s(p.name, 160);
  if (has(p, 'summary')) f.summary = p.summary === null ? '' : String(p.summary).slice(0, 1000);
  for (const k of ['startsOn', 'dueOn']) if (has(p, k)) f[k] = p[k] ?? '';
  if (has(p, 'owner')) f.ownerId = await personId(x.c, x.people, p.owner, 'Project owner');
  if (Array.isArray(p.members)) f.memberIds = await Promise.all((p.members as unknown[]).map(m => personId(x.c, x.people, m, 'Project member')));
  let out: string;
  if (!id) {
    if (!f.name) fail(400, 'Give each project a name');
    const r = (await x.c.query('select pulse.work_project_save(null,$1) v', [JSON.stringify({ type: 'internal', ...f })])).rows[0]?.v as Row;
    out = String(r?.id ?? r?.projectId ?? fail(409, 'The project could not be made'));
    x.counts.project.created++;
    if (key) await keySet(x.c, 'project', key, out);
  } else {
    const old = (await x.c.query(`select coalesce(p.title,p.name) name,wp.summary,wp.owner_id::text "ownerId",to_char(wp.starts_on,'YYYY-MM-DD') "startsOn",to_char(wp.due_on,'YYYY-MM-DD') "dueOn"
      from pulse.project p left join pulse.work_project wp on wp.project_id=p.id where p.id=$1`, [id])).rows[0] as Row | undefined;
    const differs = Object.keys(f).some(k => k === 'memberIds' || (old?.[k] ?? '') !== (f[k] ?? ''));
    if (differs) { await x.c.query('select pulse.work_project_save($1,$2)', [id, JSON.stringify(f)]); x.counts.project.updated++; } else x.counts.project.unchanged++;
    out = id;
  }
  if (key) x.keys[`project:${key}`] = out;
  queueDocs(x, p, 'project', out);
  for (const t of Array.isArray(p.tasks) ? p.tasks as Row[] : []) await doTask(x, t, out, null, 1);
  return out;
}

const STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'];
async function doTask(x: Ctx, t: Row, projectId: string | null, parentId: string | null, depth: number): Promise<string> {
  if (depth > MAX_DEPTH) fail(400, `Sub-tasks go ${MAX_DEPTH} levels deep at most`);
  if (++x.total > MAX_TASKS) fail(400, `A plan holds at most ${MAX_TASKS} tasks; send the rest in another call`);
  const key = keyOf(t, 'task');
  const id = await locate(x, 'task', t, key, 'select 1 from pulse.task where id=$1 and deleted_at is null');
  const steps = (Array.isArray(t.checklist) ? t.checklist as unknown[] : []).map(v => typeof v === 'string' ? { label: s(v, 500), done: false } : { label: s((v as Row)?.label, 500), done: (v as Row)?.done === true }).filter(v => v.label);
  const f: Row = {};
  if (has(t, 'title')) f.title = s(t.title, 300);
  for (const k of ['priority', 'dueOn', 'dueAt']) if (has(t, k)) f[k] = t[k];
  if (has(t, 'assignee')) f.assigneeId = await personId(x.c, x.people, t.assignee, 'Task assignee');
  if (has(t, 'reviewer')) f.reviewerId = await personId(x.c, x.people, t.reviewer, 'Task reviewer');
  if (has(t, 'notes') || steps.length) f.notes = notesWithSteps(has(t, 'notes') ? String(t.notes ?? '') : null, steps);
  if (projectId) f.projectId = projectId;
  if (parentId) f.parentId = parentId;
  let out: string;
  if (!id) {
    if (!f.title) fail(400, 'Give each task a title');
    if (!has(f, 'notes') && !has(t, 'notes')) delete f.notes;
    out = String((await x.c.query('select pulse.task_save(null,$1) v', [JSON.stringify(f)])).rows[0].v);
    x.counts.task.created++;
    if (key) await keySet(x.c, 'task', key, out);
    if (f.assigneeId) x.assigned.add(String(f.assigneeId));
  } else {
    const old = (await x.c.query(`select title,priority,notes,assignee_person_id::text "assigneeId",review_owner_id::text "reviewerId",project_id::text "projectId",parent_id::text "parentId",
        to_char(due_at at time zone ${ORG_TZ},'YYYY-MM-DD') "dueOn",status from pulse.task where id=$1`, [id])).rows[0] as Row;
    if (has(t, 'notes') === false && steps.length && old.notes) f.notes = notesWithSteps(String(old.notes), steps);
    const differs = Object.keys(f).some(k => k !== 'dueAt' && (old[k] ?? null) !== (f[k] ?? null)) || has(f, 'dueAt');
    if (differs) { await x.c.query('select pulse.task_save($1,$2)', [id, JSON.stringify(f)]); x.counts.task.updated++; } else x.counts.task.unchanged++;
    out = id;
  }
  // Ticked steps: the task page's checklist keeps a row per ticked step (task_check, keyed like the page).
  for (const st of steps) if (st.done) await x.c.query('select pulse.task_check_set($1,$2,$3,true)', [out, stepKey(st.label), st.label]);
  if (has(t, 'status')) {
    const want = String(t.status);
    if (!STATUSES.includes(want)) fail(400, `A task's status is one of ${STATUSES.join(', ')}`);
    const now = (await x.c.query('select status from pulse.task where id=$1', [out])).rows[0]?.status;
    if (now !== want && !(want === 'done' && ['accepted', 'in_review'].includes(String(now)))) await x.c.query('select pulse.task_move($1,$2,$3)', [out, want, s(t.statusNote, 300) || null]);
  }
  if (key) { x.keys[`task:${key}`] = out; x.taskIds.set(key, out); }
  queueDocs(x, t, 'task', out);
  if ((Array.isArray(t.blockedBy) && t.blockedBy.length) || t.waitingOn) x.pendingBlocks.push({ task: out, title: String(f.title ?? t.title ?? ''), key: key ?? out, blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy : [], waitingOn: t.waitingOn });
  for (const sub of Array.isArray(t.subtasks) ? t.subtasks as Row[] : []) await doTask(x, sub, projectId, out, depth + 1);
  return out;
}

/** blockedBy: tasks (keys from this plan, or ids) this one waits on; they unblock it by themselves when they finish.
 *  waitingOn "@person: what" makes a small task for that person and waits on it; any other words mark it blocked
 *  with that note (something outside Pulse: someone unblocks it by hand). */
async function doBlocks(x: Ctx) {
  for (const b of x.pendingBlocks) {
    const blockers: string[] = [];
    for (const ref of b.blockedBy) {
      const r = String(ref);
      blockers.push(UUID.test(r) ? r : x.taskIds.get(r) ?? (await keyFind(x.c, 'task', r)) ?? fail(400, `"${b.key}" waits on "${r}", which is not a task in this plan`));
    }
    const w = typeof b.waitingOn === 'string' ? b.waitingOn.trim() : '';
    const who = w.match(/^@([A-Za-z0-9._-]{2,60})\s*[:—-]?\s*(.*)$/);
    if (who) {
      const person = await personId(x.c, x.people, `@${who[1]}`, 'Waiting on');
      const wkey = `${b.key}~wait`;
      const found = await keyFind(x.c, 'task', wkey);
      const title = s(who[2], 280) || `Unblock: ${b.title}`.slice(0, 300);
      let wid = found;
      if (!wid) {
        wid = String((await x.c.query('select pulse.task_save(null,$1) v', [JSON.stringify({ title, assigneeId: person, notes: `Someone is waiting on this: ${b.title}` })])).rows[0].v);
        await keySet(x.c, 'task', wkey, wid); x.counts.task.created++; if (person) x.assigned.add(person);
      }
      blockers.push(wid);
    }
    for (const blocker of blockers) {
      const open = (await x.c.query('select 1 from pulse.task_link where task_id=$1 and blocker_id=$2 and cleared_at is null', [b.task, blocker])).rowCount;
      if (open) continue;
      const done = (await x.c.query(`select status in ('done','accepted','in_review','cancelled') v from pulse.task where id=$1`, [blocker])).rows[0]?.v;
      if (done) { x.warnings.push(`"${b.key}": its blocker is finished already, so it does not wait`); continue; }
      await x.c.query('select pulse.task_block($1,$2,$3)', [b.task, blocker, null]);
      x.blockers++;
    }
    if (w && !who) {
      const st = (await x.c.query('select status from pulse.task where id=$1', [b.task])).rows[0]?.status;
      if (['open', 'in_progress', 'unknown'].includes(String(st))) { await x.c.query('select pulse.task_move($1,$2,$3)', [b.task, 'blocked', `Waiting on: ${w}`.slice(0, 300)]); x.blockers++; }
    }
  }
}

async function doDecision(x: Ctx, d: Row) {
  const key = keyOf(d, 'decision');
  const id = await locate(x, 'decision', d, key, 'select 1 from pulse.plan_item where id=$1');
  const ref = (k: string, kind: string) => {
    const v = d[k]; if (!v) return undefined;
    const r = String(v); if (UUID.test(r)) return r;
    return x.keys[`${kind}:${r}`] ?? fail(400, `"${key}": no ${kind} with the key "${r}" in this plan`);
  };
  const f: Row = {};
  for (const k of ['kind', 'ref', 'text', 'saidBy', 'saidOn', 'quote', 'status', 'answer']) if (has(d, k)) f[k] = d[k];
  if (has(d, 'owner')) f.ownerId = await personId(x.c, x.people, d.owner, 'Decision owner');
  for (const [k, kind, field] of [['doc', 'doc', 'docId'], ['goal', 'goal', 'goalId'], ['project', 'project', 'projectId']] as const) if (has(d, k)) f[field] = ref(k, kind) ?? null;
  let out: string;
  if (!id) {
    out = String((await x.c.query('select pulse.plan_item_save(null,$1) v', [JSON.stringify(f)])).rows[0].v);
    x.counts.decision.created++;
    if (key) await keySet(x.c, 'decision', key, out);
  } else {
    const old = (await x.c.query(`select kind,ref,text,said_by "saidBy",said_on::text "saidOn",quote,status,answer,owner_person_id::text "ownerId",doc_id::text "docId",goal_id::text "goalId",project_id::text "projectId"
      from pulse.plan_item where id=$1`, [id])).rows[0] as Row;
    delete f.kind;
    if (Object.keys(f).some(k => (old[k] ?? null) !== (f[k] ?? null))) { await x.c.query('select pulse.plan_item_save($1,$2)', [id, JSON.stringify(f)]); x.counts.decision.updated++; } else x.counts.decision.unchanged++;
    out = id;
  }
  for (const t of Array.isArray(d.drives) ? d.drives : []) {
    const r = String(t);
    const tid = UUID.test(r) ? r : x.taskIds.get(r) ?? fail(400, `"${key}" drives "${r}", which is not a task in this plan`);
    await x.c.query('select pulse.plan_item_link_add($1,$2,$3)', [out, 'task', tid]);
  }
  if (key) x.keys[`decision:${key}`] = out;
}

export type PlanInput = { goals?: Row[]; projects?: Row[]; tasks?: Row[]; folders?: Row[]; docs?: Row[]; decisions?: Row[]; notify?: 'digest' | 'now' | 'none'; dryRun?: boolean; title?: string; key?: string };

/** Apply a plan on the caller's transaction. Order: folders, docs, goals (their projects and tasks), loose projects and
 *  tasks, blockers, doc links, decisions, then one digest per person. A failure anywhere fails the whole call. */
export async function applyPlan(c: PoolClient, plan: PlanInput, withDocs = true): Promise<PlanResult> {
  const dry = plan.dryRun === true, notify = plan.notify ?? 'digest';
  if (!(await c.query('select pulse.current_viewer() v')).rows[0]?.v) fail(403, 'Sign in to apply a plan');
  if (dry) await c.query('savepoint plan_dry_run');
  await c.query(`select set_config('pulse.notify_mode',$1,true)`, [notify === 'now' ? '' : notify]);
  const x: Ctx = { c, people: new Map(), keys: {}, warnings: [], counts: { goal: stats(), project: stats(), task: stats(), doc: stats(), folder: stats(), decision: stats() },
    links: 0, blockers: 0, docIds: new Map(), taskIds: new Map(), assigned: new Set(), pendingBlocks: [], pendingLinks: [], total: 0 };
  let result: PlanResult;
  try {
    for (const f of plan.folders ?? []) await doFolder(x, f);
    for (const d of plan.docs ?? []) await doDoc(x, d);
    const goalIds: string[] = [];
    for (const g of plan.goals ?? []) goalIds.push(await doGoal(x, g, null));
    const projectIds: string[] = [];
    for (const p of plan.projects ?? []) projectIds.push(await doProject(x, p));
    for (const t of plan.tasks ?? []) await doTask(x, t, null, null, 1);
    await doBlocks(x);
    for (const l of x.pendingLinks) { await addLink(c, docRef(x, l.doc), { kind: l.kind, id: l.id, role: l.role }); x.links++; }
    for (const d of plan.decisions ?? []) await doDecision(x, d);
    await c.query(`select set_config('pulse.notify_mode','',true)`);
    let notified = 0;
    if (notify === 'digest') {
      const title = s(plan.title, 120) || (goalIds[0] ? (await getGoal(c, goalIds[0])).title : '');
      const href = goalIds[0] ? `/goals/${goalIds[0]}` : projectIds[0] ? `/projects/${projectIds[0]}` : '';
      for (const p of x.assigned) notified += Number((await c.query('select pulse.plan_notify_digest($1,$2,$3,$4) v', [p, title, href, s(plan.key, 80) || 'plan'])).rows[0]?.v ?? 0) > 0 ? 1 : 0;
    }
    result = { dryRun: dry, counts: { ...x.counts, links: x.links, blockers: x.blockers, notified } as PlanResult['counts'], keys: x.keys, warnings: x.warnings,
      goals: await Promise.all(goalIds.map(id => goalTree(c, id, withDocs))), projects: await Promise.all(projectIds.map(id => projectTree(c, id, withDocs))) };
  } catch (e) {
    if (dry) await c.query('rollback to savepoint plan_dry_run').catch(() => undefined);
    throw e;
  }
  if (dry) { await c.query('rollback to savepoint plan_dry_run'); await c.query('release savepoint plan_dry_run'); }
  return result;
}

// ------------------------------------------------------------------------------------------------ the tree, read back
export type DocRef = { id: string; title: string; role: string };
export type TaskNode = { id: string; key: string | null; title: string; status: string; assignee: string | null; assigneeId: string | null; dueOn: string | null; priority: string | null;
  steps: { label: string; done: boolean }[]; blockedBy: { id: string; title: string; status: string }[]; docs: DocRef[]; subtasks: TaskNode[] };
export type ProjectTree = { id: string; key: string | null; name: string; summary: string | null; owner: string | null; dueOn: string | null; brief: DocRef | null; docs: DocRef[];
  tasks: TaskNode[]; openTasks: number; doneTasks: number };
export type GoalTree = { id: string; key: string | null; title: string; why: string | null; level: string; status: string; targetOn: string | null; owner: string | null;
  progress: number; brief: DocRef | null; docs: DocRef[]; projects: ProjectTree[]; tasks: TaskNode[];
  decisions: { id: string; kind: string; ref: string | null; text: string; status: string; saidBy: string | null }[] };

/** A connection without docs.read gets no doc titles (withDocs false). */
const docRefs = async (c: PoolClient, kind: string, id: string, withDocs = true): Promise<DocRef[]> =>
  withDocs ? (await docsFor(c, kind, id)).map(d => ({ id: d.id, title: d.title, role: d.role ?? 'mention' })) : [];

/** Tasks under a project (roots) or a parent, with steps, blockers and sub-tasks, MAX_DEPTH levels deep. */
async function taskNodes(c: PoolClient, where: { projectId?: string; parentId?: string; ids?: string[] }, depth = 1, withDocs = true): Promise<TaskNode[]> {
  const r = (await c.query(`select t.id::text id,t.title,t.status,a.display_name assignee,t.assignee_person_id::text "assigneeId",to_char(t.due_at at time zone ${ORG_TZ},'YYYY-MM-DD') "dueOn",
      t.priority,t.notes from pulse.task t left join pulse.person a on a.id=coalesce(t.assignee_person_id,t.owner_id)
    where t.deleted_at is null and ($1::uuid is null or (t.project_id=$1 and t.parent_id is null)) and ($2::uuid is null or t.parent_id=$2) and ($3::uuid[] is null or t.id=any($3))
    order by t.created_at,t.id limit 300`, [where.projectId ?? null, where.parentId ?? null, where.ids ?? null])).rows as Row[];
  if (!r.length) return [];
  const ids = r.map(t => String(t.id));
  const keys = await keysOf(c, 'task', ids);
  const done = (await c.query('select task_id::text id,step_key k from pulse.task_check where task_id=any($1::uuid[])', [ids])).rows;
  const blockers = (await c.query(`select l.task_id::text id,b.id::text bid,b.title,b.status from pulse.task_link l join pulse.task b on b.id=l.blocker_id
    where l.task_id=any($1::uuid[]) and l.cleared_at is null order by l.created_at`, [ids])).rows;
  const out: TaskNode[] = [];
  for (const t of r) {
    const id = String(t.id);
    const ticked = new Set(done.filter(d => d.id === id).map(d => String(d.k)));
    const steps = String(t.notes ?? '').split(/\r?\n/).map(l => l.trim().match(/^(\d{1,2})[.)]\s+(.+)$/)).filter(Boolean).map(m => ({ label: m![2].trim(), done: ticked.has(stepKey(m![2].trim())) }));
    out.push({ id, key: keys.get(id) ?? null, title: String(t.title), status: String(t.status), assignee: (t.assignee as string) ?? null, assigneeId: (t.assigneeId as string) ?? null,
      dueOn: (t.dueOn as string) ?? null, priority: (t.priority as string) ?? null, steps,
      blockedBy: blockers.filter(b => b.id === id).map(b => ({ id: String(b.bid), title: String(b.title), status: String(b.status) })),
      docs: await docRefs(c, 'task', id, withDocs), subtasks: depth < MAX_DEPTH ? await taskNodes(c, { parentId: id }, depth + 1, withDocs) : [] });
  }
  return out;
}

export async function projectTree(c: PoolClient, id: string, withDocs = true): Promise<ProjectTree> {
  const p = (await c.query(`select p.id::text id,coalesce(p.title,p.name) name,wp.summary,o.display_name owner,to_char(wp.due_on,'YYYY-MM-DD') "dueOn",
      (select count(*) from pulse.task t where t.project_id=p.id and t.deleted_at is null and t.status not in ('done','accepted','cancelled'))::int open,
      (select count(*) from pulse.task t where t.project_id=p.id and t.deleted_at is null and t.status in ('done','accepted'))::int done
    from pulse.project p left join pulse.work_project wp on wp.project_id=p.id left join pulse.person o on o.id=coalesce(wp.owner_id,p.lead_person_id) where p.id=$1`, [id])).rows[0]
    ?? fail(404, 'Project not found or not visible to you');
  const docs = await docRefs(c, 'project', id, withDocs);
  return { id, key: (await keysOf(c, 'project', [id])).get(id) ?? null, name: String(p.name ?? ''), summary: p.summary ?? null, owner: p.owner ?? null, dueOn: p.dueOn ?? null,
    brief: docs.find(d => d.role === 'brief') ?? null, docs, tasks: await taskNodes(c, { projectId: id }, 1, withDocs), openTasks: Number(p.open), doneTasks: Number(p.done) };
}

/** A goal with everything under it: projects (with their tasks, steps, blockers and docs), its own tasks, its brief and
 *  other docs, and its decisions and open questions. One read, so an agent can check what it wrote. */
export async function goalTree(c: PoolClient, id: string, withDocs = true): Promise<GoalTree> {
  const g = await getGoal(c, id);
  const links = (await c.query('select project_id::text p,task_id::text t from pulse.goal_link where goal_id=$1 order by added_at,id', [id])).rows;
  const projects: ProjectTree[] = [];
  for (const l of links.filter(l => l.p).slice(0, 60)) {
    if ((await c.query('select 1 from pulse.project where id=$1', [l.p])).rowCount) projects.push(await projectTree(c, String(l.p), withDocs));
  }
  const taskIds = links.filter(l => l.t).map(l => String(l.t));
  const docs = await docRefs(c, 'goal', id, withDocs);
  const decisions = (await c.query(`select i.id::text id,i.kind,i.ref,i.text,i.status,i.said_by "saidBy" from pulse.plan_item i
    where (i.goal_id=$1 or i.project_id=any($2::uuid[]) or i.doc_id=any($3::uuid[]))
      and (i.doc_id is null or $4::boolean) order by i.kind,i.created_at,i.id limit 200`,
    [id, projects.map(p => p.id), docs.map(d => d.id), withDocs])).rows as GoalTree['decisions'];
  return { id, key: (await keysOf(c, 'goal', [id])).get(id) ?? null, title: g.title, why: g.why ?? null, level: g.level, status: g.status, targetOn: g.targetOn ?? null,
    owner: g.owner ?? null, progress: Number(g.progress?.progress ?? 0), brief: docs.find(d => d.role === 'brief') ?? null, docs, projects,
    tasks: taskIds.length ? await taskNodes(c, { ids: taskIds }, 1, withDocs) : [], decisions };
}

/** The brief (and other docs) of one task, project or goal, for get_task / get_project / get_goal: the brief's words come
 *  along, so every AI session starts from the same context. */
export async function briefOf(c: PoolClient, kind: 'task' | 'project' | 'goal', id: string) {
  const docs = await docRefs(c, kind, id);
  const b = docs.find(d => d.role === 'brief');
  let brief: { id: string; title: string; markdown: string } | null = null;
  if (b) {
    const md = htmlToMarkdown((await getDoc(c, b.id)).html);
    brief = { id: b.id, title: b.title, markdown: md.length > 20000 ? `${md.slice(0, 20000)}\n\n[… cut here: read the whole brief with get_doc ${b.id}]` : md };
  }
  return { brief, docs };
}

/** What the viewer waits on, and who waits on the viewer (or on one person). */
export async function waiting(c: PoolClient, person: string) {
  const mine = (await c.query(`select t.id::text id,t.title,t.status,b.id::text "blockerId",b.title "blockerTitle",b.status "blockerStatus",ba.display_name "blockerWho",l.note
      from pulse.task t join pulse.task_link l on l.task_id=t.id and l.cleared_at is null join pulse.task b on b.id=l.blocker_id
      left join pulse.person ba on ba.id=coalesce(b.assignee_person_id,b.owner_id)
    where t.deleted_at is null and coalesce(t.assignee_person_id,t.owner_id)=$1 and t.status not in ('done','accepted','cancelled') order by t.due_at nulls last,t.created_at limit 200`, [person])).rows;
  const outside = (await c.query(`select t.id::text id,t.title,t.status from pulse.task t where t.deleted_at is null and coalesce(t.assignee_person_id,t.owner_id)=$1 and t.status='blocked'
      and not exists(select 1 from pulse.task_link l where l.task_id=t.id and l.cleared_at is null) order by t.due_at nulls last limit 100`, [person])).rows;
  const theirs = (await c.query(`select b.id::text id,b.title,b.status,t.id::text "waiterId",t.title "waiterTitle",ta.display_name "waiterWho"
      from pulse.task b join pulse.task_link l on l.blocker_id=b.id and l.cleared_at is null join pulse.task t on t.id=l.task_id
      left join pulse.person ta on ta.id=coalesce(t.assignee_person_id,t.owner_id)
    where b.deleted_at is null and coalesce(b.assignee_person_id,b.owner_id)=$1 and b.status not in ('done','accepted','cancelled') order by b.due_at nulls last,b.created_at limit 200`, [person])).rows;
  type Wait = { taskId: string; task: string; status: string; on: { kind: string; id: string | null; title: string; status: string; who: string | null }; note: string | null };
  const waitingOn: Wait[] = mine.map((r): Wait => ({ taskId: String(r.id), task: String(r.title), status: String(r.status), on: { kind: 'task', id: String(r.blockerId), title: String(r.blockerTitle), status: String(r.blockerStatus), who: (r.blockerWho as string) ?? null }, note: (r.note as string) ?? null }))
      .concat(outside.map((r): Wait => ({ taskId: String(r.id), task: String(r.title), status: String(r.status), on: { kind: 'outside', id: null, title: 'Something outside Pulse (see the task)', status: 'open', who: null }, note: null })));
  return {
    waitingOn,
    waitingOnMe: theirs.map(r => ({ taskId: String(r.id), task: String(r.title), status: String(r.status), waiter: { id: String(r.waiterId), title: String(r.waiterTitle), who: (r.waiterWho as string) ?? null } })),
  };
}

/** The workflow log (T7.2): one run per big workflow, appended by its lane; a run key makes a retry change nothing. */
export async function logRun(c: PoolClient, b: Row) {
  const key = s(b.runKey, 200) || null;
  if (key) {
    const had = (await c.query('select id::text id from pulse.workflow_log_run where run_key=$1', [key])).rows[0];
    if (had) return { id: String(had.id), created: false };
  }
  if (b.taskId && !(await c.query('select 1 from pulse.task where id=$1', [b.taskId])).rowCount) fail(404, 'Task not found');
  const started = String(b.startedAt), ended = b.endedAt ? String(b.endedAt) : null;
  if (Number.isNaN(Date.parse(started)) || (ended && Number.isNaN(Date.parse(ended)))) fail(400, 'startedAt and endedAt are ISO times');
  const id = (await c.query(`insert into pulse.workflow_log_run(org_id,lane,workflow,started_at,ended_at,outcome,steps,failures,why,lesson,playbook,run_key,task_id,created_by)
      values(pulse.current_org(),$1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,pulse.current_viewer()) returning id::text id`,
    [s(b.lane, 80), s(b.workflow, 160), started, ended, String(b.outcome ?? 'ok'), JSON.stringify(b.steps ?? []), JSON.stringify(b.failures ?? []),
      typeof b.why === 'string' ? b.why.slice(0, 4000) : null, typeof b.lesson === 'string' ? b.lesson.slice(0, 4000) : null,
      typeof b.playbook === 'string' ? b.playbook.slice(0, 2000) : null, key, b.taskId && UUID.test(String(b.taskId)) ? String(b.taskId) : null])).rows[0].id;
  return { id: String(id), created: true };
}
export async function listRuns(c: PoolClient, q: { lane?: string; since?: string; limit?: number }) {
  const since = q.since && DAY.test(q.since.slice(0, 10)) ? q.since : null;
  return (await c.query(`select r.id::text id,r.lane,r.workflow,r.started_at::text "startedAt",r.ended_at::text "endedAt",r.duration_s "durationS",r.outcome,r.steps,r.failures,
      r.why,r.lesson,r.playbook,r.run_key "runKey",r.task_id::text "taskId",p.display_name "by" from pulse.workflow_log_run r left join pulse.person p on p.id=r.created_by
    where ($1::text is null or r.lane=$1) and ($2::timestamptz is null or r.started_at>=$2) order by r.started_at desc,r.id limit $3`,
    [q.lane ?? null, since, Math.min(Math.max(q.limit ?? 50, 1), 200)])).rows;
}

export { listFolders };
