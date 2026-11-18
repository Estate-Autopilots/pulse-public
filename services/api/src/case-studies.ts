// CASE-STUDIES (owner, 10 Nov 2026): Growth → Case studies. Each company in the founders'-circle journey has a case
// file that follows the same 8 stages (case-studies-model.ts) and links to what Vitals already keeps: Meetings (talks,
// podcasts, transcripts), Docs (the offer, the published story), Goals, Clients, projects and AI employees. A link holds
// only the record's id; its name is read live, under the viewer's own row security, so nothing is copied.
// Module `case_studies` is organisation-only (modules.ts ORG_ONLY): on in the Vitals organisation (migration 1966).
// Leaders and admins only (row security); these routes say so in words first.
// Also GET /api/v0/goals/suggestions: suggested monthly targets for any company from its own Finance (revenue, as
// Finance → Numbers counts it), Billing (new paying clients) and Leads, with the same typed rules (no LLM).
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, leadership, type Tx, type Viewer } from './routes.js';
import { orgZone, zoneDay } from './org-time.js';
import { saveDoc } from './docs.js';
import { saveGoal } from './goals.js';
import { buildNumbers, type NumbersRaw } from './finance-truth-model.js';
import { CHECK_IDS, ENGINE, MOVES, PROBLEMS, STAGES, STAGE_COUNT, journeyDay, nextStep, rupees, seriesOf, stageChecks, stageDone, suggestAll,
  type CaseMonth, type Checks, type Metric, type MonthValue, type Suggestion } from './case-studies-model.js';

type Row = Record<string, unknown>;
const body = { type: 'object', maxProperties: 30 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const LINK_KINDS = ['meeting', 'doc', 'goal', 'client', 'project', 'ai_employee'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
const NUMBERS_FROM = ['owner', 'export', 'finance', 'workbench'] as const;
const has = (b: Row, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const str = (x: unknown, max: number) => [...String(x ?? '')].map((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch).join('').trim().slice(0, max);
const caseId = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(404, 'Case study not found');
const lead = (v: Viewer) => { if (!leadership(v) || !v.person) fail(403, 'Only leaders and admins see case studies.'); };
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const numOrNull = (x: unknown, what: string) => {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? Math.round(n * 100) / 100 : fail(400, `${what} must be a number of 0 or more`);
};
const tagList = (x: unknown, allowed: readonly string[], what: string) => Array.isArray(x)
  ? [...new Set(x.map(String))].map((t) => allowed.includes(t) ? t : fail(400, `Choose ${what} from the list`)).slice(0, 8) : fail(400, `Choose ${what}`);

/** Typed months from the screen: unique YYYY-MM, numbers of 0 or more, up to 24. */
export function monthsFrom(x: unknown): CaseMonth[] {
  if (!Array.isArray(x)) fail(400, 'Send the months as a list');
  const rows = (x as unknown[]).slice(0, 24).map((r) => {
    const m = (r ?? {}) as Row; const month = String(m.month ?? '');
    if (!MONTH.test(month)) fail(400, 'Each month is written YYYY-MM');
    return { month, revenue: numOrNull(m.revenue, 'Revenue'), clients: numOrNull(m.clients, 'New clients'), leads: numOrNull(m.leads, 'Leads') };
  });
  if (new Set(rows.map((r) => r.month)).size !== rows.length) fail(400, 'Each month only once');
  return rows.sort((a, b) => a.month.localeCompare(b.month));
}

const LIST = `select s.id, s.name, s.sector, s.aim, s.stage, s.started_on::text "startedOn", s.checks, s.published_at "publishedAt",
    s.story_doc_id "storyDocId", s.updated_at "updatedAt", p.display_name "leadName",
    (select count(*)::int from pulse.case_study_link l where l.case_id = s.id) links
  from pulse.case_study s left join pulse.person p on p.id = s.lead_person_id`;

function card(r: Row, today: string) {
  const stage = Number(r.stage), checks = (r.checks ?? {}) as Checks;
  const done = CHECK_IDS.filter((id) => checks[id] === true).length;
  return { id: String(r.id), name: String(r.name), sector: r.sector ? String(r.sector) : null, aim: String(r.aim ?? ''), stage, finished: stage > STAGE_COUNT,
    stageLabel: STAGES[Math.min(stage, STAGE_COUNT) - 1].label, ...journeyDay(String(r.startedOn), today), next: stage > STAGE_COUNT ? null : nextStep(stage, checks),
    checksDone: done, checksTotal: CHECK_IDS.length, published: !!r.publishedAt, storyDocId: r.storyDocId ?? null, leadName: r.leadName ?? null, links: r.links ?? 0 };
}

/** The live names of linked records, read under the viewer's own row security (a record they cannot see says so). */
// LAND-CAPTAIN-10: meetings are read only through the meetings module's own functions (pulse_api has no access to
// pulse.meeting itself: recordings are consent-bound): meeting_view (null where the viewer may not see it), meeting_list,
// meeting_can. Reading the table here answered 42501 and the case file did not load.
async function linksOf(c: PoolClient, id: string) {
  const rows = (await c.query(`select l.id, l.kind, l.ref_id "refId", l.note, l.created_at "createdAt",
      case l.kind
        when 'meeting' then (select pulse.meeting_view(l.ref_id) ->> 'title')
        when 'doc' then (select d.title from pulse.doc d where d.id = l.ref_id)
        when 'goal' then (select g.title from pulse.goal g where g.id = l.ref_id)
        when 'client' then (select cl.display_name from pulse.client cl where cl.id = l.ref_id)
        when 'project' then (select pr.name from pulse.project pr where pr.id = l.ref_id)
        when 'ai_employee' then (select pe.display_name from pulse.person pe where pe.id = l.ref_id and pe.side = 'agent')
      end title,
      case l.kind when 'meeting' then (select pulse.meeting_view(l.ref_id) ->> 'startedAt') end "when"
    from pulse.case_study_link l where l.case_id = $1 order by l.kind, l.created_at`, [id])).rows;
  return rows.map((r) => ({ ...r, title: r.title ?? null, missing: r.title === null || r.title === undefined }));
}

const HREF: Record<LinkKind, (id: string) => string> = {
  meeting: (id) => `/meetings/${id}`, doc: (id) => `/docs/${id}`, goal: (id) => `/goals/${id}`, client: (id) => `/clients/${id}`,
  project: (id) => `/projects/${id}`, ai_employee: (id) => `/people/ai?person=${id}`,
};

async function caseFile(c: PoolClient, id: string) {
  const today = zoneDay(await orgZone(c));
  const r = (await c.query(`select s.*, s.started_on::text "startedOn", s.published_at "publishedAt", s.story_doc_id "storyDocId", s.client_id "clientId",
      s.numbers_from "numbersFrom", p.display_name "leadName", cl.display_name "clientName", d.title "storyTitle"
    from pulse.case_study s left join pulse.person p on p.id = s.lead_person_id left join pulse.client cl on cl.id = s.client_id
    left join pulse.doc d on d.id = s.story_doc_id where s.id = $1`, [id])).rows[0] ?? fail(404, 'Case study not found');
  const checks = (r.checks ?? {}) as Checks, months = (r.months ?? []) as CaseMonth[];
  const links = (await linksOf(c, id)).map((l) => ({ ...l, href: HREF[l.kind as LinkKind](String(l.refId)) }));
  return {
    ...card({ ...r, links: links.length }, today),
    problems: r.problems ?? [], moves: r.moves ?? [], pains: r.pains ?? [], months, numbersFrom: r.numbersFrom, after: r.after ?? {},
    clientId: r.clientId ?? null, clientName: r.clientName ?? null, storyTitle: r.storyTitle ?? null,
    stages: STAGES.map((s) => ({ n: s.n, key: s.key, label: s.label, what: s.what, checks: stageChecks(s, checks), done: stageDone(s, checks) })),
    links, suggestions: suggestAll(seriesOf(months)),
    lists: { problems: PROBLEMS, moves: MOVES },
  };
}

/** Last 12 full months (oldest first) in the company's calendar, as YYYY-MM. */
export function lastMonths(today: string, n = 12): string[] {
  const [y, m] = today.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(y, m - 1 - (n - i), 1)); return d.toISOString().slice(0, 7); });
}

/** The company's own monthly numbers for Goals' suggestions; each part is read only if the viewer may read it. */
async function companySeries(c: PoolClient) {
  const today = zoneDay(await orgZone(c)), months = lastMonths(today), from = `${months[0]}-01`, to = `${months[months.length - 1]}-01`;
  const fill = (rows: { m: string; v: number }[]): MonthValue[] => { const by = new Map(rows.map((r) => [r.m, Number(r.v)])); return months.map((m) => ({ month: m, value: by.get(m) ?? 0 })); };
  const read: Record<Metric, 'yes' | 'no_access'> = { revenue: 'no_access', clients: 'no_access', leads: 'no_access' };
  const series: Record<Metric, MonthValue[]> = { revenue: [], clients: [], leads: [] };
  // Revenue: Finance → Numbers' own count (net of GST, in the month the money arrived). Finance is for leadership and the Finance role.
  await c.query('savepoint cs_fin');
  try {
    const raw = (await c.query('select pulse.finance_numbers($1,$2) n', [from, to])).rows[0].n as NumbersRaw;
    const built = buildNumbers(raw, {});
    series.revenue = fill(built.months.map((m) => ({ m: m.month, v: Math.round(m.revenue / 100) })));
    read.revenue = 'yes';
    await c.query('release savepoint cs_fin');
  } catch (e) {
    await c.query('rollback to savepoint cs_fin');
    if ((e as { code?: string }).code !== '42501') throw e;
  }
  // New clients: each client's first payment in Billing (as a goal filled from "clients who paid"); Billing readers only.
  if ((await c.query('select pulse.erp_can(false) ok')).rows[0]?.ok === true) {
    series.clients = fill((await c.query(`select to_char(f, 'YYYY-MM') m, count(*)::int v from (
        select min(p.received_on) f from pulse.erp_payment p join pulse.erp_document d on d.id = p.document_id and d.org_id = p.org_id
        where p.voided_at is null and d.client_id is not null group by d.client_id) x where f between $1::date and ($2::date + interval '1 month - 1 day') group by 1`, [from, to])).rows);
    read.clients = 'yes';
  }
  // Leads: enquiries in Leads (not hiring), as far as row security lets this person see them.
  await c.query('savepoint cs_leads');
  try {
    series.leads = fill((await c.query(`select to_char(l.created_at at time zone pulse.org_time_zone(), 'YYYY-MM') m, count(*)::int v from pulse.lead l
        where l.kind <> 'hiring' and l.created_at >= ($1::date at time zone pulse.org_time_zone()) and l.created_at < (($2::date + interval '1 month') at time zone pulse.org_time_zone())
        group by 1`, [from, to])).rows);
    read.leads = 'yes';
    await c.query('release savepoint cs_leads');
  } catch (e) {
    await c.query('rollback to savepoint cs_leads');
    if ((e as { code?: string }).code !== '42501') throw e;
  }
  // Months before the company's first number are not zero months: they did not exist in Vitals yet.
  for (const k of ['revenue', 'clients', 'leads'] as const) {
    const first = series[k].findIndex((x) => (x.value ?? 0) > 0);
    series[k] = first < 0 ? [] : series[k].slice(first);
  }
  return { today, months, read, series };
}

/** A goal from a suggestion: a company goal for the month a year from now, its number typed by hand each month. */
export function goalBody(s: Suggestion, who: string | null, today: string) {
  if (s.verdict === 'need_data' || s.low === null || s.high === null || s.baseline === null) fail(400, 'There are not enough numbers to suggest a goal yet');
  const [y, m] = today.split('-').map(Number), end = new Date(Date.UTC(y + 1, m, 0)).toISOString().slice(0, 10);
  const what = s.metric === 'revenue' ? `Revenue of ${rupees(s.low!)}–${rupees(s.high!)} a month` : s.metric === 'clients' ? `${s.low}–${s.high} new clients a month` : `${s.low}–${s.high} leads a month`;
  return { level: 'company', title: (who ? `${who}: ${what}` : what).slice(0, 160), kind: s.metric === 'revenue' ? 'money' : s.metric === 'clients' ? 'clients' : 'count',
    measureLabel: s.metric === 'revenue' ? '₹ a month' : s.metric === 'clients' ? 'new clients a month' : 'leads a month', startValue: s.baseline, targetValue: s.high, targetOn: end,
    why: `Suggested from the numbers (${ENGINE}): ${s.reasons.join(' ')}`.slice(0, 2000) };
}

function storyHtml(f: Awaited<ReturnType<typeof caseFile>>) {
  const first = f.months[0], last = f.months[f.months.length - 1], after = f.after as Row;
  const row = (label: string, before: unknown, now: unknown, fmt: (n: number) => string) => `<tr><td>${label}</td><td>${typeof before === 'number' ? fmt(before) : '—'}</td><td>${typeof now === 'number' ? fmt(now) : '—'}</td></tr>`;
  const base = (k: 'revenue' | 'clients' | 'leads') => { const xs = f.months.slice(-3).map((m) => m[k]).filter((v): v is number => typeof v === 'number'); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  return [`<h1>${esc(f.name)}: the case study</h1>`,
    `<p><em>Draft. Fill in each part in plain words, then ask ${esc(f.name)} to read it and say yes before anyone else sees it.</em></p>`,
    `<h2>The result in one line</h2><p>${esc(f.aim || 'What changed, with the number before and after.')}</p>`,
    `<h2>The business</h2><p>${esc(f.sector ? `Sector: ${f.sector}.` : 'Sector:')} Who they are, who they sell to, how big the team is.</p>`,
    `<h2>The problem</h2><ul>${(f.pains as string[]).length ? (f.pains as string[]).map((p) => `<li>${esc(p)}</li>`).join('') : '<li>The pain points from our talks.</li>'}</ul>`,
    `<h2>What we did</h2><ul>${(f.moves as string[]).length ? (f.moves as string[]).map((p) => `<li>${esc(p)}</li>`).join('') : '<li>The steps we took, in order.</li>'}</ul>`,
    `<h2>The numbers</h2><table><thead><tr><th>Measure</th><th>Before${first ? ` (${esc(first.month)} to ${esc(last.month)})` : ''}</th><th>After 45 days</th></tr></thead><tbody>`,
    row('Revenue a month', base('revenue'), after.revenue, rupees), row('New clients a month', base('clients'), after.clients, (n) => String(Math.round(n))),
    row('Leads a month', base('leads'), after.leads, (n) => String(Math.round(n))), '</tbody></table>',
    `<h2>In their words</h2><blockquote>A line from the owner, from a podcast clip.</blockquote>`,
    `<h2>Sources</h2><ul>${f.links.filter((l) => !l.missing).map((l) => `<li>${esc(l.kind === 'ai_employee' ? 'AI employee' : l.kind)}: ${esc(String(l.title))}</li>`).join('') || '<li>The meetings, docs and numbers behind each claim.</li>'}</ul>`,
  ].join('');
}

export function registerCaseStudyRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/case-studies', (req) => tx(req, async (c, v) => {
    lead(v);
    const today = zoneDay(await orgZone(c));
    const rows = (await c.query(`${LIST} order by s.stage, s.sort, s.name`)).rows.map((r) => card(r, today));
    return { cases: rows, stages: STAGES.map((s) => ({ n: s.n, key: s.key, label: s.label, what: s.what })), today };
  }));

  app.post<{ Body: Row }>('/api/v0/case-studies', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const b = req.body ?? {};
    const name = str(b.name, 120) || fail(400, 'Write the company or owner\'s name');
    const today = zoneDay(await orgZone(c));
    const r = await c.query(`insert into pulse.case_study(org_id, name, sector, aim, started_on, lead_person_id, sort)
      values (pulse.current_org(), $1, $2, $3, $4, $5, coalesce((select max(sort) + 1 from pulse.case_study), 0)) returning id`,
      [name, str(b.sector, 60) || null, str(b.aim, 300), today, v.person]);
    return { id: r.rows[0].id };
  }));

  // What a case file can link to, newest first, read under the viewer's own row security.
  app.get<{ Querystring: { kind?: string; q?: string } }>('/api/v0/case-studies/link-options', (req) => tx(req, async (c, v) => {
    lead(v);
    const kind = (LINK_KINDS as readonly string[]).includes(String(req.query.kind)) ? req.query.kind as LinkKind : fail(400, 'Choose what to link');
    const q = `%${str(req.query.q, 60).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const SQL: Record<LinkKind, string> = {
      meeting: `select x->>'id' id, x->>'title' title, x->>'startedAt' "when" from jsonb_array_elements(pulse.meeting_list()) x where x->>'title' ilike $1 limit 20`,
      doc: `select id, title, updated_at::text "when" from pulse.doc where title ilike $1 order by updated_at desc limit 20`,
      goal: `select id, title, created_at::text "when" from pulse.goal where title ilike $1 order by created_at desc limit 20`,
      client: `select id, display_name title, null "when" from pulse.client where display_name ilike $1 order by display_name limit 20`,
      project: `select id, name title, null "when" from pulse.project where name ilike $1 order by name limit 20`,
      ai_employee: `select id, display_name title, null "when" from pulse.person where side = 'agent' and display_name ilike $1 order by display_name limit 20`,
    };
    return { kind, options: (await c.query(SQL[kind], [q])).rows };
  }));

  app.get<{ Params: { id: string } }>('/api/v0/case-studies/:id', (req) => tx(req, async (c, v) => {
    lead(v);
    return { case: await caseFile(c, caseId(req.params.id)) };
  }));

  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/case-studies/:id', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const id = caseId(req.params.id), b = req.body ?? {}; const cols: [string, unknown][] = [];
    if (has(b, 'name')) cols.push(['name', str(b.name, 120) || fail(400, 'Write the company or owner\'s name')]);
    if (has(b, 'sector')) cols.push(['sector', str(b.sector, 60) || null]);
    if (has(b, 'aim')) cols.push(['aim', str(b.aim, 300)]);
    if (has(b, 'problems')) cols.push(['problems', tagList(b.problems, PROBLEMS, 'problems')]);
    if (has(b, 'moves')) cols.push(['moves', tagList(b.moves, MOVES, 'what we did')]);
    if (has(b, 'pains')) cols.push(['pains', JSON.stringify(Array.isArray(b.pains) ? b.pains.map((p) => str(p, 200)).filter(Boolean).slice(0, 10) : fail(400, 'Send the pain points as a list'))]);
    if (has(b, 'months')) cols.push(['months', JSON.stringify(monthsFrom(b.months))]);
    if (has(b, 'numbersFrom')) cols.push(['numbers_from', (NUMBERS_FROM as readonly string[]).includes(String(b.numbersFrom)) ? String(b.numbersFrom) : fail(400, 'Choose where the numbers came from')]);
    if (has(b, 'after')) {
      const a = (b.after ?? {}) as Row;
      cols.push(['after', JSON.stringify({ revenue: numOrNull(a.revenue, 'Revenue'), clients: numOrNull(a.clients, 'New clients'), leads: numOrNull(a.leads, 'Leads'), note: str(a.note, 300) })]);
    }
    if (has(b, 'clientId')) {
      const cid = b.clientId === null || b.clientId === '' ? null : UUID.test(String(b.clientId)) ? String(b.clientId) : fail(400, 'Choose a client');
      if (cid && !(await c.query('select 1 from pulse.client where id = $1', [cid])).rowCount) fail(400, 'That client is not one you can see');
      cols.push(['client_id', cid]);
    }
    if (!cols.length) fail(400, 'Choose what to change');
    const casts: Record<string, string> = { problems: '::text[]', moves: '::text[]', pains: '::jsonb', months: '::jsonb', after: '::jsonb' };
    const r = await c.query(`update pulse.case_study set ${cols.map(([col], i) => `${col} = $${i + 2}${casts[col] ?? ''}`).join(', ')}, updated_at = now() where id = $1 returning id`,
      [id, ...cols.map(([, x]) => x)]);
    if (!r.rowCount) fail(404, 'Case study not found');
    return { case: await caseFile(c, id) };
  }));

  // Tick or untick one checklist item.
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/case-studies/:id/check', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const id = caseId(req.params.id), b = req.body ?? {};
    const item = CHECK_IDS.includes(String(b.item)) ? String(b.item) : fail(400, 'Choose a step');
    const r = await c.query(`update pulse.case_study set checks = case when $3 then checks || jsonb_build_object($2::text, true) else checks - $2::text end, updated_at = now()
      where id = $1 returning id`, [id, item, b.done === true]);
    if (!r.rowCount) fail(404, 'Case study not found');
    return { case: await caseFile(c, id) };
  }));

  // Move to another stage: forward only when every step of the stages before it is done; back any time.
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/case-studies/:id/stage', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const id = caseId(req.params.id), b = req.body ?? {};
    const to = Number(b.to); if (!Number.isInteger(to) || to < 1 || to > STAGE_COUNT + 1) fail(400, 'Choose a stage');
    const row = (await c.query('select stage, checks from pulse.case_study where id = $1 for update', [id])).rows[0] ?? fail(404, 'Case study not found');
    if (to > Number(row.stage)) {
      const open = STAGES.slice(0, to - 1).find((s) => !stageDone(s, (row.checks ?? {}) as Checks));
      if (open) fail(409, `Finish the steps of "${open.label}" first`);
    }
    await c.query('update pulse.case_study set stage = $2, updated_at = now() where id = $1', [id, to]);
    return { case: await caseFile(c, id) };
  }));

  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/case-studies/:id/links', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const id = caseId(req.params.id), b = req.body ?? {};
    const kind = (LINK_KINDS as readonly string[]).includes(String(b.kind)) ? String(b.kind) as LinkKind : fail(400, 'Choose what to link');
    const ref = UUID.test(String(b.refId)) ? String(b.refId) : fail(400, 'Choose a record to link');
    const SEE: Record<LinkKind, string> = { meeting: 'pulse.meeting', doc: 'pulse.doc', goal: 'pulse.goal', client: 'pulse.client', project: 'pulse.project', ai_employee: 'pulse.person' };
    const sees = kind === 'meeting' ? 'select 1 where pulse.meeting_can($1::uuid)'
      : `select 1 from ${SEE[kind]} where id = $1${kind === 'ai_employee' ? " and side = 'agent'" : ''}`;
    if (!(await c.query(sees, [ref])).rowCount) fail(400, 'That record is not one you can see');
    if (!(await c.query('select 1 from pulse.case_study where id = $1', [id])).rowCount) fail(404, 'Case study not found');
    await c.query(`insert into pulse.case_study_link(org_id, case_id, kind, ref_id, note, created_by) values (pulse.current_org(), $1, $2, $3, $4, $5)
      on conflict (case_id, kind, ref_id) do update set note = excluded.note`, [id, kind, ref, str(b.note, 200), v.person]);
    if (kind === 'client') await c.query('update pulse.case_study set client_id = coalesce(client_id, $2), updated_at = now() where id = $1', [id, ref]);
    return { case: await caseFile(c, id) };
  }));

  app.post<{ Params: { id: string; linkId: string } }>('/api/v0/case-studies/:id/links/:linkId/remove', (req) => tx(req, async (c, v) => {
    lead(v); const id = caseId(req.params.id);
    if (!UUID.test(req.params.linkId)) fail(404, 'Link not found');
    const r = await c.query('delete from pulse.case_study_link where id = $2 and case_id = $1', [id, req.params.linkId]);
    if (!r.rowCount) fail(404, 'Link not found');
    return { case: await caseFile(c, id) };
  }));

  // Start the published story: a Doc with the case-study outline (headline result, business, problem, what we did, the
  // numbers before and after, their words, sources), filled from the case file and linked to it. It stays private to
  // its writer until they share it, and it counts as published only when they say so (the owner's OK is step 8.4).
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/case-studies/:id/story', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const id = caseId(req.params.id), b = req.body ?? {};
    const f = await caseFile(c, id);
    if (b.publish === true || b.publish === false) {
      if (!f.storyDocId) fail(409, 'Write the story first');
      await c.query('update pulse.case_study set published_at = case when $2 then coalesce(published_at, now()) else null end, updated_at = now() where id = $1', [id, b.publish === true]);
      return { case: await caseFile(c, id) };
    }
    if (f.storyDocId && f.storyTitle !== null) return { docId: f.storyDocId, case: f };
    const docId = await saveDoc(c, null, { title: `${f.name}: the case study`.slice(0, 200), html: storyHtml(f), tags: ['case-study'], access: 'private' });
    await c.query('update pulse.case_study set story_doc_id = $2, updated_at = now() where id = $1', [id, docId]);
    await c.query(`insert into pulse.case_study_link(org_id, case_id, kind, ref_id, note, created_by) values (pulse.current_org(), $1, 'doc', $2, 'The case study', $3)
      on conflict do nothing`, [id, docId, v.person]);
    return { docId, case: await caseFile(c, id) };
  }));

  // Make a goal from one of the case's suggestions and link it.
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/case-studies/:id/goal', { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const id = caseId(req.params.id), b = req.body ?? {};
    const f = await caseFile(c, id);
    const s = f.suggestions.find((x) => x.metric === b.metric) ?? fail(400, 'Choose revenue, clients or leads');
    const goalId = await saveGoal(c, null, goalBody(s, f.name, zoneDay(await orgZone(c))));
    await c.query(`insert into pulse.case_study_link(org_id, case_id, kind, ref_id, note, created_by) values (pulse.current_org(), $1, 'goal', $2, 'Suggested goal', $3)
      on conflict do nothing`, [id, goalId, v.person]);
    return { goalId, case: await caseFile(c, id) };
  }));

  // Goals: suggested monthly targets from the company's own numbers (anyone in Goals; each part only if they may read it;
  // a company goal is then made by POST /api/v0/goals, where the database decides who may set one).
  app.get('/api/v0/goals/suggestions', (req) => tx(req, async (c) => {
    const { today, read, series } = await companySeries(c);
    const suggestions = suggestAll(series).map((s) => read[s.metric] === 'yes' ? s
      : { ...s, verdict: 'need_data' as const, reasons: [s.metric === 'revenue' ? 'Only leaders and the Finance role see revenue.' : s.metric === 'clients' ? 'Only people who can see Billing see new paying clients.' : 'You cannot see Leads.'] });
    // Each usable suggestion carries the goal it would make, so "Make it a goal" posts it to /api/v0/goals as it is.
    return { today, read, engine: ENGINE, suggestions: suggestions.map((s) => ({ ...s, goal: s.verdict === 'need_data' ? null : goalBody(s, null, today) })) };
  }));
}
