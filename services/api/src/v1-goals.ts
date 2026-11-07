// FOUNDATIONS (owner, 6 Nov 2026): goals over API v1, so MCP and the `pulse` CLI get them from the same definitions.
// A goal holds projects and tasks, so it lives in the projects area (projects.read / projects.write): no key gains a
// new area, and a key that reads projects reads the goals its principal may see. Every rule is the screens' own
// (goals.ts and the database's goal_can_see / goal_can_edit under row security).
import { getGoal, goalWork, linkGoal, listGoals, saveGoal, unlinkGoal, type GoalLevel } from './goals.js';
import { pageResponse, PAGE_QUERY, pageV1 } from './v1-paging.js';
import { defineV1Operation } from './v1.js';
import { bool, change, day, int, maybe, maybeNum, member, num, object, str, text, uuid, type Row } from './v1-kit.js';

const LEVEL = { enum: ['person', 'team', 'company'] }, STATUS = { enum: ['active', 'done', 'dropped'] };
const MAYBE_ID = { type: ['string', 'null'], pattern: uuid.pattern };
const MEASURE = { type: ['object', 'null'], additionalProperties: false, required: ['label', 'start', 'target', 'current'],
  properties: { label: str, start: num, target: num, current: num } };
const PROGRESS = object({ progress: num, measure: maybeNum, work: maybeNum, tasks: int, tasksDone: int, projects: int, subGoals: int, late: bool,
  basis: { enum: ['measure', 'work', 'done', 'none'] } });
const GOAL = object({ id: uuid, level: LEVEL, title: str, why: maybe, ownerId: MAYBE_ID, owner: maybe, teamId: MAYBE_ID, team: maybe, parentId: MAYBE_ID, parent: maybe,
  targetOn: maybe, measure: MEASURE, status: STATUS, createdBy: uuid, createdAt: str, updatedAt: str, doneAt: maybe, canEdit: bool, progress: PROGRESS });
const LINK = object({ id: uuid, kind: { enum: ['project', 'task'] }, projectId: MAYBE_ID, taskId: MAYBE_ID, title: str, status: str, who: maybe, dueOn: maybe, tasks: int, tasksDone: int });
const VALUE = { type: ['number', 'null'], minimum: -1e13, maximum: 1e13 };
const FIELDS = { title: text(160), why: { type: ['string', 'null'], maxLength: 2000 }, ownerId: MAYBE_ID, teamId: uuid, parentId: MAYBE_ID,
  targetOn: { type: ['string', 'null'], pattern: day.pattern }, measureLabel: { type: ['string', 'null'], maxLength: 60 }, startValue: VALUE, targetValue: VALUE, currentValue: VALUE };
const DESCRIBE_FIELDS = 'title; why (a sentence on why it matters); targetOn (YYYY-MM-DD); a measurable target with measureLabel (what it counts, e.g. "clients signed"), '
  + 'startValue, targetValue and currentValue (progress is then how far currentValue has moved from startValue to targetValue; otherwise it is the share of its tasks done, '
  + 'counting the tasks of its projects, and its sub-goals); parentId puts it under a bigger goal.';

defineV1Operation({ operationId: 'listGoals', method: 'GET', path: '/api/v1/projects/goals', scope: 'projects.read',
  summary: 'Goals you can see: the company\'s, teams\' and people\'s, with progress rolled up',
  query: object({ ...PAGE_QUERY, level: LEVEL, who: { enum: ['me', 'all'] }, status: STATUS, ownerId: uuid }, []),
  response: pageResponse(GOAL),
  mcp: { name: 'list_goals', title: 'List goals',
    description: 'Lists goals with their progress (0 to 1), target date and measurable target. level person, team or company; who "me" keeps goals you own or set; status active, done or dropped; ownerId one person\'s. Everyone sees company and team goals; a person\'s goals are seen by them, their managers, HR and leadership. Pages of up to 100 with nextCursor.' },
  handler: async (ctx, input) => {
    await member(ctx);
    const q = input.query;
    return pageV1(ctx, 'listGoals', input, (after, take) => listGoals(ctx.client, { level: q.level as GoalLevel | undefined, who: q.who === 'me' ? 'me' : 'all', status: q.status, ownerId: q.ownerId, after, take }));
  },
});

defineV1Operation({ operationId: 'getGoal', method: 'GET', path: '/api/v1/projects/goals/{goalId}', scope: 'projects.read',
  summary: 'One goal with the projects and tasks it holds and its sub-goals',
  params: object({ goalId: uuid }),
  response: object({ goal: GOAL, links: { type: 'array', items: LINK }, subGoals: { type: 'array', items: GOAL } }),
  mcp: { name: 'get_goal', title: 'Get a goal', description: 'Reads one goal: its progress and how it is worked out (basis measure, work or done), its target, the projects and tasks it holds (with their status and task counts) and its sub-goals.' },
  handler: async (ctx, { params }) => {
    await member(ctx);
    const goal = await getGoal(ctx.client, params.goalId);
    return { goal, ...(await goalWork(ctx.client, goal.id)) };
  },
});

defineV1Operation({ operationId: 'createGoal', method: 'POST', path: '/api/v1/projects/goals', scope: 'projects.write',
  summary: 'Set a goal for yourself or a person you manage, a team, or the company',
  body: object({ level: LEVEL, ...FIELDS }, ['level', 'title']),
  response: object({ goal: GOAL, changeId: maybe }), authorize: member,
  mcp: { name: 'create_goal', title: 'Set a goal',
    description: `Sets a goal. level person (yours by default; ownerId for someone you manage), team (teamId; leadership, admins and the team's heads) or company (leadership and admins). Fields: ${DESCRIBE_FIELDS} Then add work with link_goal_work.` },
  handler: async (ctx, { body }) => {
    const id = await saveGoal(ctx.client, null, body as Row);
    const goal = await getGoal(ctx.client, id);
    return { goal, changeId: await change(ctx, 'goal.create', id, { level: goal.level, title: goal.title }) };
  },
});

defineV1Operation({ operationId: 'updateGoal', method: 'PATCH', path: '/api/v1/projects/goals/{goalId}', scope: 'projects.write',
  summary: 'Change a goal: its words, dates, target, value now or status (done, dropped)',
  params: object({ goalId: uuid }),
  body: object({ ...FIELDS, status: STATUS }, []),
  response: object({ goal: GOAL, changeId: maybe }), authorize: member,
  mcp: { name: 'update_goal', title: 'Update a goal',
    description: `Changes only the fields sent. ${DESCRIBE_FIELDS} status done or dropped closes it (active reopens it). Record progress on a measurable goal by sending currentValue. Whoever may set the goal may change it.`, idempotent: true },
  handler: async (ctx, { params, body }) => {
    const before = await getGoal(ctx.client, params.goalId);
    const id = await saveGoal(ctx.client, before.id, body as Row);
    const goal = await getGoal(ctx.client, id);
    return { goal, changeId: await change(ctx, 'goal.update', id, { fields: Object.keys(body as Row), status: before.status, currentValue: before.measure?.current ?? null }) };
  },
});

defineV1Operation({ operationId: 'linkGoalWork', method: 'POST', path: '/api/v1/projects/goals/{goalId}/links', scope: 'projects.write',
  summary: 'Put a project or a task under a goal (its progress counts toward the goal)',
  params: object({ goalId: uuid }),
  body: object({ projectId: uuid, taskId: uuid }, []),
  response: object({ linkId: uuid, goal: GOAL, changeId: maybe }), authorize: member,
  mcp: { name: 'link_goal_work', title: 'Add work to a goal',
    description: 'Puts one project (projectId, from list_projects) or one task (taskId, from list_tasks) under a goal you may change. Its tasks then count toward the goal\'s progress. Adding the same work twice is harmless.', idempotent: true },
  handler: async (ctx, { params, body }) => {
    const linkId = await linkGoal(ctx.client, params.goalId, body as Row);
    return { linkId, goal: await getGoal(ctx.client, params.goalId), changeId: await change(ctx, 'goal.link', params.goalId, { linkId, ...(body as Row) }) };
  },
});

defineV1Operation({ operationId: 'unlinkGoalWork', method: 'DELETE', path: '/api/v1/projects/goals/{goalId}/links/{linkId}', scope: 'projects.write',
  summary: 'Take a project or a task off a goal (the work itself is unchanged)',
  params: object({ goalId: uuid, linkId: uuid }),
  response: object({ goal: GOAL, changeId: maybe }), authorize: member,
  mcp: { name: 'unlink_goal_work', title: 'Take work off a goal', description: 'Removes one link (its id from get_goal) from a goal you may change. The project or task itself is not touched.' },
  handler: async (ctx, { params }) => {
    await unlinkGoal(ctx.client, params.goalId, params.linkId);
    return { goal: await getGoal(ctx.client, params.goalId), changeId: await change(ctx, 'goal.unlink', params.goalId, { linkId: params.linkId }) };
  },
});
