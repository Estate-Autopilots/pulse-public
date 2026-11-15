// PR-STUDIO (owner, 6 Nov 2026; migration 1597): the Story, briefs, audiences, creative drafts and the content calendar.
// One model serves the screens (/api/v0/pr…, below) and API v1 / MCP / the CLI (v1-pr.ts). Who may use it is decided in
// the database (pulse.pr_can under forced row security: admins, leadership and AI employees); the words come from
// pr-copy.ts. Nothing is sent from here: drafts are copied and sent by a person.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx } from './routes.js';
import { BRIEF_KINDS, CHANNELS, KINDS, PR_AGENTS, RATIOS, TONES, chapters, composeBrief, composePack, streak, type Audience, type BriefKind,
  type ChapterEdit, type Entry, type ImageSpec, type Kind } from './pr-copy.js';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const has = (b: Row, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const line = (v: unknown, max: number) => v === null || v === undefined ? '' : String(v).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const block = (v: unknown, max: number) => v === null || v === undefined ? '' : String(v).replace(/\r\n?/g, '\n').replace(/[^\S\n]+$/gm, '').trim().slice(0, max);
const day = (v: unknown, what: string) => DAY.test(String(v)) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? String(v) : fail(400, `${what} is a date (YYYY-MM-DD)`);
const id = (v: unknown, what: string) => UUID.test(String(v)) ? String(v) : fail(404, `${what} not found`);
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T => (list as readonly string[]).includes(String(v)) ? String(v) as T : fail(400, `Choose ${what}: ${list.join(', ')}`);
const ids = (v: unknown, what: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 200 || v.some(x => !UUID.test(String(x)))) fail(400, `${what} is a list of up to 200 ids`);
  return [...new Set((v as unknown[]).map(String))];
};

/** Refuses anyone PR Studio is not for (403), before anything is read or written. */
export async function prGate(c: PoolClient) {
  if ((await c.query('select pulse.pr_can() v')).rows[0]?.v !== true) fail(403, 'PR Studio is for the company\'s admins, leadership and AI employees');
}
async function clock(c: PoolClient) {
  const r = (await c.query(`select (now() at time zone pulse.org_time_zone())::date::text today,extract(hour from now() at time zone pulse.org_time_zone())::int as hour,
      extract(isodow from now() at time zone pulse.org_time_zone())::int as dow,(select name from pulse.org where id=pulse.current_org()) company,
      (select side from pulse.person where id=pulse.current_viewer()) side`)).rows[0];
  return { today: String(r.today), hour: Number(r.hour), dow: Number(r.dow), company: String(r.company ?? 'Our company'), side: String(r.side ?? '') };
}
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// ------------------------------------------------------------------------------------------------ the Story
export type StoryEntry = Entry & { edited: boolean; hidden: boolean; toldAt: string | null; collected: boolean; createdAt: string };
const ENTRY = `select id,happened_on::text "happenedOn",kind,title,body,edited,hidden,told_at::text "toldAt",source_key is not null collected,created_at::text "createdAt" from pulse.pr_story`;
const entryOut = (r: Row): StoryEntry => ({ id: String(r.id), happenedOn: String(r.happenedOn), kind: r.kind as Kind, title: String(r.title), body: String(r.body ?? ''),
  edited: r.edited === true, hidden: r.hidden === true, toldAt: (r.toldAt as string) ?? null, collected: r.collected === true, createdAt: String(r.createdAt) });

export type StoryFilter = { from?: string; to?: string; kind?: string; untold?: boolean; hidden?: boolean; after?: string | null; take?: number };
export async function listStory(c: PoolClient, f: StoryFilter = {}): Promise<StoryEntry[]> {
  const r = await c.query(`${ENTRY} where ($1::date is null or happened_on>=$1) and ($2::date is null or happened_on<=$2) and ($3::text is null or kind=$3)
      and ($4::boolean is false or told_at is null) and ($5::boolean or not hidden) and ($6::uuid is null or id>$6)
    order by ${f.after !== undefined ? 'id' : 'happened_on desc,created_at desc'} limit $7`,
  [f.from ?? null, f.to ?? null, f.kind ?? null, f.untold === true, f.hidden === true, f.after ?? null, Math.min(Math.max(f.take ?? 300, 1), 1000)]);
  return r.rows.map(entryOut);
}
export async function getEntry(c: PoolClient, entryId: string): Promise<StoryEntry> {
  const r = (await c.query(`${ENTRY} where id=$1`, [id(entryId, 'Story line')])).rows[0];
  return r ? entryOut(r) : fail(404, 'Story line not found');
}
/** Add a line to the Story (a feature landed, a meeting, a note …): what happened, never code. */
export async function addEntry(c: PoolClient, b: Row): Promise<string> {
  const title = line(b.title, 200) || fail(400, 'Say what happened in a line');
  const happenedOn = b.happenedOn ? day(b.happenedOn, 'The day') : (await clock(c)).today;
  const kind = b.kind === undefined ? 'note' : oneOf(b.kind, KINDS, 'what kind of thing happened');
  return (await c.query(`insert into pulse.pr_story(org_id,happened_on,kind,title,body,created_by) values(pulse.current_org(),$1,$2,$3,$4,pulse.current_viewer()) returning id`,
    [happenedOn, kind, title, block(b.body, 4000)])).rows[0].id;
}
/** Change a line: its words (it is then kept as written, never refreshed by the collector), its day or kind, hide or show it. */
export async function updateEntry(c: PoolClient, entryId: string, b: Row): Promise<StoryEntry> {
  const old = await getEntry(c, entryId);
  const title = has(b, 'title') ? line(b.title, 200) || fail(400, 'Say what happened in a line') : old.title;
  const body = has(b, 'body') ? block(b.body, 4000) : old.body;
  const happenedOn = has(b, 'happenedOn') ? day(b.happenedOn, 'The day') : old.happenedOn;
  const kind = has(b, 'kind') ? oneOf(b.kind, KINDS, 'what kind of thing happened') : old.kind;
  const hidden = has(b, 'hidden') ? b.hidden === true : old.hidden;
  const words = title !== old.title || body !== old.body;
  await c.query('update pulse.pr_story set title=$2,body=$3,happened_on=$4,kind=$5,hidden=$6,edited=edited or $7 where id=$1', [old.id, title, body, happenedOn, kind, hidden, words]);
  return getEntry(c, old.id);
}
/** Gather what the company's records say happened (tasks done, bugs fixed, goals, releases) between two days. */
export async function collect(c: PoolClient, from: string, to: string): Promise<number> {
  return Number((await c.query('select pulse.pr_collect($1,$2) n', [day(from, 'From'), day(to, 'To')])).rows[0].n);
}
export async function chapterEdits(c: PoolClient): Promise<ChapterEdit[]> {
  return (await c.query(`select period,starts_on::text "startsOn",title,summary from pulse.pr_chapter`)).rows as ChapterEdit[];
}
/** Name a week or a month of the Story and say what it was about (empty words go back to the worked-out ones). */
export async function saveChapter(c: PoolClient, b: Row) {
  const period = oneOf(b.period, ['week', 'month'] as const, 'a week or a month');
  let startsOn = day(b.startsOn, 'The chapter\'s first day');
  if (period === 'month') startsOn = `${startsOn.slice(0, 7)}-01`;
  else { const t = new Date(`${startsOn}T00:00:00Z`); startsOn = addDays(startsOn, -((t.getUTCDay() + 6) % 7)); }
  await c.query(`insert into pulse.pr_chapter(org_id,period,starts_on,title,summary,updated_by) values(pulse.current_org(),$1,$2,$3,$4,pulse.current_viewer())
    on conflict(org_id,period,starts_on) do update set title=excluded.title,summary=excluded.summary,updated_by=excluded.updated_by,updated_at=now()`,
  [period, startsOn, line(b.title, 120), block(b.summary, 4000)]);
  return { period, startsOn };
}
export async function story(c: PoolClient, from: string, to: string) {
  const entries = await listStory(c, { from, to, take: 1000 });
  return { from, to, months: chapters(entries, await chapterEdits(c)), count: entries.length };
}

// ------------------------------------------------------------------------------------------------ briefs
export type Brief = { id: string; kind: BriefKind; personId: string | null; day: string; title: string; body: string; entryIds: string[]; writtenBy: 'auto' | 'ai' | 'person'; author: string | null; createdAt: string };
const BRIEF = `select b.id,b.kind,b.person_id "personId",b.day::text "day",b.title,b.body,b.entry_ids::text[] "entryIds",b.written_by "writtenBy",a.display_name author,b.created_at::text "createdAt"
  from pulse.pr_brief b left join pulse.person a on a.id=b.author_id`;
const briefOut = (r: Row): Brief => ({ id: String(r.id), kind: r.kind as BriefKind, personId: (r.personId as string) ?? null, day: String(r.day), title: String(r.title), body: String(r.body),
  entryIds: (r.entryIds as string[]) ?? [], writtenBy: r.writtenBy as Brief['writtenBy'], author: (r.author as string) ?? null, createdAt: String(r.createdAt) });
export async function listBriefs(c: PoolClient, f: { day?: string; kind?: string; after?: string | null; take?: number } = {}): Promise<Brief[]> {
  return (await c.query(`${BRIEF} where ($1::date is null or b.day=$1) and ($2::text is null or b.kind=$2) and ($3::uuid is null or b.id>$3)
    order by ${f.after !== undefined ? 'b.id' : 'b.day desc,b.created_at desc'} limit $4`, [f.day ?? null, f.kind ?? null, f.after ?? null, Math.min(Math.max(f.take ?? 30, 1), 200)])).rows.map(briefOut);
}
async function untoldCount(c: PoolClient) { return Number((await c.query('select count(*)::int n from pulse.pr_story where told_at is null and not hidden')).rows[0].n); }
async function toldDays(c: PoolClient): Promise<string[]> {
  return (await c.query(`select distinct (posted_at at time zone pulse.org_time_zone())::date::text d from pulse.pr_draft where status='posted' and posted_at>now()-interval '400 days'`)).rows.map(r => String(r.d));
}
/** Compose a brief of a kind from the Story now (written_by auto): morning = since yesterday, evening = today, weekly =
 *  the last 7 days, update = what was added since the last brief. Returns null when an update would say nothing. */
export async function composeBriefNow(c: PoolClient, kind: BriefKind): Promise<{ title: string; body: string; entryIds: string[]; day: string } | null> {
  const k = await clock(c);
  let entries: Entry[];
  if (kind === 'update') {
    const since = (await c.query('select max(created_at) t from pulse.pr_brief where person_id is null')).rows[0].t;
    entries = (await c.query(`${ENTRY} where not hidden and ($1::timestamptz is null or created_at>$1 or updated_at>$1) order by happened_on desc limit 60`, [since])).rows.map(entryOut);
    if (!entries.length) return null;
  } else {
    const from = kind === 'morning' ? addDays(k.today, -1) : kind === 'weekly' ? addDays(k.today, -7) : k.today;
    const to = kind === 'morning' ? addDays(k.today, -1) : k.today;
    entries = await listStory(c, { from, to, take: 200 });
  }
  const due = (await c.query(`select count(*) filter (where (due_at at time zone pulse.org_time_zone())::date=$1)::int today,
      count(*) filter (where (due_at at time zone pulse.org_time_zone())::date<$1)::int overdue
    from pulse.task where status in ('open','in_progress','blocked') and due_at is not null`, [k.today])).rows[0];
  const b = composeBrief({ kind, day: k.today, company: k.company, entries, dueToday: Number(due.today), overdue: Number(due.overdue),
    untold: await untoldCount(c), streak: streak(await toldDays(c), k.today) });
  return { ...b, entryIds: entries.map(e => e.id), day: k.today };
}
/** Write a brief: given words (a person's or an AI employee's), or composed from the Story when none are given. */
export async function writeBrief(c: PoolClient, b: Row, by: 'ai' | 'person'): Promise<Brief> {
  const kind = oneOf(b.kind ?? 'update', BRIEF_KINDS, 'the kind of brief');
  const personId = b.personId ? id(b.personId, 'Person') : null;
  let title = line(b.title, 160), body = block(b.body, 8000), entryIds = ids(b.entryIds, 'entryIds'), d = b.day ? day(b.day, 'The day') : null;
  if (!body) {
    const made = await composeBriefNow(c, kind) ?? fail(400, 'Nothing new in the Story since the last brief');
    title ||= made.title; body = made.body; entryIds = entryIds.length ? entryIds : made.entryIds; d ??= made.day;
  }
  if (!title) fail(400, 'Give the brief a title');
  d ??= (await clock(c)).today;
  const r = await c.query(`insert into pulse.pr_brief(org_id,kind,person_id,day,title,body,entry_ids,written_by,author_id) values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,pulse.current_viewer()) returning id`,
    [kind, personId, d, title, body, entryIds, by]);
  return (await listBriefs(c, { take: 200 })).find(x => x.id === r.rows[0].id) ?? fail(404, 'Brief not found');
}
/** The briefs that write themselves when PR Studio is opened: the morning one from 07:00, the evening one from 18:00,
 *  the weekly one on Monday mornings, and an update when five or more things (or a release) were added since the last
 *  brief and the last update is three hours old. The Story is gathered for yesterday and today first. */
export async function autoBriefs(c: PoolClient) {
  const k = await clock(c);
  await c.query('select pg_advisory_xact_lock(hashtext(pulse.current_org()::text||\':pr-brief\'))');
  await collect(c, addDays(k.today, -1), k.today);
  const make = async (kind: BriefKind) => {
    const m = await composeBriefNow(c, kind);
    if (m) await c.query(`insert into pulse.pr_brief(org_id,kind,day,title,body,entry_ids,written_by) values(pulse.current_org(),$1,$2,$3,$4,$5,'auto')
      on conflict (org_id,kind,day) where written_by='auto' and person_id is null and kind in ('morning','evening','weekly') do nothing`, [kind, m.day, m.title, m.body, m.entryIds]);
  };
  const today = (await c.query(`select kind from pulse.pr_brief where day=$1 and person_id is null and written_by='auto'`, [k.today])).rows.map(r => r.kind);
  if (k.hour >= 7 && !today.includes('morning')) await make('morning');
  if (k.hour >= 7 && k.dow === 1 && !today.includes('weekly')) await make('weekly');
  if (k.hour >= 18 && !today.includes('evening')) await make('evening');
  const fresh = (await c.query(`select count(*)::int n,bool_or(kind='release') rel,(select max(created_at)>now()-interval '3 hours' from pulse.pr_brief where kind='update' and person_id is null) recent
    from pulse.pr_story where not hidden and created_at>coalesce((select max(created_at) from pulse.pr_brief where person_id is null),'-infinity')`)).rows[0];
  if ((Number(fresh.n) >= 5 || fresh.rel === true) && fresh.recent !== true) {
    const m = await composeBriefNow(c, 'update');
    if (m) await c.query(`insert into pulse.pr_brief(org_id,kind,day,title,body,entry_ids,written_by) values(pulse.current_org(),'update',$1,$2,$3,$4,'auto')`, [m.day, m.title, m.body, m.entryIds]);
  }
}

// ------------------------------------------------------------------------------------------------ audiences
export type PrAudience = Audience & { note: string; archived: boolean };
const AUD = `select id,name,tone,channel,ratio,note,archived from pulse.pr_audience`;
const audOut = (r: Row): PrAudience => ({ id: String(r.id), name: String(r.name), tone: r.tone as Audience['tone'], channel: r.channel as Audience['channel'],
  ratio: r.ratio as Audience['ratio'], note: String(r.note ?? ''), archived: r.archived === true });
export async function listAudiences(c: PoolClient, all = false): Promise<PrAudience[]> {
  return (await c.query(`${AUD} where $1::boolean or not archived order by archived,lower(name)`, [all])).rows.map(audOut);
}
export async function getAudience(c: PoolClient, audienceId: string): Promise<PrAudience> {
  const r = (await c.query(`${AUD} where id=$1`, [id(audienceId, 'Audience')])).rows[0];
  return r ? audOut(r) : fail(404, 'Audience not found');
}
/** Make an audience (no id) or change the fields sent. */
export async function saveAudience(c: PoolClient, audienceId: string | null, b: Row): Promise<PrAudience> {
  const old = audienceId ? await getAudience(c, audienceId) : null;
  const name = has(b, 'name') ? line(b.name, 80) : old?.name ?? '';
  if (!name) fail(400, 'Name the audience (for example "Testers" or "Clients")');
  const tone = has(b, 'tone') ? oneOf(b.tone, TONES, 'a tone') : old?.tone ?? 'warm';
  const channel = has(b, 'channel') ? oneOf(b.channel, CHANNELS, 'a channel') : old?.channel ?? 'whatsapp';
  const ratio = has(b, 'ratio') ? oneOf(b.ratio, RATIOS, 'an image shape') : old?.ratio ?? '1:1';
  const note = has(b, 'note') ? line(b.note, 500) : old?.note ?? '';
  const archived = has(b, 'archived') ? b.archived === true : old?.archived ?? false;
  if ((await c.query('select 1 from pulse.pr_audience where lower(name)=lower($1) and id is distinct from $2', [name, old?.id ?? null])).rowCount) fail(409, 'An audience has that name already');
  const r = old
    ? await c.query('update pulse.pr_audience set name=$2,tone=$3,channel=$4,ratio=$5,note=$6,archived=$7 where id=$1 returning id', [old.id, name, tone, channel, ratio, note, archived])
    : await c.query(`insert into pulse.pr_audience(org_id,name,tone,channel,ratio,note,created_by) values(pulse.current_org(),$1,$2,$3,$4,$5,pulse.current_viewer()) returning id`,
      [name, tone, channel, ratio, note]);
  return getAudience(c, r.rows[0].id);
}

// ------------------------------------------------------------------------------------------------ drafts and the calendar
export type Draft = { id: string; audienceId: string; audience: string; channel: Audience['channel']; tone: Audience['tone']; ratio: Audience['ratio']; briefId: string | null;
  entryIds: string[]; headline: string; copy: string; longPost: string; images: ImageSpec[]; status: 'draft' | 'planned' | 'posted' | 'skipped'; planOn: string | null;
  taskId: string | null; postedAt: string | null; writtenBy: 'auto' | 'ai' | 'person'; createdAt: string; updatedAt: string };
const DRAFT = `select d.id,d.audience_id "audienceId",a.name audience,a.channel,a.tone,a.ratio,d.brief_id "briefId",d.entry_ids::text[] "entryIds",d.headline,d.copy,d.long_post "longPost",
    d.images,d.status,d.plan_on::text "planOn",d.task_id "taskId",d.posted_at::text "postedAt",d.written_by "writtenBy",d.created_at::text "createdAt",d.updated_at::text "updatedAt"
  from pulse.pr_draft d join pulse.pr_audience a on a.id=d.audience_id`;
const IMAGE_TEMPLATES = ['headline', 'list', 'number'] as const;
const imagesOut = (v: unknown): ImageSpec[] => (Array.isArray(v) ? v : []).slice(0, 3).map((x: Row) => ({ template: IMAGE_TEMPLATES.includes(x.template as never) ? x.template as ImageSpec['template'] : 'headline',
  ratio: RATIOS.includes(x.ratio as never) ? x.ratio as ImageSpec['ratio'] : '1:1', kicker: String(x.kicker ?? ''), title: String(x.title ?? ''),
  lines: Array.isArray(x.lines) ? x.lines.slice(0, 6).map(String) : [], big: x.big === null || x.big === undefined ? null : String(x.big) }));
const draftOut = (r: Row): Draft => ({ id: String(r.id), audienceId: String(r.audienceId), audience: String(r.audience), channel: r.channel as Draft['channel'], tone: r.tone as Draft['tone'],
  ratio: r.ratio as Draft['ratio'], briefId: (r.briefId as string) ?? null, entryIds: (r.entryIds as string[]) ?? [], headline: String(r.headline), copy: String(r.copy),
  longPost: String(r.longPost), images: imagesOut(r.images), status: r.status as Draft['status'], planOn: (r.planOn as string) ?? null, taskId: (r.taskId as string) ?? null,
  postedAt: (r.postedAt as string) ?? null, writtenBy: r.writtenBy as Draft['writtenBy'], createdAt: String(r.createdAt), updatedAt: String(r.updatedAt) });
export const DRAFT_STATUSES = ['draft', 'planned', 'posted', 'skipped'] as const;
export async function listDrafts(c: PoolClient, f: { status?: string; from?: string; to?: string; after?: string | null; take?: number } = {}): Promise<Draft[]> {
  return (await c.query(`${DRAFT} where ($1::text is null or d.status=$1) and ($2::date is null or d.plan_on>=$2) and ($3::date is null or d.plan_on<=$3) and ($4::uuid is null or d.id>$4)
    order by ${f.after !== undefined ? 'd.id' : 'd.plan_on nulls first,d.updated_at desc'} limit $5`,
  [f.status ?? null, f.from ?? null, f.to ?? null, f.after ?? null, Math.min(Math.max(f.take ?? 200, 1), 500)])).rows.map(draftOut);
}
export async function getDraft(c: PoolClient, draftId: string): Promise<Draft> {
  const r = (await c.query(`${DRAFT} where d.id=$1`, [id(draftId, 'Draft')])).rows[0];
  return r ? draftOut(r) : fail(404, 'Draft not found');
}
/** A creative pack for one audience from Story lines (entryIds), a brief (briefId), or, with neither, everything done
 *  but not yet told. The words come from pr-copy.ts; edit them after, or let an AI employee rewrite them. */
export async function createDraft(c: PoolClient, b: Row, by: 'auto' | 'ai' | 'person' = 'auto'): Promise<Draft> {
  const audience = await getAudience(c, String(b.audienceId ?? ''));
  const briefId = b.briefId ? id(b.briefId, 'Brief') : null;
  let entryIds = ids(b.entryIds, 'entryIds');
  if (!entryIds.length && briefId) entryIds = (await c.query('select entry_ids::text[] e from pulse.pr_brief where id=$1', [briefId])).rows[0]?.e ?? fail(404, 'Brief not found');
  const entries = entryIds.length ? (await c.query(`${ENTRY} where id=any($1::uuid[]) and not hidden`, [entryIds])).rows.map(entryOut)
    : await listStory(c, { untold: true, take: 30 });
  if (!entries.length) fail(400, 'Nothing to tell yet: add a line to the Story first');
  const k = await clock(c);
  const p = composePack(entries, audience, k.company);
  const headline = line(b.headline, 160) || p.headline, copy = block(b.copy, 4000) || p.copy, longPost = block(b.longPost, 8000) || p.longPost;
  const r = await c.query(`insert into pulse.pr_draft(org_id,audience_id,brief_id,entry_ids,headline,copy,long_post,images,written_by,created_by)
    values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,pulse.current_viewer()) returning id`,
  [audience.id, briefId, entries.map(e => e.id), headline, copy, longPost, JSON.stringify(p.images), b.headline || b.copy || b.longPost ? by === 'auto' ? 'person' : by : 'auto']);
  const d = await getDraft(c, r.rows[0].id);
  return b.planOn ? updateDraft(c, d.id, { planOn: b.planOn }, by) : d;
}
async function savepoint<T>(c: PoolClient, f: () => Promise<T>): Promise<T | null> {
  await c.query('savepoint pr_task');
  try { const v = await f(); await c.query('release savepoint pr_task'); return v; }
  catch { await c.query('rollback to savepoint pr_task'); return null; }
}
/** Change a draft: its words, the day it is planned for (a person gets a task "Post … to …" on that day, moved with it),
 *  or its status (posted marks its Story lines told and closes the task; skipped closes the task without telling). */
export async function updateDraft(c: PoolClient, draftId: string, b: Row, by: 'auto' | 'ai' | 'person' = 'person'): Promise<Draft> {
  const old = await getDraft(c, draftId);
  const headline = has(b, 'headline') ? line(b.headline, 160) || fail(400, 'Give the draft a headline') : old.headline;
  const copy = has(b, 'copy') ? block(b.copy, 4000) : old.copy;
  const longPost = has(b, 'longPost') ? block(b.longPost, 8000) : old.longPost;
  const planOn = has(b, 'planOn') ? (b.planOn === null || b.planOn === '' ? null : day(b.planOn, 'The day to post')) : old.planOn;
  let status = has(b, 'status') ? oneOf(b.status, DRAFT_STATUSES, 'a status') : old.status;
  if (status === 'draft' && planOn && !has(b, 'status')) status = 'planned';
  if (status === 'planned' && !planOn) status = 'draft';
  const words = headline !== old.headline || copy !== old.copy || longPost !== old.longPost;
  let taskId = old.taskId;
  const k = await clock(c);
  // The task on My day: only a person gets one (an AI employee plans; the person posts).
  if (planOn && status === 'planned' && k.side === 'staff') {
    const fields = { title: `Post “${headline.slice(0, 120)}” to ${old.audience}`, notes: `From PR Studio: copy the text and image from /pr?tab=drafts&draft=${old.id}, then send it yourself.`, dueOn: planOn };
    if (taskId) await savepoint(c, () => c.query('select pulse.task_save($1,$2)', [taskId, JSON.stringify({ title: fields.title, dueOn: planOn })]));
    else taskId = await savepoint(c, async () => String((await c.query('select pulse.task_save(null,$1) id', [JSON.stringify(fields)])).rows[0].id));
  }
  if (taskId && (status === 'posted' || status === 'skipped') && old.status !== status) await savepoint(c, () => c.query(`select pulse.task_move($1,$2)`, [taskId, status === 'posted' ? 'done' : 'cancelled']));
  await c.query(`update pulse.pr_draft set headline=$2,copy=$3,long_post=$4,plan_on=$5,status=$6,task_id=$7,
      posted_at=case when $6='posted' then coalesce(posted_at,now()) else null end,written_by=case when $8 then $9 else written_by end where id=$1`,
  [old.id, headline, copy, longPost, planOn, status, taskId, words, by === 'auto' ? 'person' : by]);
  if (status === 'posted' && old.status !== 'posted' && old.entryIds.length) await c.query('update pulse.pr_story set told_at=coalesce(told_at,now()) where id=any($1::uuid[])', [old.entryIds]);
  return getDraft(c, old.id);
}

// ------------------------------------------------------------------------------------------------ the dashboard
export async function dashboard(c: PoolClient, month?: string) {
  await autoBriefs(c);
  const k = await clock(c);
  const m = month && /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : `${k.today.slice(0, 7)}-01`;
  const from = addDays(m, -7), to = addDays(m, 45);
  const days = await toldDays(c);
  const last30 = days.filter(d => d > addDays(k.today, -30)).length;
  const active = (await c.query(`select count(distinct happened_on)::int n from pulse.pr_story where not hidden and happened_on>$1`, [addDays(k.today, -30)])).rows[0].n;
  return { today: k.today, company: k.company, month: m.slice(0, 7), briefs: await listBriefs(c, { take: 12 }),
    waiting: (await listDrafts(c, { take: 100 })).filter(d => d.status === 'draft' || (d.status === 'planned' && (d.planOn ?? '') <= k.today)),
    calendar: await listDrafts(c, { from, to, take: 500 }), untold: await listStory(c, { untold: true, take: 50 }), untoldCount: await untoldCount(c),
    audiences: await listAudiences(c), streak: streak(days, k.today), toldLast30: last30, activeDaysLast30: Number(active), toldToday: days.includes(k.today),
    agents: PR_AGENTS.map(a => ({ key: a.key, name: a.name, title: a.title, lane: a.lane, duty: a.duty })),
    // The PR team's templates already added as AI employees (by title), and who would own a new one (the viewer).
    hired: await savepoint(c, async () => (await c.query(`select distinct lower(m.title) t from pulse.agent_member m join pulse.person p on p.id=m.person_id where p.status='active'`)).rows.map(r => String(r.t))) ?? [],
    me: k.side === 'staff' ? (await c.query('select pulse.current_viewer() v')).rows[0].v as string : null,
    voice: process.env.PULSE_ELEVENLABS_KEY && process.env.PULSE_PR_VOICE === '1' ? 'on' : 'off' };
}

// ------------------------------------------------------------------------------------------------ screens
type Body = Record<string, unknown>;
const body = { type: 'object' } as const;
export function registerPrRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const gated = <T>(req: Parameters<Tx>[0], f: (c: PoolClient) => Promise<T>) => tx(req, async c => { await prGate(c); return f(c); });
  app.get<{ Querystring: Record<string, string> }>('/api/v0/pr', req => gated(req, c => dashboard(c, req.query.month)));
  app.get<{ Querystring: Record<string, string> }>('/api/v0/pr/story', req => gated(req, async c => {
    const k = await clock(c);
    const to = req.query.to && DAY.test(req.query.to) ? req.query.to : k.today, from = req.query.from && DAY.test(req.query.from) ? req.query.from : addDays(to, -62);
    return story(c, from, to);
  }));
  app.post<{ Body: Body }>('/api/v0/pr/story', { schema: { body } }, req => gated(req, async c => ({ entry: await getEntry(c, await addEntry(c, req.body ?? {})) })));
  app.post<{ Body: Body }>('/api/v0/pr/story/collect', { schema: { body } }, req => gated(req, async c => {
    const k = await clock(c), b = req.body ?? {};
    return { added: await collect(c, b.from ? String(b.from) : addDays(k.today, -30), b.to ? String(b.to) : k.today) };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/story/:id', { schema: { body } }, req => gated(req, async c => ({ entry: await updateEntry(c, req.params.id, req.body ?? {}) })));
  app.post<{ Body: Body }>('/api/v0/pr/chapters', { schema: { body } }, req => gated(req, async c => ({ chapter: await saveChapter(c, req.body ?? {}) })));
  app.get('/api/v0/pr/briefs', req => gated(req, async c => ({ briefs: await listBriefs(c, { take: 60 }) })));
  app.post<{ Body: Body }>('/api/v0/pr/briefs', { schema: { body } }, req => gated(req, async c => ({ brief: await writeBrief(c, req.body ?? {}, 'person') })));
  app.get('/api/v0/pr/audiences', req => gated(req, async c => ({ audiences: await listAudiences(c, true) })));
  app.post<{ Body: Body }>('/api/v0/pr/audiences', { schema: { body } }, req => gated(req, async c => ({ audience: await saveAudience(c, null, req.body ?? {}) })));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/audiences/:id', { schema: { body } }, req => gated(req, async c => ({ audience: await saveAudience(c, req.params.id, req.body ?? {}) })));
  app.post<{ Body: Body }>('/api/v0/pr/drafts', { schema: { body } }, req => gated(req, async c => ({ draft: await createDraft(c, req.body ?? {}) })));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/pr/drafts/:id', { schema: { body } }, req => gated(req, async c => ({ draft: await updateDraft(c, req.params.id, req.body ?? {}) })));
}
