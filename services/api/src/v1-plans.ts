// AC-PLAN-TOOLS (owner, 13 Nov 2026; the AC handoff of 13 Nov, section 3): a whole plan in one call, read back in one
// call, blockers and "waiting on", folders ensured by path, and the workflow log, over API v1, so the REST API, MCP
// (named tools) and the `pulse` CLI share one definition. Every rule is the screens' own (plan-import.ts).
import { saveFolder } from './docs.js';
import { applyPlan, ensureFolderPath, goalTree, listFolders, listRuns, logRun, waiting, type PlanInput } from './plan-import.js';
import { defineV1Operation, v1Fail } from './v1.js';
import { bool, change, day, int, maybe, member, num, object, one, qText, str, text, uuid, type Row } from './v1-kit.js';

const maybeText = (max: number) => ({ type: ['string', 'null'], maxLength: max });
const arr = (items: unknown, maxItems: number) => ({ type: 'array', maxItems, items });
const KEY = { type: 'string', minLength: 1, maxLength: 200, description: 'Your stable key for this item (e.g. a T-id). Sending the plan again with the same keys changes what differs and makes nothing twice.' };
const REF = { type: 'string', minLength: 1, maxLength: 200 };
const WHO = { type: 'string', minLength: 1, maxLength: 200, description: 'A person: their id, @username or work e-mail.' };
const STATUSES = { enum: ['open', 'in_progress', 'blocked', 'done', 'cancelled'] };

// ------------------------------------------------------------------------------------------------ the plan (input)
const TASK_FIELDS = { key: KEY, id: uuid, title: text(300), assignee: WHO, reviewer: WHO, priority: { enum: ['low', 'normal', 'high', 'urgent'] }, dueOn: day,
  dueAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$' }, notes: text(4000, 0),
  checklist: arr({ anyOf: [{ type: 'string', minLength: 1, maxLength: 500 }, object({ label: text(500), done: bool }, ['label'])] }, 50),
  status: STATUSES, statusNote: text(300),
  blockedBy: { ...arr(REF, 20), description: 'Keys (from this plan) or ids of tasks this one waits on; it unblocks by itself when they finish.' },
  waitingOn: { type: 'string', minLength: 1, maxLength: 300, description: '"@username: what" makes a small task for that person and waits on it; other words mark it blocked on something outside Pulse.' },
  brief: { ...REF, description: 'The key (from docs) or id of its brief doc.' }, docs: { ...arr(REF, 20), description: 'Keys or ids of related docs.' } };
const TASK3 = object(TASK_FIELDS, []);
const TASK2 = object({ ...TASK_FIELDS, subtasks: arr(TASK3, 50) }, []);
const TASK1 = object({ ...TASK_FIELDS, subtasks: arr(TASK2, 50) }, []);
const PROJECT_IN = object({ key: KEY, id: uuid, name: text(160), summary: maybeText(1000), owner: WHO, startsOn: day, dueOn: day, members: arr(WHO, 50),
  brief: REF, briefDocId: uuid, docs: arr(REF, 20), tasks: arr(TASK1, 300) }, []);
const GOAL_FIELDS = { key: KEY, id: uuid, title: text(160), why: maybeText(2000), level: { enum: ['person', 'team', 'company'] }, targetOn: { type: ['string', 'null'], pattern: day.pattern },
  owner: WHO, measureLabel: maybeText(60), startValue: { type: ['number', 'null'] }, targetValue: { type: ['number', 'null'] }, currentValue: { type: ['number', 'null'] },
  status: { enum: ['active', 'done', 'dropped'] }, brief: REF, docs: arr(REF, 20), projects: arr(PROJECT_IN, 60), tasks: arr(TASK1, 200) };
const GOAL_IN = object({ ...GOAL_FIELDS, goals: arr(object(GOAL_FIELDS, []), 20) }, []);
const FOLDER_IN = object({ key: KEY, id: uuid, path: text(600), name: text(120), access: { enum: ['company', 'people'] }, people: arr(WHO, 100) }, []);
const DOC_IN = object({ key: KEY, id: uuid, title: text(200), folder: { ...REF, maxLength: 600, description: 'A folder key from folders, a folder id, or a path such as "Plans/Sales X-Ray plan".' },
  markdown: { type: 'string', maxLength: 500000 }, tags: arr({ type: 'string', maxLength: 40 }, 20), category: maybeText(40), access: { enum: ['private', 'company'] } }, []);
const DECISION_IN = object({ key: KEY, id: uuid, kind: { enum: ['decision', 'question'] }, ref: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9.-]{0,19}$' }, text: text(2000),
  saidBy: text(200, 0), saidOn: day, quote: text(2000, 0), status: { enum: ['made', 'changed', 'dropped', 'open', 'settled'] }, answer: text(2000, 0), owner: WHO,
  doc: REF, goal: REF, project: REF, drives: arr(REF, 50) }, []);

// ------------------------------------------------------------------------------------------------ the tree (output)
const DOC_REF = object({ id: uuid, title: str, role: str });
const BRIEF_REF = { anyOf: [{ type: 'null' }, DOC_REF] };
const STEP = object({ label: str, done: bool });
const node = (sub: Record<string, unknown>) => object({ id: uuid, key: maybe, title: str, status: str, assignee: maybe, assigneeId: maybe, dueOn: maybe, priority: maybe,
  steps: { type: 'array', items: STEP }, blockedBy: { type: 'array', items: object({ id: uuid, title: str, status: str }) }, docs: { type: 'array', items: DOC_REF }, subtasks: sub });
const NODE = node({ type: 'array', items: node({ type: 'array', items: node({ type: 'array', maxItems: 0 }) }) });
const PROJECT_TREE = object({ id: uuid, key: maybe, name: str, summary: maybe, owner: maybe, dueOn: maybe, brief: BRIEF_REF, docs: { type: 'array', items: DOC_REF },
  tasks: { type: 'array', items: NODE }, openTasks: int, doneTasks: int });
const GOAL_TREE = object({ id: uuid, key: maybe, title: str, why: maybe, level: str, status: str, targetOn: maybe, owner: maybe, progress: num, brief: BRIEF_REF,
  docs: { type: 'array', items: DOC_REF }, projects: { type: 'array', items: PROJECT_TREE }, tasks: { type: 'array', items: NODE },
  decisions: { type: 'array', items: object({ id: uuid, kind: str, ref: maybe, text: str, status: str, saidBy: maybe }) } });
const STATS = object({ created: int, updated: int, unchanged: int });
const RESULT = object({ dryRun: bool, counts: object({ goal: STATS, project: STATS, task: STATS, doc: STATS, folder: STATS, decision: STATS, links: int, blockers: int, notified: int }),
  keys: { type: 'array', items: object({ kind: str, key: str, id: uuid }) }, warnings: { type: 'array', items: str },
  goals: { type: 'array', items: GOAL_TREE }, projects: { type: 'array', items: PROJECT_TREE }, changeId: maybe });

const PLAN_HELP = 'One plan: goals (each with its projects, each project with tasks, sub-tasks up to 3 levels and checklist steps), loose projects and tasks, '
  + 'folders (made by path; access people with people makes one private to them), docs (Markdown, put in a folder, with tags and a category such as "Meeting notes"), '
  + 'doc links (brief or docs on any goal, project or task: keys from docs or doc ids), blockers (blockedBy keys; waitingOn "@username: what" or outside words) and '
  + 'decisions and open questions (kind decision|question, ref D1/O1, who said it, the quote, status, linked to a doc, goal or project, and the tasks they drive). '
  + 'Every item needs a key (your stable id, e.g. a T-id) or the id of an existing record: sending the same plan again changes what differs and never makes duplicates. '
  + 'Existing projects or goals are linked by id. People are ids, @usernames or work e-mails. It all happens in one transaction: one refusal and nothing changes. '
  + 'dryRun true does everything, reads the tree back and then undoes it (the ids shown are not kept). notify digest (default) sends each person one notice for all their '
  + 'new tasks; now sends one per task; none sends none. Answers with counts, every key\'s id and the whole tree as written (as get_goal_tree).';

/** Whether a plan makes or changes any task (anywhere in its goals, sub-goals and projects). */
const hasTasks = (o: Row): boolean => ['tasks', 'goals', 'projects'].some(k => Array.isArray(o[k]) && (o[k] as Row[]).some(x => k === 'tasks' || hasTasks(x)));

defineV1Operation({ operationId: 'applyPlan', method: 'POST', path: '/api/v1/projects/plans', scope: 'projects.write', keyScopes: ['tasks.write', 'docs.write', 'docs.read'],
  summary: 'Put a whole plan into Pulse in one call: goals, projects, tasks, sub-tasks, checklist steps, docs, folders, doc links, blockers and decisions',
  body: object({ title: text(120), key: text(80), notify: { enum: ['digest', 'now', 'none'] }, dryRun: bool, goals: arr(GOAL_IN, 20), projects: arr(PROJECT_IN, 60), tasks: arr(TASK1, 300),
    folders: arr(FOLDER_IN, 20), docs: arr(DOC_IN, 50), decisions: arr(DECISION_IN, 200) }, []),
  response: RESULT, authorize: member,
  mcp: { name: 'apply_plan', title: 'Apply a plan', description: PLAN_HELP, idempotent: true },
  handler: async (ctx, { body }) => {
    const b = body as PlanInput & Row;
    const held = await ctx.keyScopes!(['tasks.write', 'docs.write', 'docs.read']);
    const tasks = hasTasks(b);
    if (tasks && !held.includes('tasks.write')) v1Fail(403, 'This plan makes tasks: this connection needs tasks.write too (see whoami for how to add it)');
    if (((b.docs?.length ?? 0) || (b.folders?.length ?? 0)) && !held.includes('docs.write')) v1Fail(403, 'This plan writes docs or folders: this connection needs docs.write too (see whoami for how to add it)');
    const r = await applyPlan(ctx.client, b, held.includes('docs.read'));
    const keys = Object.entries(r.keys).map(([k, id]) => ({ kind: k.split(':')[0], key: k.slice(k.indexOf(':') + 1), id }));
    const changeId = r.dryRun ? null : await change(ctx, 'plan.apply', r.goals[0]?.id ?? r.projects[0]?.id ?? ctx.principal.id, { key: b.key ?? null, counts: r.counts });
    return { ...r, keys, changeId };
  },
});

defineV1Operation({ operationId: 'getGoalTree', method: 'GET', path: '/api/v1/projects/goals/{goalId}/tree', scope: 'projects.read', keyScopes: ['docs.read'],
  summary: 'A goal with everything under it in one read: projects, tasks, sub-tasks, steps, blockers, docs, decisions and open questions',
  params: object({ goalId: uuid }), response: object({ goal: GOAL_TREE }),
  mcp: { name: 'get_goal_tree', title: 'Read a goal\'s whole tree',
    description: 'Reads one goal and everything under it: its projects (summary, brief, docs, tasks with their sub-tasks up to 3 levels, checklist steps with which are done, and what each waits on), its own tasks, its brief and docs, and the decisions and open questions recorded on it, its projects or its docs. Use it to check what a plan wrote. Keys you gave with apply_plan come back on each item.' },
  handler: async (ctx, { params }) => { await member(ctx); return { goal: await goalTree(ctx.client, params.goalId, (await ctx.keyScopes!(['docs.read'])).includes('docs.read')) }; },
});

// ------------------------------------------------------------------------------------------------ waiting on
const WAIT = object({ taskId: uuid, task: str, status: str, on: object({ kind: { enum: ['task', 'outside'] }, id: { type: ['string', 'null'] }, title: str, status: str, who: maybe }), note: maybe });
const WAITED = object({ taskId: uuid, task: str, status: str, waiter: object({ id: uuid, title: str, who: maybe }) });
defineV1Operation({ operationId: 'listWaiting', method: 'GET', path: '/api/v1/tasks/waiting', scope: 'tasks.read',
  summary: 'What you (or one person) wait on, and who waits on you',
  query: object({ personId: uuid }, []), response: object({ waitingOn: { type: 'array', items: WAIT }, waitingOnMe: { type: 'array', items: WAITED } }),
  mcp: { name: 'list_waiting', title: 'What am I waiting on', description: 'Lists the open tasks that wait on another task (with that task, its status and who has it) or on something outside Pulse, and the open tasks of yours that others wait on (who waits and on what). personId shows one person\'s instead of yours (only the tasks you may see).' },
  handler: async (ctx, { query }) => {
    await member(ctx);
    return waiting(ctx.client, query.personId ?? ctx.principal.id);
  },
});

defineV1Operation({ operationId: 'blockTask', method: 'POST', path: '/api/v1/tasks/{taskId}/blockers', scope: 'tasks.write',
  summary: 'Make a task wait on another task (it unblocks by itself when that one is finished)',
  params: object({ taskId: uuid }), body: object({ blockerId: uuid, note: text(300, 0) }, ['blockerId']),
  response: object({ linkId: uuid, taskId: uuid, blockerId: uuid, changeId: maybe }), authorize: member,
  mcp: { name: 'block_task', title: 'Make a task wait on another', description: 'Makes taskId wait on blockerId (both from list_tasks). While the blocker is open the task shows Blocked and the blocker\'s person is told someone waits; when the blocker is finished the task unblocks by itself and its person is told. Loops are refused.' },
  handler: async (ctx, { params, body }) => {
    const b = body as Row;
    const linkId = await one<string>(ctx, 'select pulse.task_block($1,$2,$3) v', [params.taskId, b.blockerId, typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null]);
    return { linkId, taskId: params.taskId, blockerId: String(b.blockerId), changeId: await change(ctx, 'task.block', params.taskId, { blockerId: b.blockerId }) };
  },
});
defineV1Operation({ operationId: 'unblockTask', method: 'DELETE', path: '/api/v1/tasks/{taskId}/blockers/{blockerId}', scope: 'tasks.write',
  summary: 'Stop a task waiting on another task', params: object({ taskId: uuid, blockerId: uuid }),
  response: object({ cleared: int, changeId: maybe }), authorize: member,
  mcp: { name: 'unblock_task', title: 'Stop a task waiting', description: 'Takes the blocker off a task (the people on either task, their team head or leadership may). With no blocker left the task goes back to open or in progress.' },
  handler: async (ctx, { params }) => {
    const cleared = await one<number>(ctx, 'select pulse.task_unblock($1,$2) v', [params.taskId, params.blockerId]);
    return { cleared, changeId: await change(ctx, 'task.unblock', params.taskId, { blockerId: params.blockerId }) };
  },
});

// ------------------------------------------------------------------------------------------------ folders by path
const FOLDER = object({ id: uuid, name: str, parentId: { type: ['string', 'null'] }, createdBy: uuid, canEdit: bool, docs: int, files: int, access: { enum: ['company', 'people'] }, canShare: bool,
  people: { type: 'array', items: object({ personId: uuid, name: str }) } });
defineV1Operation({ operationId: 'ensureDocFolder', method: 'POST', path: '/api/v1/docs/folders/ensure', scope: 'docs.write',
  summary: 'Find or make a doc folder by its path (each part inside the one before), optionally private to chosen people',
  body: object({ path: text(600), access: { enum: ['company', 'people'] }, people: { type: 'array', maxItems: 100, items: uuid } }, ['path']),
  response: object({ folder: FOLDER, created: bool }), authorize: member,
  mcp: { name: 'ensure_doc_folder', title: 'Find or make a folder by path',
    description: 'Finds the folder at a path like "Plans/Sales X-Ray plan" and makes the parts that are missing. access people with people (person ids from search_people) makes the last folder private to them and you (company: everyone). Sending it again changes nothing.', idempotent: true },
  handler: async (ctx, { body }) => {
    const b = body as Row;
    const r = await ensureFolderPath(ctx.client, String(b.path));
    if (b.access !== undefined || b.people !== undefined) await saveFolder(ctx.client, r.id, { ...(b.access !== undefined ? { access: b.access } : {}), ...(b.people !== undefined ? { people: b.people } : {}) });
    const folder = (await listFolders(ctx.client)).find(f => f.id === r.id) ?? v1Fail(404, 'Folder not found');
    return { folder, created: r.created };
  },
});

// ------------------------------------------------------------------------------------------------ workflow log (T7.2)
const STEP_IN = object({ name: text(200), startedAt: text(40), endedAt: text(40), minutes: { type: 'number', minimum: 0, maximum: 100000 }, ok: bool, note: text(500, 0) }, ['name']);
const FAIL_IN = object({ step: text(200, 0), what: text(1000), why: text(1000, 0), fix: text(1000, 0) }, ['what']);
const RUN = object({ id: uuid, lane: str, workflow: str, startedAt: str, endedAt: maybe, durationS: { type: ['integer', 'null'] }, outcome: str,
  steps: { type: 'array', items: STEP_IN }, failures: { type: 'array', items: FAIL_IN }, why: maybe, lesson: maybe, playbook: maybe, runKey: maybe, taskId: maybe, by: maybe });
defineV1Operation({ operationId: 'logWorkflowRun', method: 'POST', path: '/api/v1/projects/workflow-runs', scope: 'workflows.write',
  summary: 'Add one run to the workflow log: start, end, steps, failures, why, and the lesson for next time',
  body: object({ lane: text(80), workflow: text(160), startedAt: text(40), endedAt: text(40), outcome: { enum: ['ok', 'partial', 'failed', 'blocked'] },
    steps: arr(STEP_IN, 100), failures: arr(FAIL_IN, 50), why: text(4000, 0), lesson: text(4000, 0), playbook: text(2000, 0), runKey: text(200), taskId: uuid }, ['lane', 'workflow', 'startedAt', 'outcome']),
  response: object({ id: uuid, created: bool }), authorize: member,
  mcp: { name: 'log_workflow_run', title: 'Log a workflow run',
    description: 'Adds one run of a big workflow to the company\'s workflow log: lane (who ran it), workflow (what), startedAt and endedAt (ISO; the duration follows), outcome ok|partial|failed|blocked, steps [{name, minutes, ok, note}], failures [{step, what, why, fix}], why (why it went this way), lesson (what to do better) and playbook (a proposed playbook change). runKey makes a retry change nothing. The daily review reads these and proposes playbook changes.', idempotent: true },
  handler: async (ctx, { body }) => logRun(ctx.client, body as Row),
});
defineV1Operation({ operationId: 'listWorkflowLogRuns', method: 'GET', path: '/api/v1/projects/workflow-runs', scope: 'workflows.read',
  summary: 'The workflow log: runs newest first, with their steps, failures and lessons',
  query: object({ lane: qText(80), since: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}' }, limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|1[0-9][0-9]|200)$' } }, []),
  response: object({ items: { type: 'array', items: RUN } }),
  mcp: { name: 'list_workflow_runs', title: 'Read the workflow log', description: 'Lists workflow runs newest first (one lane with lane, from a day with since YYYY-MM-DD, up to 200): duration, outcome, steps, failures, why and the lesson. The daily review uses it to propose playbook changes.' },
  handler: async (ctx, { query }) => { await member(ctx); return { items: await listRuns(ctx.client, { lane: query.lane, since: query.since, limit: query.limit ? Number(query.limit) : undefined }) }; },
});
