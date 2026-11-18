// KAZUK-REST slice 4 (Kazuk, 3 Nov meeting, D1-D3; migration 1712): in-person meetings recorded in Pulse.
//   GET  /api/v0/meetings                         the viewer's meetings (theirs, the ones they were in; leadership: all)
//   GET  /api/v0/meetings/options                 projects, clients and colleagues to attach a meeting to
//   POST /api/v0/meetings {title,projectId,clientId,attendees,kind,consent,mime}   start one (a recording needs consent)
//   POST /api/v0/meetings/:id/parts {seq,bytes}   a 5-second part of the audio (base64, up to 1 MB), in order
//   POST /api/v0/meetings/:id/stop {seconds}      stop: the transcript is queued for the server's own Whisper when it is on
//   POST /api/v0/meetings/:id/notes {text}        typed or pasted notes become the transcript; action items are read again
//   GET  /api/v0/meetings/:id                     one meeting, its transcript and its action items (read once it is ready)
//   GET  /api/v0/meetings/:id/audio               the audio (range requests), only for those who see the meeting
//   POST /api/v0/meetings/:id/actions/:action/confirm {title,assigneeId,dueOn}   a draft becomes a task
//   POST /api/v0/meetings/:id/actions/:action/drop
//   POST /api/v0/meetings/:id/remove              the recorder or an admin; tasks already made stay
// MEETING-CAPTURE (1946): a transcript pasted or uploaded, and "Narrate a problem".
//   POST /api/v0/meetings/preview {text,fileName,purpose,from}   what Pulse read (format, speakers, name, summary, drafts); saves nothing
//   POST /api/v0/meetings/import {text,fileName,title,heldOn,projectId,clientId,attendees,purpose,from}   the meeting, its lines and drafts
//   GET  /api/v0/meetings/search?q=               transcript lines the viewer may read (row security per meeting)
//   GET  /api/v0/meetings/for-task/:id            the meeting (and line) a task was made from
//   A narrated problem's draft is confirmed as the person's own bug report (bug-reports.ts fileReport: its task, and
//   KAZUK-REST slice 5 sends it to the dev board), or as a task.
// The audio never leaves the server; transcripts, lines, summaries and action items are read here (meeting-actions.ts,
// transcript-import.ts), not by an outside AI.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { transcriptsOn } from './chat-voice.js';
import { CONSENT_TEXT, extractActions, type Person } from './meeting-actions.js';
import { fileReport } from './bug-reports.js';
import { draftProblems, nameFor, parseTranscript, problemName, readable, summaryOf, type Line, type Parsed } from './transcript-import.js';
import { fail, work, type Tx, type Viewer } from './routes.js';

/** A narrated problem's recording: the person records only their own voice. */
export const PROBLEM_CONSENT = 'I recorded only myself, describing a problem in Pulse; it is written down on the company’s own server.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIMES = new Set(['audio/webm', 'audio/ogg', 'audio/mp4']);
const id = (raw: unknown) => UUID.test(String(raw)) ? String(raw) : fail(400, 'Choose a valid meeting');
const opt = (raw: unknown) => raw === undefined || raw === null || raw === '' ? null : UUID.test(String(raw)) ? String(raw) : fail(400, 'Choose a valid project, client or person');
const staff = (v: Viewer) => { work(v); if (!v.person || v.role === 'accountant') fail(403, 'Meetings belong to a staff person'); return v.person; };
type Body = Record<string, unknown>;
const body = { type: 'object' };

/** The meeting's start, checked before the database checks it again. */
export function startInput(b: Body) {
  const kind = b.kind === 'notes' ? 'notes' : 'recording';
  const title = typeof b.title === 'string' ? b.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160) : '';
  if (kind === 'recording' && b.consent !== true) fail(400, 'Tell everyone present that the meeting is recorded, and confirm they agreed, before you start');
  const attendees = Array.isArray(b.attendees) ? (b.attendees.length > 40 ? fail(400, 'Up to 40 people') : b.attendees.map(opt).filter((x): x is string => !!x)) : [];
  const mime = String(b.mime ?? '').split(';')[0];
  // MEETING-CAPTURE: a narrated problem is the person recording only themself (Narrate a problem): no project or people.
  if (b.purpose === 'problem') return { kind, purpose: 'problem', title: title || 'A problem I described', projectId: null, clientId: null, attendees: [], consent: kind === 'recording', consentText: PROBLEM_CONSENT, mime: MIMES.has(mime) ? mime : 'audio/webm' };
  return { kind, purpose: 'meeting', title: title || 'Meeting', projectId: opt(b.projectId), clientId: opt(b.clientId), attendees: [...new Set(attendees)], consent: kind === 'recording', consentText: CONSENT_TEXT, mime: MIMES.has(mime) ? mime : 'audio/webm' };
}

async function view(c: PoolClient, mid: string) {
  let m = (await c.query('select pulse.meeting_view($1) j', [mid])).rows[0].j as Body | null;
  if (!m) fail(404, 'Meeting unavailable');
  const lines = m!.lines as unknown[];
  // MEETING-CAPTURE: the transcript is ready (Whisper finished, or notes were written) and has no lines yet: keep it line by
  // line (the server's timed segments, or the text read as a transcript), with its summary and speakers.
  if (m!.transcriptState === 'done' && typeof m!.transcript === 'string' && !lines?.length) {
    const segs = Array.isArray(m!.segments) ? m!.segments as { s?: number; t?: string }[] : [];
    const p: Parsed = segs.length ? { format: 'plain', heading: null, heldOn: null, speakers: [],
      lines: segs.filter((x) => typeof x.t === 'string' && x.t.trim()).map((x) => ({ speaker: null, at: Number.isFinite(x.s) ? Math.floor(Number(x.s)) : null, text: String(x.t).trim() })) }
      : parseTranscript(m!.transcript as string);
    await c.query('select pulse.meeting_lines_set($1,$2::jsonb,$3,$4::text[])', [mid, JSON.stringify(p.lines), summaryOf(p), p.speakers]);
    m = (await c.query('select pulse.meeting_view($1) j', [mid])).rows[0].j as Body;
  }
  // The transcript is ready: read its action items once, as drafts.
  if (m!.actionsState === 'pending' && m!.transcriptState === 'done' && typeof m!.transcript === 'string') {
    await readActions(c, mid, m!);
    m = (await c.query('select pulse.meeting_view($1) j', [mid])).rows[0].j as Body;
  }
  return { ...m!, transcripts: transcriptsOn() };
}
const today = async (c: PoolClient) => (await c.query(`select (now() at time zone pulse.org_time_zone())::date::text today`)).rows[0].today as string;
const colleagues = async (c: PoolClient) => (await c.query(`select id, display_name name from pulse.person where side='staff' and coalesce(status,'active')='active' order by display_name limit 2000`)).rows as Person[];
/** Each draft's line in the transcript: the first line its words come from. */
function lineOf(quote: string, lines: { n: number; text: string }[]): number | null {
  const q = quote.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
  return q ? lines.find((l) => l.text.toLowerCase().replace(/\s+/g, ' ').includes(q) || q.includes(l.text.toLowerCase().replace(/\s+/g, ' ').slice(0, 80)))?.n ?? null : null;
}
/** The colleague a speaker's name is: the same full name, else the only colleague with that first name. */
export function speakerId(name: string, people: Person[]): string | null {
  const k = name.toLowerCase().trim(), first = k.split(/\s+/)[0];
  const exact = people.filter((p) => p.name.toLowerCase().trim() === k);
  const hit = exact.length ? exact : people.filter((p) => p.name.toLowerCase().trim().split(/\s+/)[0] === first);
  return hit.length === 1 ? hit[0].id : null;
}
/** The action items in a transcript's lines. With speakers, each line is read on its own and its "I" is that speaker
 *  ("Meera: I will upload them" is Meera's, or nobody's yet when Meera is not a colleague), never the person who brought
 *  the transcript in; without speakers, as slice 4 reads notes ("I" is the person who recorded or brought it). */
export function actionsOf(lines: { speaker?: string | null; text: string }[], o: { today: string; people: Person[]; me: string | null }) {
  if (!lines.some((l) => l.speaker)) return extractActions(lines.map((l) => l.text).join('\n'), o);
  const out: ReturnType<typeof extractActions> = [], seen = new Set<string>();
  for (const l of lines) {
    const me = l.speaker ? speakerId(l.speaker, o.people) : o.me;
    for (const a of extractActions(l.text, { ...o, me, max: 5 })) {
      const key = a.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (seen.has(key) || out.length >= 20) continue;
      seen.add(key); out.push(a);
    }
  }
  return out;
}
async function readActions(c: PoolClient, mid: string, m: Body) {
  const lines = (m.lines as { n: number; speaker?: string; text: string }[] | undefined) ?? [];
  const items = m.purpose === 'problem'
    ? draftProblems(lines.length ? lines.map((l) => l.text).join('\n') : String(m.transcript), { from: null }).map((d) => ({ ...d, lineNo: lineOf(d.quote, lines) ?? d.lineNo, assigneeId: null, dueOn: null }))
    : actionsOf(lines.length ? lines : [{ text: String(m.transcript) }], { today: await today(c), people: await colleagues(c), me: String(m.by) }).map((a) => ({ ...a, lineNo: lineOf(a.quote, lines) }));
  await c.query('select pulse.meeting_actions_set($1,$2::jsonb)', [mid, JSON.stringify(items)]);
}

const FILE_NAME = /^[^\u0000-\u001f\u007f/\\]{1,200}$/;
/** A transcript brought in: its text and name checked, read as lines, named, summarised (nothing leaves the server). */
export function importInput(b: Body, day: string) {
  const raw = typeof b.text === 'string' ? b.text : '';
  if (!raw.trim()) fail(400, b.purpose === 'problem' ? 'Say what went wrong first' : 'Paste the transcript or choose its file');
  if (raw.length > 400_000) fail(400, 'That transcript is too long (up to 400,000 characters). Split it in two.');
  const fileName = typeof b.fileName === 'string' && FILE_NAME.test(b.fileName.trim()) ? b.fileName.trim() : null;
  const purpose = b.purpose === 'problem' ? 'problem' as const : 'meeting' as const;
  const from = typeof b.from === 'string' && /^\/[A-Za-z0-9/_.~%-]{0,200}$/.test(b.from) ? b.from : null;
  const p = parseTranscript(raw, fileName);
  if (!p.lines.length) fail(400, fileName ? 'Pulse found no words in that file. Choose a .txt, .vtt or .srt transcript.' : 'Pulse found no words to read. Paste the transcript text.');
  const drafts = purpose === 'problem' ? draftProblems(raw, { from }) : [];
  const auto = purpose === 'problem' ? problemName(drafts, p.heldOn ?? day) : nameFor(p, { fileName, day });
  const typed = typeof b.title === 'string' ? b.title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  const heldOn = typeof b.heldOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.heldOn) ? b.heldOn : p.heldOn;
  return { parsed: p, purpose, fileName, from, drafts, title: typed || auto, autoTitle: auto, heldOn, summary: purpose === 'problem' ? null : summaryOf(p) };
}

export function registerMeetingRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/meetings', req => tx(req, async (c, v) => {
    staff(v);
    return { meetings: (await c.query('select pulse.meeting_list() j')).rows[0].j, transcripts: transcriptsOn() };
  }));
  app.get('/api/v0/meetings/options', req => tx(req, async (c, v) => {
    const me = staff(v);
    const projects = (await c.query(`select id, coalesce(title, name) name, (select display_name from pulse.client cl where cl.id=p.client_id) "clientName" from pulse.project p
      where deleted_at is null order by coalesce(title, name) limit 300`)).rows;
    const clients = (await c.query('select id, display_name name from pulse.client order by display_name limit 500')).rows;
    const people = (await c.query(`select id, display_name name from pulse.person where side='staff' and coalesce(status,'active')='active' and id<>$1 order by display_name limit 500`, [me])).rows;
    return { projects, clients, people, transcripts: transcriptsOn(), consentText: CONSENT_TEXT };
  }));
  app.post<{ Body: Body }>('/api/v0/meetings', { schema: { body }, bodyLimit: 8192 }, req => tx(req, async (c, v) => {
    staff(v);
    const s = startInput(req.body ?? {});
    const mid = (await c.query('select pulse.meeting_start($1::jsonb) id', [JSON.stringify(s)])).rows[0].id as string;
    return { id: mid };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/meetings/:id/parts', { schema: { body }, bodyLimit: 1_500_000 }, req => tx(req, async (c, v) => {
    staff(v); const b = req.body, seq = Number(b.seq), bytes = String(b.bytes ?? '');
    if (!Number.isInteger(seq) || seq < 0 || seq > 20000) fail(400, 'Send the part number');
    if (!bytes || bytes.length > 1_400_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(bytes)) fail(400, 'Send a part up to 1 MB');
    await c.query('select pulse.meeting_part_add($1,$2,$3)', [id(req.params.id), seq, Buffer.from(bytes, 'base64')]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/meetings/:id/stop', { schema: { body }, bodyLimit: 2048 }, req => tx(req, async (c, v) => {
    staff(v); const mid = id(req.params.id), secs = Number(req.body?.seconds);
    await c.query('select pulse.meeting_stop($1,$2,$3)', [mid, Number.isFinite(secs) ? Math.max(0, Math.min(86400, Math.round(secs))) : null, transcriptsOn()]);
    return { meeting: await view(c, mid) };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/meetings/:id/notes', { schema: { body }, bodyLimit: 600_000 }, req => tx(req, async (c, v) => {
    staff(v); const mid = id(req.params.id), text = typeof req.body?.text === 'string' ? req.body.text.replace(/\r/g, '') : '';
    if (!text.trim()) fail(400, 'Write the notes first');
    await c.query('select pulse.meeting_notes_set($1,$2)', [mid, text.slice(0, 400000)]);
    return { meeting: await view(c, mid) };
  }));
  // MEETING-CAPTURE: what Pulse read from a transcript before it is saved (the person checks the name and the people).
  app.post<{ Body: Body }>('/api/v0/meetings/preview', { schema: { body }, bodyLimit: 1_800_000 }, req => tx(req, async (c, v) => {
    staff(v);
    const r = importInput(req.body ?? {}, await today(c));
    const people = r.purpose === 'meeting' ? await colleagues(c) : [];
    const actions = r.purpose === 'problem' ? r.drafts
      : actionsOf(r.parsed.lines, { today: await today(c), people, me: v.person ?? null }).map((a) => ({ kind: 'task', title: a.title, quote: a.quote, who: people.find((p) => p.id === a.assigneeId)?.name ?? (a.assigneeId && a.assigneeId === v.person ? 'You' : null) }));
    // Colleagues whose names are the speakers' are offered as the people who were there.
    const named = r.parsed.speakers.map((s) => speakerId(s, people)).filter((x): x is string => !!x && x !== v.person);
    return { format: r.parsed.format, speakers: r.parsed.speakers, lineCount: r.parsed.lines.length, title: r.title, heldOn: r.heldOn ?? await today(c), summary: r.summary,
      sample: r.parsed.lines.slice(0, 8), drafts: actions.slice(0, 20), attendees: [...new Set(named)], from: r.from };
  }));
  app.post<{ Body: Body }>('/api/v0/meetings/import', { schema: { body }, bodyLimit: 1_800_000 }, req => tx(req, async (c, v) => {
    staff(v); const b = req.body ?? {};
    const r = importInput(b, await today(c));
    const attendees = Array.isArray(b.attendees) ? (b.attendees.length > 40 ? fail(400, 'Up to 40 people') : b.attendees.map(opt).filter((x): x is string => !!x)) : [];
    const lines: Line[] = r.parsed.lines;
    const mid = (await c.query('select pulse.meeting_import($1::jsonb) id', [JSON.stringify({
      title: r.title, purpose: r.purpose, source: r.fileName ? 'file' : 'paste', format: r.parsed.format, sourceName: r.fileName, heldOn: r.heldOn,
      projectId: opt(b.projectId), clientId: opt(b.clientId), attendees: [...new Set(attendees)],
      transcript: r.purpose === 'problem' || r.parsed.format === 'plain' ? String(b.text).replace(/\r/g, '').trim() : readable(lines),
      lines, summary: r.summary, speakers: r.parsed.speakers })])).rows[0].id as string;
    // A narrated problem's drafts name the page it was started on when the words name none.
    if (r.purpose === 'problem') {
      const m = (await c.query('select pulse.meeting_view($1) j', [mid])).rows[0].j as Body;
      const ls = (m.lines as { n: number; text: string }[]) ?? [];
      await c.query('select pulse.meeting_actions_set($1,$2::jsonb)', [mid, JSON.stringify(r.drafts.map((d) => ({ ...d, lineNo: lineOf(d.quote, ls) ?? d.lineNo, assigneeId: null, dueOn: null })))]);
    }
    return { id: mid, meeting: await view(c, mid) };
  }));
  app.get<{ Querystring: { q?: string } }>('/api/v0/meetings/search', req => tx(req, async (c, v) => {
    staff(v); const q = String(req.query?.q ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
    return { q, results: q.length < 2 ? [] : (await c.query('select pulse.meeting_search($1) j', [q])).rows[0].j };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/meetings/for-task/:id', req => tx(req, async (c, v) => {
    staff(v); return { meeting: (await c.query('select pulse.meeting_for_task($1) j', [id(req.params.id)])).rows[0].j ?? null };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/meetings/:id', req => tx(req, async (c, v) => { staff(v); return { meeting: await view(c, id(req.params.id)) }; }));
  app.get<{ Params: { id: string } }>('/api/v0/meetings/:id/audio', async (req, reply) => {
    const row = await tx(req, async (c, v) => { staff(v); return (await c.query('select * from pulse.meeting_audio($1)', [id(req.params.id)])).rows[0] as { mime: string; bytes: Buffer | null } | undefined; });
    if (!row?.bytes) return fail(404, 'Recording unavailable');
    const all = row.bytes, size = all.length, ext = row.mime === 'audio/mp4' ? 'm4a' : row.mime === 'audio/ogg' ? 'ogg' : 'webm';
    reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').header('accept-ranges', 'bytes')
      .header('content-disposition', `inline; filename="meeting.${ext}"`).type(row.mime);
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])), end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      if (start >= size || start > end) return reply.code(416).header('content-range', `bytes */${size}`).send();
      return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).send(all.subarray(start, end + 1));
    }
    return reply.send(all);
  });
  for (const act of ['confirm', 'drop'] as const) app.post<{ Params: { id: string; action: string }; Body: Body }>(`/api/v0/meetings/:id/actions/:action/${act}`, { schema: { body }, bodyLimit: 4096 }, req => tx(req, async (c, v) => {
    staff(v); const mid = id(req.params.id), aid = id(req.params.action), b = req.body ?? {};
    const patch: Body = {};
    if (typeof b.title === 'string' && b.title.trim()) patch.title = b.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
    if ('assigneeId' in b) patch.assigneeId = opt(b.assigneeId);
    if ('dueOn' in b) patch.dueOn = typeof b.dueOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.dueOn) ? b.dueOn : null;
    if (b.kind === 'task' || b.kind === 'bug') patch.kind = b.kind;
    if (act === 'confirm') {
      // MEETING-CAPTURE: a narrated problem confirmed as a bug report is filed as the person's own report first (the same
      // command again returns the first report), then the draft is marked with it.
      const m = (await c.query('select pulse.meeting_view($1) j', [mid])).rows[0].j as Body | null;
      const a = ((m?.actions as Body[] | undefined) ?? []).find((x) => x.id === aid);
      if (a && a.state === 'draft' && (patch.kind ?? a.kind) === 'bug') {
        const title = String(patch.title ?? a.title), quote = typeof a.quote === 'string' ? a.quote : '';
        const route = typeof a.route === 'string' ? a.route : '/meetings';
        const filed = await fileReport(c, v, { commandId: `meeting-${aid}`, route, platform: 'web',
          words: [title, quote && quote !== title ? quote : '', `Told in Meetings: /meetings/${mid}${a.lineNo ? `?line=${a.lineNo}` : ''}`].filter(Boolean).join('\n\n') });
        patch.bugId = filed.id;
      }
    }
    const r = (await c.query('select pulse.meeting_action_decide($1,$2,$3,$4::jsonb) j', [mid, aid, act === 'confirm', JSON.stringify(patch)])).rows[0].j;
    return { result: r, meeting: await view(c, mid) };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/meetings/:id/remove', { schema: { body }, bodyLimit: 1024 }, req => tx(req, async (c, v) => {
    staff(v); await c.query('select pulse.meeting_remove($1)', [id(req.params.id)]); return { ok: true };
  }));
}
