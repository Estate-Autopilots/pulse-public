// Screen entities and RLS, on the v1 transaction. Membership is applied before the keyset seek/limit.
import { FROM, saveTask } from './tasks.js';
import { saveWorkProject } from './work.js';
import { defineV1Operation, v1Fail, type Closed, type V1Context, type V1Input } from './v1.js';
import { PAGE_QUERY, pageResponse, pageV1 } from './v1-paging.js';

const object = (properties: Closed['properties'], required = Object.keys(properties)): Closed =>
  ({ type: 'object', additionalProperties: false, properties, required });
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' };
const text = { type: 'string' }, nullable = { type: ['string', 'null'] };
const task = object({ id: uuid, title: text, status: text, projectId: nullable, assigneeId: nullable,
  assigneeKind: { enum: ['staff', 'agent', null] }, priority: text, notes: nullable });
const project = object({ id: uuid, name: text, status: text, summary: nullable });
const TASK = `t.id,t.title,t.status,t.project_id "projectId",coalesce(t.assignee_person_id,t.owner_id) "assigneeId",case when a.id is null then null when a.side='agent' then 'agent' else 'staff' end "assigneeKind",t.priority,t.notes`;
const PROJECT_FROM = 'pulse.project p join pulse.work_project wp on wp.project_id=p.id and wp.org_id=p.org_id';
const PROJECT = 'p.id,coalesce(p.title,p.name) name,wp.status,wp.summary';

/** Reusable by chats/search. column is a trusted SQL identifier from the adapter, never request input.
 * Apps and AI use the bound member's explicit project membership, intersected with the query's own RLS.
 * Personal principals retain their screen permissions. No owner or role is borrowed from another person. */
export function projectAccess(ctx: V1Context, column: string) {
  return ctx.principal.kind === 'person' ? 'true' : `exists(select 1 from pulse.project_member m
    where m.org_id=pulse.current_org() and m.project_id=${column} and m.person_id=pulse.current_viewer() and m.left_at is null)`;
}
export async function requireProjectAccess(ctx: V1Context, projectId: string) {
  if (!(await ctx.client.query(`select p.id from pulse.project p where p.id=$1 and ${projectAccess(ctx, 'p.id')}`, [projectId])).rowCount)
    v1Fail(404, 'Project unavailable');
}

defineV1Operation({ operationId: 'listTasks', method: 'GET', path: '/api/v1/tasks', scope: 'tasks.read',
  summary: 'List visible tasks in explicitly granted projects; assigneeKind identifies AI',
  query: object({ ...PAGE_QUERY, projectId: uuid, status: { type: 'string', maxLength: 30 } }, []), response: pageResponse(task),
  authorize: async (ctx, { query }) => { if (query.projectId) await requireProjectAccess(ctx, query.projectId); },
  handler: (ctx, input) => pageV1(ctx, 'listTasks', input, async (after, take) =>
    (await ctx.client.query(`select ${TASK} from ${FROM} where ${projectAccess(ctx, 't.project_id')}
      and ($1::uuid is null or t.project_id=$1) and ($2::text is null or t.status=$2)
      and ($3::uuid is null or t.id>$3) order by t.id limit $4`, [input.query.projectId ?? null, input.query.status ?? null, after, take])).rows),
});
defineV1Operation({ operationId: 'getTask', method: 'GET', path: '/api/v1/tasks/{taskId}', scope: 'tasks.read',
  summary: 'Read one visible task in a granted project', params: object({ taskId: uuid }), response: task,
  handler: async (ctx, { params }) => (await ctx.client.query(`select ${TASK} from ${FROM}
    where t.id=$1 and ${projectAccess(ctx, 't.project_id')}`, [params.taskId])).rows[0] ?? v1Fail(404, 'Task unavailable'),
});
defineV1Operation({ operationId: 'listProjects', method: 'GET', path: '/api/v1/projects', scope: 'projects.read',
  summary: 'List explicitly granted work projects', query: object({ ...PAGE_QUERY }, []), response: pageResponse(project),
  handler: (ctx, input) => pageV1(ctx, 'listProjects', input, async (after, take) =>
    (await ctx.client.query(`select ${PROJECT} from ${PROJECT_FROM} where ${projectAccess(ctx, 'p.id')}
      and ($1::uuid is null or p.id>$1) order by p.id limit $2`, [after, take])).rows),
});
defineV1Operation({ operationId: 'getProject', method: 'GET', path: '/api/v1/projects/{projectId}', scope: 'projects.read',
  summary: 'Read one explicitly granted work project', params: object({ projectId: uuid }), response: project,
  handler: async (ctx, { params }) => (await ctx.client.query(`select ${PROJECT} from ${PROJECT_FROM}
    where p.id=$1 and ${projectAccess(ctx, 'p.id')}`, [params.projectId])).rows[0] ?? v1Fail(404, 'Project unavailable'),
});

// CTO: preserve staff-only domain guards. No synthetic resolver is production personal-token support (EST-1617).
async function authorizeWrite(ctx: V1Context, input: V1Input, area: 'tasks' | 'projects') {
  const c = ctx.client, b = input.body as Record<string, unknown>, tid = input.params.taskId, pid = input.params.projectId;
  // Published active-staff predicate prechecks replay; private viewer/edit guards remain inside the saves.
  if (ctx.principal.kind !== 'person' || !(await c.query('select pulse.native_is_staff() ok')).rows[0].ok) v1Fail(403, 'Staff task permission required');
  const t = tid ? (await c.query('select * from pulse.task where id=$1', [tid])).rows[0] : undefined;
  if (tid && !t) v1Fail(404, 'Task unavailable');
  if (tid && !(await c.query('select pulse.task_can_edit($1) ok', [tid])).rows[0].ok) v1Fail(403, 'Task edit permission required');
  if (t?.project_id) await requireProjectAccess(ctx, t.project_id);
  for (const projectId of [pid, b.projectId]) if (projectId) await requireProjectAccess(ctx, String(projectId));
  const parent = b.parentId ? (await c.query(`select t.project_id from pulse.task t where t.id=$1 and ${projectAccess(ctx, 't.project_id')}`, [b.parentId])).rows[0] : undefined;
  if (b.parentId && !parent) v1Fail(404, 'Parent task unavailable');
  for (const field of ['assigneeId', 'reviewerId']) if (b[field]) {
    const mode = (await c.query('select pulse.work_assign_mode($1,$2,$3,$4) value',
      [b[field], b.projectId ?? t?.project_id ?? parent?.project_id ?? null, t?.category ?? null, t?.tags ?? []])).rows[0].value;
    if (mode.why === 'inactive') v1Fail(400, 'Choose an active team member');
    if (field === 'assigneeId' && b[field] !== t?.assignee_person_id && !['self', 'direct'].includes(mode.mode)) v1Fail(403, 'Assignment permission required');
  }
  if (area === 'projects') {
    const sql = pid ? 'select pulse.work_project_can_manage($1) ok' :
      'select pulse.work_can_create_project((select pod from pulse.people_profile where person_id=pulse.current_viewer())) ok';
    if (!(await c.query(sql, pid ? [pid] : [])).rows[0].ok) v1Fail(403, 'Project edit permission required');
  }
}
const taskFields = { title: { type: 'string', minLength: 1, maxLength: 300 }, projectId: { ...uuid, type: ['string', 'null'] },
  assigneeId: { ...uuid, type: ['string', 'null'] }, reviewerId: { ...uuid, type: ['string', 'null'] }, parentId: { ...uuid, type: ['string', 'null'] },
  priority: { enum: ['low', 'normal', 'high', 'urgent'] }, notes: { ...nullable, maxLength: 20000 } };
const projectFields = { name: { type: 'string', minLength: 2, maxLength: 200 }, summary: { ...nullable, maxLength: 1000 } };
for (const create of [true, false]) {
  defineV1Operation({ operationId: create ? 'createTask' : 'updateTask', method: create ? 'POST' : 'PATCH',
    path: create ? '/api/v1/tasks' : '/api/v1/tasks/{taskId}', scope: 'tasks.write',
    summary: 'Save a task through existing staff-only domain permissions; AI/app writes remain refused',
    available: async ctx => ctx.principal.kind === 'person' && (await ctx.client.query('select pulse.native_is_staff() ok')).rows[0].ok,
    ...(create ? {} : { params: object({ taskId: uuid }) }), response: object({ id: uuid }),
    body: object({ ...taskFields, ...(create ? {} : { status: { enum: ['open', 'in_progress', 'blocked', 'done', 'in_review', 'cancelled'] }, note: { type: 'string', maxLength: 1000 } }) }, create ? ['title'] : []),
    authorize: (ctx, input) => authorizeWrite(ctx, input, 'tasks'),
    handler: (ctx, input) => saveTask(ctx.client, input.params.taskId ?? null, input.body as Record<string, unknown>),
  });
  defineV1Operation({ operationId: create ? 'createProject' : 'updateProject', method: create ? 'POST' : 'PATCH',
    path: create ? '/api/v1/projects' : '/api/v1/projects/{projectId}', scope: 'projects.write',
    summary: 'Save an internal work project through existing staff-only domain permissions; AI/app writes remain refused',
    available: async ctx => ctx.principal.kind === 'person' && (await ctx.client.query('select pulse.native_is_staff() ok')).rows[0].ok,
    ...(create ? {} : { params: object({ projectId: uuid }) }), response: object({ id: uuid }),
    body: object({ ...projectFields, ...(create ? {} : { status: { enum: ['planned', 'active', 'paused', 'done', 'cancelled'] } }) }, create ? ['name'] : []),
    authorize: (ctx, input) => authorizeWrite(ctx, input, 'projects'),
    handler: async (ctx, input) => ({ id: (await saveWorkProject(ctx.client, input.params.projectId ?? null, input.body as Record<string, unknown>)).id }),
  });
}
