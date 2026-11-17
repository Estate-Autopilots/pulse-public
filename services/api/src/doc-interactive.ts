// DOCS-INTERACTIVE (owner, 7 Nov 2026): what makes a doc more than words (1715). One model for the screens (/api/v0/docs…,
// below) and API v1 / MCP / the CLI (v1-docs.ts):
//   * interactive blocks: a fixed catalogue of kinds (approval, checklist, form, actions, quote, chart, timeline), stored in
//     the doc's HTML as data (`<div data-type="pulse-block" data-block='{json}'>`), never as code; each is checked here
//     against its kind before it is stored, and people's answers are kept per person (doc_block_answer);
//   * docs sent to a person ("read this and approve it"): doc_request, a notification, and the answer;
//   * reading receipts: each reader's active time, depth and time per section (doc_read), summarised as
//     "Read 92 %, 6 min, skipped §4"; seen only by the reader, the doc's owner and whoever sent it to that reader;
//   * links between a doc and tasks, projects and goals both ways, and a task's brief (doc_link).
// docs/spec/DOCS.md ("Interactive docs") has the design; the research is in DOCS-INTERACTIVE-RESEARCH.md.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx } from './routes.js';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isId = (x: unknown): x is string => typeof x === 'string' && UUID.test(x);
const anId = (x: unknown, what: string) => isId(x) ? x : fail(400, `Choose ${what}`);

import { ANSWERED, blocksIn, line, listOf, type BlockKind } from './doc-blocks.js';
export { BLOCK_KINDS, blockAttribs, blockHtml, blocksFromMarkdown, blocksIn, cleanBlock } from './doc-blocks.js';

// ------------------------------------------------------------------------------------------------ reading receipts
export type SectionRead = { id: string; title: string; words: number; ms: number; views: number; state: 'read' | 'skimmed' | 'skipped' };
export type ReadSummary = { personId: string; name: string; sessions: number; activeMs: number; depth: number; readPct: number; reReads: number;
  firstAt: string | null; lastAt: string | null; sections: SectionRead[]; summary: string; request: null | { id: string; ask: string; status: string; sentAt: string; answeredAt: string | null; openedAt: string | null } };

/** A section is read when its time reaches 35 % of a fast reader's (400 words a minute), and at least 2 s; skipped when it
 *  was never on screen for half a second; skimmed in between. */
export const sectionState = (words: number, ms: number): SectionRead['state'] =>
  ms >= Math.max(2000, words * 150 * 0.35) ? 'read' : ms < 500 ? 'skipped' : 'skimmed';
export const minutes = (ms: number) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`;

/** One reader's sessions folded into what a sender needs: read %, time, depth, each section's state, re-reads. */
export function summarise(rows: Row[], order: { id: string; title: string; words: number }[]): Omit<ReadSummary, 'personId' | 'name' | 'request'> {
  const per = new Map<string, { title: string; words: number; ms: number; views: number }>();
  for (const s of order) per.set(s.id, { title: s.title, words: s.words, ms: 0, views: 0 });
  let activeMs = 0, depth = 0, first: string | null = null, last: string | null = null;
  for (const r of rows) {
    activeMs += Number(r.active_ms ?? 0); depth = Math.max(depth, Number(r.depth ?? 0));
    const s = String(r.started_at ?? ''), l = String(r.last_at ?? '');
    if (s && (!first || s < first)) first = s;
    if (l && (!last || l > last)) last = l;
    for (const [id, v] of Object.entries((r.sections ?? {}) as Record<string, Row>)) {
      const cur = per.get(id) ?? { title: line(v.t, 80) || 'Section', words: Number(v.w ?? 0), ms: 0, views: 0 };
      cur.ms += Math.max(0, Number(v.ms ?? 0)); cur.views += Math.max(0, Number(v.n ?? 0));
      if (!per.has(id)) per.set(id, cur);
    }
  }
  const sections: SectionRead[] = [...per.entries()].map(([id, s]) => ({ id, title: s.title, words: s.words, ms: s.ms, views: s.views, state: sectionState(s.words, s.ms) }));
  const words = sections.reduce((n, s) => n + s.words, 0);
  const readWords = sections.reduce((n, s) => n + (s.state === 'read' ? s.words : 0), 0);
  const readPct = words > 0 ? Math.round((readWords / words) * 100) : Math.round(depth * 100);
  const reReads = sections.reduce((n, s) => n + Math.max(0, s.views - rows.length), 0);
  const skipped = sections.map((s, i) => s.state === 'skipped' ? `§${i + 1}` : null).filter(Boolean) as string[];
  const summary = !rows.length ? 'Not opened yet'
    : `Read ${readPct} %, ${minutes(activeMs)}${skipped.length ? `, skipped ${skipped.slice(0, 4).join(', ')}${skipped.length > 4 ? '…' : ''}` : ''}${reReads ? `, ${reReads} re-read${reReads > 1 ? 's' : ''}` : ''}`;
  return { sessions: rows.length, activeMs, depth: Math.round(depth * 100) / 100, readPct, reReads, firstAt: first, lastAt: last, sections, summary };
}

/** The doc's sections as the reader's screen splits them (headings), from the latest session that reported them. */
function sectionOrder(rows: Row[]) {
  const latest = [...rows].sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)))[0];
  return Object.entries(((latest?.sections ?? {}) as Record<string, Row>)).sort((a, b) => Number(a[1].i ?? 0) - Number(b[1].i ?? 0))
    .map(([id, v]) => ({ id, title: line(v.t, 80) || 'Section', words: Number(v.w ?? 0) }));
}

/** Everyone's reading of a doc that the viewer may see (row security: their own; all for the owner; a sender's recipients). */
export async function docReads(c: PoolClient, docIdValue: string): Promise<ReadSummary[]> {
  const rows = (await c.query(`select r.person_id::text pid,p.display_name name,r.active_ms,r.depth,r.sections,r.started_at::text started_at,r.last_at::text last_at
    from pulse.doc_read r join pulse.person p on p.id=r.person_id where r.doc_id=$1 order by r.last_at desc limit 500`, [docIdValue])).rows;
  const reqs = (await c.query(`select q.id::text id,q.to_person::text pid,p.display_name name,q.ask,q.status,q.created_at::text "sentAt",q.answered_at::text "answeredAt",q.opened_at::text "openedAt"
    from pulse.doc_request q join pulse.person p on p.id=q.to_person where q.doc_id=$1 and q.status<>'cancelled' order by q.created_at desc`, [docIdValue])).rows;
  const people = new Map<string, string>();
  for (const r of [...reqs, ...rows]) if (!people.has(String(r.pid))) people.set(String(r.pid), String(r.name));
  const order = sectionOrder(rows);
  return [...people.entries()].map(([pid, name]) => {
    const mine = rows.filter((r) => r.pid === pid);
    const q = reqs.find((r) => r.pid === pid);
    return { personId: pid, name, ...summarise(mine, order), request: q ? { id: String(q.id), ask: String(q.ask), status: String(q.status), sentAt: String(q.sentAt), answeredAt: (q.answeredAt as string) ?? null, openedAt: (q.openedAt as string) ?? null } : null };
  });
}

const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
/** A reader's screen reports its session so far (cumulative; the larger numbers win, so a late beacon never lowers them). */
export async function saveRead(c: PoolClient, docIdValue: string, b: Row) {
  if (!(await c.query('select pulse.doc_reads_on() v')).rows[0]?.v) return { stored: false, reason: 'off' };
  const session = SESSION.test(String(b.session ?? '')) ? String(b.session) : fail(400, 'Send the reading session');
  const sections: Record<string, { t: string; w: number; ms: number; n: number; i: number }> = {};
  let n = 0;
  for (const [id, v] of Object.entries((b.sections && typeof b.sections === 'object' ? b.sections : {}) as Record<string, Row>)) {
    if (!/^s[0-9]{1,3}[a-z0-9-]{0,40}$/.test(id) || n++ >= 120) continue;
    sections[id] = { t: line(v.t, 80), w: Math.min(100_000, Math.max(0, Math.round(Number(v.w) || 0))), ms: Math.min(86_400_000, Math.max(0, Math.round(Number(v.ms) || 0))),
      n: Math.min(1000, Math.max(0, Math.round(Number(v.n) || 0))), i: Math.min(1000, Math.max(0, Math.round(Number(v.i) || 0))) };
  }
  const active = Math.min(86_400_000, Math.max(0, Math.round(Number(b.activeMs) || 0)));
  const depth = Math.min(1, Math.max(0, Number(b.depth) || 0));
  await c.query(`insert into pulse.doc_read(org_id,doc_id,person_id,session_id,version,active_ms,depth,sections)
      values(pulse.current_org(),$1,pulse.current_viewer(),$2,$3,$4,$5,$6)
    on conflict (doc_id,person_id,session_id) do update set last_at=now(),version=excluded.version,active_ms=greatest(pulse.doc_read.active_ms,excluded.active_ms),
      depth=greatest(pulse.doc_read.depth,excluded.depth),sections=case when excluded.active_ms>=pulse.doc_read.active_ms then excluded.sections else pulse.doc_read.sections end`,
  [docIdValue, session, Math.max(0, Math.round(Number(b.version) || 0)), active, depth, JSON.stringify(sections)]);
  return { stored: true };
}

// ------------------------------------------------------------------------------------------------ requests
export type DocRequest = { id: string; docId: string; title: string; ask: string; status: string; note: string | null; dueAt: string | null; from: string; fromId: string;
  to: string; toId: string; sentAt: string; answeredAt: string | null; answerNote: string | null; openedAt: string | null };
const REQUEST = `q.id::text id,q.doc_id::text "docId",d.title,q.ask,q.status,q.note,q.due_at::text "dueAt",f.display_name "from",q.from_person::text "fromId",
  t.display_name "to",q.to_person::text "toId",q.created_at::text "sentAt",q.answered_at::text "answeredAt",q.answer_note "answerNote",q.opened_at::text "openedAt"
  from pulse.doc_request q join pulse.doc d on d.id=q.doc_id join pulse.person f on f.id=q.from_person join pulse.person t on t.id=q.to_person`;

export async function sendDoc(c: PoolClient, docIdValue: string, b: Row): Promise<string> {
  const to = anId(b.to ?? b.personId, 'who to send it to');
  const ask = ['read', 'approve', 'review'].includes(String(b.ask)) ? String(b.ask) : 'read';
  const due = b.dueAt ? new Date(String(b.dueAt)) : null;
  if (due && Number.isNaN(due.getTime())) fail(400, 'The due date is not a date');
  return (await c.query('select pulse.doc_request_send($1,$2,$3,$4,$5) v', [docIdValue, to, ask, b.note ? String(b.note).slice(0, 2000) : null, due])).rows[0].v;
}
export async function answerRequest(c: PoolClient, requestId: string, b: Row) {
  const status = ({ approve: 'approved', approved: 'approved', decline: 'declined', declined: 'declined', changes: 'changes', read: 'read' } as Record<string, string>)[String(b.answer ?? b.status)]
    ?? fail(400, 'Answer approve, decline, changes or read');
  await c.query('select pulse.doc_request_answer($1,$2,$3)', [anId(requestId, 'a request'), status, b.note ? String(b.note).slice(0, 2000) : null]);
  return (await c.query(`select ${REQUEST} where q.id=$1`, [requestId])).rows[0] as DocRequest;
}
export async function listRequests(c: PoolClient, direction: 'to' | 'from' | 'all', status?: string, take = 100): Promise<(DocRequest & { reads?: string })[]> {
  const rows = (await c.query(`select ${REQUEST} where q.status<>'cancelled'
      and ($1='all' or ($1='to' and q.to_person=pulse.current_viewer()) or ($1='from' and q.from_person=pulse.current_viewer()))
      and ($2::text is null or q.status=$2) order by (q.status='waiting') desc,q.created_at desc limit $3`, [direction, status ?? null, Math.min(Math.max(take, 1), 200)])).rows as DocRequest[];
  // The sender's view carries the reading summary of each recipient.
  const out: (DocRequest & { reads?: string })[] = [];
  for (const r of rows) {
    if (direction === 'to') { out.push(r); continue; }
    const reads = (await c.query('select active_ms,depth,sections,started_at::text started_at,last_at::text last_at from pulse.doc_read where doc_id=$1 and person_id=$2', [r.docId, r.toId])).rows;
    out.push({ ...r, reads: summarise(reads, sectionOrder(reads)).summary });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ block answers
export type BlockAnswer = { blockId: string; kind: string; personId: string; who: string; value: Row; effect: Row | null; answeredAt: string; mine: boolean };
export async function blockAnswers(c: PoolClient, docIdValue: string): Promise<BlockAnswer[]> {
  return (await c.query(`select a.block_id "blockId",a.kind,a.person_id::text "personId",p.display_name who,a.value,a.effect,a.answered_at::text "answeredAt",
      a.person_id=pulse.current_viewer() mine from pulse.doc_block_answer a join pulse.person p on p.id=a.person_id where a.doc_id=$1 order by a.answered_at`, [docIdValue])).rows as BlockAnswer[];
}

function cleanAnswer(block: Row & { kind: BlockKind }, v: Row): Row {
  switch (block.kind) {
    case 'approval': {
      const decision = ['approved', 'declined', 'changes'].includes(String(v.decision)) ? String(v.decision) : fail(400, 'Approve, decline or ask for changes');
      return { decision, note: line(v.note, 1000) };
    }
    case 'checklist': {
      const n = (block.items as string[]).length;
      return { done: listOf(v.done, n, (x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) < n ? x as number : null) };
    }
    case 'form': {
      const fields = block.fields as { label: string; type: string; options?: string[] }[];
      const values = (v.values && typeof v.values === 'object' ? v.values : {}) as Row;
      return { values: Object.fromEntries(fields.map((f, i) => {
        const raw = values[String(i)];
        const val = f.type === 'number' ? (raw === '' || raw === null || raw === undefined ? null : Number.isFinite(Number(raw)) ? Number(raw) : fail(400, `${f.label}: a number`))
          : f.type === 'choice' ? ((f.options ?? []).includes(String(raw)) ? String(raw) : null) : line(raw, f.type === 'long' ? 2000 : 300) || null;
        return [String(i), val];
      })) };
    }
    case 'actions': {
      const n = (block.rows as string[]).length;
      const marks = (v.marks && typeof v.marks === 'object' ? v.marks : {}) as Row;
      return { marks: Object.fromEntries(Object.entries(marks).filter(([k, m]) => Number(k) >= 0 && Number(k) < n && ['done', 'later', 'question'].includes(String(m)))) };
    }
    default: return fail(400, 'This block is not answered');
  }
}

/** A person answers a block. An approval may create a task (linked back to the doc) or finish a linked task, once; an
 *  approval also answers that person's waiting "please approve" request on the doc. */
export async function answerBlock(c: PoolClient, docIdValue: string, bid: string, v: Row) {
  const html: string = (await c.query('select body_html from pulse.doc where id=$1 and archived_at is null', [docIdValue])).rows[0]?.body_html ?? fail(404, 'Doc not found');
  const block = blocksIn(html).find((b) => b.id === bid) ?? fail(404, 'That block is not in this doc any more. Reload the doc.');
  if (!ANSWERED.includes(block.kind)) fail(400, 'This block is not answered');
  const value = cleanAnswer(block, v);
  let effect: Row | null = null;
  if (block.kind === 'approval' && value.decision === 'approved' && block.onApprove) {
    const done = (await c.query(`select 1 from pulse.doc_block_answer where doc_id=$1 and block_id=$2 and effect is not null`, [docIdValue, bid])).rowCount;
    if (!done) effect = await approvalEffect(c, docIdValue, block.onApprove as Row);
  }
  await c.query(`insert into pulse.doc_block_answer(org_id,doc_id,block_id,kind,person_id,value,effect) values(pulse.current_org(),$1,$2,$3,pulse.current_viewer(),$4,$5)
    on conflict (doc_id,block_id,person_id) do update set value=excluded.value,effect=coalesce(excluded.effect,pulse.doc_block_answer.effect),answered_at=now()`,
  [docIdValue, bid, block.kind, JSON.stringify(value), effect ? JSON.stringify(effect) : null]);
  if (block.kind === 'approval') {
    const waiting = (await c.query(`select id from pulse.doc_request where doc_id=$1 and to_person=pulse.current_viewer() and ask='approve' and status='waiting' limit 1`, [docIdValue])).rows[0];
    if (waiting) await c.query('select pulse.doc_request_answer($1,$2,$3)', [waiting.id, value.decision, value.note || null]);
  }
  return { effect };
}

async function approvalEffect(c: PoolClient, docIdValue: string, on: Row): Promise<Row> {
  await c.query('savepoint doc_block_effect');
  try {
    let out: Row;
    // The same task functions the Work screens use (pulse.task_save / task_move), so every task rule still applies.
    if (typeof on.createTask === 'string') {
      const fields = { title: on.createTask, ...(isId(on.assignee) ? { assigneeId: on.assignee } : {}) };
      const id = String((await c.query('select pulse.task_save(null,$1::jsonb)::text id', [JSON.stringify(fields)])).rows[0].id);
      await linkSafely(c, docIdValue, 'task', id, 'related');
      out = { taskId: id, created: true };
    } else if (isId(on.taskId)) {
      await c.query(`select pulse.task_move($1,'done')`, [on.taskId]);
      await linkSafely(c, docIdValue, 'task', on.taskId, 'related');
      out = { taskId: on.taskId, done: true };
    } else out = {};
    await c.query('release savepoint doc_block_effect');
    return out;
  } catch {
    await c.query('rollback to savepoint doc_block_effect');
    return { error: 'The approval is saved, but Pulse could not change the task. Do it from the task.' };
  }
}

// ------------------------------------------------------------------------------------------------ links
const LINK_KINDS = ['task', 'project', 'goal'] as const;
const LINK_SEE: Record<(typeof LINK_KINDS)[number], string> = {
  task: 'select id,title label,status sub from pulse.task where id=$1', project: 'select id,coalesce(title,name) label,status sub from pulse.project where id=$1',
  goal: 'select id,title label,status sub from pulse.goal where id=$1',
};
const LINK_HREF = { task: '/tasks/', project: '/projects/', goal: '/goals/' } as const;
export type DocLink = { id: string; kind: string; refId: string; role: string; label: string; sub: string | null; href: string; hidden: boolean };

async function seeTarget(c: PoolClient, kind: (typeof LINK_KINDS)[number], id: string): Promise<Row | null> {
  await c.query('savepoint doc_link_see');
  try { const r = (await c.query(LINK_SEE[kind], [id])).rows[0] ?? null; await c.query('release savepoint doc_link_see'); return r; }
  catch { await c.query('rollback to savepoint doc_link_see'); return null; }
}
/** Link when the viewer may (a reader who approves cannot edit the doc's links; the task still knows the doc from its evidence). */
async function linkSafely(c: PoolClient, docIdValue: string, kind: string, ref: string, role: string) {
  await c.query('savepoint doc_link_safe');
  try {
    await c.query(`insert into pulse.doc_link(org_id,doc_id,kind,ref_id,role,added_by) values(pulse.current_org(),$1,$2,$3,$4,pulse.current_viewer()) on conflict do nothing`,
      [docIdValue, kind, ref, role]);
    await c.query('release savepoint doc_link_safe');
  } catch { await c.query('rollback to savepoint doc_link_safe'); }
}
/** Link a doc to a task, project or goal the viewer can see; its briefs are listed first (the newest on top). */
export async function addLink(c: PoolClient, docIdValue: string, b: Row) {
  const kind = (LINK_KINDS as readonly string[]).includes(String(b.kind)) ? String(b.kind) as (typeof LINK_KINDS)[number] : fail(400, 'Link a task, project or goal');
  const ref = anId(b.id ?? b.refId, `a ${kind}`);
  const role = b.role === 'brief' ? 'brief' : 'related';
  if (!(await seeTarget(c, kind, ref))) fail(404, `That ${kind} is not one you can see`);
  const r = await c.query(`insert into pulse.doc_link(org_id,doc_id,kind,ref_id,role,added_by) values(pulse.current_org(),$1,$2,$3,$4,pulse.current_viewer())
    on conflict (doc_id,kind,ref_id) do update set role=excluded.role returning id`, [docIdValue, kind, ref, role]).catch(() => fail(403, 'You can read this doc but not change its links'));
  return String(r.rows[0].id);
}
export async function removeLink(c: PoolClient, docIdValue: string, linkId: string) {
  const r = await c.query('delete from pulse.doc_link where id=$1 and doc_id=$2 returning id', [anId(linkId, 'a link'), docIdValue]);
  if (!r.rowCount) fail(403, 'Links are changed by the doc\'s editors');
}
export async function linksOf(c: PoolClient, docIdValue: string): Promise<DocLink[]> {
  const rows = (await c.query('select id::text id,kind,ref_id::text "refId",role from pulse.doc_link where doc_id=$1 order by role,added_at', [docIdValue])).rows;
  const out: DocLink[] = [];
  for (const r of rows) {
    const t = await seeTarget(c, r.kind, r.refId);
    out.push({ id: r.id, kind: r.kind, refId: r.refId, role: r.role, label: t ? String(t.label ?? '') : 'Hidden from you', sub: t?.sub ? String(t.sub) : null,
      href: `${LINK_HREF[r.kind as keyof typeof LINK_HREF]}${r.refId}`, hidden: !t });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ what a doc page needs
export async function interactiveOf(c: PoolClient, docIdValue: string) {
  const me = (await c.query(`select pulse.current_viewer()::text me,pulse.doc_reads_on() reads,
      (select created_by=pulse.current_viewer() from pulse.doc where id=$1) owner`, [docIdValue])).rows[0];
  const [requests, answers, links] = await Promise.all([
    c.query(`select ${REQUEST} where q.doc_id=$1 and q.status<>'cancelled' order by q.created_at desc limit 100`, [docIdValue]).then((r) => r.rows as DocRequest[]),
    blockAnswers(c, docIdValue), linksOf(c, docIdValue)]);
  const forMe = requests.find((r) => r.toId === me.me && r.status === 'waiting') ?? requests.find((r) => r.toId === me.me) ?? null;
  const sentByMe = requests.some((r) => r.fromId === me.me);
  // Reading is tracked when someone sent this doc to the viewer, and the company has receipts on. The chip says so.
  const tracking = me.reads === true && !!forMe;
  if (forMe) await c.query('select pulse.doc_request_opened($1)', [docIdValue]);
  const reads = me.owner || sentByMe ? await docReads(c, docIdValue) : [];
  return { me: me.me as string, readsOn: me.reads === true, tracking, forMe, requests: requests.filter((r) => me.owner || r.fromId === me.me || r.toId === me.me), answers, links, reads };
}

/** Docs linked to (or mentioning) a task, project or goal: "Docs" on its page, the brief first. */
export async function docsFor(c: PoolClient, kind: string, id: string) {
  if (!(LINK_KINDS as readonly string[]).includes(kind) || !isId(id)) return [];
  return (await c.query(`select d.id::text id,d.title,u.display_name "updatedBy",d.updated_at::text "updatedAt",l.role from pulse.doc d
      left join pulse.doc_link l on l.doc_id=d.id and l.kind=$1 and l.ref_id=$2 left join pulse.person u on u.id=d.updated_by
    where d.archived_at is null and (l.id is not null or exists(select 1 from pulse.doc_mention m where m.doc_id=d.id and m.kind=$1 and m.ref_id=$2))
    order by (l.role='brief') desc nulls last,d.updated_at desc limit 50`, [kind, id])).rows as { id: string; title: string; updatedBy: string | null; updatedAt: string; role: string | null }[];
}

// ------------------------------------------------------------------------------------------------ screens
type Body = Record<string, unknown>;
const body = { type: 'object' } as const;
const docOk = (x: unknown) => isId(x) ? x : fail(404, 'Doc not found');
export function registerDocInteractiveRoutes(app: FastifyInstance, { tx }: { tx: Tx }, deps: { saveDoc: (c: PoolClient, id: string | null, b: Row) => Promise<string>; brief: string }) {
  app.get('/api/v0/docs/inbox', req => tx(req, async c => ({ waiting: await listRequests(c, 'to'), sent: await listRequests(c, 'from', undefined, 50) })));
  app.get<{ Querystring: Record<string, string> }>('/api/v0/docs/for', req => tx(req, async c => ({ docs: await docsFor(c, String(req.query.kind ?? ''), String(req.query.id ?? '')) })));
  // A task's (project's, goal's) brief: a new doc from the brief template, linked as its brief.
  app.post<{ Body: Body }>('/api/v0/docs/brief', { schema: { body } }, req => tx(req, async c => {
    const kind = String(req.body?.kind ?? ''), ref = anId(req.body?.id, 'what the brief is for');
    if (!(LINK_KINDS as readonly string[]).includes(kind)) fail(400, 'A brief is for a task, project or goal');
    const target = await seeTarget(c, kind as (typeof LINK_KINDS)[number], ref) ?? fail(404, `That ${kind} is not one you can see`);
    const id = await deps.saveDoc(c, null, { title: `Brief: ${String(target.label ?? '').slice(0, 180)}`, html: deps.brief, access: 'company' });
    await addLink(c, id, { kind, id: ref, role: 'brief' });
    return { id };
  }));
  app.get('/api/v0/docs/settings', req => tx(req, async c => (await c.query(`select pulse.doc_reads_on() "docReads",pulse.viewer_is('admin') "canChange"`)).rows[0]));
  app.post<{ Body: Body }>('/api/v0/docs/settings', { schema: { body } }, req => tx(req, async c => {
    if (!(await c.query(`select pulse.viewer_is('admin') v`)).rows[0]?.v) fail(403, 'Admins change reading receipts for the company');
    await c.query(`insert into pulse.telemetry_setting(org_id,doc_reads,updated_by) values(pulse.current_org(),$1,pulse.current_viewer())
      on conflict (org_id) do update set doc_reads=excluded.doc_reads,updated_by=excluded.updated_by,updated_at=now()`, [req.body?.docReads !== false]);
    return (await c.query(`select pulse.doc_reads_on() "docReads",true "canChange"`)).rows[0];
  }));
  app.post<{ Params: { rid: string }; Body: Body }>('/api/v0/docs/requests/:rid/answer', { schema: { body } }, req => tx(req, async c => ({ request: await answerRequest(c, req.params.rid, req.body ?? {}) })));
  app.post<{ Params: { rid: string } }>('/api/v0/docs/requests/:rid/cancel', req => tx(req, async c => {
    const r = await c.query(`update pulse.doc_request set status='cancelled' where id=$1 and from_person=pulse.current_viewer() and status='waiting' returning id`, [anId(req.params.rid, 'a request')]);
    return r.rowCount ? { ok: true } : fail(403, 'Only the sender takes back a request that is still waiting');
  }));
  app.get<{ Params: { id: string } }>('/api/v0/docs/:id/interactive', req => tx(req, async c => interactiveOf(c, docOk(req.params.id))));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/docs/:id/requests', { schema: { body } }, req => tx(req, async c => {
    const id = docOk(req.params.id);
    const rid = await sendDoc(c, id, req.body ?? {});
    return { id: rid, requests: (await interactiveOf(c, id)).requests };
  }));
  app.post<{ Params: { id: string; bid: string }; Body: Body }>('/api/v0/docs/:id/blocks/:bid', { schema: { body } }, req => tx(req, async c => {
    const id = docOk(req.params.id);
    const r = await answerBlock(c, id, String(req.params.bid), (req.body ?? {}) as Row);
    return { ...r, answers: await blockAnswers(c, id) };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/docs/:id/reads', { schema: { body }, bodyLimit: 64_000 }, req => tx(req, async c => saveRead(c, docOk(req.params.id), req.body ?? {})));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/docs/:id/links', { schema: { body } }, req => tx(req, async c => {
    const id = docOk(req.params.id);
    await addLink(c, id, req.body ?? {});
    return { links: await linksOf(c, id) };
  }));
  app.post<{ Params: { id: string; lid: string } }>('/api/v0/docs/:id/links/:lid/remove', req => tx(req, async c => {
    const id = docOk(req.params.id);
    await removeLink(c, id, req.params.lid);
    return { links: await linksOf(c, id) };
  }));
}
