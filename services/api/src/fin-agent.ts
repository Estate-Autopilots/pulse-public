import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Open, type Tx } from './routes.js';
import { agentTxFor } from './agents.js';

/* FIN-AGENT (17 Nov 2026): the Finance AI employee's jobs, what it learned (skills), and what it asks people to check.
   People (Finance → AI analyst, leadership and the Finance role as Finance → Entries): the queue, each job with its time,
   tokens and model calls, the lines it proposes with their flags (confirm saves them through the standard statement
   import), and its skills (leadership with the Money plan permission, or an admin, publishes one once its tests pass).
   The AI employee's runtime (its own key, /api/v0/agent/jobs/*): open a job from a chat message (the fast reply), take
   the next one, read its files, say how far it is (the chat message is edited in place), hand in lines and skills,
   finish. The database decides every rule (db/migrations/2240_fin_agent.sql). */
type Body = Record<string, unknown>;
const body = { type: 'object' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (x: unknown, what = 'item') => UUID.test(String(x ?? '')) ? String(x) : fail(400, `Choose a valid ${what}`);
const optId = (x: unknown, what: string) => x == null || x === '' ? null : id(x, what);
const str = (x: unknown, n: number) => typeof x === 'string' ? x.slice(0, n) : '';
const FLAGS = ['suspicious', 'unclear_category', 'missing_document', 'possible_duplicate'];
const JOB = `j.id,j.kind,j.title,j.status,j.progress,j.status_line "line",j.rows_in::bigint "rowsIn",j.rows_out::bigint "rowsOut",j.cpu_seconds::float "cpuSeconds",
 j.wall_seconds::float "seconds",j.tokens,j.model_calls "modelCalls",j.skills_used "skillsUsed",j.error,j.created_at "createdAt",j.started_at "startedAt",j.finished_at "finishedAt",
 a.display_name "agent",b.display_name "askedBy",(select count(*)::int from pulse.agent_job_file f where f.job_id=j.id) files`;
const SKILL = `s.id,s.name,s.title,s.kind,s.area,s.status,s.version,s.published_version "publishedVersion",s.uses::bigint uses,s.lines_handled::bigint "linesHandled",
 s.model_calls_saved::bigint "modelCallsSaved",s.last_used_at "lastUsedAt",s.created_at "createdAt",s.published_at "publishedAt",a.display_name "learnedBy",
 v.test_result "testResult",v.why,jsonb_array_length(v.tests) tests`;
const ITEM = `i.id,i.txn_date::text date,i.amount_minor::bigint "amountMinor",i.direction,i.narration,i.channel,i.counterparty,i.category,i.kind,i.confidence::float confidence,
 i.flags,i.reasons,i.match,i.status,i.decided_category "decidedCategory",i.bank,i.account,i.file_name "file",i.source`;
const num = (r: Record<string, unknown>, ...k: string[]) => { for (const x of k) if (r[x] != null) r[x] = Number(r[x]); return r; };

/** Finance readers only (as Finance → Entries); a write needs the Finance write rights. 403 before anything else. */
async function finance(c: PoolClient, write = false) {
  if (!(await c.query('select pulse.fin_entry_can($1) ok', [write])).rows[0].ok) fail(403, write ? 'Changing Finance is for leadership and the Finance role' : 'Finance is for leadership and the Finance role');
}

export function registerFinAgentRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  const agentTx = agentTxFor(open);

  // ---------------------------------------------------------------- people
  app.get('/api/v0/finance/agent', (req) => tx(req, async (c) => {
    await finance(c);
    const rights = (await c.query('select pulse.fin_entry_can(true) "canWrite",pulse.skill_can_publish() "canPublish"')).rows[0];
    const agents = (await c.query(`select p.id,p.display_name name,pp.username,m.title from pulse.agent_member m join pulse.person p on p.id=m.person_id
      left join pulse.people_profile pp on pp.person_id=p.id where m.disabled_at is null and 'billing'=any(m.tools) order by p.display_name`)).rows;
    const counts = (await c.query(`select count(*) filter (where status='open')::int open,
      count(*) filter (where status='open' and 'suspicious'=any(flags))::int suspicious,count(*) filter (where status='open' and 'unclear_category'=any(flags))::int unclear_category,
      count(*) filter (where status='open' and 'missing_document'=any(flags))::int missing_document,count(*) filter (where status='open' and 'possible_duplicate'=any(flags))::int possible_duplicate,
      count(*) filter (where status='confirmed')::int confirmed,count(*) filter (where status='set_aside')::int set_aside from pulse.fin_review_item`)).rows[0];
    const jobs = (await c.query(`select ${JOB} from pulse.agent_job j join pulse.person a on a.id=j.agent_id left join pulse.person b on b.id=j.asked_by
      where j.kind like 'fin.%' order by j.created_at desc limit 30`)).rows.map((r) => num(r, 'rowsIn', 'rowsOut'));
    const skills = (await c.query(`select ${SKILL} from pulse.agent_skill s left join pulse.person a on a.id=s.agent_id
      left join pulse.agent_skill_version v on v.skill_id=s.id and v.version=s.version where s.area='finance' order by s.status='proposed' desc,s.uses desc,s.created_at desc limit 60`)).rows
      .map((r) => num(r, 'uses', 'linesHandled', 'modelCallsSaved'));
    const week = (await c.query(`select count(*)::int jobs,coalesce(sum(rows_in),0)::bigint lines,coalesce(sum(tokens),0)::bigint tokens,coalesce(sum(model_calls),0)::int "modelCalls",
      coalesce(sum(wall_seconds),0)::float seconds from pulse.agent_job where kind like 'fin.%' and created_at>now()-interval '7 days'`)).rows[0];
    await c.query("select pulse.audit_write('restricted_read','finance.agent')");
    return { ...rights, agents, counts, jobs, skills, week: num(week, 'lines', 'tokens') };
  }));
  // The lines to check: by flag, status and words; grouped by who the money went to or came from, so one tap settles
  // a group ("Confirm all 212 Meta ad payments").
  app.get('/api/v0/finance/agent/review', (req) => tx(req, async (c) => {
    await finance(c);
    const q = req.query as Record<string, string>;
    const where = ['true'], args: unknown[] = [];
    const status = ['open', 'confirmed', 'set_aside'].includes(q.status) ? q.status : 'open';
    args.push(status); where.push(`i.status=$${args.length}`);
    if (FLAGS.includes(q.flag)) { args.push(q.flag); where.push(`$${args.length}=any(i.flags)`); }
    else if (q.flag === 'clear') where.push('cardinality(i.flags)=0');
    if (UUID.test(q.job ?? '')) { args.push(q.job); where.push(`i.job_id=$${args.length}`); }
    const words = String(q.q ?? '').trim().slice(0, 60);
    if (words) { args.push(`%${words.replace(/[%_\\]/g, (m) => '\\' + m)}%`); where.push(`(i.counterparty ilike $${args.length} or i.narration ilike $${args.length} or i.category ilike $${args.length})`); }
    const offset = Math.max(0, Math.min(100000, Number(q.offset) || 0));
    const groups = (await c.query(`select coalesce(i.counterparty,'(no name in the bank line)') who,i.direction,count(*)::int lines,sum(i.amount_minor)::bigint "amountMinor",
      mode() within group (order by i.category) category,min(i.txn_date)::text "from",max(i.txn_date)::text "to",
      ${FLAGS.map((f) => `count(*) filter (where '${f}'=any(i.flags))::int "${f}"`).join(',')}
      from pulse.fin_review_item i where ${where.join(' and ')} group by 1,2
      order by count(*) filter (where cardinality(i.flags)>0)>0 desc,sum(i.amount_minor) desc limit 40`, args)).rows
      .map((g) => { const flags = FLAGS.filter((f) => g[f] > 0); for (const f of FLAGS) delete g[f]; return { ...num(g, 'amountMinor'), flags }; });
    const total = (await c.query(`select count(*)::int n from pulse.fin_review_item i where ${where.join(' and ')}`, args)).rows[0].n;
    const items = (await c.query(`select ${ITEM} from pulse.fin_review_item i where ${where.join(' and ')} order by cardinality(i.flags) desc,i.amount_minor desc,i.txn_date desc limit 50 offset ${offset}`, args)).rows
      .map((r) => num(r, 'amountMinor'));
    return { status, total, offset, groups, items };
  }));
  app.post<{ Body: Body }>('/api/v0/finance/agent/review', { schema: { body } }, (req) => tx(req, async (c) => {
    await finance(c, true);
    const b = req.body;
    const decision = ['confirm', 'set_aside', 'reopen'].includes(String(b.decision)) ? String(b.decision) : fail(400, 'Confirm, set aside or reopen');
    const category = str(b.category, 61).trim() || null;
    let ids: string[];
    if (Array.isArray(b.ids)) ids = b.ids.slice(0, 2000).map((x) => id(x, 'line'));
    else if (typeof b.who === 'string') {
      // A whole group: everyone in it with the same side, still open (or set aside, to reopen), up to 2,000 at a time.
      const dir = b.direction === 'in' ? 'in' : 'out';
      const who = b.who === '(no name in the bank line)' ? null : str(b.who, 80);
      ids = (await c.query(`select id from pulse.fin_review_item where status=$1 and direction=$2 and coalesce(counterparty,'')=coalesce($3,'')
        ${FLAGS.includes(String(b.flag)) ? 'and $4=any(flags)' : ''} order by txn_date limit 2000`,
        [decision === 'reopen' ? 'set_aside' : 'open', dir, who, ...(FLAGS.includes(String(b.flag)) ? [b.flag] : [])])).rows.map((r) => r.id);
    } else return fail(400, 'Choose the lines or a group');
    if (!ids.length) fail(400, 'Nothing to change there any more');
    return (await c.query('select pulse.fin_review_decide($1::uuid[],$2,$3) r', [ids, decision, category])).rows[0].r;
  }));
  // Start a job from the page: the files' names and sizes first, then each file in parts of up to 4 MB.
  app.post<{ Body: Body }>('/api/v0/finance/agent/jobs', { schema: { body } }, (req) => tx(req, async (c) => {
    await finance(c, true);
    const b = req.body;
    if (!Array.isArray(b.files) || !b.files.length) fail(400, 'Choose the files to read');
    const files = (b.files as Body[]).slice(0, 20).map((f) => ({ name: str(f.name, 200), mime: str(f.mime, 100) || 'application/octet-stream', size: Number(f.size) || 0, parts: Number(f.parts) || 1 }));
    return { id: (await c.query('select pulse.fin_agent_job_start($1,$2,$3) id', [id(b.agentId, 'AI employee'), str(b.title, 200), JSON.stringify(files)])).rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/finance/agent/jobs/:id/parts', { schema: { body }, bodyLimit: 6 * 1024 * 1024 }, (req) => tx(req, async (c) => {
    await finance(c, true);
    const b = req.body, bytes = String(b.bytes ?? '');
    if (!bytes || bytes.length > 5600000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(bytes)) fail(400, 'Send each part as up to 4 MB');
    const file = Number(b.file), part = Number(b.part);
    if (!Number.isInteger(file) || !Number.isInteger(part)) fail(400, 'Say which file and part');
    return (await c.query('select pulse.fin_agent_job_part($1,$2,$3,$4) r', [id(req.params.id, 'job'), file, part, Buffer.from(bytes, 'base64')])).rows[0].r;
  }));
  app.get<{ Params: { id: string } }>('/api/v0/finance/agent/jobs/:id', (req) => tx(req, async (c) => {
    await finance(c);
    const j = (await c.query(`select ${JOB},j.steps,j.result,(select coalesce(jsonb_agg(jsonb_build_object('name',f.name,'size',f.size) order by f.file_no),'[]') from pulse.agent_job_file f where f.job_id=j.id) "fileList"
      from pulse.agent_job j join pulse.person a on a.id=j.agent_id left join pulse.person b on b.id=j.asked_by where j.id=$1`, [id(req.params.id, 'job')])).rows[0];
    if (!j) fail(404, 'No such job');
    return num(j, 'rowsIn', 'rowsOut');
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/finance/agent/skills/:id', { schema: { body } }, (req) => tx(req, async (c) => {
    await finance(c, true);
    if (typeof req.body.publish !== 'boolean') fail(400, 'Publish it or retire it');
    return (await c.query('select pulse.agent_skill_publish($1,$2) r', [id(req.params.id, 'skill'), req.body.publish])).rows[0].r;
  }));
  app.get<{ Params: { id: string } }>('/api/v0/finance/agent/skills/:id', (req) => tx(req, async (c) => {
    await finance(c);
    const s = (await c.query(`select ${SKILL} from pulse.agent_skill s left join pulse.person a on a.id=s.agent_id left join pulse.agent_skill_version v on v.skill_id=s.id and v.version=s.version where s.id=$1`, [id(req.params.id, 'skill')])).rows[0];
    if (!s) fail(404, 'No such skill');
    const versions = (await c.query(`select v.version,v.body,v.tests,v.test_result "testResult",v.why,v.created_at "createdAt",v.made_in_job "job" from pulse.agent_skill_version v where v.skill_id=$1 order by v.version desc limit 20`, [s.id])).rows;
    return { ...num(s, 'uses', 'linesHandled', 'modelCallsSaved'), versions };
  }));

  // ---------------------------------------------------------------- the AI employee's runtime (its own key)
  app.post<{ Body: Body }>('/api/v0/agent/jobs', { schema: { body } }, (req) => agentTx(req, async (c) => {
    const b = req.body;
    const kind = /^[a-z][a-z0-9_]*\.[a-z0-9_.-]{1,40}$/.test(String(b.kind ?? '')) ? String(b.kind) : fail(400, 'Name the kind of job');
    const title = str(b.title, 200).trim() || fail(400, 'Say what the job does');
    const files = Array.isArray(b.files) ? b.files.slice(0, 20).map((x) => id(x, 'file')) : [];
    const input = b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input : {};
    return (await c.query('select pulse.agent_job_create($1,$2,$3,$4,$5,$6::uuid[],$7) r',
      [kind, title, optId(b.channelId, 'conversation'), optId(b.sourceMessageId, 'message'), JSON.stringify(input), files, id(b.clientId, 'client key')])).rows[0].r;
  }));
  app.post<{ Body: Body }>('/api/v0/agent/jobs/claim', { schema: { body } }, (req) => agentTx(req, async (c) => {
    const kinds = Array.isArray(req.body.kinds) ? req.body.kinds.map(String).filter((k) => /^[a-z][a-z0-9_.-]{1,48}$/.test(k)).slice(0, 20) : null;
    return { job: (await c.query('select pulse.agent_job_claim($1::text[]) j', [kinds])).rows[0].j };
  }));
  app.get<{ Params: { id: string }; Querystring: { lease?: string } }>('/api/v0/agent/jobs/:id/context', (req) => agentTx(req, async (c) =>
    (await c.query('select pulse.agent_job_context($1,$2) r', [id(req.params.id, 'job'), id(req.query.lease, 'lease')])).rows[0].r));
  app.get<{ Params: { id: string; no: string; part: string }; Querystring: { lease?: string } }>('/api/v0/agent/jobs/:id/files/:no/:part', async (req, reply) => {
    const bytes = await agentTx(req, async (c) => (await c.query('select pulse.agent_job_bytes($1,$2,$3,$4) b',
      [id(req.params.id, 'job'), id(req.query.lease, 'lease'), Number(req.params.no) || 0, Number(req.params.part) || 0])).rows[0].b as Buffer);
    reply.header('cache-control', 'no-store').type('application/octet-stream');
    return reply.send(bytes);
  });
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/jobs/:id/progress', { schema: { body } }, (req) => agentTx(req, async (c) => {
    await c.query('select pulse.agent_job_progress($1,$2,$3,$4)', [id(req.params.id, 'job'), id(req.body.lease, 'lease'), Math.round(Number(req.body.progress) || 0), str(req.body.line, 300)]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/jobs/:id/items', { schema: { body }, bodyLimit: 16 * 1024 * 1024 }, (req) => agentTx(req, async (c) => {
    if (!Array.isArray(req.body.items) || req.body.items.length > 5000) fail(400, 'Send up to 5,000 lines at a time');
    return { added: (await c.query('select pulse.agent_job_items($1,$2,$3) n', [id(req.params.id, 'job'), id(req.body.lease, 'lease'), JSON.stringify(req.body.items)])).rows[0].n };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/jobs/:id/skills', { schema: { body }, bodyLimit: 1024 * 1024 }, (req) => agentTx(req, async (c) => {
    if (!req.body.skill || typeof req.body.skill !== 'object') fail(400, 'Send the skill');
    return (await c.query('select pulse.agent_skill_propose($1,$2,$3) r', [id(req.params.id, 'job'), id(req.body.lease, 'lease'), JSON.stringify(req.body.skill)])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/jobs/:id/model', { schema: { body } }, (req) => agentTx(req, async (c) => {
    await c.query('select pulse.agent_job_model_use($1,$2,$3)', [id(req.params.id, 'job'), id(req.body.lease, 'lease'), Math.max(0, Math.round(Number(req.body.tokens) || 0))]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/agent/jobs/:id/finish', { schema: { body }, bodyLimit: 1024 * 1024 }, (req) => agentTx(req, async (c) => {
    const b = req.body;
    const status = b.status === 'done' || b.status === 'failed' ? b.status : fail(400, 'A job ends done or failed');
    const result = b.result && typeof b.result === 'object' ? JSON.stringify(b.result).slice(0, 250000) : null;
    if (result && result.length >= 250000) fail(400, 'Keep the result under 250 kB');
    await c.query('select pulse.agent_job_finish($1,$2,$3,$4,$5,$6,$7)', [id(req.params.id, 'job'), id(b.lease, 'lease'), status, str(b.line, 300), result, str(b.error, 500) || null, JSON.stringify(b.stats && typeof b.stats === 'object' ? b.stats : {})]);
    return { ok: true };
  }));
}
