// TASK-MERGE (owner, 7 Nov 2026: merging "exposed everywhere: UI, API v1, MCP and CLI"): merge suggestions and merges
// over API v1. Each is one operation that the REST API, the MCP adapter (named tools) and the pulse CLI share, running as
// its principal and reusing the screens' own functions (merges.ts), so row security and the database functions decide
// exactly what the screens decide.
import { linkOrigin } from './tenant-context.js';
import { defineV1Operation } from './v1.js';
import { bool, int, list, maybe, member, num, object, str, text, uuid, viewerOf, type Row } from './v1-kit.js';
import { mergeStory, mergeTasks, rejectSuggestion, scanPerson, scanTeam, suggestionsFor, undoMerge } from './merges.js';

// FIX-SHELL: links in API answers point at the shared app address and the company path (linkOrigin).
const origin = () => linkOrigin();
const MTASK = object({ id: uuid, title: str, status: str, dueOn: maybe, projectName: maybe });
const SUGGESTION = object({ id: uuid, kind: { enum: ['duplicate', 'cluster'] }, score: num, method: str, title: str, reason: maybe, shape: { enum: ['task', 'brief'] },
  tasks: { type: 'array', items: MTASK } });
const MOVED = object({ links: int, proof: int, steps: int, subtasks: int, goals: int, comments: int });

defineV1Operation({ operationId: 'listMergeSuggestions', method: 'GET', path: '/api/v1/tasks/merge-suggestions', scope: 'tasks.read',
  summary: 'Merge suggestions for your open tasks (or a person you look after): duplicates and clusters that could become one task or brief',
  query: object({ personId: uuid }, []), response: list(SUGGESTION),
  mcp: { name: 'list_merge_suggestions', title: 'List merge suggestions',
    description: 'Lists open merge suggestions for your tasks, or for personId (from search_people) when you are their manager, HR or leadership: "duplicate" (tasks that read as the same work, merged into one task) and "cluster" (several tasks about one thing, merged into one brief with a step each), each with a score 0-1, the reason and the tasks. Run find_merge_suggestions first to look again. Nothing merges until merge_tasks.' },
  handler: async (ctx, { query }) => {
    await member(ctx);
    const v = await viewerOf(ctx);
    const rows = await suggestionsFor(ctx.client, query.personId ?? v.person!);
    return { items: rows.map((r: Row) => ({ id: String(r.id), kind: r.kind, score: Number(r.score), method: String(r.method), title: String(r.title), reason: (r.reason as string) ?? null, shape: r.shape,
      tasks: (r.tasks as Row[]).map((t) => ({ id: String(t.id), title: String(t.title), status: String(t.status), dueOn: (t.dueOn as string) ?? null, projectName: (t.projectName as string) ?? null })) })) };
  },
});

defineV1Operation({ operationId: 'findMergeSuggestions', method: 'POST', path: '/api/v1/tasks/merge-suggestions/scan', scope: 'tasks.write',
  summary: 'Look again for tasks that could be merged: yours, a person\'s you look after, or (team true) everyone you look after',
  body: object({ personId: uuid, team: bool }, []), response: object({ scanned: int, found: int, open: int }), authorize: member,
  mcp: { name: 'find_merge_suggestions', title: 'Find tasks to merge', idempotent: true,
    description: 'Scans open tasks for duplicates and clusters and keeps the proposals (a set someone rejected is never proposed again). Yours by default; personId for a person you manage (or anyone, for HR and leadership); team true for everyone you look after. Merges nothing.' },
  handler: async (ctx, { body }) => {
    const b = (body ?? {}) as { personId?: string; team?: boolean }, v = await viewerOf(ctx);
    if (b.team === true) { const r = await scanTeam(ctx.client, v); return { scanned: r.people, found: r.found, open: r.open }; }
    const r = await scanPerson(ctx.client, b.personId ?? v.person!);
    return { scanned: 1, found: r.found, open: r.open };
  },
});

defineV1Operation({ operationId: 'rejectMergeSuggestion', method: 'POST', path: '/api/v1/tasks/merge-suggestions/{suggestionId}/reject', scope: 'tasks.write',
  summary: 'Say a merge suggestion is wrong: the same tasks are never proposed together again',
  params: object({ suggestionId: uuid }), response: object({ rejected: bool }), authorize: member,
  mcp: { name: 'reject_merge_suggestion', title: 'Reject a merge suggestion', idempotent: true, description: 'Rejects a suggestion from list_merge_suggestions; the same set of tasks is never proposed again.' },
  handler: async (ctx, { params }) => rejectSuggestion(ctx.client, params.suggestionId),
});

defineV1Operation({ operationId: 'mergeTasks', method: 'POST', path: '/api/v1/tasks/merge', scope: 'tasks.write',
  summary: 'Merge several tasks into one new task or brief (or into one of them); the originals close as merged, with their history kept',
  body: object({ taskIds: { type: 'array', items: uuid, minItems: 1, maxItems: 30 }, targetId: uuid, title: text(300), shape: { enum: ['task', 'brief'] },
    reason: text(2000, 0), suggestionId: uuid }, ['taskIds']),
  response: object({ mergeId: uuid, targetId: uuid, madeNew: bool, merged: int, url: str, storyUrl: str }), authorize: member,
  mcp: { name: 'merge_tasks', title: 'Merge tasks into one', destructive: true,
    description: 'Merges taskIds (2-30 tasks you may change) into ONE: a new task (title, or the first task\'s) or, with shape "brief", a brief whose notes list each original as a step; with targetId, into that existing task instead. The originals are closed as "Merged into …" (never deleted) and keep their history and comments; what waited on them, their proof, ticked steps, subtasks and goal links move to the merged task. Pass suggestionId when accepting a suggestion and a short reason. Undo with undo_merge for 7 days.' },
  handler: async (ctx, { body }) => {
    const v = await viewerOf(ctx);
    const r = await mergeTasks(ctx.client, v, body as Row);
    return { ...r, url: `${origin()}/tasks/${r.targetId}`, storyUrl: `${origin()}/tasks/merges/${r.mergeId}` };
  },
});

defineV1Operation({ operationId: 'getMerge', method: 'GET', path: '/api/v1/tasks/merges/{mergeId}', scope: 'tasks.read',
  summary: 'Read a merge: what was merged into what, why, by whom, and what moved',
  params: object({ mergeId: uuid }),
  response: object({ id: uuid, title: str, reason: maybe, shape: str, method: str, createdAt: str, createdBy: maybe, undone: bool,
    target: object({ id: uuid, title: str, status: str, url: str }),
    sources: { type: 'array', items: object({ id: uuid, title: str, statusBefore: str, statusNow: maybe, url: str }) }, moved: MOVED }),
  mcp: { name: 'get_merge', title: 'Read a merge', description: 'Reads one merge (mergeId from merge_tasks): the merged task, each original with its status before and now, the reason, who merged and when, and how many links, proof items, steps, subtasks and goal links moved.' },
  handler: async (ctx, { params }) => {
    await member(ctx);
    const s = await mergeStory(ctx.client, await viewerOf(ctx), params.mergeId);
    const m = s.merge as Row, t = (s.target ?? {}) as Row;
    const n = (k: string) => Number((s.moved as Record<string, number>)[k] ?? 0);
    return { id: String(m.id), title: String(m.title), reason: (m.reason as string) ?? null, shape: String(m.shape), method: String(m.method),
      createdAt: new Date(m.createdAt as string).toISOString(), createdBy: (m.createdBy as string) ?? null, undone: !!m.undoneAt,
      target: { id: String(m.targetId), title: String(t.title ?? m.title), status: String(t.status ?? 'open'), url: `${origin()}/tasks/${m.targetId}` },
      sources: (s.sources as Row[]).map((x) => ({ id: String(x.id), title: String(x.title), statusBefore: String(x.statusBefore), statusNow: (x.statusNow as string) ?? null, url: `${origin()}/tasks/${x.id}` })),
      moved: { links: n('links'), proof: n('proof'), steps: n('steps'), subtasks: n('subtasks'), goals: n('goals'), comments: n('comments') } };
  },
});

defineV1Operation({ operationId: 'undoMerge', method: 'POST', path: '/api/v1/tasks/merges/{mergeId}/undo', scope: 'tasks.write',
  summary: 'Undo a merge within 7 days: the originals open again in the status they had',
  params: object({ mergeId: uuid }), response: object({ reopened: int }), authorize: member,
  mcp: { name: 'undo_merge', title: 'Undo a merge', description: 'Undoes a merge (within 7 days, by whoever merged or someone who may change the merged task): each original opens again in the status it had. Links, proof and steps stay on the merged task; a task the merge made is cancelled if nothing else happened to it.' },
  handler: async (ctx, { params }) => undoMerge(ctx.client, params.mergeId),
});
