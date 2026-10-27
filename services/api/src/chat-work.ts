import type { FastifyInstance } from 'fastify';
import { ORG_TZ } from './org-time.js';
import { fail, type Tx, type Viewer } from './routes.js';

/** CHAT-WORK (owner, 22 Oct 2026: "all things can be done via chat"). What a group is working on, asked from its
 *  composer (/tasks, /projects, /steps): the open tasks, live projects and Flow steps of the group's people (a pod's
 *  group also its pod's projects), only what the asker may see; and a task given in a chat answered there (take it,
 *  decline it, ask a question: 0905_chat_work.sql). Nothing here is written to the chat unless the person shares it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (raw: unknown, what = 'conversation') => UUID.test(String(raw)) ? String(raw) : fail(400, `Choose a valid ${what}`);
const member = (v: Viewer) => v.person ?? fail(403, 'Chats requires your individual employee account');
type Body = Record<string, unknown>;
const body = { type: 'object' } as const;
const DUE = `coalesce(t.work_on,(t.due_at at time zone ${ORG_TZ})::date)`;
const TODAY = `(now() at time zone ${ORG_TZ})::date`;
export const WORK_KINDS = ['tasks', 'projects', 'steps'] as const;
export type WorkKind = typeof WORK_KINDS[number];

export function registerChatWorkRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // GET /api/v0/chats/:id/work?kind=tasks|projects|steps: the group's work, for one of its members.
  app.get<{ Params: { id: string }; Querystring: { kind?: string } }>('/api/v0/chats/:id/work', req => tx(req, async (c, v) => {
    const me = member(v), cid = id(req.params.id), kind = (WORK_KINDS as readonly string[]).includes(String(req.query.kind)) ? req.query.kind as WorkKind : fail(400, 'Ask for tasks, projects or steps');
    const ch = (await c.query(`select ch.id,ch.kind,ch.name,(select u.name from pulse.unit u where ch.kind='pod' and 'pod:'||u.id=ch.key) pod
      from pulse.chat_channel ch join pulse.chat_member cm on cm.channel_id=ch.id and cm.person_id=$2 where ch.id=$1`, [cid, me])).rows[0];
    if (!ch) fail(404, 'Conversation unavailable');
    const people = (await c.query('select cm.person_id id from pulse.chat_member cm where cm.channel_id=$1 and pulse.chat_current(cm.person_id)', [cid])).rows.map((r) => r.id as string);
    const scope = { kind: ch.kind as string, name: ch.kind === 'direct' ? 'the two of you' : ch.name as string, pod: ch.pod as string | null, people: people.length };
    if (kind === 'tasks') {
      const rows = (await c.query(`select t.id,t.title,t.status,pulse.chat_task_label(t.status) "statusLabel",t.priority,t.assignee_person_id "assigneeId",a.display_name "assigneeName",
        a.side='agent' "assigneeAgent",${DUE}::text "dueOn",(${DUE}<${TODAY}) late,coalesce(pr.title,pr.name) "projectName"
        from pulse.task t left join pulse.person a on a.id=t.assignee_person_id left join pulse.project pr on pr.id=t.project_id
        where t.deleted_at is null and t.status in ('open','in_progress','blocked','in_review') and t.id in (select pulse.task_visible_ids())
          and (coalesce(t.assignee_person_id,t.owner_id)=any($1::uuid[]) or ($2::text is not null and exists(select 1 from pulse.work_project wp where wp.project_id=t.project_id and wp.pod=$2)))
        order by t.status='blocked' desc,(${DUE}<${TODAY}) desc nulls last,${DUE} nulls last,coalesce(t.updated_at,t.created_at) desc limit 41`, [people, scope.pod])).rows;
      return { scope, kind, more: rows.length > 40, tasks: rows.slice(0, 40) };
    }
    if (kind === 'projects') {
      const rows = (await c.query(`select wp.project_id id,coalesce(pr.title,pr.name) name,wp.kind,wp.status,wp.pod,o.display_name "ownerName",
        (select count(*)::int from pulse.task t where t.project_id=wp.project_id and t.deleted_at is null and t.status in ('open','in_progress','blocked')) open,
        (select count(*)::int from pulse.task t where t.project_id=wp.project_id and t.deleted_at is null and t.status in ('open','in_progress','blocked') and ${DUE}<${TODAY}) late,
        (select min(${DUE})::text from pulse.task t where t.project_id=wp.project_id and t.deleted_at is null and t.status in ('open','in_progress','blocked') and ${DUE}>=${TODAY}) "nextDue"
        from pulse.work_project wp join pulse.project pr on pr.id=wp.project_id left join pulse.person o on o.id=wp.owner_id
        where wp.status not in ('done','cancelled') and pr.status<>'cancelled'
          and (($2::text is not null and wp.pod=$2) or wp.owner_id=any($1::uuid[])
               or exists(select 1 from pulse.project_member m where m.project_id=wp.project_id and m.person_id=any($1::uuid[]) and m.left_at is null))
        order by 8 desc,7 desc,coalesce(pr.title,pr.name) limit 31`, [people, scope.pod])).rows;
      return { scope, kind, more: rows.length > 30, projects: rows.slice(0, 30) };
    }
    const rows = (await c.query(`select s.id,s.title,s.state,s.due_on::text "dueOn",s.due_on<${TODAY} late,s.blocked_at is not null blocked,s.run_id "runId",r.name run,p.name process,
      s.person_id "personId",pe.display_name "personName",exists(select 1 from pulse.chat_flow_follow f where f.run_id=s.run_id and f.channel_id=$3) followed
      from pulse.flow_run_step s join pulse.flow_run r on r.id=s.run_id join pulse.flow_process p on p.id=r.process_id left join pulse.person pe on pe.id=s.person_id
      where r.status='running' and r.mode='live' and s.state in ('open','in_progress','in_review')
        and (s.person_id=any($1::uuid[]) or ($2::text is not null and exists(select 1 from pulse.work_project wp where wp.project_id=r.project_id and wp.pod=$2)))
      order by s.blocked_at is not null desc,s.due_on nulls last,s.position limit 41`, [people, scope.pod, cid])).rows;
    return { scope, kind, more: rows.length > 40, steps: rows.slice(0, 40).map((s) => ({ ...s, href: `/runs/${s.runId}?step=${s.id}` })) };
  }));

  // J6: a run's step updates post into this chat too (only someone in the run turns it on).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/chats/flow-runs/:id/follow', { schema: { body } }, req => tx(req, async (c, v) => {
    member(v); if (typeof req.body.on !== 'boolean') fail(400, 'Turn updates on or off');
    await c.query('select pulse.chat_flow_follow_set($1,$2,$3)', [id(req.params.id, 'run'), id(req.body.channelId), req.body.on]); return { ok: true };
  }));

  // The person a task was given to in a chat answers there: accept, decline (a reason optional) or ask (a question).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/chats/tasks/:id/respond', { schema: { body } }, req => tx(req, async (c, v) => {
    member(v);
    const answer = String(req.body.answer ?? '');
    if (!['accept', 'decline', 'ask'].includes(answer)) fail(400, 'Take it, decline it or ask a question');
    const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    if (note.length > 500) fail(400, 'Keep it to 500 characters');
    return (await c.query('select pulse.chat_task_respond($1,$2,$3,$4) r', [id(req.params.id, 'task'), id(req.body.channelId), answer, note || null])).rows[0].r;
  }));
}
