// SERVERS-AI (5 Nov 2026): Pulse Runner, "Connect a server" (docs/runner/PROTOCOL.md, v1; migration 1560).
//  * /runner/v1/*: what a paired server calls (outbound only, HTTPS). Every call but /pair carries the server's prc_
//    credential; pulse.runner_session() turns it into the organisation and the server (row security does the rest).
//    Errors are { error: { code, message } }; an admin's revoke answers exactly 401 runner_revoked (the runner then
//    deletes its credential and exits), anything else stays retryable. Never a redirect.
//  * /api/v0/admin/runners*: Settings → Servers & AI, for organisation admins: pairing codes, servers (rename, revoke),
//    jobs (start, cancel, follow).
// Jobs are not idempotent: a job is handed out again only while its server has not acknowledged it (60 s), and a job
// the server stopped reporting for 60 s fails as runner_lost. Each claude/codex job carries its own Pulse MCP token.
import { EventEmitter } from 'node:events';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { admin, fail, type Open, type Tx, type Viewer } from './routes.js';
import { budget, type Budget } from './v1-limits.js';
import * as M from './runner-model.js';
import { agentTxFor } from './agents.js';
import { scopesOf, v1Operations } from './v1.js';

export const RUNNER_PREFIX = '/runner/v1';
type Session = { runnerId: string; orgId: string };
type Body = Record<string, unknown>;
const FINAL = ['succeeded', 'failed', 'timed_out', 'cancelled', 'rejected'];
const ACTIVE = ['queued', 'delivered', 'running', 'cancelling'];

// A job or cancel for a server wakes its held poll on this process; other processes find it on their next 2 s check.
const wake = new EventEmitter(); wake.setMaxListeners(0);
const nudge = (runnerId: string) => { wake.emit(runnerId); };

/** Process-local budgets: per credential (authenticated calls) and per address (credentials Pulse does not know). */
function budgets(limit: number) {
  const all = new Map<string, Budget>();
  return (key: string) => {
    if (all.size > 10000) all.clear();
    let b = all.get(key); if (!b) { b = budget(limit); all.set(key, b); }
    return b;
  };
}
const perCredential = budgets(900), unknownPerAddress = budgets(30);
const clientIp = (req: FastifyRequest) => String(req.headers['x-pulse-client-ip'] ?? req.ip ?? 'unknown').slice(0, 80);

async function bare<T>(pool: Pool, run: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('begin'); const r = await run(c); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback').catch(() => undefined); throw e; } finally { c.release(); }
}

/** One server call: the credential checked inside its own transaction, then the work as that server. */
async function asRunner<T>(pool: Pool, req: FastifyRequest, run: (c: PoolClient, s: Session) => Promise<T>): Promise<T> {
  const credential = M.bearer(req.headers.authorization);
  const ip = clientIp(req);
  if (unknownPerAddress(ip).state().remaining <= 0) M.refuse(429, 'rate_limited', 'Too many calls with an unknown credential. Try again in a minute.');
  if (!credential) { unknownPerAddress(ip)(); M.refuse(401, 'invalid_credential', 'Send the server credential as Authorization: Bearer prc_…'); }
  const hash = M.sha256(credential!);
  if (perCredential(hash)()) M.refuse(429, 'rate_limited', 'Too many calls from this server. Try again in a minute.');
  return bare(pool, async (c) => {
    const s = (await c.query('select pulse.runner_session($1) s', [hash])).rows[0].s as { status: string; runnerId: string; orgId: string };
    if (s.status === 'revoked') M.refuse(401, 'runner_revoked', 'This runner was revoked in Pulse.');
    if (s.status === 'unavailable') M.refuse(503, 'org_unavailable', "This organisation's Pulse is not available right now.");
    if (s.status !== 'ok') { unknownPerAddress(ip)(); M.refuse(401, 'invalid_credential', 'Pulse does not know this credential.'); }
    return run(c, { runnerId: s.runnerId, orgId: s.orgId });
  });
}

/** The server's own job, locked; anything else (another server's, another organisation's, unknown) is 404 job_not_active. */
async function ownJob(c: PoolClient, id: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) M.refuse(404, 'job_not_active', 'Pulse has no such job for this server.');
  const j = (await c.query(`select id,status,attempts,outputs from pulse.runner_job where id=$1 and runner_id=pulse.current_runner() for update`, [id])).rows[0] as
    { id: string; status: string; attempts: number; outputs: { path: string }[] } | undefined;
  if (!j) M.refuse(404, 'job_not_active', 'Pulse has no such job for this server.');
  return j!;
}
const notActive = () => M.refuse(409, 'job_not_active', 'Pulse no longer wants this job.');

/** runningJobs against Pulse's view: seen jobs are running (a late acknowledgement too); a running job missing for over
 *  60 s with no result is lost; ids Pulse does not hold as active for this server are cancelled. */
async function reconcile(c: PoolClient, runningJobs: string[]) {
  await c.query(`update pulse.runner_job set status='running',acked_at=coalesce(acked_at,now()),missing_since=null
    where runner_id=pulse.current_runner() and id=any($1) and status in ('queued','delivered')`, [runningJobs]);
  await c.query(`update pulse.runner_job set missing_since=null where runner_id=pulse.current_runner() and id=any($1) and missing_since is not null`, [runningJobs]);
  await c.query(`update pulse.runner_job set missing_since=now() where runner_id=pulse.current_runner() and status in ('running','cancelling')
    and not (id=any($1)) and missing_since is null`, [runningJobs]);
  const lost = (await c.query(`update pulse.runner_job set status=case when status='cancelling' then 'cancelled' else 'failed' end,
      error_code='runner_lost',error_message='The server stopped reporting this job',finished_at=now()
    where runner_id=pulse.current_runner() and status in ('running','cancelling') and not (id=any($1)) and missing_since < now()-interval '60 seconds' returning id`, [runningJobs])).rows;
  for (const j of lost) await c.query('select pulse.runner_mcp_end($1)', [j.id]);
  const active = new Set((await c.query(`select id from pulse.runner_job where runner_id=pulse.current_runner() and id=any($1) and status=any($2)`, [runningJobs, ACTIVE])).rows.map((r) => r.id as string));
  return runningJobs.filter((id) => !active.has(id));
}

/** RUNNERS-FULL (PROTOCOL.md §10): logins for this server: stale ones expire, new ones start (or log out), a pasted
 *  code goes once (deleted as it is taken), and a cancel goes once. Independent of free job slots. */
async function loginWork(c: PoolClient) {
  await c.query(`update pulse.runner_login set status='expired',finished_at=now(),updated_at=now(),url=null,user_code=null
    where runner_id=pulse.current_runner() and status in ('requested','starting','waiting','verifying') and created_at < now()-interval '20 minutes'`);
  const out: Body[] = [];
  const starts = (await c.query(`update pulse.runner_login set status='starting',delivered_at=now(),updated_at=now()
    where runner_id=pulse.current_runner() and status='requested' and cancel_requested_at is null returning id,tool,action`)).rows as { id: string; tool: string; action: string }[];
  for (const l of starts) out.push({ id: l.id, tool: l.tool, action: l.action === 'logout' ? 'logout' : 'start' });
  const open = (await c.query(`select id from pulse.runner_login where runner_id=pulse.current_runner() and status in ('waiting','verifying') and cancel_requested_at is null`)).rows as { id: string }[];
  for (const l of open) {
    const code = (await c.query('select pulse.runner_login_code_take($1) c', [l.id])).rows[0].c as string | null;
    if (code) out.push({ id: l.id, action: 'code', code });
  }
  const cancels = (await c.query(`update pulse.runner_login set cancel_sent_at=now() where runner_id=pulse.current_runner() and cancel_requested_at is not null
    and cancel_sent_at is null and status in ('starting','waiting','verifying') returning id`)).rows as { id: string }[];
  for (const l of cancels) out.push({ id: l.id, action: 'cancel' });
  return out;
}

/** One look for work: stale deliveries go back to the queue, cancels not yet sent, then up to `slots` queued jobs. */
async function collect(c: PoolClient, s: Session, poll: ReturnType<typeof M.cleanPoll>, deliver: boolean) {
  const stray = await reconcile(c, poll.runningJobs);
  const logins = deliver ? await loginWork(c) : [];
  // Not acknowledged within 60 s: handed out again (five times at most).
  await c.query(`update pulse.runner_job set status=case when attempts>=4 then 'failed' else 'queued' end,delivered_at=null,attempts=attempts+1,
      error_code=case when attempts>=4 then 'not_acknowledged' end,error_message=case when attempts>=4 then 'The server never acknowledged this job' end,
      finished_at=case when attempts>=4 then now() end
    where runner_id=pulse.current_runner() and status='delivered' and delivered_at < now()-interval '60 seconds'`);
  const fresh = (await c.query(`update pulse.runner_job set cancel_sent_at=now() where runner_id=pulse.current_runner() and status='cancelling'
    and (cancel_sent_at is null or cancel_sent_at < now()-interval '30 seconds') returning id`)).rows.map((r) => r.id as string);
  const jobs: ReturnType<typeof M.jobObject>[] = [];
  if (deliver && poll.slots > 0) {
    const rows = (await c.query(`select j.id,j.org_id::text org_id,j.kind,j.prompt,j.command,j.profile,j.approval,j.model,j.time_limit_sec,j.cost_cap_usd,j.outputs,j.dry_run,
        j.requested_by::text requested_by,p.display_name requester_name,j.requested_by_type,j.access_level,j.sandbox
      from pulse.runner_job j left join pulse.person p on p.id=j.requested_by
      where j.runner_id=pulse.current_runner() and j.status='queued' order by j.created_at limit $1 for update of j skip locked`, [poll.slots])).rows as M.JobRow[];
    for (const j of rows) {
      await c.query(`update pulse.runner_job set status='delivered',delivered_at=now() where id=$1`, [j.id]);
      let mcp: { token: string; expiresAt: string } | null = null;
      if (j.kind === 'claude' || j.kind === 'codex') {
        const token = M.makeMcpToken();
        const until = (await c.query('select pulse.runner_mcp_issue($1,$2) u', [j.id, M.sha256(token)])).rows[0].u as Date;
        mcp = { token, expiresAt: new Date(until).toISOString() };
      }
      jobs.push(M.jobObject(j, mcp));
    }
  }
  return { jobs, cancel: [...new Set([...fresh, ...stray])], logins, urgent: jobs.length > 0 || fresh.length > 0 || logins.length > 0, session: s };
}

/** AI-EMPLOYEE-POWER: what each tier on a server lets an AI employee do (shown in its profile under Capabilities). */
export const TIERS = [
  { key: 'read-only', label: 'Read-only', commands: ['Any read command in a sandbox with a read-only view of the server: ls, cat, grep, find, ps, top -bn1, df, free, journalctl, docker ps and logs where readable',
    'echo, uname, uptime, df, free, nproc and sleep run directly', 'Claude Code or Codex tasks at read-only', 'Nothing on the server can change'] },
  { key: 'sandboxed', label: 'Read-write, sandboxed', commands: ['Everything read-only allows', 'Writes, downloads and builds inside its own sandboxed work folder (curl, wget, git clone, npm, python)',
    'Claude Code or Codex tasks that write, up to the server\'s level', 'The rest of the server stays read-only'] },
  { key: 'root', label: 'Root, unsandboxed', commands: ['A full root shell on this server, no command list', 'Download and fetch anything from the internet',
    'ssh and scp between the company\'s own servers', 'Manage docker, systemd services and packages', 'Read and write any file',
    'Time limit up to 30 minutes; longer work runs in the background and is followed with get_server_job', 'Every command and its output goes to Settings → Servers → Root access (secrets hidden)'] },
] as const;

const SECRET_RE = /(pak_[0-9a-f]{8}_[0-9a-f]{20,}|pmt_[A-Za-z0-9_-]{20,}|pat_[A-Za-z0-9_-]{20,}|psvc_[0-9a-f-]{36}_[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@|((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*)\S+)/gi;
/** A command or output with anything that looks like a secret replaced by [hidden]. */
export const redactSecrets = (v: unknown) => typeof v === 'string' ? v.replace(SECRET_RE, (_m: string, _all: string, _end: string | undefined, keep: string | undefined) => keep ? `${keep}[hidden]` : '[hidden]') : v ?? null;

/** The MCP tools an AI employee reaches: every API v1 operation with a tool, in the areas its managers left it (null = all). */
function agentTools(areas: string[] | null) {
  return v1Operations().filter((op) => op.mcp && (areas === null || scopesOf(op).some((s) => areas.includes(s))))
    .map((op) => ({ name: op.mcp!.name, title: op.mcp!.title ?? op.summary ?? op.mcp!.name, description: String(op.mcp!.description ?? op.summary ?? '').split(/(?<=\.)\s/)[0].slice(0, 200),
      area: String(op.scope).split('.')[0], writes: op.method !== 'GET' }))
    .sort((x, y) => x.area.localeCompare(y.area) || x.name.localeCompare(y.name));
}

export function registerRunnerRoutes(app: FastifyInstance, { tx, open, pool }: { tx: Tx; open: Open; pool: Pool }) {
  // ------------------------------------------------------------------------------------------------ the server's API
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: M.OUTPUT_BYTES }, (_req, body, done) => done(null, body));
    scope.addHook('onSend', async (_req, reply, payload) => { reply.header('cache-control', 'no-store'); return payload; });
    scope.setNotFoundHandler((_req, reply) => { void reply.code(404).send({ error: { code: 'not_found', message: 'No such runner endpoint' } }); });
    scope.setErrorHandler((error: FastifyError | M.RunnerError, req, reply) => {
      if (error instanceof M.RunnerError) {
        if (error.status === 429) void reply.header('retry-after', 60);
        return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
      }
      const status = (error as FastifyError).statusCode;
      if (status === 413) return reply.code(413).send({ error: { code: 'too_large', message: `Pulse keeps files up to ${M.OUTPUT_BYTES / 1048576} MiB and requests up to 4 MiB` } });
      if (status && status < 500) return reply.code(400).send({ error: { code: 'invalid_request', message: 'Pulse could not read this request' } });
      req.log.error({ code: (error as { code?: string }).code ?? 'unknown' }, 'Runner call failed');
      return reply.code(500).send({ error: { code: 'internal_error', message: 'Pulse could not finish this call. It will work on a retry.' } });
    });

    // 1. Pairing (no credential): a code from Settings → Servers & AI becomes the server's credential, once.
    scope.post('/pair', async (req) => {
      const ok = await open(async (c) => (await c.query('select pulse.auth_allow($1,$2) ok', [M.sha256(`runner-pair:${clientIp(req)}`), 20])).rows[0].ok as boolean);
      if (!ok) M.refuse(429, 'rate_limited', 'Too many pairing attempts from this address. Try again in 15 minutes.');
      const p = M.cleanPair(req.body);
      const credential = M.makeCredential();
      const d = await bare(pool, async (c) => (await c.query('select pulse.runner_pair($1,$2,$3,$4,$5,$6) d',
        [M.codeHash(p.code), M.sha256(credential), p.hostname, p.os, p.arch, p.version])).rows[0].d as { status: string; runnerId: string; orgId: string; orgName: string });
      if (d.status === 'invalid') M.refuse(404, 'invalid_code', 'Pulse does not know this code. Check it in Settings → Servers & AI.');
      if (d.status === 'expired') M.refuse(410, 'expired_code', 'This code has expired. Make a new one in Settings → Servers & AI.');
      if (d.status === 'used') M.refuse(409, 'code_used', 'This code was already used. Make a new one in Settings → Servers & AI.');
      if (d.status === 'limit') M.refuse(409, 'runner_limit', 'This organisation already has 20 servers. Remove one in Pulse first.');
      return { runnerId: d.runnerId, orgId: d.orgId, orgName: d.orgName, credential };
    });

    // `pulse-runner uninstall`: the credential ends and the server is marked removed.
    scope.post('/deregister', async (req) => asRunner(pool, req, async (c, s) => {
      await c.query(`select pulse.runner_end($1,'removed')`, [s.runnerId]);
      return { ok: true };
    }));

    // 2. Heartbeat, every 30 s.
    scope.post('/heartbeat', async (req) => asRunner(pool, req, async (c, s) => {
      const h = M.cleanHeartbeat(req.body);
      await c.query(`update pulse.runner set state=$2,version=coalesce($3,version),max_concurrent=coalesce($4,max_concurrent),uptime_sec=$5 where id=$1`,
        [s.runnerId, h.status, h.version, h.maxConcurrent, h.uptimeSec]);
      await reconcile(c, h.runningJobs);
      return { ok: true, serverTime: new Date().toISOString() };
    }));

    // 3. Capabilities: stored field by field from the protocol's list, nothing else.
    scope.post('/capabilities', async (req) => asRunner(pool, req, async (c, s) => {
      const caps = M.cleanCapabilities(req.body);
      // RUNNERS-FULL: when each CLI was last signed in here, so a lapsed login shows as "needs a new login".
      const prev = (await c.query('select ai_logins from pulse.runner where id=$1', [s.runnerId])).rows[0]?.ai_logins;
      await c.query(`update pulse.runner set capabilities=$2,capabilities_at=now(),version=coalesce($3,version),os=coalesce($4,os),arch=coalesce($5,arch),
        max_concurrent=coalesce($6,max_concurrent),ai_logins=$7 where id=$1`,
        [s.runnerId, JSON.stringify(caps), caps.runnerVersion, caps.system.os, caps.system.arch, caps.limits.maxConcurrent, JSON.stringify(M.nextAiLogins(prev, caps))]);
      return { ok: true };
    }));

    // 4. The long poll: held up to 25 s, answered as soon as there is a job or a new cancel.
    scope.post('/poll', async (req, reply) => {
      const poll = M.cleanPoll(req.body);
      const deadline = Date.now() + poll.waitSec * 1000;
      let gone = false, runnerId = '';
      reply.raw.once('close', () => { if (!reply.raw.writableFinished) { gone = true; if (runnerId) nudge(runnerId); } });
      for (let pass = 0; ; pass++) {
        const out = await asRunner(pool, req, (c, s) => collect(c, s, poll, !gone));
        runnerId = out.session.runnerId;
        if (out.urgent || gone || Date.now() >= deadline) return { jobs: out.jobs, cancel: out.cancel, ...(out.logins.length ? { logins: out.logins } : {}) };
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); wake.off(runnerId, done); resolve(); };
          const timer = setTimeout(done, Math.max(50, Math.min(2000, deadline - Date.now())));
          wake.once(runnerId, done);
        });
      }
    });

    // RUNNERS-FULL (PROTOCOL.md §10): how a login this server was asked for is going. Only the sign-in link and the device
    // code are kept (for the admin's page), and only while it waits; never anything of a token.
    scope.post<{ Params: { id: string } }>('/logins/:id', async (req) => asRunner(pool, req, async (c) => {
      const r = M.cleanLoginReport(req.body);
      if (!M.LOGIN_ID.test(req.params.id)) M.refuse(404, 'login_not_active', 'Pulse has no such login for this server.');
      const l = (await c.query('select id,status from pulse.runner_login where id=$1 and runner_id=pulse.current_runner() for update', [req.params.id])).rows[0] as { id: string; status: string } | undefined;
      if (!l) M.refuse(404, 'login_not_active', 'Pulse has no such login for this server.');
      if (M.LOGIN_FINAL.includes(l!.status)) M.refuse(409, 'login_not_active', 'Pulse no longer wants this login.');
      const final = r.state === 'succeeded' || r.state === 'failed' || r.state === 'cancelled';
      // After a pasted code the login stays "verifying" until the CLI says how it went (a late "waiting" re-sends the link only).
      const state = r.state === 'waiting' && l!.status === 'verifying' && !r.error ? 'verifying' : r.state;
      await c.query(`update pulse.runner_login set status=$2,updated_at=now(),
          url=case when $3 then null when $4::text is not null then $4 else url end,
          user_code=case when $3 then null when $4::text is not null then $5 else user_code end,
          needs_code=case when $2='waiting' then $6 else needs_code end,
          error_code=$7,error_message=$8,finished_at=case when $3 then now() else finished_at end where id=$1`,
        [l!.id, state, final, r.url, r.userCode, r.needsCode, r.error?.code ?? null, r.error?.message ?? null]);
      if (final) await c.query('select pulse.runner_login_code_take($1)', [l!.id]);
      return { ok: true };
    }));

    // Received: the job runs now and is never handed out again by itself.
    scope.post<{ Params: { id: string } }>('/jobs/:id/ack', async (req) => asRunner(pool, req, async (c) => {
      const j = await ownJob(c, req.params.id);
      if (j.status === 'queued' || j.status === 'delivered') await c.query(`update pulse.runner_job set status='running',acked_at=now(),missing_since=null where id=$1`, [j.id]);
      else if (FINAL.includes(j.status)) notActive();
      return { ok: true };
    }));

    // 5. Events, deduplicated on (job, seq). "cancel": true while Pulse wants the job stopped.
    scope.post<{ Params: { id: string } }>('/jobs/:id/events', { bodyLimit: 4 * 1024 * 1024 }, async (req) => asRunner(pool, req, async (c) => {
      const events = M.cleanEvents(req.body);
      const j = await ownJob(c, req.params.id);
      if (FINAL.includes(j.status)) notActive();
      if (j.status === 'queued' || j.status === 'delivered') await c.query(`update pulse.runner_job set status='running',acked_at=coalesce(acked_at,now()) where id=$1`, [j.id]);
      // At most 20,000 stored events per job; past that the job keeps running and the events are dropped.
      const room = Math.max(0, 20000 - Number((await c.query('select event_count n from pulse.runner_job where id=$1', [j.id])).rows[0].n));
      const kept = events.slice(0, room);
      const added = kept.length ? (await c.query(`insert into pulse.runner_job_event(org_id,job_id,runner_id,seq,ts,type,data)
          select pulse.current_org(),$1,pulse.current_runner(),x.seq,x.ts,x.type,x.data from jsonb_to_recordset($2::jsonb) x(seq int,ts timestamptz,type text,data jsonb)
          on conflict (job_id,seq) do nothing returning seq,type,data,ts`, [j.id, JSON.stringify(kept)])).rows as { seq: number; type: string; data: Body; ts: Date | null }[] : [];
      added.sort((a, b) => a.seq - b.seq);
      const states = added.filter((e) => e.type === 'status' && typeof e.data.state === 'string');
      const last = states.at(-1)?.data.state as string | undefined;
      const started = states.find((e) => e.data.state === 'running');
      const usage = added.filter((e) => e.type === 'usage').at(-1)?.data;
      await c.query(`update pulse.runner_job set event_count=event_count+$2,last_state=coalesce($3,last_state),
          started_at=coalesce(started_at,$4),usage=coalesce($5::jsonb,usage),cost_usd=coalesce(($5::jsonb->>'costUsd')::numeric,cost_usd),
          cancel_acked_at=case when status='cancelling' and $6 then coalesce(cancel_acked_at,now()) else cancel_acked_at end where id=$1`,
        [j.id, added.length, last ?? null, started ? (started.ts ?? new Date()) : null, usage ? JSON.stringify(usage) : null, states.some((e) => e.data.state === 'stopping')]);
      return { ok: true, cancel: j.status === 'cancelling' };
    }));

    // 6. Output files: declared paths only, the hash checked, at most 8 MiB each.
    scope.put<{ Params: { id: string }; Querystring: { path?: string } }>('/jobs/:id/outputs', async (req, reply) => asRunner(pool, req, async (c) => {
      const path = M.outputPath(req.query.path);
      if (!path) M.refuse(400, 'invalid_request', 'path is a relative path inside the job folder');
      if (!Buffer.isBuffer(req.body)) M.refuse(400, 'invalid_request', 'Send the file as application/octet-stream');
      const body = req.body as Buffer, hash = String(req.headers['x-content-sha256'] ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash) || hash !== M.sha256(body)) M.refuse(400, 'invalid_request', 'X-Content-SHA256 does not match the file');
      const j = await ownJob(c, req.params.id);
      if (FINAL.includes(j.status) || j.status === 'queued') notActive();
      if (!(j.outputs ?? []).some((o) => o.path === path)) M.refuse(400, 'invalid_request', 'This path was not declared for the job');
      const id = (await c.query(`insert into pulse_priv.runner_job_output(org_id,id,job_id,runner_id,path,bytes,sha256,content)
          values (pulse.current_org(),$1,$2,pulse.current_runner(),$3,$4,$5,$6)
          on conflict (job_id,path) do update set bytes=excluded.bytes,sha256=excluded.sha256,content=excluded.content,created_at=now() returning id`,
        [M.outputId(), j.id, path, body.length, hash, body])).rows[0].id as string;
      void reply.code(201);
      return { outputId: id };
    }));

    // 7. The result, once per job (a retry answers ok and changes nothing). A capacity rejection goes back to the queue.
    scope.post<{ Params: { id: string } }>('/jobs/:id/result', async (req) => asRunner(pool, req, async (c) => {
      const r = M.cleanResult(req.body);
      const j = await ownJob(c, req.params.id);
      if (FINAL.includes(j.status)) return { ok: true };
      if (r.status === 'rejected' && r.error?.code === 'capacity' && j.attempts < 4) {
        await c.query(`update pulse.runner_job set status='queued',delivered_at=null,acked_at=null,missing_since=null,attempts=attempts+1 where id=$1`, [j.id]);
        await c.query('select pulse.runner_mcp_end($1)', [j.id]);
        return { ok: true };
      }
      await c.query(`update pulse.runner_job set status=$2,finished_at=coalesce($3::timestamptz,now()),started_at=coalesce(started_at,$4::timestamptz),exit_code=$5,signal=$6,
          error_code=$7,error_message=$8,duration_ms=$9,usage=coalesce($10::jsonb,usage),cost_usd=coalesce(($10::jsonb->>'costUsd')::numeric,cost_usd),
          audit=$11,result_outputs=$12,missing_since=null where id=$1`,
        [j.id, r.status, r.finishedAt, r.startedAt, r.exitCode, r.signal, r.error?.code ?? null, r.error?.message ?? null, r.durationMs,
          r.usage ? JSON.stringify(r.usage) : null, JSON.stringify(r.audit), JSON.stringify(r.outputs)]);
      await c.query('select pulse.runner_mcp_end($1)', [j.id]);
      return { ok: true };
    }));
  }, { prefix: RUNNER_PREFIX });

  // ------------------------------------------------------------------------------------------------ Settings → Servers & AI
  const boss = (v: Viewer) => { if (!admin(v) || !v.person || v.nativeDevice) fail(403, 'Servers are connected by organisation admins'); };
  const JOB = `j.id,j.runner_id "runnerId",r.name "runnerName",j.kind,j.profile,j.status,j.dry_run "dryRun",j.model,
    left(coalesce(j.prompt,array_to_string(j.command,' ')),160) "summary",j.time_limit_sec "timeLimitSec",j.cost_cap_usd::float "costCapUsd",
    j.created_at "createdAt",j.delivered_at "deliveredAt",j.acked_at "ackedAt",j.started_at "startedAt",j.finished_at "finishedAt",
    j.cancel_requested_at "cancelRequestedAt",j.last_state "lastState",j.error_code "errorCode",j.error_message "errorMessage",j.exit_code "exitCode",
    j.duration_ms::float "durationMs",j.usage,j.cost_usd::float "costUsd",j.event_count "eventCount",p.display_name "requestedBy",
    j.requested_by_type "requestedByType",j.access_level "accessLevel",j.sandbox,pf.display_name "requestedFor"`;
  const JOBS_FROM = 'pulse.runner_job j join pulse.runner r on r.id=j.runner_id left join pulse.person p on p.id=j.requested_by left join pulse.person pf on pf.id=j.requested_for';
  const RUN_ID = /^run_[0-9a-f]{32}$/;
  const runnerRow = async (c: PoolClient, id: string) => {
    if (!RUN_ID.test(id)) fail(404, 'No such server');
    const r = (await c.query(`select id,status,access_level "accessLevel" from pulse.runner where id=$1`, [id])).rows[0] as { id: string; status: string; accessLevel: string } | undefined;
    if (!r || r.status !== 'active') fail(404, 'No such server');
    return r!;
  };

  app.get('/api/v0/admin/runners', (req) => tx(req, async (c, v) => {
    boss(v);
    const rows = (await c.query(`select r.id,r.name,r.hostname,r.os,r.arch,r.version,r.state,r.max_concurrent "maxConcurrent",r.capabilities,r.capabilities_at "capabilitiesAt",
        r.last_seen_at "lastSeenAt",r.created_at "createdAt",
        (select count(*)::int from pulse.runner_job j where j.runner_id=r.id and j.status in ('delivered','running','cancelling')) "running",
        (select count(*)::int from pulse.runner_job j where j.runner_id=r.id and j.status='queued') "queued",
        -- Usage, the last 30 days: jobs, how they ended, what the CLI reported they cost and how long they ran.
        (select jsonb_build_object('jobs',count(*),'succeeded',count(*) filter (where j.status='succeeded'),
            'failed',count(*) filter (where j.status in ('failed','timed_out','rejected')),'costUsd',round(coalesce(sum(j.cost_usd),0),2),
            'minutes',round(coalesce(sum(j.duration_ms),0)/60000.0,1))
          from pulse.runner_job j where j.runner_id=r.id and j.created_at > now()-interval '30 days') "usage",
        -- RUNNERS-FULL: access (level, sandbox, AI employees, who set it), its ledger, and the login going on now.
        r.access_level "accessLevel",r.sandbox,r.ai_employees "aiEmployees",r.access_set_at "accessSetAt",ap.display_name "accessSetBy",r.ai_logins "aiLogins",
        (select coalesce(jsonb_agg(x order by x.at desc),'[]'::jsonb) from (select a.at,a.approver_name "approvedBy",a.from_level "fromLevel",a.to_level "toLevel",
            a.sandbox,a.ai_employees "aiEmployees",a.reason from pulse.runner_access_log a where a.runner_id=r.id order by a.at desc limit 5) x) "accessLog",
        (select to_jsonb(x) from (select l.id,l.tool,l.action,l.status,l.url,l.user_code "userCode",l.needs_code "needsCode",l.error_code "errorCode",
            l.error_message "errorMessage",l.created_at "createdAt",l.updated_at "updatedAt" from pulse.runner_login l where l.runner_id=r.id
            and (l.status in ('requested','starting','waiting','verifying') or l.updated_at > now()-interval '10 minutes') order by l.created_at desc limit 1) x) "login"
      from pulse.runner r left join pulse.person ap on ap.id=r.access_set_by where r.status='active' order by r.created_at`)).rows;
    const runners = rows.map(({ capabilities: caps, aiLogins, ...r }) => {
      const ai = (caps?.ai ?? {}) as Record<string, { installed?: boolean; loggedIn?: boolean; version?: string | null; subscriptionType?: string | null; authMethod?: string | null }>;
      const seen = (aiLogins ?? {}) as Record<string, { lastLoggedInAt?: string | null; lapsedAt?: string | null }>;
      const cli = (k: string) => ({ installed: !!ai[k]?.installed, loggedIn: !!ai[k]?.loggedIn, version: ai[k]?.version ?? null, plan: ai[k]?.subscriptionType ?? ai[k]?.authMethod ?? null,
        needsLogin: M.needsLogin(ai[k], seen[k]), lapsedAt: seen[k]?.lapsedAt ?? null });
      return { ...r, online: M.online(r.lastSeenAt), reported: !!r.capabilitiesAt, claude: cli('claude'), codex: cli('codex'),
        // mode 'none': the server's own admin turned the sandbox off by hand; it runs jobs, not sealed off.
        isolation: { verified: !!caps?.isolation?.verified, off: caps?.isolation?.mode === 'none', mode: caps?.isolation?.mode ?? null, reason: caps?.isolation?.reason ?? null },
        system: caps?.system ?? null, maxProfile: caps?.limits?.maxProfile ?? null, allowNoSandbox: caps?.limits?.allowNoSandbox === true };
    });
    const pairing = (await c.query('select pulse.runner_pair_code_live() p')).rows[0].p;
    const jobs = (await c.query(`select ${JOB} from ${JOBS_FROM} order by j.created_at desc limit 25`)).rows;
    return { runners, pairing, jobs, mcpUrl: M.mcpUrl(), command: M.installCommand('XXXX-XXXX'), onlineSeconds: M.ONLINE_SEC, now: new Date().toISOString() };
  }));

  app.post('/api/v0/admin/runners/pair-code', (req) => tx(req, async (c, v) => {
    boss(v);
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = M.makeCode();
      await c.query('savepoint code');
      try {
        const until = (await c.query('select pulse.runner_pair_code_create($1) u', [M.codeHash(code)])).rows[0].u as Date;
        await c.query('release savepoint code');
        return { code, expiresAt: new Date(until).toISOString(), expiresIn: M.CODE_MINUTES * 60, command: M.installCommand(code) };
      } catch (e) {
        await c.query('rollback to savepoint code');
        if ((e as { code?: string }).code !== '23505') throw e;
      }
    }
    return fail(503, 'Pulse could not make a code. Try again.');
  }));

  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/admin/runners/:id/rename', { schema: { body: { type: 'object', maxProperties: 4 } } }, (req) => tx(req, async (c, v) => {
    boss(v);
    const r = await runnerRow(c, req.params.id);
    const name = String(req.body?.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 80) fail(400, 'Give the server a name of up to 80 characters');
    await c.query('update pulse.runner set name=$2 where id=$1', [r.id, name]);
    return { ok: true, name };
  }));

  app.post<{ Params: { id: string } }>('/api/v0/admin/runners/:id/revoke', (req) => tx(req, async (c, v) => {
    boss(v);
    const r = await runnerRow(c, req.params.id);
    await c.query(`select pulse.runner_end($1,'revoked')`, [r.id]);
    setImmediate(() => nudge(r.id));
    return { ok: true };
  }));

  app.get<{ Querystring: { runner?: string } }>('/api/v0/admin/runners/jobs', (req) => tx(req, async (c, v) => {
    boss(v);
    const runner = req.query.runner && RUN_ID.test(req.query.runner) ? req.query.runner : null;
    return { jobs: (await c.query(`select ${JOB} from ${JOBS_FROM} where ($1::text is null or j.runner_id=$1) order by j.created_at desc limit 100`, [runner])).rows };
  }));

  app.get<{ Params: { id: string } }>('/api/v0/admin/runners/jobs/:id', (req) => tx(req, async (c, v) => {
    boss(v);
    if (!M.JOB_ID.test(req.params.id)) fail(404, 'No such job');
    const job = (await c.query(`select ${JOB},j.approval,j.audit,j.result_outputs "resultOutputs",j.outputs "declaredOutputs" from ${JOBS_FROM} where j.id=$1`, [req.params.id])).rows[0];
    if (!job) fail(404, 'No such job');
    const events = (await c.query(`select seq,ts,type,data from pulse.runner_job_event where job_id=$1 order by seq desc limit 200`, [req.params.id])).rows.reverse();
    const outputs = (await c.query(`select id,path,bytes::float bytes,sha256,created_at "createdAt" from pulse_priv.runner_job_output where job_id=$1 order by path`, [req.params.id])).rows;
    return { job, events, outputs };
  }));

  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/admin/runners/:id/jobs', { bodyLimit: 1100 * 1024, schema: { body: { type: 'object', maxProperties: 20 } } }, (req) => tx(req, async (c, v) => {
    boss(v);
    const r = await runnerRow(c, req.params.id);
    // The checks are the runner's own (RunnerError); here they answer as every other Settings refusal does.
    let q: M.JobRequest;
    try { q = M.cleanJobRequest(req.body); } catch (e) { if (e instanceof M.RunnerError) return fail(e.status, e.message); throw e; }
    if (!M.levelAllows(r.accessLevel, q.profile)) fail(403, `This server allows ${r.accessLevel} work only. Raise its access first.`);
    const approval = q.profile === 'read-only' ? null : { approvedBy: { id: v.person, name: v.name }, approvedAt: new Date().toISOString() };
    const id = M.jobId();
    await c.query(`insert into pulse.runner_job(org_id,id,runner_id,kind,prompt,command,profile,approval,model,time_limit_sec,cost_cap_usd,outputs,dry_run,requested_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [v.org, id, r.id, q.kind, q.prompt, q.command, q.profile, approval ? JSON.stringify(approval) : null, q.model, q.timeLimitSec, q.costCapUsd, JSON.stringify(q.outputs), q.dryRun, v.person]);
    setImmediate(() => nudge(r.id));
    return { job: (await c.query(`select ${JOB} from ${JOBS_FROM} where j.id=$1`, [id])).rows[0] };
  }));

  // RUNNERS-FULL: a server's access. Every change needs an organisation admin and writes the ledger (who approved, why).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/admin/runners/:id/access', { schema: { body: { type: 'object', maxProperties: 6 } } }, (req) => tx(req, async (c, v) => {
    boss(v);
    const r = await runnerRow(c, req.params.id);
    let a: ReturnType<typeof M.cleanAccess>;
    try { a = M.cleanAccess(req.body); } catch (e) { if (e instanceof M.RunnerError) return fail(e.status, e.message); throw e; }
    const out = (await c.query('select pulse.runner_access_set($1,$2,$3,$4,$5) a', [r.id, a.level, a.sandbox, a.aiEmployees, a.reason])).rows[0].a;
    return { access: out };
  }));

  // AI-EMPLOYEE-POWER (1681): an AI employee's capabilities (its tools, its tier on each server), the owner's root grant
  // with a typed confirm, "Revoke all root", and the root audit (commands and output, secrets redacted). The database
  // checks each (agent_server_tier_set, agent_root_revoke_all, runner_root_audit).
  const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  app.get<{ Params: { id: string } }>('/api/v0/admin/runners/agents/:id/capabilities', (req) => tx(req, async (c, v) => {
    boss(v);
    if (!AGENT_ID.test(req.params.id)) fail(404, 'No such AI employee');
    const a = (await c.query(`select m.person_id id,p.display_name name,m.v1_areas areas from pulse.agent_member m join pulse.person p on p.id=m.person_id
      where m.person_id=$1`, [req.params.id])).rows[0] as { id: string; name: string; areas: string[] | null } | undefined;
    if (!a) fail(404, 'No such AI employee');
    const servers = (await c.query(`select r.id,r.name,r.last_seen_at "lastSeenAt",r.ai_employees "aiEmployees",r.access_level "accessLevel",
        pulse.agent_server_tier_of($1,r.id) t,coalesce((r.capabilities #>> '{shell,direct}')::boolean,false) "directShell",
        coalesce((r.capabilities #>> '{shell,root}')::boolean,false) "rootShell"
      from pulse.runner r where r.status='active' order by r.created_at`, [a!.id])).rows
      .map(({ t, lastSeenAt, ...r }) => ({ ...r, online: M.online(lastSeenAt), tier: t.tier, explicit: t.explicit, timeLimitSec: t.timeLimitSec, grantedBy: t.grantedBy ?? null, grantedAt: t.grantedAt ?? null }));
    const canGrantRoot = (await c.query('select pulse.org_owner_or_superadmin() o')).rows[0].o === true;
    return { agent: { id: a!.id, name: a!.name }, canGrantRoot, tools: agentTools(a!.areas), servers, tiers: TIERS };
  }));
  app.post<{ Params: { id: string; runner: string }; Body: Body }>('/api/v0/admin/runners/agents/:id/servers/:runner/tier', { schema: { body: { type: 'object', maxProperties: 6 } } }, (req) => tx(req, async (c, v) => {
    boss(v);
    if (!AGENT_ID.test(req.params.id)) fail(404, 'No such AI employee');
    const r = await runnerRow(c, req.params.runner);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const tier = typeof b.tier === 'string' ? b.tier : '';
    if (!['read-only', 'sandboxed', 'root', 'default'].includes(tier)) fail(400, 'The level is read-only, sandboxed, root or default');
    const time = b.timeLimitSec === undefined ? null : Number.isInteger(b.timeLimitSec) && (b.timeLimitSec as number) >= 10 && (b.timeLimitSec as number) <= 1800 ? b.timeLimitSec : fail(400, 'The time limit is 10 seconds to 30 minutes');
    const out = (await c.query('select pulse.agent_server_tier_set($1,$2,$3,$4,$5,$6) s', [req.params.id, r.id, tier, time,
      typeof b.confirm === 'string' ? b.confirm.slice(0, 40) : null, typeof b.reason === 'string' ? b.reason.slice(0, 500) : null])).rows[0].s;
    return { server: { id: out.id, name: out.name, tier: out.tier, explicit: out.explicit, timeLimitSec: out.timeLimitSec, grantedBy: out.grantedBy ?? null, grantedAt: out.grantedAt ?? null } };
  }));
  app.post<{ Body: Body }>('/api/v0/admin/runners/revoke-root', { schema: { body: { type: ['object', 'null'], maxProperties: 2 } } }, (req) => tx(req, async (c, v) => {
    boss(v);
    const reason = typeof (req.body as Record<string, unknown> | null)?.reason === 'string' ? String((req.body as Record<string, unknown>).reason).slice(0, 500) : null;
    const out = (await c.query('select pulse.agent_root_revoke_all($1) o', [reason])).rows[0].o as { revoked: number; cancelledJobs: number };
    const servers = (await c.query(`select distinct runner_id from pulse.runner_job where profile='root' and status='cancelling'`)).rows as { runner_id: string }[];
    setImmediate(() => { for (const s of servers) nudge(s.runner_id); });
    return out;
  }));
  app.get<{ Querystring: { limit?: string } }>('/api/v0/admin/runners/root-audit', (req) => tx(req, async (c, v) => {
    boss(v);
    const limit = Math.max(1, Math.min(200, Number.parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const out = (await c.query('select pulse.runner_root_audit($1) a', [limit])).rows[0].a as { items: Record<string, unknown>[]; grants: unknown[]; log: unknown[] };
    // Secrets never show: a key, token, private key or password-bearing URL in a command or its output is hidden.
    return { ...out, items: out.items.map((i) => ({ ...i, command: redactSecrets(i.command), output: redactSecrets(i.output), errorMessage: redactSecrets(i.errorMessage) })) };
  }));

  // AI-SERVER-TOOLS (1590): what each AI employee may reach over API v1 (every area unless narrowed), "ask me first for
  // writes" on servers, and "Pause all AI employees" for the company. The database checks each (agent_access_set,
  // agent_pause_set); a change is audited like every admin change.
  app.get('/api/v0/admin/runners/ai-access', (req) => tx(req, async (c, v) => {
    boss(v);
    const areas = (await c.query('select pulse.v1_scopes() s')).rows[0].s as string[];
    const agents = (await c.query(`select m.person_id id,p.display_name name,m.v1_areas areas,m.server_writes_ask "serverWritesAsk"
      from pulse.agent_member m join pulse.person p on p.id=m.person_id where p.status='active' and m.disabled_at is null order by p.display_name`)).rows
      .map((a) => ({ ...a, all: a.areas === null, areas: a.areas ?? areas }));
    const pause = (await c.query(`select x.paused_at "pausedAt",pp.display_name "pausedBy",x.reason from pulse.agent_org_pause x left join pulse.person pp on pp.id=x.paused_by`)).rows[0] ?? null;
    return { areas, agents, paused: !!pause, pause };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/admin/runners/ai-access/:id', { schema: { body: { type: 'object', maxProperties: 3 } } }, (req) => tx(req, async (c, v) => {
    boss(v);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(req.params.id)) fail(404, 'No such AI employee');
    const b = req.body ?? {};
    const areas = b.areas === null || b.areas === undefined ? null : Array.isArray(b.areas) ? (b.areas as unknown[]).map(String).slice(0, 64) : fail(400, 'areas is a list of areas, or null for all');
    const ask = typeof b.serverWritesAsk === 'boolean' ? b.serverWritesAsk : null;
    const out = await c.query('select pulse.agent_access_set($1,$2,$3) a', [req.params.id, areas, ask]).then((r) => r.rows[0].a, (e) => {
      if (e.code === '42501') fail(403, String(e.message)); if (e.code === '22023') fail(400, String(e.message)); throw e; });
    return { access: out };
  }));
  app.post<{ Body: Body }>('/api/v0/admin/runners/ai-pause', { schema: { body: { type: 'object', maxProperties: 2 } } }, (req) => tx(req, async (c, v) => {
    boss(v);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;
    return (await c.query('select pulse.agent_pause_set($1,$2) r', [req.body?.paused === true, reason])).rows[0].r;
  }));

  // RUNNERS-FULL (PROTOCOL.md §10): "Connect Claude / Codex" and "Disconnect": the server runs the CLI's own login; Pulse
  // shows the link (and code) it printed. One login per server and tool at a time: an older one is stopped.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/admin/runners/:id/logins', { schema: { body: { type: 'object', maxProperties: 4 } } }, (req) => tx(req, async (c, v) => {
    boss(v);
    const r = await runnerRow(c, req.params.id);
    const tool = req.body?.tool, action = req.body?.action ?? 'login';
    if (!(M.LOGIN_TOOLS as readonly unknown[]).includes(tool)) fail(400, 'Connect claude or codex');
    if (action !== 'login' && action !== 'logout') fail(400, 'action is login or logout');
    await c.query(`update pulse.runner_login set cancel_requested_at=now(),updated_at=now(),
        status=case when status='requested' then 'cancelled' else status end,finished_at=case when status='requested' then now() else finished_at end
      where runner_id=$1 and tool=$2 and status in ('requested','starting','waiting','verifying') and cancel_requested_at is null`, [r.id, tool]);
    const id = M.loginId();
    await c.query(`insert into pulse.runner_login(org_id,id,runner_id,tool,action,requested_by) values ($1,$2,$3,$4,$5,$6)`, [v.org, id, r.id, tool, action, v.person]);
    setImmediate(() => nudge(r.id));
    return { login: { id, tool, action, status: 'requested' } };
  }));

  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/admin/runners/logins/:id/code', { schema: { body: { type: 'object', maxProperties: 2 } } }, (req) => tx(req, async (c, v) => {
    boss(v);
    if (!M.LOGIN_ID.test(req.params.id)) fail(404, 'No such login');
    const code = M.cleanPastedCode(req.body?.code);
    if (!code) fail(400, 'Paste the code the sign-in page showed you');
    const l = (await c.query('select id,runner_id,status from pulse.runner_login where id=$1', [req.params.id])).rows[0] as { id: string; runner_id: string; status: string } | undefined;
    if (!l) fail(404, 'No such login');
    if (l!.status !== 'waiting' && l!.status !== 'verifying') fail(409, 'This login is not waiting for a code. Start again.');
    await c.query('select pulse.runner_login_code_put($1,$2)', [l!.id, code]);
    setImmediate(() => nudge(l!.runner_id));
    return { ok: true };
  }));

  app.post<{ Params: { id: string } }>('/api/v0/admin/runners/logins/:id/cancel', (req) => tx(req, async (c, v) => {
    boss(v);
    if (!M.LOGIN_ID.test(req.params.id)) fail(404, 'No such login');
    const l = (await c.query(`update pulse.runner_login set cancel_requested_at=now(),updated_at=now(),
        status=case when status='requested' then 'cancelled' else status end,finished_at=case when status='requested' then now() else finished_at end
      where id=$1 and status in ('requested','starting','waiting','verifying') returning runner_id`, [req.params.id])).rows[0] as { runner_id: string } | undefined;
    if (!l) fail(409, 'This login has already ended');
    setImmediate(() => nudge(l!.runner_id));
    return { ok: true };
  }));

  // ------------------------------------------------------------------------------------------------ AI employees
  // RUNNERS-FULL: an AI employee (its co-worker key) runs Claude or Codex on a server of its organisation that allows AI
  // employees, up to the server's level (services/coworker's "runner" engine). Every job is audited like a person's.
  const agentTx = agentTxFor(open);
  const pgRefusal = (e: unknown): never => {
    const err = e as { code?: string; message?: string };
    if (err.code === '42501') fail(403, String(err.message ?? 'Not allowed on this server'));
    if (err.code === '54000') fail(429, String(err.message ?? 'Too many jobs on this server'));
    if (err.code === '22023') fail(400, String(err.message ?? 'That job is not valid'));
    throw e;
  };
  app.get('/api/v0/agent/runners', (req) => agentTx(req, async (c) => ({ servers: (await c.query('select pulse.runner_agent_servers() s')).rows[0].s })));
  app.post<{ Body: Body }>('/api/v0/agent/runner-jobs', { bodyLimit: 1100 * 1024, schema: { body: { type: 'object', maxProperties: 10 } } }, (req) => agentTx(req, async (c) => {
    const b = req.body ?? {};
    const runnerId = String(b.runnerId ?? '');
    if (!RUN_ID.test(runnerId)) fail(404, 'No such server');
    let q: M.JobRequest;
    try { q = M.cleanJobRequest({ kind: b.kind, prompt: b.prompt, model: b.model, profile: b.profile, timeLimitSec: b.timeLimitSec, costCapUsd: b.costCapUsd, approve: true }); }
    catch (e) { if (e instanceof M.RunnerError) return fail(e.status, e.message); throw e; }
    if (q.kind === 'shell-safe') fail(400, 'An AI employee asks Claude or Codex');
    const id = await c.query('select pulse.runner_agent_job_create($1,$2,$3,$4,$5,$6,$7) id', [runnerId, q.kind, q.prompt, q.model, q.profile, q.timeLimitSec, q.costCapUsd])
      .then((r) => r.rows[0].id as string, pgRefusal);
    setImmediate(() => nudge(runnerId));
    return { job: { id, status: 'queued' } };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/agent/runner-jobs/:id', (req) => agentTx(req, async (c) => {
    if (!M.JOB_ID.test(req.params.id)) fail(404, 'No such job');
    const job = (await c.query('select pulse.runner_agent_job_read($1) j', [req.params.id])).rows[0].j;
    if (!job) fail(404, 'No such job');
    return { job };
  }));

  app.post<{ Params: { id: string } }>('/api/v0/admin/runners/jobs/:id/cancel', (req) => tx(req, async (c, v) => {
    boss(v);
    if (!M.JOB_ID.test(req.params.id)) fail(404, 'No such job');
    const j = (await c.query(`select id,status,runner_id from pulse.runner_job where id=$1 for update`, [req.params.id])).rows[0] as { id: string; status: string; runner_id: string } | undefined;
    if (!j) fail(404, 'No such job');
    if (FINAL.includes(j!.status)) fail(409, 'This job has already finished');
    if (j!.status === 'queued') {
      await c.query(`update pulse.runner_job set status='cancelled',finished_at=now(),error_code='cancelled',error_message='Cancelled in Pulse before it started',
        cancel_requested_at=now(),cancel_requested_by=$2 where id=$1`, [j!.id, v.person]);
      await c.query('select pulse.runner_mcp_end($1)', [j!.id]);
    } else if (j!.status !== 'cancelling') {
      await c.query(`update pulse.runner_job set status='cancelling',cancel_requested_at=now(),cancel_requested_by=$2 where id=$1`, [j!.id, v.person]);
    }
    setImmediate(() => nudge(j!.runner_id));
    return { job: (await c.query(`select ${JOB} from ${JOBS_FROM} where j.id=$1`, [j!.id])).rows[0] };
  }));
}
