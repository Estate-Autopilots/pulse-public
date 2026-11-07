// AGENT-API (owner, 4 Nov 2026: "the strongest possible API, MCP and CLI", so Claude, ChatGPT, Codex and bots such as
// Willow Lane's Bhrata can run a business on Pulse): work over API v1. Tasks, projects and their stages, comments, chat
// messages, the calendar and attendance, each as one operation that the REST API, the MCP adapter (named tools) and
// the pulse CLI share. Every call runs as its principal on the v1 transaction and reuses the screens' own functions
// (task_save, task_move, createWorkTask, assignOrAsk, work_comment_add, work_project_save, chat_send …), so row
// security and the assignment rules decide exactly what the screens decide. Writes are recorded in
// pulse_priv.app_change with the app that sent them and most can be undone for 7 days (undo_change, 1510).
import { createHash } from 'node:crypto';
import { companyOrigin } from './tenant-context.js';
import { ORG_TZ } from './org-time.js';
import { assignOrAsk, createWorkTask } from './work.js';
import { projectStages } from './project-stages.js';
import { defineV1Operation, v1Fail, type V1Context } from './v1.js';
import { aiReviewer, bool, change, day, int, list, maybe, maybeId, member, object, one, qBool, qText, rows, str, text, undoUntil, uuid, viewerOf, type Row } from './v1-kit.js';

const UNDO = { changeId: maybe, undoUntil: maybe };
const origin = () => companyOrigin();

// ------------------------------------------------------------------------------------------------ tasks
const TASK = object({ id: uuid, title: str, status: str, priority: maybe, dueAt: maybe, projectId: maybe, project: maybe, assigneeId: maybe, assignee: maybe,
  stage: { type: ['integer', 'null'] }, url: str });
const TASK_COLS = `t.id,t.title,case when t.status='cancelled' and t.closed_as='not_applicable' then 'not_applicable' else t.status end status,t.priority,to_char(t.due_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') "dueAt",t.project_id "projectId",
  coalesce(pr.title,pr.name) project,coalesce(t.assignee_person_id,t.owner_id) "assigneeId",a.display_name assignee,t.stage`;
const TASK_FROM = `pulse.task t left join pulse.project pr on pr.id=t.project_id left join pulse.person a on a.id=coalesce(t.assignee_person_id,t.owner_id)`;
const taskOut = (r: Row) => ({ id: String(r.id), title: String(r.title), status: String(r.status), priority: (r.priority as string) ?? null, dueAt: (r.dueAt as string) ?? null,
  projectId: (r.projectId as string) ?? null, project: (r.project as string) ?? null, assigneeId: (r.assigneeId as string) ?? null, assignee: (r.assignee as string) ?? null,
  stage: r.stage === null || r.stage === undefined ? null : Number(r.stage), url: `${origin()}/tasks/${r.id}` });
const OPEN = ['open', 'in_progress', 'blocked', 'in_review', 'unknown'];
async function readTask(ctx: V1Context, id: string) {
  const r = (await ctx.client.query(`select ${TASK_COLS},t.notes,t.done_at "doneAt",t.deleted_at "deletedAt" from ${TASK_FROM} where t.id=$1`, [id])).rows[0];
  if (!r || r.deletedAt) v1Fail(404, 'Task not found or not visible to you');
  return r as Row;
}

defineV1Operation({ operationId: 'listTasks', method: 'GET', path: '/api/v1/tasks', scope: 'tasks.read',
  summary: 'Tasks you can see: yours by default, or a project\'s, a person\'s or matching words',
  query: object({ who: { enum: ['me', 'anyone'] }, assigneeId: uuid, projectId: uuid, status: { enum: ['open', 'done', 'all'] }, query: qText(120),
    dueBefore: day, limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' } }, []),
  response: list(TASK),
  mcp: { name: 'list_tasks', title: 'List tasks', description: 'Lists tasks you can see, newest due first. By default your own open tasks; who "anyone" with projectId or assigneeId lists a project\'s or a person\'s; status open (default), done or all; query matches words in the title; dueBefore YYYY-MM-DD. Up to 100 (limit).' },
  handler: async (ctx, { query }) => {
    await member(ctx);
    const status = query.status ?? 'open', mine = (query.who ?? (query.projectId || query.assigneeId ? 'anyone' : 'me')) === 'me';
    const words = (query.query ?? '').toLowerCase().split(/\s+/).filter(w => w.length > 1).slice(0, 6);
    const r = await rows(ctx, `select ${TASK_COLS} from ${TASK_FROM} where t.deleted_at is null
        and ($1::boolean is false or pulse.current_viewer() in (t.assignee_person_id,t.owner_id))
        and ($2::uuid is null or coalesce(t.assignee_person_id,t.owner_id)=$2) and ($3::uuid is null or t.project_id=$3)
        and ($4='all' or ($4='open' and t.status=any($5)) or ($4='done' and t.status in ('done','accepted')))
        and ($6::date is null or t.due_at < ($6::date::timestamp at time zone ${ORG_TZ}))
        and (cardinality($7::text[])=0 or (select bool_and(lower(t.title) like '%'||w||'%') from unnest($7::text[]) w))
      order by t.due_at asc nulls last,t.created_at desc limit $8`,
      [mine, query.assigneeId ?? null, query.projectId ?? null, status, OPEN, query.dueBefore ?? null, words, Number(query.limit ?? 50)]);
    return { items: r.map(taskOut) };
  },
});

defineV1Operation({ operationId: 'getTask', method: 'GET', path: '/api/v1/tasks/{taskId}', scope: 'tasks.read',
  summary: 'Read one task with its notes and latest comments', params: object({ taskId: uuid }),
  response: object({ task: TASK, notes: maybe, comments: { type: 'array', items: object({ id: uuid, author: maybe, body: str, at: str }) } }),
  mcp: { name: 'get_task', title: 'Read a task', description: 'Reads one task by id: status, due time, project, stage, who has it, its notes and the last 30 comments.' },
  handler: async (ctx, { params }) => {
    await member(ctx);
    const r = await readTask(ctx, params.taskId);
    const comments = await rows(ctx, `select w.id,a.display_name author,w.body,w.created_at::text at from pulse.work_comment w left join pulse.person a on a.id=w.author_id
      where w.task_id=$1 order by w.created_at desc limit 30`, [params.taskId]);
    return { task: taskOut(r), notes: (r.notes as string) ?? null, comments: comments.map(c => ({ id: String(c.id), author: (c.author as string) ?? null, body: String(c.body ?? ''), at: String(c.at) })) };
  },
});

const ASSIGNED = object({ id: uuid, title: str, assigned: bool, askedId: maybe, assigneeName: maybe, url: str, changeId: maybe, undoUntil: maybe });
defineV1Operation({ operationId: 'createTask', method: 'POST', path: '/api/v1/tasks', scope: 'tasks.write',
  summary: 'Create a task for yourself or someone (theirs at once where the rules allow, otherwise they are asked)',
  body: object({ title: text(300), assigneeId: uuid, projectId: uuid, stage: { type: 'integer', minimum: 0, maximum: 40 }, dueOn: day,
    dueAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$' },
    priority: { enum: ['low', 'normal', 'high', 'urgent'] }, notes: text(4000, 0), reviewerId: uuid, parentId: uuid }, ['title']),
  response: ASSIGNED, authorize: member,
  mcp: { name: 'create_task', title: 'Create a task',
    description: 'Creates a task. Without assigneeId it is yours. With assigneeId (from search_people) it is theirs at once when Pulse\'s rules allow, otherwise they are asked to take it (askedId) and it stays yours until they accept. projectId and stage put it on a project\'s stage; dueOn (YYYY-MM-DD, due 18:00 company time) or dueAt (ISO with offset). Undo with undo_change for 7 days.' },
  handler: async (ctx, { body }) => {
    const b = body as Row, v = await viewerOf(ctx);
    const reviewerId = b.reviewerId ?? await aiReviewer(ctx);
    const made = await createWorkTask(ctx.client, v, { ...b, ...(reviewerId ? { reviewerId } : {}) }) as Row;
    const asked = made.asked as { id: string } | null;
    const title = String(b.title).trim();
    return { id: String(made.id), title, assigned: !!made.assigned, askedId: asked?.id ?? null, assigneeName: (made.assigneeName as string) ?? null,
      url: `${origin()}/tasks/${made.id}`, changeId: await change(ctx, 'task.create', String(made.id), { title }), undoUntil: undoUntil() };
  },
});

defineV1Operation({ operationId: 'assignTask', method: 'POST', path: '/api/v1/tasks/{taskId}/assign', scope: 'tasks.write',
  summary: 'Give a task to someone (at once where the rules allow, otherwise they are asked), or unassign it',
  params: object({ taskId: uuid }), body: object({ personId: maybeId, note: text(500, 0) }, ['personId']),
  response: object({ id: uuid, assigned: bool, askedId: maybe, assigneeName: maybe, unchanged: bool, ...UNDO }), authorize: member,
  mcp: { name: 'assign_task', title: 'Give a task to someone', idempotent: true,
    description: 'Gives a task to personId (from search_people): theirs at once when Pulse\'s rules allow, otherwise they are asked to take it (askedId). personId null unassigns. Undo with undo_change for 7 days.' },
  handler: async (ctx, { params, body }) => {
    const b = body as { personId: string | null; note?: string };
    const before = await one<string | null>(ctx, 'select coalesce(assignee_person_id,owner_id) v from pulse.task where id=$1 and deleted_at is null', [params.taskId]);
    if (before === undefined) v1Fail(404, 'Task not found or not visible to you');
    const r = await assignOrAsk(ctx.client, await viewerOf(ctx), params.taskId, b.personId, b.note?.trim() || null) as Row;
    const asked = r.asked as { id: string } | null, unchanged = !!r.unchanged;
    const moved = !unchanged && (r.assigned || b.personId === null);
    const changeId = moved ? await change(ctx, 'task.assign', params.taskId, { from: before ?? null, to: b.personId }) : null;
    return { id: params.taskId, assigned: !!r.assigned, askedId: asked?.id ?? null, assigneeName: (r.assigneeName as string) ?? null, unchanged,
      changeId, undoUntil: changeId ? undoUntil() : null };
  },
});

const FIELDS_SQL = `select title,priority,notes,case when status='cancelled' and closed_as='not_applicable' then 'not_applicable' else status end status,to_char(due_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') "dueAt" from pulse.task where id=$1 and deleted_at is null`;
defineV1Operation({ operationId: 'updateTask', method: 'PATCH', path: '/api/v1/tasks/{taskId}', scope: 'tasks.write',
  summary: 'Change a task\'s title, due date, priority, notes or status (open, in progress, not applicable or cancelled)',
  params: object({ taskId: uuid }),
  body: object({ title: text(300), dueOn: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, priority: { enum: ['low', 'normal', 'high', 'urgent'] },
    notes: { type: ['string', 'null'], maxLength: 4000 }, status: { enum: ['open', 'in_progress', 'not_applicable', 'cancelled'] }, note: text(1000, 0) }, []),
  response: object({ task: TASK, changed: { type: 'array', items: str }, ...UNDO }), authorize: member,
  mcp: { name: 'update_task', title: 'Update a task', idempotent: true,
    description: 'Changes any of title, dueOn (YYYY-MM-DD or null to clear), priority (low, normal, high, urgent), notes (null clears) and status (open, in_progress, not_applicable, cancelled; use complete_task to finish). not_applicable closes a task that does not apply: it counts as closed, not as done. Only the fields given change. Undo with undo_change for 7 days.' },
  handler: async (ctx, { params, body }) => {
    const b = body as Row;
    const before = (await ctx.client.query(FIELDS_SQL, [params.taskId])).rows[0] ?? v1Fail(404, 'Task not found or not visible to you');
    const fields: Row = {};
    for (const k of ['title', 'dueOn', 'priority', 'notes'] as const) if (k in b) fields[k] = b[k] === null ? null : String(b[k]).trim();
    if (Object.keys(fields).length) await ctx.client.query('select pulse.task_save($1,$2)', [params.taskId, JSON.stringify(fields)]);
    if (b.status && b.status !== before.status) await ctx.client.query('select pulse.task_move($1,$2,$3)', [params.taskId, b.status, (b.note as string)?.trim() || null]);
    const after = (await ctx.client.query(FIELDS_SQL, [params.taskId])).rows[0];
    const changed = ['title', 'priority', 'notes', 'status', 'dueAt'].filter(k => String(before[k] ?? '') !== String(after[k] ?? ''));
    const changeId = changed.length ? await change(ctx, 'task.update', params.taskId, { before, after, changed }) : null;
    return { task: taskOut(await readTask(ctx, params.taskId)), changed, changeId, undoUntil: changeId ? undoUntil() : null };
  },
});

defineV1Operation({ operationId: 'completeTask', method: 'POST', path: '/api/v1/tasks/{taskId}/complete', scope: 'tasks.write',
  summary: 'Mark a task done (it goes to its reviewer when it has one)', params: object({ taskId: uuid }), body: object({ note: text(1000, 0) }, []),
  response: object({ id: uuid, status: str, ...UNDO }), authorize: member,
  mcp: { name: 'complete_task', title: 'Complete a task', idempotent: true,
    description: 'Marks the task done with an optional note; a task with a reviewer goes to them for review. Undo with undo_change for 7 days (it goes back to the status it had).' },
  handler: async (ctx, { params, body }) => {
    const from = await one<string>(ctx, 'select status v from pulse.task where id=$1 and deleted_at is null', [params.taskId]) ?? v1Fail(404, 'Task not found or not visible to you');
    if (['done', 'accepted'].includes(from)) return { id: params.taskId, status: from, changeId: null, undoUntil: null };
    const r = await one<Row>(ctx, 'select pulse.task_move($1,$2,$3) v', [params.taskId, 'done', (body as Row).note ? String((body as Row).note).trim() : null]);
    const status = String(r?.status ?? 'done');
    const changeId = await change(ctx, 'task.complete', params.taskId, { from, to: status });
    return { id: params.taskId, status, changeId, undoUntil: undoUntil() };
  },
});

defineV1Operation({ operationId: 'addComment', method: 'POST', path: '/api/v1/tasks/comments', scope: 'tasks.write',
  summary: 'Comment on a task or a project, mentioning people (they are told)',
  body: object({ taskId: uuid, projectId: uuid, body: text(4000), mentions: { type: 'array', items: uuid, maxItems: 20 } }, ['body']),
  response: object({ id: uuid, taskId: maybe, projectId: maybe, ...UNDO }), authorize: member,
  mcp: { name: 'comment', title: 'Comment on a task or project',
    description: 'Adds a comment to a task (taskId) or a project (projectId). mentions are person ids (from search_people); they are told. Undo with undo_change for 7 days.' },
  handler: async (ctx, { body }) => {
    const b = body as { taskId?: string; projectId?: string; body: string; mentions?: string[] };
    if (!!b.taskId === !!b.projectId) v1Fail(400, 'Give taskId or projectId (one of them)');
    const id = await one<string>(ctx, 'select pulse.work_comment_add($1,$2,$3,$4) v', [b.taskId ?? null, b.projectId ?? null, b.body.trim(), [...new Set(b.mentions ?? [])]]);
    return { id, taskId: b.taskId ?? null, projectId: b.projectId ?? null, changeId: await change(ctx, 'comment.add', id, { taskId: b.taskId ?? null, projectId: b.projectId ?? null }), undoUntil: undoUntil() };
  },
});

// ------------------------------------------------------------------------------------------------ projects and stages
const PROJECT = object({ id: uuid, name: str, status: maybe, client: maybe, ownerId: maybe, owner: maybe, startsOn: maybe, dueOn: maybe, openTasks: int, url: str });
const PROJECT_SQL = `select p.id,coalesce(p.title,p.name) name,p.status,c.display_name client,coalesce(wp.owner_id,p.lead_person_id) "ownerId",o.display_name owner,
    coalesce(wp.starts_on,p.starts_on)::text "startsOn",coalesce(wp.due_on,p.ends_on)::text "dueOn",(select count(*)::int from pulse.task t where t.project_id=p.id and t.deleted_at is null and t.status=any($1)) "openTasks"
  from pulse.project p left join pulse.client c on c.id=p.client_id left join pulse.work_project wp on wp.project_id=p.id
  left join pulse.person o on o.id=coalesce(wp.owner_id,p.lead_person_id) where p.deleted_at is null`;
const projectOut = (r: Row) => ({ id: String(r.id), name: String(r.name ?? 'Untitled project'), status: (r.status as string) ?? null, client: (r.client as string) ?? null,
  ownerId: (r.ownerId as string) ?? null, owner: (r.owner as string) ?? null, startsOn: (r.startsOn as string) ?? null, dueOn: (r.dueOn as string) ?? null,
  openTasks: Number(r.openTasks ?? 0), url: `${origin()}/tasks/projects/${r.id}` });

defineV1Operation({ operationId: 'listProjects', method: 'GET', path: '/api/v1/projects', scope: 'projects.read',
  summary: 'Projects you can see, matching words if given', query: object({ query: qText(120), mine: qBool }, []), response: list(PROJECT),
  mcp: { name: 'list_projects', title: 'List projects', description: 'Lists up to 100 projects you can see with their client, owner, dates and open task count; query matches the name; mine "true" keeps those you own or have tasks in.' },
  handler: async (ctx, { query }) => {
    await member(ctx);
    const words = (query.query ?? '').toLowerCase().split(/\s+/).filter(w => w.length > 1).slice(0, 6);
    const r = await rows(ctx, `${PROJECT_SQL} and (cardinality($2::text[])=0 or (select bool_and(lower(coalesce(p.title,p.name,'')||' '||coalesce(c.display_name,'')) like '%'||w||'%') from unnest($2::text[]) w))
        and ($3::boolean is false or coalesce(wp.owner_id,p.lead_person_id)=pulse.current_viewer() or exists(select 1 from pulse.task t where t.project_id=p.id and pulse.current_viewer() in (t.assignee_person_id,t.owner_id)))
      order by p.updated_at desc nulls last limit 100`, [OPEN, words, query.mine === 'true']);
    return { items: r.map(projectOut) };
  },
});

const STAGE = object({ n: int, label: str, ownerId: maybe, owner: maybe });
defineV1Operation({ operationId: 'getProject', method: 'GET', path: '/api/v1/projects/{projectId}', scope: 'projects.read',
  summary: 'Read one project with its stages and open tasks', params: object({ projectId: uuid }),
  response: object({ project: PROJECT, summary: maybe, stages: { type: 'array', items: STAGE }, currentStage: { type: ['integer', 'null'] }, tasks: { type: 'array', items: TASK } }),
  mcp: { name: 'get_project', title: 'Read a project', description: 'Reads one project by id: client, owner, dates, its delivery stages (with each stage\'s owner and the current one) and up to 100 open tasks.' },
  handler: async (ctx, { params }) => {
    await member(ctx);
    const r = (await ctx.client.query(`${PROJECT_SQL} and p.id=$2`, [OPEN, params.projectId])).rows[0] ?? v1Fail(404, 'Project not found or not visible to you');
    const summary = await one<string | null>(ctx, 'select summary v from pulse.work_project where project_id=$1', [params.projectId]);
    const st = await projectStages(ctx.client, params.projectId);
    const tasks = await rows(ctx, `select ${TASK_COLS} from ${TASK_FROM} where t.project_id=$1 and t.deleted_at is null and t.status=any($2) order by t.stage nulls last,t.due_at nulls last limit 100`, [params.projectId, OPEN]);
    return { project: projectOut(r), summary: summary ?? null, stages: st.stages.map(s => ({ n: s.n, label: s.label, ownerId: s.ownerId, owner: s.owner })),
      currentStage: st.current ?? null, tasks: tasks.map(taskOut) };
  },
});

defineV1Operation({ operationId: 'createProject', method: 'POST', path: '/api/v1/projects', scope: 'projects.write',
  summary: 'Create a project (internal work), with an owner, dates and members',
  body: object({ name: text(160), summary: text(1000, 0), ownerId: uuid, startsOn: day, dueOn: day, memberIds: { type: 'array', items: uuid, maxItems: 50 } }, ['name']),
  response: object({ project: PROJECT, ...UNDO }), authorize: member,
  mcp: { name: 'create_project', title: 'Create a project',
    description: 'Creates a project you can then add tasks to (create_task with projectId). ownerId and memberIds are person ids from search_people; dates are YYYY-MM-DD. Client projects start themselves when their invoice is paid. Undo with undo_change for 7 days.' },
  handler: async (ctx, { body }) => {
    const b = body as Row, f: Row = { type: 'internal', name: String(b.name).trim() };
    for (const k of ['summary', 'ownerId', 'startsOn', 'dueOn', 'memberIds']) if (k in b) f[k] = b[k];
    const r = await one<Row>(ctx, 'select pulse.work_project_save(null,$1) v', [JSON.stringify(f)]);
    const id = String(r?.id ?? r?.projectId ?? v1Fail(409, 'The project could not be made'));
    const p = (await ctx.client.query(`${PROJECT_SQL} and p.id=$2`, [OPEN, id])).rows[0];
    return { project: projectOut(p), changeId: await change(ctx, 'project.create', id, { name: f.name }), undoUntil: undoUntil() };
  },
});

// API-PLATFORM (owner, 5 Nov 2026): projects are full CRUD over API v1. Changing and deleting go through the screens'
// own functions (work_project_save, project_delete), so only the project's owner, the head of its pod or leadership
// change it, and its owner, leadership or an admin delete it; a deleted project is restored from Work for 30 days.
const DATE_OR_NULL = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
defineV1Operation({ operationId: 'updateProject', method: 'PATCH', path: '/api/v1/projects/{projectId}', scope: 'projects.write',
  summary: 'Change a project\'s name, summary, owner, dates or members (only the fields given change)',
  params: object({ projectId: uuid }),
  body: object({ name: text(160), summary: { type: ['string', 'null'], maxLength: 1000 }, ownerId: uuid, startsOn: DATE_OR_NULL, dueOn: DATE_OR_NULL,
    memberIds: { type: 'array', items: uuid, maxItems: 50 } }, []),
  response: object({ project: PROJECT, changed: { type: 'array', items: str }, ...UNDO }), authorize: member,
  mcp: { name: 'update_project', title: 'Update a project', idempotent: true,
    description: 'Changes any of name, summary (null clears), ownerId, startsOn and dueOn (YYYY-MM-DD, null clears) of a project, and adds memberIds (person ids from search_people; people outside your reach are invited). Only the project\'s owner, the head of its team or leadership may change it. Logged in list_my_changes.' },
  handler: async (ctx, { params, body }) => {
    const b = body as Row;
    if (!Object.keys(b).length) v1Fail(400, 'Give at least one field to change');
    const read = async () => (await ctx.client.query(`${PROJECT_SQL} and p.id=$2`, [OPEN, params.projectId])).rows[0] ?? v1Fail(404, 'Project not found or not visible to you');
    const before = projectOut(await read());
    const f: Row = {};
    for (const k of ['name', 'summary', 'ownerId', 'startsOn', 'dueOn', 'memberIds']) if (k in b) f[k] = b[k] === null ? '' : b[k];
    await ctx.client.query('select pulse.work_project_save($1,$2)', [params.projectId, JSON.stringify(f)]);
    const after = projectOut(await read());
    const changed: string[] = (['name', 'ownerId', 'startsOn', 'dueOn'] as const).filter(k => before[k] !== after[k]).map(String).concat('summary' in b ? ['summary'] : [], 'memberIds' in b ? ['memberIds'] : []);
    const changeId = changed.length ? await change(ctx, 'project.update', params.projectId, { before, fields: Object.keys(f) }) : null;
    return { project: after, changed, changeId, undoUntil: null };
  },
});
defineV1Operation({ operationId: 'deleteProject', method: 'DELETE', path: '/api/v1/projects/{projectId}', scope: 'projects.write',
  summary: 'Delete an internal project with its tasks (restorable from Work for 30 days); send confirm=true',
  params: object({ projectId: uuid }), query: object({ confirm: { enum: ['true', 'false'] }, note: qText(300) }, []),
  response: object({ id: uuid, deleted: bool, tasks: int, restoreUntil: str, changeId: maybe }), authorize: member,
  mcp: { name: 'delete_project', title: 'Delete a project', destructive: true,
    description: 'Deletes an internal project and its tasks (client projects close from Clients). Only its owner, leadership or an admin may. It can be restored from Work → Deleted for 30 days. Destructive: send confirm "true" only after the person agreed; without it nothing changes and the answer says what would happen.' },
  handler: async (ctx, { params, query }) => {
    const p = (await ctx.client.query(`${PROJECT_SQL} and p.id=$2`, [OPEN, params.projectId])).rows[0] ?? v1Fail(404, 'Project not found or not visible to you');
    const tasks = await one<number>(ctx, 'select count(*)::int v from pulse.task where project_id=$1 and deleted_at is null', [params.projectId]);
    if (query.confirm !== 'true') v1Fail(409, `Confirm first: delete the project "${String(p.name)}" and its ${tasks} tasks (restorable for 30 days). Ask the person, then send the same call with confirm=true.`);
    const r = await one<Row>(ctx, 'select pulse.project_delete($1,$2) v', [params.projectId, query.note?.trim() || 'Deleted through the API']);
    const changeId = await change(ctx, 'project.delete', params.projectId, { name: p.name, tasks: Number(r?.tasks ?? tasks) });
    return { id: params.projectId, deleted: true, tasks: Number(r?.tasks ?? tasks), restoreUntil: new Date(String(r?.restoreUntil ?? Date.now() + 30 * 864e5)).toISOString(), changeId };
  },
});

const STAGE_PARAMS = object({ projectId: uuid, stage: { type: 'string', pattern: '^(?:[0-9]|[1-3][0-9]|40)$' } });
defineV1Operation({ operationId: 'setStageOwner', method: 'POST', path: '/api/v1/projects/{projectId}/stages/{stage}/owner', scope: 'projects.write',
  summary: 'Choose who owns one stage of a project\'s delivery plan', params: STAGE_PARAMS, body: object({ personId: maybeId }),
  response: object({ projectId: uuid, stage: int, ownerId: maybe }), authorize: member,
  mcp: { name: 'set_stage_owner', title: 'Choose a stage owner', idempotent: true, description: 'Sets the person (from search_people) who owns stage n of the project\'s plan (get_project lists the stages); personId null clears it.' },
  handler: async (ctx, { params, body }) => {
    const personId = (body as { personId: string | null }).personId;
    await ctx.client.query('select pulse.project_stage_owner_set($1,$2,$3)', [params.projectId, Number(params.stage), personId]);
    await change(ctx, 'stage.owner', params.projectId, { stage: Number(params.stage), personId });
    return { projectId: params.projectId, stage: Number(params.stage), ownerId: personId };
  },
});
defineV1Operation({ operationId: 'placeTaskOnStage', method: 'POST', path: '/api/v1/projects/{projectId}/stages/{stage}/tasks', scope: 'projects.write',
  summary: 'Put one of the project\'s tasks on a stage of its plan', params: STAGE_PARAMS, body: object({ taskId: uuid }),
  response: object({ taskId: uuid, stage: int }), authorize: member,
  mcp: { name: 'place_task_on_stage', title: 'Put a task on a stage', idempotent: true, description: 'Moves a task of this project onto stage n of its plan (get_project lists the stages).' },
  handler: async (ctx, { params, body }) => {
    const taskId = (body as { taskId: string }).taskId;
    if (!(await one<boolean>(ctx, 'select exists(select 1 from pulse.task where id=$1 and project_id=$2 and deleted_at is null) v', [taskId, params.projectId]))) v1Fail(404, 'Task not found in this project');
    await ctx.client.query('select pulse.project_task_stage($1,$2)', [taskId, Number(params.stage)]);
    await change(ctx, 'stage.task', taskId, { projectId: params.projectId, stage: Number(params.stage) });
    return { taskId, stage: Number(params.stage) };
  },
});

// ------------------------------------------------------------------------------------------------ chats
const CHAT = object({ id: uuid, name: str, kind: str, lastAt: maybe, unread: int });
defineV1Operation({ operationId: 'listChats', method: 'GET', path: '/api/v1/chats/conversations', scope: 'chats.read',
  summary: 'Your conversations (groups and direct chats), latest first', query: object({ query: qText(80) }, []), response: list(CHAT),
  mcp: { name: 'list_chats', title: 'List my conversations', description: 'Lists up to 50 of your chat groups and direct conversations, latest first, with unread counts; query matches the name or the other person.' },
  handler: async (ctx, { query }) => {
    await member(ctx);
    const q = (query.query ?? '').toLowerCase().trim();
    const r = await rows(ctx, `select x.* from (select c.id,coalesce(nullif(c.name,''),(select string_agg(p.display_name,', ' order by p.display_name) from pulse.chat_member m2 join pulse.person p on p.id=m2.person_id
          where m2.channel_id=c.id and m2.person_id<>pulse.current_viewer()),'Conversation') name,c.kind,
        (select max(created_at) from pulse.chat_message where channel_id=c.id and removed_at is null)::text "lastAt",
        (select count(*)::int from pulse.chat_message cm where cm.channel_id=c.id and cm.removed_at is null and cm.author_id<>pulse.current_viewer()
          and cm.created_at>coalesce(m.read_through,'-infinity')) unread
      from pulse.chat_channel c join pulse.chat_member m on m.channel_id=c.id and m.person_id=pulse.current_viewer()) x
      where $1='' or lower(x.name) like '%'||$1||'%' order by x."lastAt" desc nulls last limit 50`, [q]);
    return { items: r.map(c => ({ id: String(c.id), name: String(c.name), kind: String(c.kind ?? 'group'), lastAt: (c.lastAt as string) ?? null, unread: Number(c.unread ?? 0) })) };
  },
});
const MESSAGE = object({ id: uuid, author: maybe, authorId: maybe, body: str, at: str, parentId: maybe });
defineV1Operation({ operationId: 'listMessages', method: 'GET', path: '/api/v1/chats/{chatId}/messages', scope: 'chats.read',
  summary: 'The latest messages of a conversation you are in', params: object({ chatId: uuid }), query: object({ before: { type: 'string', minLength: 10, maxLength: 40 } }, []),
  response: list(MESSAGE),
  mcp: { name: 'read_messages', title: 'Read a conversation', description: 'Reads the latest 50 messages of a conversation you are in (from list_chats), oldest first; before (an ISO time) pages back.' },
  handler: async (ctx, { params, query }) => {
    await member(ctx);
    if (!(await one<boolean>(ctx, 'select exists(select 1 from pulse.chat_member where channel_id=$1 and person_id=pulse.current_viewer()) v', [params.chatId]))) v1Fail(404, 'Conversation not found or you are not in it');
    if (query.before && Number.isNaN(Date.parse(query.before))) v1Fail(400, 'before is an ISO time');
    const r = await rows(ctx, `select * from (select m.id,a.display_name author,m.author_id "authorId",m.body,m.created_at::text at,m.parent_id "parentId",m.created_at
      from pulse.chat_message m left join pulse.person a on a.id=m.author_id where m.channel_id=$1 and m.removed_at is null and ($2::timestamptz is null or m.created_at<$2)
      order by m.created_at desc limit 50) x order by x.created_at`, [params.chatId, query.before ?? null]);
    return { items: r.map(m => ({ id: String(m.id), author: (m.author as string) ?? null, authorId: (m.authorId as string) ?? null, body: String(m.body ?? ''), at: String(m.at), parentId: (m.parentId as string) ?? null })) };
  },
});
defineV1Operation({ operationId: 'sendMessage', method: 'POST', path: '/api/v1/chats/{chatId}/messages', scope: 'chats.write',
  summary: 'Send a message in a conversation you are in', params: object({ chatId: uuid }), body: object({ body: text(4000), parentId: uuid }, ['body']),
  response: object({ id: uuid, at: str, ...UNDO }), authorize: member,
  mcp: { name: 'send_message', title: 'Send a chat message',
    description: 'Sends a message as you in a conversation you are in (from list_chats); parentId replies in a thread. Everyone in it sees it at once. Undo with undo_change for 7 days removes it.' },
  handler: async (ctx, { params, body }) => {
    const b = body as { body: string; parentId?: string };
    if (!(await one<boolean>(ctx, 'select exists(select 1 from pulse.chat_member where channel_id=$1 and person_id=pulse.current_viewer()) v', [params.chatId]))) v1Fail(404, 'Conversation not found or you are not in it');
    await ctx.client.query('select pulse.chat_refresh()');
    // The client id makes the send itself idempotent inside the chat (the same request id, the same message).
    const h = createHash('sha256').update(`${ctx.requestId}:${params.chatId}`).digest('hex');
    const clientId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    const id = await one<string>(ctx, 'select pulse.chat_send($1,$2,$3,$4,$5) v', [params.chatId, b.body, b.parentId ?? null, '[]', clientId]);
    const at = await one<string>(ctx, 'select created_at::text v from pulse.chat_message where id=$1', [id]);
    return { id, at, changeId: await change(ctx, 'chat.message', id, { chatId: params.chatId }), undoUntil: undoUntil() };
  },
});

// ------------------------------------------------------------------------------------------------ calendar and attendance
const range = (from?: string, to?: string) => {
  const start = from ?? new Date().toISOString().slice(0, 10), end = to ?? new Date(Date.parse(start) + 13 * 864e5).toISOString().slice(0, 10);
  if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end)) || end < start) v1Fail(400, 'from and to are dates (YYYY-MM-DD), to not before from');
  if ((Date.parse(end) - Date.parse(start)) / 864e5 > 62) v1Fail(400, 'Ask for at most 62 days at a time');
  return { start, end };
};
const EVENT = object({ date: str, endDate: maybe, kind: { enum: ['holiday', 'my_leave', 'leave', 'task_due'] }, title: str, personId: maybe, status: maybe, ref: maybe });
defineV1Operation({ operationId: 'myCalendar', method: 'GET', path: '/api/v1/people/me/calendar', scope: 'people.read',
  summary: 'Your calendar: holidays, your leave, colleagues away and your tasks due, for up to 62 days',
  query: object({ from: day, to: day }, []), response: object({ from: str, to: str, items: { type: 'array', items: EVENT } }),
  mcp: { name: 'my_calendar', title: 'My calendar', description: 'Lists, between from and to (YYYY-MM-DD; default the next 14 days, at most 62): company holidays, your leave, colleagues on approved leave you may see, and your open tasks due.' },
  handler: async (ctx, { query }) => {
    await member(ctx);
    const { start, end } = range(query.from, query.to);
    const items = await rows(ctx, `select * from (
        select h.day::text date,null "endDate",'holiday' kind,h.name||case when h.optional then ' (optional)' else '' end title,null::uuid "personId",null status,null ref from pulse.holiday h where h.day between $1 and $2
        union all select l.from_date::text,l.to_date::text,case when l.person_id=pulse.current_viewer() then 'my_leave' else 'leave' end,
          case when l.person_id=pulse.current_viewer() then 'Your '||replace(l.leave_kind,'_',' ')||' leave' else p.display_name||' is away' end,l.person_id,l.status,l.id::text
          from pulse.leave_request l join pulse.person p on p.id=l.person_id where l.from_date<=$2 and l.to_date>=$1
          and (l.person_id=pulse.current_viewer() or l.status='approved') and l.status not in ('cancelled','rejected','withdrawn')
        union all select (t.due_at at time zone ${ORG_TZ})::date::text,null,'task_due',t.title,null,t.status,t.id::text from pulse.task t
          where t.deleted_at is null and pulse.current_viewer() in (t.assignee_person_id,t.owner_id) and t.status=any($3)
          and (t.due_at at time zone ${ORG_TZ})::date between $1 and $2) x order by 1,3 limit 300`, [start, end, OPEN]);
    return { from: start, to: end, items: items.map(i => ({ date: String(i.date), endDate: (i.endDate as string) ?? null, kind: i.kind as 'holiday', title: String(i.title),
      personId: (i.personId as string) ?? null, status: (i.status as string) ?? null, ref: (i.ref as string) ?? null })) };
  },
});
const DAY = object({ date: str, personId: uuid, name: str, checkedInAt: maybe, checkedOutAt: maybe, mode: maybe, lateMinutes: { type: ['integer', 'null'] } });
defineV1Operation({ operationId: 'attendance', method: 'GET', path: '/api/v1/people/attendance', scope: 'people.read',
  summary: 'Check-ins and check-outs: yours, or your team\'s for managers, HR and leadership',
  query: object({ who: { enum: ['me', 'team'] }, from: day, to: day }, []), response: object({ from: str, to: str, items: { type: 'array', items: DAY } }),
  mcp: { name: 'attendance', title: 'Attendance', description: 'Lists check-in and check-out times between from and to (YYYY-MM-DD; default today, at most 62 days). who "me" (default) is yours; "team" is everyone you may see (your reports; all staff for HR and leadership). Read only: check-ins are made by each person in the app.' },
  handler: async (ctx, { query }) => {
    await member(ctx);
    const today = await one<string>(ctx, `select (now() at time zone ${ORG_TZ})::date::text v`);
    const { start, end } = range(query.from ?? today, query.to ?? query.from ?? today);
    const r = await rows(ctx, `select a.work_date::text date,a.person_id "personId",p.display_name name,a.checked_in_at::text "checkedInAt",a.checked_out_at::text "checkedOutAt",a.mode,a.late_minutes "lateMinutes"
      from pulse.attendance_effective a join pulse.person p on p.id=a.person_id where a.work_date between $1 and $2 and ($3::boolean or a.person_id=pulse.current_viewer())
      order by a.work_date desc,p.display_name limit 500`, [start, end, query.who === 'team']);
    return { from: start, to: end, items: r.map(x => ({ date: String(x.date), personId: String(x.personId), name: String(x.name), checkedInAt: (x.checkedInAt as string) ?? null,
      checkedOutAt: (x.checkedOutAt as string) ?? null, mode: (x.mode as string) ?? null, lateMinutes: x.lateMinutes === null || x.lateMinutes === undefined ? null : Number(x.lateMinutes) })) };
  },
});

// ------------------------------------------------------------------------------------------------ organisations
// Per-organisation selection: a token, key or connection belongs to one organisation. Someone in several (Willow Lane
// and I-Solar) connects each one; this lists them with the address to connect.
defineV1Operation({ operationId: 'listMyOrganisations', method: 'GET', path: '/api/v1/people/me/organisations', scope: 'people.read',
  summary: 'The organisations your Pulse account is in, and which one this connection acts in',
  response: object({ current: object({ name: str, address: str }), items: { type: 'array', items: object({ name: str, kind: str, current: bool }) }, how: str }),
  mcp: { name: 'list_my_organisations', title: 'My organisations', description: 'Lists the organisations your Pulse account belongs to and which one this connection acts in. Each organisation\'s data is separate: to work in another one, connect Pulse again while signed in to it (or use a token made there).' },
  handler: async ctx => {
    const name = await one<string>(ctx, 'select name v from pulse.org where id=pulse.current_org()');
    const account = ctx.principal.kind === 'person' ? await one<{ orgs?: { id: string; name: string; kind?: string }[] } | null>(ctx, 'select pulse.account_me() v') : null;
    const items = (account?.orgs ?? []).map(o => ({ name: String(o.name), kind: String(o.kind ?? 'staff'), current: o.id === ctx.tenantId }));
    if (!items.some(i => i.current)) items.unshift({ name, kind: 'staff', current: true });
    return { current: { name, address: origin() }, items,
      how: 'This connection acts in the current organisation only. Switch organisation in Pulse, then connect again (Claude, ChatGPT, pulse login) or make a token there in Settings → API keys.' };
  },
});

