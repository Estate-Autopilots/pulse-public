// EST-1035 (owner, 16 Oct 2026; contract: plan revision 3 on EST-1035, review "slice-1-review"): the routes an AI
// co-worker's runner calls with its company's key, and nothing else. The key travels in x-pulse-agent-key on
// /api/v0/agent/* only; the database checks it (agent_key_resolve: this company, not revoked or expired, the co-worker
// switched on; no person's credential alongside it) and the session then runs as that co-worker with pulse.agent_session on, so the chat checks and row
// security give it only the conversations it is a member of. No person's sign-in is read here, and a person's routes
// refuse an agent key (routes.ts, and the web proxy before it), so neither can stand in for the other.
//
// The runner's loop: claim (leases), dispatch (with the live lease: checked again, capacity reserved, run recorded and
// the event's context returned, all before any model call), answer in that conversation inside that run, maybe
// propose a hand-off on the answer, finish (the provider's own count, or unknown). Accepted hand-offs are claimed and
// filed once. Chats and tasks stay on the company's own server: the runner calls this from that server.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { admin, fail, leadership, type Open, type Tx, type Viewer } from './routes.js';
import type { Installation } from './installation.js';
import { staffUsername } from './records.js';
import { agentConnection, agentConnectionReport } from './connect-ai.js';
import { stackForAgent } from './stack-intel.js';

export const AGENT_KEY = /^pak_[0-9a-f]{8}_[0-9a-f]{64}$/;
export type Agent = { id: string; name: string; username: string | null };
type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (x: unknown, what: string) => UUID.test(String(x)) ? String(x) : fail(400, `Choose a valid ${what}`);
const optId = (x: unknown, what: string) => x === undefined || x === null || x === '' ? null : id(x, what);
const str = (x: unknown, max: number) => typeof x === 'string' ? x.trim().slice(0, max) : '';
const body = { type: 'object' } as const;
const when = (x: unknown) => { if (x === undefined || x === null || x === '') return null; const d = new Date(String(x)); return Number.isFinite(d.getTime()) ? d.toISOString() : fail(400, 'Give a valid time'); };
// CHAT-WORK: what an admin or its manager sets on an AI employee besides what anyone has (agent_settings_save checks each).
const SETTINGS = ['title', 'ownerId', 'pod', 'department', 'provider', 'model', 'effort', 'lane', 'dailyTokenBudget', 'runReserve', 'tools', 'speakScope', 'speakChannels', 'interject'] as const;
const settingsOf = (b: Body) => Object.fromEntries(SETTINGS.filter((k) => b[k] !== undefined).map((k) => [k, ['dailyTokenBudget', 'runReserve'].includes(k) ? String(b[k]) : b[k]]));
// AI-EMPLOYEES v2: who it listens to, how it acts per kind of message (own / approve / off), who approves, its
// instructions, SOP links and MCP servers (agent_ai_save checks each).
const AI_SETTINGS = ['listensTo', 'autonomy', 'approverId', 'instructions', 'sopLinks', 'mcpServers'] as const;
const aiSettingsOf = (b: Body) => Object.fromEntries(AI_SETTINGS.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
// The provider's own token count, or null when it reported none (shown as unknown, never as zero).
const tokens = (x: unknown) => x === null || x === undefined ? null : Number.isInteger(x) && (x as number) >= 0 ? x as number : fail(400, 'Give the tokens the provider reported, or null');
const seconds = (x: unknown) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : fail(400, 'Give the seconds the run took'); };
// A person's credential never travels with a co-worker key: such a request is refused before any database work.
const PERSON_HEADERS = ['authorization', 'cookie', 'x-pulse-session', 'x-pulse-client-session', 'cf-access-authenticated-user-email', 'cf-access-jwt-assertion'];
// Tokens a co-worker has used or reserved today, in the company's own day.
const USED_TODAY = (m: string) => `(select coalesce(sum(case when r.state in ('done','error') then coalesce(r.tokens,r.reserved) else r.reserved end),0)::int from pulse.agent_run r
  where r.agent_id=${m}.person_id and (r.started_at at time zone pulse.org_time_zone())::date=(now() at time zone pulse.org_time_zone())::date)`;

/** The transaction an AI co-worker's key opens: its company, it as the viewer, nothing of a person's. PRODUCT-MAP's AI
 *  pass (product-map.ts) uses the same. */
export function agentTxFor(open: Open) {
  return async <T>(request: FastifyRequest, run: (c: PoolClient, a: Agent) => Promise<T>): Promise<T> => {
    const key = request.headers['x-pulse-agent-key'];
    if (typeof key !== 'string' || !AGENT_KEY.test(key)) fail(401, 'An AI co-worker key is required');
    if (PERSON_HEADERS.some((h) => request.headers[h] !== undefined)) fail(401, 'Send the co-worker key alone, with no person\'s sign-in');
    return open(async c => {
      const who = (await c.query('select pulse.agent_key_resolve($1) id', [key])).rows[0]?.id as string | null;
      if (!who) fail(401, 'This co-worker key is unknown here, revoked or expired, or its co-worker is switched off');
      await c.query("select set_config('pulse.viewer_id',$1,true)", [who]);
      await c.query("select set_config('pulse.agent_session','on',true)");
      const a = (await c.query('select p.id,p.display_name name,pp.username from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=$1', [who])).rows[0] as Agent;
      await c.query("select set_config('pulse.actor_account',$1,true)", [`agent:${a.username ?? a.id}`]);
      return run(c, a);
    });
  };
}

export function registerAgentRoutes(app: FastifyInstance, { open }: { open: Open }) {
  const agentTx = agentTxFor(open);

  app.get('/api/v0/agent/me', req => agentTx(req, async (c, a) => {
    // CHAT-WORK: what its profile sets (runtime, model, effort, tools, where it may speak), for the runtime to follow.
    const m = (await c.query(`select m.title,m.run_reserve "runReserve",m.daily_token_budget "dailyBudget",${USED_TODAY('m')} "usedToday",
      m.provider,m.runtime model,m.effort,m.lane,m.tools,m.speak_scope "speakScope",m.interject,o.display_name manager,m.runtime_state "runtimeState",m.runtime_until "runtimeUntil",
      m.listens_to "listensTo",m.autonomy,m.instructions,m.sop_links "sopLinks",m.mcp_servers "mcpServers",ap.display_name approver,
      m.ai_connection_id "aiConnectionId",m.ai_workspace_id "aiWorkspaceId",m.access
      from pulse.agent_member m left join pulse.person o on o.id=m.owner_person_id left join pulse.person ap on ap.id=coalesce(m.approver_person_id,m.owner_person_id) where m.person_id=$1`, [a.id])).rows[0];
    return { ...a, ...m };
  }));
  // Up to ten events, leased for two minutes: [{event: {id, eventType, subjectType, subjectId, eventKey, createdAt}, leaseToken, leaseUntil, lane}].
  app.post<{ Body: Body }>('/api/v0/agent/events/claim', { schema: { body } }, req => agentTx(req, async c => {
    const limit = Number(req.body.limit), n = Number.isInteger(limit) && limit >= 1 && limit <= 10 ? limit : 5;
    // CHAT-WORK: a runtime that says it does tasks (kinds: ['chat','task']) is given tasks too; an older one only questions.
    const tasks = Array.isArray(req.body.kinds) && req.body.kinds.includes('task');
    return { events: (await c.query(tasks ? 'select pulse.agent_events_claim_kinds($1,true) e' : 'select pulse.agent_events_claim($1) e', [n])).rows[0].e };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/events/:id/release', { schema: { body } }, req => agentTx(req, async c => {
    await c.query('select pulse.agent_event_release($1,$2)', [id(req.params.id, 'event'), id(req.body.leaseToken, 'lease')]);
    return { ok: true };
  }));
  // {status: dispatched, runId, deadline, reserved, context} | {status: busy|refused, reason}.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/events/:id/dispatch', { schema: { body } }, req => agentTx(req, async c => {
    const ev = id(req.params.id, 'event');
    const k = (await c.query("select subject_type='task' t, event_type='consult.answer' consult from pulse.agent_event where id=$1", [ev])).rows[0];
    // SIM-CLIENTS (1035): a colleague's answer to its question (consult.answer) has its own dispatch.
    const fn = k?.t === true ? 'agent_task_dispatch' : k?.consult === true ? 'agent_consult_dispatch' : 'agent_dispatch';
    return (await c.query(`select pulse.${fn}($1,$2,$3,$4) d`, [ev, id(req.body.leaseToken, 'lease'), str(req.body.lane, 40), str(req.body.model, 80)])).rows[0].d;
  }));
  // CHAT-WORK: its report on a task, inside the run (posted in the task's chat; done goes to its manager's review).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/runs/:id/report', { schema: { body } }, req => agentTx(req, async c => {
    const text = str(req.body.body, 4001);
    if (!text || text.length > 4000) fail(400, 'Write the report in up to 4,000 characters');
    return (await c.query('select pulse.agent_task_report($1,$2,$3,$4) r', [id(req.params.id, 'run'), str(req.body.state, 10), text, id(req.body.clientId, 'client key')])).rows[0].r;
  }));
  // Its plan refused the run (out of quota): the run closes at no cost and the work waits until the plan resets.
  // AI-EMP (1003): reason "model_error" retries after a failure that is not a quota (closes as model_error, no quota mark).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/runs/:id/requeue', { schema: { body } }, req => agentTx(req, async c =>
    req.body.reason === 'model_error'
      ? (await c.query('select pulse.agent_run_requeue($1,$2,$3) r', [id(req.params.id, 'run'), when(req.body.until), 'model_error'])).rows[0].r
      : (await c.query('select pulse.agent_run_requeue($1,$2) r', [id(req.params.id, 'run'), when(req.body.until)])).rows[0].r));
  // How its runtime is: ready, out of quota (until when) or failing; the profile and cards say so as reported.
  app.post<{ Body: Body }>('/api/v0/agent/runtime', { schema: { body } }, req => agentTx(req, async c => {
    await c.query('select pulse.agent_runtime_report($1,$2,$3)', [str(req.body.state, 20), when(req.body.until), str(req.body.detail, 200) || null]);
    return { ok: true };
  }));
  // A note it keeps from a run (what it learned), given to its later runs.
  app.post<{ Body: Body }>('/api/v0/agent/memory', { schema: { body } }, req => agentTx(req, async (c, a) =>
    ({ id: (await c.query('select pulse.agent_memory_add($1,$2,$3) id', [a.id, str(req.body.body, 1001), id(req.body.runId, 'run')])).rows[0].id })));
  // The answer, in the run's own conversation, before its deadline; the client key makes an identical retry the same message.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/chats/:id/messages', { schema: { body } }, req => agentTx(req, async c => {
    const text = str(req.body.body, 4001);
    if (!text || text.length > 4000) fail(400, 'Write the answer in up to 4,000 characters');
    // EA-AI: a conversation with a client (anyone not staff) gets no message of its own: it becomes a proposal its
    // approver sends or not (the database refuses the post anyway: agent_client_guard).
    const channel = id(req.params.id, 'conversation');
    if ((await c.query('select pulse.chat_client_facing($1) f', [channel])).rows[0].f === true)
      return { proposal: (await c.query('select pulse.agent_propose($1,$2,$3,$4) r', [id(req.body.runId, 'run'), text, 'A client is in this conversation, so a person approves first.', id(req.body.clientId, 'client key')])).rows[0].r };
    return { id: (await c.query('select pulse.agent_chat_reply($1,$2,$3,$4,$5) id', [id(req.params.id, 'conversation'), text, optId(req.body.parentId, 'message'), id(req.body.clientId, 'client key'), id(req.body.runId, 'run')])).rows[0].id };
  }));
  // AI-EMPLOYEES v2: what it would post, sent to its approver in a direct message instead of the group (Send it / Edit / Don't).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/runs/:id/propose', { schema: { body } }, req => agentTx(req, async c => {
    const text = str(req.body.body, 4001);
    if (!text || text.length > 4000) fail(400, 'Write the proposal in up to 4,000 characters');
    return (await c.query('select pulse.agent_propose($1,$2,$3,$4) r', [id(req.params.id, 'run'), text, str(req.body.why, 1000) || null, id(req.body.clientId, 'client key')])).rows[0].r;
  }));
  // EA-AI: a task it would create (title, for whom by @username, due, notes), sent to its approver like a proposal
  // (Create it / Edit / Don't); nothing is created until a person says so (agent_proposal_decide, as that person).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/runs/:id/propose-task', { schema: { body } }, req => agentTx(req, async c => {
    const b = req.body, task = { title: str(b.title, 201), assignee: str(b.assignee, 60), dueOn: str(b.dueOn, 10) || null, notes: str(b.notes, 2000) || null };
    return (await c.query('select pulse.agent_propose_task($1,$2,$3,$4) r', [id(req.params.id, 'run'), JSON.stringify(task), str(b.why, 1000) || null, id(b.clientId, 'client key')])).rows[0].r;
  }));
  // SIM-CLIENTS (1035): ask a colleague before answering, act on their answer, say what a colleague told it to say, follow up.
  // Who it may ask (its organisation's staff, this conversation's first) and its conversations (for "tell X in Y").
  app.get<{ Querystring: { channel?: string } }>('/api/v0/agent/colleagues', req => agentTx(req, async c =>
    ({ people: (await c.query('select pulse.agent_colleagues($1) d', [optId(req.query.channel, 'conversation')])).rows[0].d })));
  app.get('/api/v0/agent/conversations', req => agentTx(req, async c => ({ conversations: (await c.query('select pulse.agent_conversations() d')).rows[0].d })));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/runs/:id/consult', { schema: { body } }, req => agentTx(req, async c =>
    (await c.query('select pulse.agent_consult_ask($1,$2,$3,$4) r', [id(req.params.id, 'run'), str(req.body.to, 60), str(req.body.question, 1500), id(req.body.clientId, 'client key')])).rows[0].r));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/runs/:id/relay', { schema: { body } }, req => agentTx(req, async c => {
    const text = str(req.body.body, 4001);
    if (!text || text.length > 4000) fail(400, 'Write the reply in up to 4,000 characters');
    return (await c.query('select pulse.agent_consult_relay($1,$2,$3,$4,$5) r', [id(req.params.id, 'run'), id(req.body.consultId, 'question'), text, str(req.body.why, 900) || null, id(req.body.clientId, 'client key')])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/runs/:id/post-to', { schema: { body } }, req => agentTx(req, async c => {
    const text = str(req.body.body, 4001);
    if (!text || text.length > 4000) fail(400, 'Write the message in up to 4,000 characters');
    return (await c.query('select pulse.agent_relay_instructed($1,$2,$3,$4,$5) r', [id(req.params.id, 'run'), id(req.body.channelId, 'conversation'), text, str(req.body.why, 900) || null, id(req.body.clientId, 'client key')])).rows[0].r;
  }));
  app.post('/api/v0/agent/consults/sweep', req => agentTx(req, async c => (await c.query('select pulse.agent_consults_sweep() r')).rows[0].r));
  // EA-AI: who it may give work to: the whole staff with operations access, otherwise the staff in that conversation.
  app.get<{ Querystring: { channel?: string } }>('/api/v0/agent/directory', req => agentTx(req, async c =>
    ({ people: (await c.query('select pulse.agent_directory($1) d', [optId(req.query.channel, 'conversation')])).rows[0].d })));
  // PULSE-HQ (0973): Stack Intelligence, read only: the tools its organisation weighs and its stacks, to recommend tools.
  app.get('/api/v0/agent/stack', req => agentTx(req, async c => stackForAgent(c)));
  // CONNECT-AI: inside its live run, what to call: its organisation's connection (opened here, for this runtime only, never
  // stored by it) and its workspace; or this server's own sign-in, or its monthly cap reached. Then how the connection did.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/runs/:id/connection', async (req, reply) => reply.header('cache-control', 'no-store').send(await agentTx(req, async c =>
    agentConnection(c, id(req.params.id, 'run'), optId((req.body as Body | undefined)?.connectionId, 'connection')))));
  // FEATURES-1024 (0988): the engine router's view (its chain, its organisation's chain, budgets, today's use, connections
  // without secrets), which engine ran a run with tokens in and out, and "needs more budget" (for this work or today).
  app.get('/api/v0/agent/engines', req => agentTx(req, async c => (await c.query('select pulse.agent_engines_read() e')).rows[0].e));
  // FEATURES-1024 (0991): its asks nobody answered for three days close as Expired.
  app.post('/api/v0/agent/proposals/expire', req => agentTx(req, async c => ({ expired: (await c.query('select pulse.agent_proposals_expire() n')).rows[0].n })));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/runs/:id/engine', { schema: { body } }, req => agentTx(req, async c => {
    await c.query('select pulse.agent_run_engine($1,$2)', [id(req.params.id, 'run'), JSON.stringify({ engine: str(req.body.engine, 80), tier: str(req.body.tier, 10),
      tokensIn: Number.isInteger(req.body.tokensIn) ? String(req.body.tokensIn) : '', tokensOut: Number.isInteger(req.body.tokensOut) ? String(req.body.tokensOut) : '', fallbackFrom: str(req.body.fallbackFrom, 300) })]);
    return { ok: true };
  }));
  app.post<{ Body: Body }>('/api/v0/agent/budget/ask', { schema: { body } }, req => agentTx(req, async c =>
    (await c.query('select pulse.agent_budget_ask($1,$2,$3) r', [optId(req.body.runId, 'run'), JSON.stringify({ scope: str(req.body.scope, 10) || 'run',
      estimate: Number.isInteger(req.body.estimate) ? String(req.body.estimate) : '', why: str(req.body.why, 900) }), id(req.body.clientId, 'client key')])).rows[0].r));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/runs/:id/connection/report', { schema: { body } }, req => agentTx(req, async c =>
    agentConnectionReport(c, id(req.params.id, 'run'), req.body)));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/runs/:id/handoff', { schema: { body } }, req => agentTx(req, async c =>
    ({ id: (await c.query('select pulse.agent_handoff_propose($1,$2,$3,$4) id', [id(req.params.id, 'run'), id(req.body.messageId, 'message'), str(req.body.title, 200), str(req.body.details, 4000)])).rows[0].id })));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/runs/:id', { schema: { body } }, req => agentTx(req, async c =>
    (await c.query('select pulse.agent_run_finish($1,$2,$3,$4,$5) r', [id(req.params.id, 'run'), str(req.body.state, 10), tokens(req.body.tokens), seconds(req.body.seconds), str(req.body.errorCode, 20) || null])).rows[0].r));
  app.post<{ Body: Body }>('/api/v0/agent/handoffs/claim', { schema: { body } }, req => agentTx(req, async c =>
    ({ handoffs: (await c.query('select pulse.agent_handoffs_claim() h')).rows[0].h })));
  app.post('/api/v0/agent/handoffs/poll', req => agentTx(req, async c =>
    ({ handoffs: (await c.query('select pulse.agent_handoffs_poll() h')).rows[0].h })));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/handoffs/:id/updates', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['clientId', 'state', 'text'],
    properties: { clientId: { type: 'string', format: 'uuid' }, commentId: { type: 'string', format: 'uuid' }, state: { enum: ['started', 'progress', 'in_review', 'blocked', 'cancelled'] }, text: { type: 'string', minLength: 1 } },
  } } }, req => agentTx(req, async c => (await c.query('select pulse.agent_handoff_update($1,$2,$3,$4,$5) r',
    [id(req.params.id, 'hand-off'), id(req.body.clientId, 'client key'), req.body.state, str(req.body.text, 600), optId(req.body.commentId, 'board comment')])).rows[0].r));
  // Filed once under the live filing token; a filing the runner cannot confirm is marked uncertain and never filed again.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/handoffs/:id/filed', { schema: { body } }, req => agentTx(req, async c =>
    (await c.query('select pulse.agent_handoff_filed($1,$2,$3,$4) r', [id(req.params.id, 'hand-off'), id(req.body.filingToken, 'filing token'), str(req.body.boardRef, 40), id(req.body.clientId, 'client key')])).rows[0].r));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/handoffs/:id/unsure', { schema: { body } }, req => agentTx(req, async c => {
    await c.query('select pulse.agent_handoff_unsure($1,$2)', [id(req.params.id, 'hand-off'), id(req.body.filingToken, 'filing token')]);
    return { ok: true };
  }));
}

/** People's side. Admins add AI employees, see the company's co-workers with their keys, revoke a key and switch a co-worker off (its keys
 *  stop at once) or back on; keys are issued on the company's own server by its operator (agent_key_issue, 90 days by
 *  default) straight into a root-only file, never shown here; rotating is: issue a new key, then revoke the old one.
 *  Leaders accept or decline a co-worker's proposed hand-off, and add a co-worker to a group they run. */
/** CONNECT-AI: which AI it uses (a connection, this server's sign-in or the test runtime) and where it runs, by name only. */
async function withAi(c: PoolClient, d: Record<string, unknown> | null, agent: string) {
  if (!d) return d;
  const a = (await c.query(`select m.access,m.ai_connection_id "connectionId",m.ai_workspace_id "workspaceId",k.name "connectionName",k.provider "connectionProvider",k.kind "connectionKind",
      k.state "connectionState",k.removed_at is not null "connectionRemoved",w.name "workspaceName",m.group_approvers "groupApprovers"
    from pulse.agent_member m left join pulse.ai_connection k on k.id=m.ai_connection_id left join pulse.ai_workspace w on w.id=m.ai_workspace_id where m.person_id=$1`, [agent])).rows[0];
  return { ...d, ai: a ?? null };
}

export function registerAgentAdminRoutes(app: FastifyInstance, { tx }: { tx: Tx }, installation: Installation) {
  const admins = (v: Viewer) => { if (!admin(v)) fail(403, 'Admins manage AI co-workers'); };
  const leaders = (v: Viewer) => { if (!leadership(v)) fail(403, 'Leaders work with AI co-workers'); };
  app.get('/api/v0/agents', req => tx(req, async (c, v) => { admins(v); return { agents: (await c.query('select pulse.agent_list() a')).rows[0].a }; }));
  // EST-1733: an admin adds an AI employee, which gets its permanent <code>-AI-nnn ID. Never a key: keys come only from
  // the operator or v1 token path. A co-worker key never reaches this (routes.ts refuses it on people's routes).
  app.post<{ Body: Body }>('/api/v0/agents', { schema: { body } }, req => tx(req, async (c, v) => {
    if (!admin(v) || !v.person) fail(403, 'Admins add AI employees');
    const b = req.body, name = str(b.name, 81), title = str(b.title, 121), lane = str(b.lane, 9);
    if (!name || name.length > 80) fail(400, 'Name the AI employee in up to 80 characters');
    if (!title || title.length > 120) fail(400, 'Give the AI employee a role of up to 120 characters');
    if (lane !== 'quick' && lane !== 'thinking') fail(400, 'Choose the quick or thinking lane');
    const ownerId = id(b.ownerId, 'owner');
    // Generated like a person's username (first.last, then first.last2…) under the same lock, unless the admin chose one.
    const generated = await staffUsername(c, v.org, name), username = str(b.username, 41).toLowerCase() || generated;
    const pid = (await c.query('select pulse.agent_create($1) id', [JSON.stringify({ name, title, ownerId, lane, username })])).rows[0].id;
    // CHAT-WORK: the rest of its profile (pod, team) and what is set only for AI, in the same step.
    const { title: _t, ownerId: _o, lane: _l, ...rest } = settingsOf(b); void _t; void _o; void _l;
    if (Object.keys(rest).length) await c.query('select pulse.agent_settings_save($1,$2)', [pid, JSON.stringify(rest)]);
    const ai = aiSettingsOf(b);
    if (Object.keys(ai).length) await c.query('select pulse.agent_ai_save($1,$2)', [pid, JSON.stringify(ai)]);
    return (await c.query('select person_id id,employee_id "employeeId" from pulse.agent_member where person_id=$1', [pid])).rows[0];
  }));
  // The Team list's AI view (leaders and admins): who each AI employee is, its owner, lane, state and budget left today.
  app.get('/api/v0/agents/team', req => tx(req, async (c, v) => {
    leaders(v);
    return { agents: (await c.query(`select m.person_id id,m.employee_id "employeeId",p.display_name name,m.title,o.display_name "ownerName",m.lane,
        case when p.status<>'active' then 'off' when m.paused_reason is not null then 'paused' when m.disabled_at is not null then 'off' else 'on' end status,
        greatest(m.daily_token_budget-${USED_TODAY('m')},0) "budgetLeft"
      from pulse.agent_member m join pulse.person p on p.id=m.person_id left join pulse.person o on o.id=m.owner_person_id order by m.employee_no`)).rows };
  }));
  // A profile is shown only where the AI employee already appears to the viewer; anywhere else it does not exist.
  app.get<{ Params: { id: string } }>('/api/v0/agents/:id', req => tx(req, async c =>
    (await c.query('select pulse.agent_profile($1) p', [id(req.params.id, 'AI employee')])).rows[0].p ?? fail(404, 'Not found')));
  // CHAT-WORK: its profile's settings, notes, groups, runs, tasks and runtime state, where agent_profile shows it.
  app.get<{ Params: { id: string } }>('/api/v0/agents/:id/detail', req => tx(req, async c => withAi(c,
    (await c.query('select pulse.agent_detail($1) d', [id(req.params.id, 'AI employee')])).rows[0].d ?? fail(404, 'Not found'), req.params.id)));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agents/:id/settings', { schema: { body } }, req => tx(req, async (c, v) => {
    const s = settingsOf(req.body), ai = aiSettingsOf(req.body);
    if (Object.keys(s).length || !Object.keys(ai).length) await c.query('select pulse.agent_settings_save($1,$2)', [id(req.params.id, 'AI employee'), JSON.stringify(s)]);
    if (Object.keys(ai).length) await c.query('select pulse.agent_ai_save($1,$2)', [id(req.params.id, 'AI employee'), JSON.stringify(ai)]);
    // EA-AI: operations access (the whole company; always asks first) is an admin's choice (agent_access_set checks).
    if (req.body.access !== undefined) await c.query('select pulse.agent_access_set($1,$2)', [id(req.params.id, 'AI employee'), str(req.body.access, 20)]);
    // CONNECT-AI: its AI: this server's Claude or Codex sign-in (the install's own organisation), the test runtime, or a connection; and its workspace.
    if (req.body.aiChoice !== undefined) {
      const choice = str(req.body.aiChoice, 60), ws = req.body.aiWorkspaceId === 'cloud' || !req.body.aiWorkspaceId ? null : id(req.body.aiWorkspaceId, 'workspace');
      if ((choice === 'claude' || choice === 'codex') && v.org !== await installation.readOrg()) fail(400, 'Connect an AI for this organisation first (Settings → AI)');
      const conn = UUID.test(choice) ? choice : null;
      await c.query('select pulse.agent_ai_connect($1,$2,$3,$4)', [req.params.id, conn ? 'connection' : choice, conn, ws]);
    }
    return withAi(c, (await c.query('select pulse.agent_detail($1) d', [req.params.id])).rows[0].d, req.params.id);
  }));
  // FEATURES-1024 (0988): spend per run and per day by engine (its managers, or leaders for the whole organisation), its
  // own engine chain, and the organisation's default chain, run budgets and daily cap (leaders).
  app.get<{ Querystring: { days?: string } }>('/api/v0/agents/spend', req => tx(req, async c =>
    (await c.query('select pulse.agent_spend(null,$1) s', [Number(req.query.days) || 14])).rows[0].s));
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>('/api/v0/agents/:id/spend', req => tx(req, async c =>
    (await c.query('select pulse.agent_spend($1,$2) s', [id(req.params.id, 'AI employee'), Number(req.query.days) || 14])).rows[0].s));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agents/:id/engines', { schema: { body } }, req => tx(req, async c => {
    // Who may change it is decided first (404 for anyone else, like an unknown AI employee), then what was sent.
    const agent = id(req.params.id, 'AI employee');
    if (!Array.isArray(req.body.engines)) { await c.query('select pulse.agent_spend($1,1)', [agent]); fail(400, 'Give the engines in order'); }
    const list = (req.body.engines as unknown[]).map((x) => str(x, 60)).filter(Boolean).slice(0, 12);
    await c.query('select pulse.agent_engines_set($1,$2)', [agent, list]);
    return { engines: list };
  }));
  app.get('/api/v0/agents/engine-settings', req => tx(req, async (c, v) => {
    if (!leadership(v)) fail(403, 'Leaders set the organisation\'s AI engines and budgets');
    return (await c.query('select pulse.agent_org_ai_read() s')).rows[0].s;
  }));
  app.post<{ Body: Body }>('/api/v0/agents/engine-settings', { schema: { body } }, req => tx(req, async c => {
    const b = req.body, p: Record<string, unknown> = {};
    if (Array.isArray(b.engines)) p.engines = (b.engines as unknown[]).map((x) => str(x, 60)).filter(Boolean).slice(0, 12);
    if (b.budgets && typeof b.budgets === 'object' && !Array.isArray(b.budgets)) p.budgets = b.budgets;
    if (b.dailyTokens !== undefined) p.dailyTokens = b.dailyTokens === null || b.dailyTokens === '' ? '' : Number.isInteger(b.dailyTokens) ? String(b.dailyTokens) : fail(400, 'Give the daily tokens as a whole number');
    return (await c.query('select pulse.agent_org_ai_save($1) s', [JSON.stringify(p)])).rows[0].s;
  }));
  // FEATURES-1024 (0987): whom it asks before posting in one of its groups (say the project's coordinator in that
  // project's group); no person sets it back to its usual approver. agent_group_approver_set checks who may change it.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agents/:id/group-approver', { schema: { body } }, req => tx(req, async c => {
    // Who may change it is decided first (in the database: 404 for anyone else), then the group and the person.
    const agent = id(req.params.id, 'AI employee'), channel = UUID.test(String(req.body.channelId)) ? String(req.body.channelId) : null;
    const who = req.body.personId ? id(req.body.personId, 'person') : null;
    await c.query('select pulse.agent_group_approver_set($1,$2,$3)', [agent, channel, who]);
    return withAi(c, (await c.query('select pulse.agent_detail($1) d', [agent])).rows[0].d, agent);
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agents/:id/memory', { schema: { body } }, req => tx(req, async c =>
    ({ id: (await c.query('select pulse.agent_memory_add($1,$2,null) id', [id(req.params.id, 'AI employee'), str(req.body.body, 1001)])).rows[0].id })));
  app.post<{ Params: { id: string } }>('/api/v0/agents/memory/:id/retire', req => tx(req, async c => {
    await c.query('select pulse.agent_memory_retire($1)', [id(req.params.id, 'note')]); return { ok: true };
  }));
  app.post<{ Params: { prefix: string } }>('/api/v0/agents/keys/:prefix/revoke', req => tx(req, async (c, v) => {
    admins(v);
    if (!/^[0-9a-f]{8}$/.test(req.params.prefix)) fail(400, 'Choose a key');
    await c.query('select pulse.agent_key_revoke($1)', [req.params.prefix]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agents/:id/switch', { schema: { body } }, req => tx(req, async (c, v) => {
    admins(v);
    if (typeof req.body.on !== 'boolean') fail(400, 'Switch it on or off');
    await c.query('select pulse.agent_switch($1,$2)', [id(req.params.id, 'co-worker'), req.body.on]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/chats/handoffs/:id/decide', { schema: { body } }, req => tx(req, async (c, v) => {
    leaders(v);
    if (typeof req.body.accept !== 'boolean') fail(400, 'Accept or decline it');
    return { state: (await c.query('select pulse.agent_handoff_decide($1,$2) s', [id(req.params.id, 'hand-off'), req.body.accept])).rows[0].s };
  }));
  // AI-EMPLOYEES v2: its approver (or whoever may change it) sends its proposal, as written or edited, or says don't.
  // Anyone else gets 404 (decided in the database: agent_proposal_decide).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/chats/proposals/:id/decide', { schema: { body } }, req => tx(req, async c => {
    const action = str(req.body.action, 10);
    if (action !== 'send' && action !== 'dismiss') fail(400, "Send it or don't");
    const text = str(req.body.body, 4001);
    if (text.length > 4000) fail(400, 'Up to 4,000 characters');
    return (await c.query('select pulse.agent_proposal_decide($1,$2,$3,$4) r', [id(req.params.id, 'proposal'), action, text || null, 'button'])).rows[0].r;
  }));
  // AI-EMPLOYEES v2: a leader makes a person or an AI employee a project's coordinator or co-coordinator (null: member).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/projects/:id/coordinators', { schema: { body } }, req => tx(req, async (c, v) => {
    leaders(v);
    const role = req.body.role === null || req.body.role === '' ? null : str(req.body.role, 20);
    await c.query('select pulse.project_coordinator_set($1,$2,$3)', [id(req.params.id, 'project'), id(req.body.personId, 'person'), role]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/chats/:id/agents', { schema: { body } }, req => tx(req, async (c, v) => {
    leaders(v);
    if (typeof req.body.add !== 'boolean') fail(400, 'Add or remove the co-worker');
    await c.query('select pulse.agent_group_member($1,$2,$3)', [id(req.params.id, 'conversation'), id(req.body.agentId, 'co-worker'), req.body.add]);
    return { ok: true };
  }));
}
