// AI-TASKS (owner, 25 Oct 2026: "assign tasks directly to AI employees, and they do the work like a real employee"):
// the routes an AI employee's runtime calls while it works a task (with its key, like agents.ts), and what people read
// about that work. The database decides everything (1064_ai_tasks.sql): inside a run on its own task it plans,
// comments, attaches what it wrote, makes sub-tasks for people, messages colleagues, drafts a card for a client
// conversation and moves the task, all in one step (agent_task_act); a retry of the same run returns the same result.
import type { FastifyInstance } from 'fastify';
import { agentTxFor } from './agents.js';
import { fail, type Open, type Tx } from './routes.js';

type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (x: unknown, what: string) => UUID.test(String(x)) ? String(x) : fail(400, `Choose a valid ${what}`);
const str = (x: unknown, max: number) => typeof x === 'string' ? x.trim().slice(0, max) : '';
const body = { type: 'object' } as const;
const list = (x: unknown, max: number) => Array.isArray(x) ? x.slice(0, max) : [];
const obj = (x: unknown): Body => x && typeof x === 'object' && !Array.isArray(x) ? x as Body : {};

/** What the runtime sends after a run on a task, kept to the shapes and sizes agent_task_act reads. */
export function taskAct(b: Body) {
  const status = str(b.status, 10) || 'working';
  if (!['working', 'waiting', 'done'].includes(status)) fail(400, 'Say working, waiting or done');
  const plan = list(b.plan, 12).map((s) => typeof s === 'string' ? { label: s.trim().slice(0, 200), done: false } : { label: str(obj(s).label, 200), done: obj(s).done === true }).filter((s) => s.label);
  const files = list(b.files, 3).map((f) => ({ name: str(obj(f).name, 120), text: typeof obj(f).text === 'string' ? String(obj(f).text).slice(0, 400000) : '' })).filter((f) => f.text.trim());
  const subtasks = list(b.subtasks, 3).map((s) => ({ title: str(obj(s).title, 300), assignee: str(obj(s).assignee, 60), dueOn: /^\d{4}-\d{2}-\d{2}$/.test(str(obj(s).dueOn, 10)) ? str(obj(s).dueOn, 10) : null, notes: str(obj(s).notes, 4000) }));
  // AI-TASKS 1097: follow-ups for colleagues (new tasks that do not hold this one).
  const followups = list(b.followups, 5).map((s) => ({ title: str(obj(s).title, 300), assignee: str(obj(s).assignee, 60), dueOn: /^\d{4}-\d{2}-\d{2}$/.test(str(obj(s).dueOn, 10)) ? str(obj(s).dueOn, 10) : null, notes: str(obj(s).notes, 4000) }));
  const messages = list(b.messages, 2).map((m) => ({ to: str(obj(m).to, 60), text: str(obj(m).text, 3500) })).filter((m) => m.to && m.text);
  const post = b.post && typeof b.post === 'object' ? { channel: str(obj(b.post).channel, 40), text: str(obj(b.post).text, 4000), why: str(obj(b.post).why, 600) } : null;
  return { status, plan, comment: str(b.comment, 4000), files, subtasks, followups, messages, ...(post && post.text ? { post } : {}), waitingOn: str(b.waitingOn, 300) || null, continue: b.continue === true };
}

export function registerAgentTaskRoutes(app: FastifyInstance, { open, tx }: { open: Open; tx: Tx }) {
  const agentTx = agentTxFor(open);
  // Inside its run on a task: everything it did, at once. {status, phase, commentId, files, subtasks, messages, cards, posted, skipped}.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/runs/:id/task-act', { schema: { body } }, req => agentTx(req, async c =>
    (await c.query('select pulse.agent_task_act($1,$2,$3) r', [id(req.params.id, 'run'), JSON.stringify(taskAct(req.body)), id(req.body.clientId, 'client key')])).rows[0].r));
  // Each working day: its open tasks get a look (priority, then due date); at most once a task a day.
  app.post('/api/v0/agent/tasks/daily', req => agentTx(req, async c => (await c.query('select pulse.agent_tasks_daily() r')).rows[0].r));

  // People's side: an AI employee's work on one task, its queue, and throughput and cost per AI employee.
  app.get<{ Params: { id: string } }>('/api/v0/tasks/:id/ai', req => tx(req, async c =>
    ({ ai: (await c.query('select pulse.agent_task_status($1) s', [id(req.params.id, 'task')])).rows[0].s })));
  app.get<{ Params: { id: string } }>('/api/v0/agents/:id/queue', req => tx(req, async c =>
    ({ queue: (await c.query('select pulse.agent_task_queue($1) q', [id(req.params.id, 'AI employee')])).rows[0].q ?? fail(404, 'Not found') })));
  app.get<{ Querystring: { days?: string } }>('/api/v0/agents/tasks/throughput', req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Sign in with your own account to see this');
    return (await c.query('select pulse.agent_task_throughput($1) t', [Number(req.query.days) || 14])).rows[0].t;
  }));
}
