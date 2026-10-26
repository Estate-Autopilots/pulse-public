import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from './routes.js';
import { matchPerson, matchProject, parseQuick, type QuickPerson, type QuickProject } from './task-quick.js';
import { projectsMatching, staffList } from './tasks.js';
import { ORG_TZ } from './org-time.js';
import { createWorkTask } from './work.js';

type Row = { title: string; status?: string; assignee?: string; assigneeId?: string; project?: string; projectId?: string; due?: string; priority?: string; skip?: boolean };
type Input = { importKey: string; preview: boolean; dateOrder?: 'dmy' | 'mdy'; rows: Row[] };
type Problem = { field: string; code: string; message: string };
type Person = { id: string; name: string; isAgent: boolean };
type Resolved = { row: number; title: string; status: string; assignee: Person | null; project: QuickProject | null; dueOn: string | null; priority: string;
  defaults: string[]; problems: Problem[]; candidates: { assignee?: Person[]; project?: QuickProject[] }; duplicateOf: string | null; duplicateInPaste: number | null };
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const STATUS: Record<string, string> = { todo: 'open', 'to do': 'open', new: 'open', open: 'open', doing: 'in_progress', 'in progress': 'in_progress', in_progress: 'in_progress', wip: 'in_progress', started: 'in_progress', blocked: 'blocked', waiting: 'blocked', 'on hold': 'blocked', done: 'done', complete: 'done', finished: 'done' };
const person = (p: QuickPerson): Person => ({ id: p.id, name: p.name, isAgent: p.isAgent === true });
const normalized = (s: string) => s.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const validDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;

function input(value: Input): Input {
  if (!value || !UUID.test(value.importKey) || typeof value.preview !== 'boolean') fail(400, 'Send an importKey UUID and choose preview or import');
  if (!Array.isArray(value.rows) || !value.rows.length) fail(400, 'Paste at least one task');
  if (value.rows.length > 200) fail(400, 'Import at most 200 rows at a time');
  if (value.dateOrder !== undefined && !['dmy', 'mdy'].includes(value.dateOrder)) fail(400, 'Choose day-first or month-first dates');
  const keys = new Set(['title', 'status', 'assignee', 'assigneeId', 'project', 'projectId', 'due', 'priority', 'skip']);
  for (const r of value.rows) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.entries(r).some(([k, v]) => !keys.has(k) || (k === 'skip' ? typeof v !== 'boolean' : typeof v !== 'string' || v.length > 1200))) fail(400, 'Send task rows with text fields and an optional skip choice');
  }
  return { ...value, importKey: value.importKey.toLowerCase() };
}

function dueDate(raw: string, today: string, order: Input['dateOrder'], problems: Problem[]) {
  const bad = (code: string, message: string) => problems.push({ field: 'due', code, message });
  let text = raw.trim();
  const numeric = text.match(/^(\d{1,2})([/-])(\d{1,2})(?:\2(\d{4}))?$/);
  if (numeric) {
    const a = Number(numeric[1]), b = Number(numeric[3]), day = order === 'mdy' ? b : a, month = order === 'mdy' ? a : b;
    if (!order && a <= 12 && b <= 12) bad('ambiguousDate', 'Interpreted day-first; choose a date order to confirm');
    text = numeric[4] ? `${numeric[4]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : `${day}/${month}`;
  }
  const parsed = parseQuick(`Import ${text}`, today, [], []);
  if (parsed.title !== 'Import' || !parsed.dueOn || !validDay(parsed.dueOn)) { bad('invalidDate', 'Choose a valid due date'); return null; }
  return parsed.dueOn;
}

async function resolve(c: PoolClient, v: Viewer, b: Input): Promise<Resolved[]> {
  const people = await staffList(c, true), self = people.find(p => p.id === v.person);
  const today = (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d as string;
  const projectNames = new Map<string, QuickProject[]>();
  for (const r of b.rows) if (r.project?.trim() && !r.projectId && !projectNames.has(r.project.trim())) projectNames.set(r.project.trim(), await projectsMatching(c, '', [r.project.trim()]));
  const ids = b.rows.flatMap(r => r.projectId && UUID.test(r.projectId) ? [r.projectId] : []);
  const projects = ids.length ? (await c.query(`select id,coalesce(title,name) name from pulse.project where id=any($1::uuid[]) and status<>'cancelled'`, [ids])).rows as QuickProject[] : [];
  const result = b.rows.map((r, row): Resolved => {
    const out: Resolved = { row, title: (r.title ?? '').trim(), status: 'open', assignee: self ? person(self) : null, project: null, dueOn: null, priority: 'normal', defaults: [], problems: [], candidates: {}, duplicateOf: null, duplicateInPaste: null };
    const problem = (field: string, code: string, message: string) => out.problems.push({ field, code, message });
    if (!out.title || [...out.title].length > 300) problem('title', 'invalidTitle', 'Give the task a title of 1 to 300 characters');
    for (const field of ['status', 'assignee', 'project', 'due', 'priority'] as const) if (!r[field]?.trim() && !(field === 'assignee' && r.assigneeId) && !(field === 'project' && r.projectId)) out.defaults.push(field);
    if (r.status?.trim()) {
      const key = r.status.trim().toLowerCase(), known = Object.hasOwn(STATUS, key);
      out.status = known ? STATUS[key] : 'open';
      if (!known || (!b.preview && !['open', 'in_progress', 'blocked', 'done'].includes(r.status))) problem('status', 'invalidStatus', 'Choose open, in_progress, blocked or done');
    }
    if (r.priority?.trim()) {
      const parsed = parseQuick(`Import !${r.priority.trim().toLowerCase().replace(/^!/, '')}`, today, [], []);
      out.priority = parsed.priority;
      if (parsed.title !== 'Import' || (!b.preview && !['low', 'normal', 'high', 'urgent'].includes(r.priority))) problem('priority', 'invalidPriority', 'Choose low, normal, high or urgent');
    }
    if (r.assigneeId) {
      const found = people.find(p => p.id === r.assigneeId?.toLowerCase());
      out.assignee = found ? person(found) : null;
      if (!found) problem('assignee', 'unknownAssignee', 'Choose a visible team member or AI employee');
    } else if (r.assignee?.trim()) {
      const found = matchPerson(r.assignee.trim(), people, self ?? null);
      out.assignee = found.person ? person(found.person) : null;
      if (found.problem) problem('assignee', found.candidates ? 'ambiguousAssignee' : 'unknownAssignee', found.problem);
      if (found.candidates) out.candidates.assignee = found.candidates.slice(0, 50).map(person);
    }
    if (r.projectId) {
      out.project = projects.find(p => p.id === r.projectId?.toLowerCase()) ?? null;
      if (!out.project) problem('project', 'unknownProject', 'Choose a visible project');
    } else if (r.project?.trim()) {
      const found = matchProject(r.project.trim(), projectNames.get(r.project.trim()) ?? []);
      out.project = found.project;
      if (found.problem) problem('project', found.candidates ? 'ambiguousProject' : 'unknownProject', found.problem);
      if (found.candidates) out.candidates.project = found.candidates;
    }
    if (r.due?.trim()) out.dueOn = dueDate(r.due, today, b.dateOrder, out.problems);
    return out;
  });
  const seen = new Map<string, number>();
  for (const r of result) { const key = normalized(r.title); if (seen.has(key)) r.duplicateInPaste = seen.get(key)!; else seen.set(key, r.row); }
  // At most one visible unfinished match per input row; no unbounded task list leaves PostgreSQL/RLS.
  const duplicates = await c.query(`select r.idx,t.id from jsonb_to_recordset($1::jsonb) r(idx int,title text,project uuid) cross join lateral
   (select e.id from pulse.task e where e.org_id=pulse.current_org() and e.status in ('open','in_progress','blocked','unknown')
    and lower(regexp_replace(btrim(normalize(e.title,NFKC)),'[[:space:]]+',' ','g'))=r.title and (r.project is null or e.project_id=r.project) order by e.id limit 1) t`,
  [JSON.stringify(result.map(r => ({ idx: r.row, title: normalized(r.title), project: r.project?.id ?? null })))]);
  for (const d of duplicates.rows) result[d.idx].duplicateOf = d.id;
  return result;
}

export function registerTaskImportRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // Body validation stays inside tx: anonymous requests authenticate before malformed input is explained.
  app.post<{ Body: Input }>('/api/v0/tasks/import', { bodyLimit: 1024 * 1024 }, (req, reply) => tx(req, async (c, v) => {
    if (!v.person || (v.side && v.side !== 'staff')) fail(403, 'Sign in with your own staff account to use tasks');
    const b = input(req.body);
    if (!b.preview) {
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`task-import:${v.org}:${b.importKey}`]);
      const receipt = (await c.query('select creator_id,result from pulse.task_import where import_key=$1', [b.importKey])).rows[0];
      if (receipt) {
        if (receipt.creator_id !== v.person) fail(409, 'This import key belongs to another person; start a new import');
        return { ...receipt.result, replay: true };
      }
    }
    const rows = await resolve(c, v, b);
    if (b.preview) return { rows };
    if (rows.some(r => !b.rows[r.row].skip && r.problems.length)) { reply.code(400); return { error: 'Correct or skip the rows with problems before importing', rows }; }
    const created: { row: number; id: string; asked: unknown }[] = [], skipped: number[] = [];
    for (const r of rows) {
      if (b.rows[r.row].skip) { skipped.push(r.row); continue; }
      const made = await createWorkTask(c, v, { title: r.title, assigneeId: r.assignee?.id ?? v.person, projectId: r.project?.id ?? null, dueOn: r.dueOn, priority: r.priority });
      if (r.status !== 'open') await c.query('select pulse.task_move($1,$2,null)', [made.id, r.status]);
      created.push({ row: r.row, id: made.id, asked: made.asked });
    }
    const result = { created, skipped, replay: false };
    await c.query('insert into pulse.task_import(org_id,import_key,creator_id,result) values($1,$2,$3,$4)', [v.org, b.importKey, v.person, JSON.stringify(result)]);
    return result;
  }));
}
