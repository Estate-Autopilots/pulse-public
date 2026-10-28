// BUG-REPORT (owner, 27 Oct 2026): "Report a bug" from any screen (Ctrl+B / ⌘B, a phone shake, the account menu, the
// command palette) and the triage page (/bug-reports). Migration 1201.
//   POST /api/v0/bug-reports                 a signed-in person's report (words, the screen, app and device, recent
//                                            errors, failed calls, app steps, an optional screenshot and recording);
//                                            sending the same command id again returns the first report
//   GET  /api/v0/bug-reports/mine            the person's own reports and where each stands
//   GET  /api/v0/bug-reports                 leadership and admins: every report, with triage, people and counts
//   GET  /api/v0/bug-reports/:id             one report (leadership and admins, or the person who sent it)
//   GET  /api/v0/bug-reports/:id/screenshot  its picture; /recording its recording (the same people)
//   POST /api/v0/bug-reports/:id             triage: status, severity, assignee, duplicate of, a note (leadership, admins)
//   POST /api/v0/bug-reports/:id/task        a Pulse task made from the report (leadership and admins)
//   POST /api/v0/auth/bug-report             signed out (sign-in, team setup, password, invitation and error pages)
// The owner hears of new reports on Telegram through the host's ea-notify (tools/bug-report-notify.py reads
// pulse.reported_bug_feed() as the worker role); nothing here sends anything outside Pulse.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, leadership, sessionHash, type Open, type Tx, type Viewer } from './routes.js';
import { parseScreenshot } from './pulse-app-model.js';
import { cleanCalls, cleanContext, cleanErrors, cleanTrail, fingerprint, parseRecording, PLATFORMS, routeOf, scrubText, scrubWords,
  SEVERITIES, sha256, STATUSES } from './bug-report-model.js';

type Body = Record<string, unknown>;
const body = { type: 'object', maxProperties: 30 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PER_HOUR = 30;
const lead = (v: Viewer) => { if (!leadership(v)) fail(403, 'Bug triage is for leadership and admins'); };
const reportId = (raw: string) => (UUID.test(raw) ? raw : fail(404, 'Report not found'));
const CARD = `b.id, b.number, b.words, b.route, b.status, b.severity, b.blocks_work "blocksWork", b.platform, b.app_version "appVersion",
  b.person_id "reporterId", coalesce(rp.display_name, b.reporter_name) "reporterName", b.signed_out "signedOut", b.reporter_contact "reporterContact", b.assignee_id "assigneeId", ap.display_name "assigneeName",
  b.duplicate_of "duplicateOf", d.number "duplicateNumber", b.task_id "taskId", b.created_at "createdAt", b.status_at "statusAt",
  exists (select 1 from pulse.reported_bug_file f where f.report_id = b.id and f.kind = 'screenshot') "hasScreenshot",
  exists (select 1 from pulse.reported_bug_file f where f.report_id = b.id and f.kind = 'recording') "hasRecording",
  jsonb_array_length(b.errors)::int "errorCount", jsonb_array_length(b.network)::int "callCount", jsonb_array_length(b.trail)::int "stepCount",
  (select count(*)::int from pulse.reported_bug s where s.fingerprint = b.fingerprint and s.id <> b.id) similar`;
const FROM = `from pulse.reported_bug b left join pulse.person rp on rp.id = b.person_id left join pulse.person ap on ap.id = b.assignee_id
  left join pulse.reported_bug d on d.id = b.duplicate_of`;

async function one(c: PoolClient, v: Viewer, id: string) {
  const row = (await c.query(`select ${CARD}, b.context, b.errors, b.network, b.trail, b.fingerprint ${FROM} where b.id = $1`, [id])).rows[0];
  if (!row || (!leadership(v) && row.reporterId !== v.person)) fail(404, 'Report not found');
  return row;
}

const SIGNED_OUT_PICTURE = 1536 * 1024;
const commandOf = (b: Body) => {
  if (!scrubWords(b.words)) fail(400, 'Write what went wrong first');
  return typeof b.commandId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(b.commandId) ? b.commandId : fail(400, 'Send the report again');
};

/** Writes one report and its files in the request's company; a picture or recording that does not check out is left out
 *  (the report still goes) and the answer says so. */
async function store(c: PoolClient, b: Body, who: { person: string | null; command: string; name?: string | null; contact?: string | null; shotLimit?: number }) {
  const words = scrubWords(b.words);
  let shot: ReturnType<typeof parseScreenshot> = null, clip: ReturnType<typeof parseRecording> = null, shotSkipped = false, clipSkipped = false;
  try { shot = parseScreenshot(b.screenshot); } catch { shotSkipped = true; }
  if (shot && who.shotLimit && shot.bytes.length > who.shotLimit) { shot = null; shotSkipped = true; }
  try { clip = parseRecording(b.recording); } catch { clipSkipped = true; }
  const route = routeOf(b.route);
  const errors = cleanErrors(b.errors), network = cleanCalls(b.network), trail = cleanTrail(b.trail);
  const platform = (PLATFORMS as readonly string[]).includes(String(b.platform)) ? String(b.platform) : 'web';
  const version = typeof b.appVersion === 'string' && /^[A-Za-z0-9.+_-]{1,60}$/.test(b.appVersion) ? b.appVersion : null;
  const blocks = b.blocksWork === true;
  await c.query("select pg_advisory_xact_lock(hashtext('pulse.reported_bug:' || pulse.current_org()::text))");
  const row = (await c.query(`insert into pulse.reported_bug (org_id, number, person_id, command_id, words, blocks_work, route, fingerprint, platform,
      app_version, context, errors, network, trail, severity, signed_out, reporter_name, reporter_contact)
    select pulse.current_org(), coalesce(max(number), 0) + 1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16 from pulse.reported_bug
    returning id, number`,
    [who.person, who.command, words, blocks, route, fingerprint(route, errors), platform, version, JSON.stringify(cleanContext(b.context)),
      JSON.stringify(errors), JSON.stringify(network), JSON.stringify(trail), blocks ? 'high' : null, !who.person, who.name ?? null, who.contact ?? null])).rows[0];
  for (const [kind, file, seconds] of [['screenshot', shot, null], ['recording', clip, typeof b.recordingSeconds === 'number' ? Math.min(120, Math.max(1, Math.round(b.recordingSeconds))) : null]] as const) {
    if (!file) continue;
    await c.query('insert into pulse.reported_bug_file (report_id, org_id, kind, content_type, bytes, seconds, sha256, data) values ($1, pulse.current_org(), $2, $3, $4, $5, $6, $7)',
      [row.id, kind, file.type, file.bytes.length, seconds, sha256(file.bytes), file.bytes]);
  }
  const said = (file: unknown, skipped: boolean) => (file ? 'kept' : skipped ? 'skipped' : 'none');
  return { id: row.id as string, number: row.number as number, screenshot: said(shot, shotSkipped), recording: said(clip, clipSkipped) };
}

export function registerBugReportRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  app.post<{ Body: Body }>('/api/v0/bug-reports', { bodyLimit: 16 * 1024 * 1024, schema: { body } }, req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Reporting a bug needs your own Pulse sign-in');
    const b = req.body ?? {};
    const command = commandOf(b);
    const again = (await c.query('select id, number from pulse.reported_bug where person_id = $1 and command_id = $2', [v.person, command])).rows[0];
    if (again) return { id: again.id, number: again.number, again: true, screenshot: 'kept', recording: 'kept' };
    const recent = (await c.query("select count(*)::int n from pulse.reported_bug where person_id = $1 and created_at > now() - interval '1 hour'", [v.person])).rows[0].n;
    if (recent >= PER_HOUR) fail(429, 'That is a lot of reports in an hour. Send again a little later.');
    return store(c, b, { person: v.person, command });
  }));

  // Signed out (owner, 27 Oct 2026): the sign-in, team setup, password, invitation and error pages report too. The person
  // may type a name and an e-mail or phone to hear back; nothing else about them is known. Limited per address and per
  // company, a hidden field no person fills in (a bot does) is answered as if sent and dropped, the picture is capped at
  // 1.5 MB and there is no recording. It lands in the same inbox, marked "signed out".
  app.post<{ Body: Body }>('/api/v0/auth/bug-report', { bodyLimit: 3 * 1024 * 1024, schema: { body } }, async req => {
    const b = req.body ?? {};
    if (typeof b.website === 'string' && b.website.trim()) return { id: null, number: 0, screenshot: 'none', recording: 'none' };
    const ip = String(req.headers['x-pulse-client-ip'] ?? req.ip);
    const ok = await open(async c => (await c.query('select pulse.auth_allow($1, 5) a, pulse.auth_allow($2, 200) b', [sessionHash(`bug-report:${ip}`), sessionHash('bug-report:signed-out')])).rows[0]);
    if (!ok.a || !ok.b) fail(429, 'That is a lot of reports. Try again in a few minutes.');
    const command = commandOf(b);
    const name = scrubText(b.name, 120).replace(/\[(email|phone|long|token|key|secret)\]/g, '').trim() || null;
    const raw = typeof b.contact === 'string' ? b.contact.trim().slice(0, 200) : '';
    const contact = !raw ? null : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw.toLowerCase() : /^\+?[0-9][0-9 ()-]{6,20}$/.test(raw) ? raw.replace(/[^0-9+]/g, '') : fail(400, 'Type an e-mail address or a phone number, or leave it empty');
    return open(c => store(c, { ...b, recording: null }, { person: null, command, name, contact, shotLimit: SIGNED_OUT_PICTURE }));
  });

  app.get('/api/v0/bug-reports/mine', req => tx(req, async (c, v) => {
    if (!v.person) return { rows: [] };
    const rows = (await c.query(`select b.id, b.number, left(b.words, 300) words, b.route, b.status, b.status_at "statusAt", b.created_at "createdAt",
        d.number "duplicateNumber" from pulse.reported_bug b left join pulse.reported_bug d on d.id = b.duplicate_of
      where b.person_id = $1 order by b.created_at desc limit 50`, [v.person])).rows;
    return { rows };
  }));

  app.get('/api/v0/bug-reports', req => tx(req, async (c, v) => {
    lead(v);
    const q = req.query as Record<string, string | undefined>;
    const status = (STATUSES as readonly string[]).includes(q.status ?? '') ? q.status! : q.status === 'all' ? 'all' : 'open';
    const search = scrubText(q.q, 80);
    const rows = (await c.query(`select ${CARD} ${FROM}
      where ($1 = 'all' or ($1 = 'open' and b.status in ('new', 'triaged', 'fixing')) or b.status = $1)
        and ($2 = '' or b.words ilike '%' || $2 || '%' or b.route ilike '%' || $2 || '%' or b.number::text = $2 or rp.display_name ilike '%' || $2 || '%')
      order by case b.severity when 'blocker' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 2 end,
        b.created_at desc limit 300`, [status, search])).rows;
    const counts = (await c.query(`select count(*) filter (where status = 'new')::int "new", count(*) filter (where status = 'triaged')::int triaged,
        count(*) filter (where status = 'fixing')::int fixing, count(*) filter (where status = 'fixed')::int fixed, count(*) filter (where status = 'wontfix')::int wontfix,
        count(*)::int "all" from pulse.reported_bug`)).rows[0];
    const people = (await c.query("select id, display_name name from pulse.person where side = 'staff' and status = 'active' order by display_name limit 500")).rows;
    return { status, q: search, rows, counts, people };
  }));

  app.get<{ Params: { id: string } }>('/api/v0/bug-reports/:id', req => tx(req, async (c, v) => {
    const row = await one(c, v, reportId(req.params.id));
    const events = (await c.query(`select e.kind, e.value, e.note, e.at, p.display_name "actorName" from pulse.reported_bug_event e left join pulse.person p on p.id = e.actor_id
      where e.report_id = $1 order by e.at, e.id`, [row.id])).rows;
    const similar = leadership(v) ? (await c.query(`select b.id, b.number, left(b.words, 160) words, b.status, b.created_at "createdAt" from pulse.reported_bug b
      where b.fingerprint = $1 and b.id <> $2 order by b.created_at desc limit 20`, [row.fingerprint, row.id])).rows : [];
    const files = (await c.query('select kind, content_type "contentType", bytes, seconds from pulse.reported_bug_file where report_id = $1', [row.id])).rows;
    delete row.fingerprint;
    return { ...row, events, similar, files, canTriage: leadership(v) };
  }));

  for (const kind of ['screenshot', 'recording'] as const) {
    app.get<{ Params: { id: string } }>(`/api/v0/bug-reports/:id/${kind}`, async (req, reply) => {
      const file = await tx(req, async (c, v) => {
        await one(c, v, reportId(req.params.id));
        return (await c.query('select content_type, data from pulse.reported_bug_file where report_id = $1 and kind = $2', [req.params.id, kind])).rows[0];
      });
      if (!file) fail(404, kind === 'screenshot' ? 'No picture with this report' : 'No recording with this report');
      return reply.header('content-type', file.content_type).header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff')
        .header('content-security-policy', 'sandbox').send(file.data);
    });
  }

  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/bug-reports/:id', { schema: { body } }, req => tx(req, async (c, v) => {
    lead(v);
    const id = reportId(req.params.id), b = req.body ?? {};
    const row = (await c.query('select id, number, status, severity, assignee_id, duplicate_of from pulse.reported_bug where id = $1 for update', [id])).rows[0];
    if (!row) fail(404, 'Report not found');
    const events: [string, string | null, string | null][] = [];
    const sets: string[] = [], args: unknown[] = [id];
    const set = (column: string, value: unknown) => { args.push(value); sets.push(`${column} = $${args.length}`); };
    if ('status' in b) {
      if (!(STATUSES as readonly string[]).includes(String(b.status))) fail(400, 'Choose new, triaged, fixing, fixed or won’t fix');
      if (b.status !== row.status) { set('status', b.status); sets.push('status_at = now()'); events.push(['status', String(b.status), null]); }
    }
    if ('severity' in b) {
      const s = b.severity === null || b.severity === '' ? null : (SEVERITIES as readonly string[]).includes(String(b.severity)) ? String(b.severity) : fail(400, 'Choose blocker, high, medium or low');
      if (s !== row.severity) { set('severity', s); events.push(['severity', s, null]); }
    }
    if ('assigneeId' in b) {
      const a = b.assigneeId === null || b.assigneeId === '' ? null : UUID.test(String(b.assigneeId)) ? String(b.assigneeId) : fail(400, 'Choose a person');
      if (a && !(await c.query("select 1 from pulse.person where id = $1 and status = 'active'", [a])).rowCount) fail(400, 'Choose an active colleague');
      if (a !== row.assignee_id) { set('assignee_id', a); events.push(['assignee', a, null]); }
    }
    if ('duplicateOf' in b) {
      let dup: string | null = null, label: string | null = null;
      if (b.duplicateOf !== null && b.duplicateOf !== '') {
        const n = Number(String(b.duplicateOf).replace(/^#/, ''));
        const target = Number.isInteger(n) && n > 0 ? (await c.query('select id, number, duplicate_of from pulse.reported_bug where number = $1', [n])).rows[0] : null;
        if (!target) fail(400, 'No report has that number');
        // Point at the original, never at a chain of duplicates or at itself.
        const root = target.duplicate_of ? (await c.query('select id, number from pulse.reported_bug where id = $1', [target.duplicate_of])).rows[0] : target;
        if (root.id === id) fail(400, 'A report cannot be a duplicate of itself');
        dup = root.id; label = `#${root.number}`;
      }
      if (dup !== row.duplicate_of) {
        set('duplicate_of', dup); events.push(['duplicate', label, null]);
        // Its own duplicates follow it to the original.
        if (dup) await c.query('update pulse.reported_bug set duplicate_of = $2, updated_at = now() where duplicate_of = $1', [id, dup]);
      }
    }
    const note = scrubWords(b.note).slice(0, 2000);
    if (note) events.push(['note', null, note]);
    if (!sets.length && !events.length) fail(400, 'Nothing to change');
    if (sets.length) await c.query(`update pulse.reported_bug set ${sets.join(', ')}, updated_at = now() where id = $1`, args);
    for (const [kind, value, text] of events) await c.query('insert into pulse.reported_bug_event (org_id, report_id, kind, value, note, actor_id) values (pulse.current_org(), $1, $2, $3, $4, $5)', [id, kind, value, text, v.person]);
    return one(c, v, id);
  }));

  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/bug-reports/:id/task', { schema: { body } }, req => tx(req, async (c, v) => {
    lead(v);
    if (!v.person) fail(403, 'Making a task needs your own Pulse sign-in');
    const id = reportId(req.params.id);
    const row = (await c.query('select id, number, words, route, severity, assignee_id, task_id from pulse.reported_bug where id = $1 for update', [id])).rows[0];
    if (!row) fail(404, 'Report not found');
    if (row.task_id) return { taskId: row.task_id, existing: true };
    const first = String(row.words).split('\n')[0].slice(0, 90);
    const fields = { title: `Bug #${row.number}: ${first}`, assigneeId: row.assignee_id ?? null, priority: row.severity === 'blocker' || row.severity === 'high' ? 'high' : 'normal',
      notes: `Reported bug #${row.number} on ${row.route}. Screenshot, errors and steps: /bug-reports?id=${row.id}\n\n${String(row.words).slice(0, 1500)}` };
    const taskId = (await c.query('select pulse.task_save(null, $1) id', [JSON.stringify(fields)])).rows[0].id as string;
    await c.query("update pulse.reported_bug set task_id = $2, status = case when status = 'new' then 'triaged' else status end, status_at = case when status = 'new' then now() else status_at end, updated_at = now() where id = $1", [id, taskId]);
    await c.query("insert into pulse.reported_bug_event (org_id, report_id, kind, value, actor_id) values (pulse.current_org(), $1, 'task', $2, $3)", [id, taskId, v.person]);
    return { taskId };
  }));
}
