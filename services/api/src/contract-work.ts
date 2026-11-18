// CONTRACTS-3 (owner, 9 Nov 2026; SESSION-ASKS, the 7 Nov meeting C #1): what CONTRACTS-2 left open on agreements.
//   * Parties from real records: our clients and vendors (with their point of contact), a person by @handle; a company
//     on Vitals OS comes from the directory's CompanyPicker on the screen.
//   * A point of contact per party (name, phone, e-mail).
//   * Links both ways: what an agreement can link (projects, tasks, invoices) and the agreements linked to a project or task.
//   * Proposed drafts: new words proposed (here, through API v1 or MCP); nothing changes until a person uses one.
//   * What clients change: per template, the clauses clients ask to change and the ones changed in new drafts.
// Who may do what is decided in the database (contract_manager, contract_runner, 2030's functions under forced row
// security); this file shapes input and answers.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { agreementClauses, clauseName, compareClauses } from '@pulse/invoice-doc';
import { fail, type Tx } from './routes.js';
import { said } from './contract-signing.js';
import { pocInput } from './contracts.js';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const idOr404 = (x: unknown, what: string) => (UUID.test(String(x)) ? String(x) : fail(404, `${what} not found`));
const q = (v: unknown) => String(v ?? '').trim().slice(0, 120);
const like = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** A clause as people say it, without its number: "2. Price and payment" and "Price and payment" are one clause. */
export const clauseKey = (name: string) => name.replace(/^\s*\d{1,2}[.)]\s*/, '').trim().toLowerCase();

/** Our clients and vendors matching the words, each with its point of contact (billing profile, primary contact, first contact). */
export async function partyRecords(c: PoolClient, words: string) {
  const rows = (await c.query(`with hits as (
      select cl.id, coalesce(nullif(btrim(cl.company_name),''), cl.display_name) "name", 'client' "kind", cl.email, cl.phone,
        coalesce((select ep.contact_person_id from pulse.erp_party ep where ep.client_id=cl.id), cl.primary_contact_id,
          (select cc.person_id from pulse.client_contact cc where cc.client_id=cl.id order by cc.is_primary desc limit 1)) contact
      from pulse.client cl where cl.status is distinct from 'churned' and ($1 = '' or cl.display_name ilike $2 or cl.company_name ilike $2)
      union all
      select p.id, p.display_name, 'vendor', null, null, p.id from pulse.person p where p.side = 'vendor' and p.status = 'active' and ($1 = '' or p.display_name ilike $2))
    select h.id, h.name, h.kind, ct.display_name "pocName", coalesce(cp.phone, h.phone) "pocPhone", coalesce(cp.email, h.email) "pocEmail"
    from hits h left join pulse.person ct on ct.id = h.contact left join pulse.contact_profile cp on cp.person_id = h.contact
    order by h.name ilike $3 desc, h.name limit 12`, [words, like(words), `${words.replace(/[\\%_]/g, (m) => `\\${m}`)}%`])).rows;
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), kind: r.kind as 'client' | 'vendor',
    poc: { name: (r.pocName as string | null) ?? null, phone: (r.pocPhone as string | null) ?? null, email: (r.pocEmail as string | null) ?? null } }));
}

/** Per template: how many agreements, which clauses clients asked to change, and which changed in a new draft. */
export async function clauseInsights(c: PoolClient) {
  const contracts = (await c.query(`select c.id, c.body, c.status, s.template_id "templateId", t.name "templateName"
    from pulse.contract c join pulse.contract_side s on s.contract_id = c.id left join pulse.contract_template t on t.id = s.template_id
    where c.home_org = c.org_id order by c.created_at desc limit 500`)).rows;
  if (!contracts.length) return { templates: [], agreements: 0 };
  const ids = contracts.map((x) => x.id);
  const asks = (await c.query(`select contract_id, clause, body, at from pulse.contract_event where kind = 'change_asked' and contract_id = any($1) order by at`, [ids])).rows;
  const versions = (await c.query(`select contract_id, version, terms->>'body' body from pulse.contract_version where contract_id = any($1) order by contract_id, version`, [ids])).rows;
  type Clause = { name: string; asks: number; agreementsAsked: Set<string>; changed: number; lastAt: string | null; words: string[] };
  type Bucket = { id: string | null; name: string; agreements: number; asked: Set<string>; clauses: Map<string, Clause> };
  const buckets = new Map<string, Bucket>();
  const bucketOf = (x: Row) => {
    const k = String(x.templateId ?? 'none');
    if (!buckets.has(k)) buckets.set(k, { id: (x.templateId as string | null) ?? null, name: (x.templateName as string | null) ?? 'Without a template', agreements: 0, asked: new Set(), clauses: new Map() });
    return buckets.get(k)!;
  };
  const clause = (b: Bucket, name: string) => {
    const k = clauseKey(name) || 'the whole agreement';
    if (!b.clauses.has(k)) b.clauses.set(k, { name: name.replace(/^\s*\d{1,2}[.)]\s*/, '').trim() || 'The whole agreement', asks: 0, agreementsAsked: new Set(), changed: 0, lastAt: null, words: [] });
    return b.clauses.get(k)!;
  };
  const byId = new Map(contracts.map((x) => [String(x.id), x]));
  for (const x of contracts) bucketOf(x).agreements++;
  for (const a of asks) {
    const x = byId.get(String(a.contract_id)); if (!x) continue;
    const b = bucketOf(x), k = clause(b, String(a.clause ?? ''));
    k.asks++; k.agreementsAsked.add(String(a.contract_id)); b.asked.add(String(a.contract_id));
    k.lastAt = new Date(a.at).toISOString();
    if (a.body) k.words = [String(a.body).slice(0, 200), ...k.words].slice(0, 3);
  }
  // Each new draft compared with the one before it (the last with today's words): the clauses that changed.
  const drafts = new Map<string, string[]>();
  for (const v of versions) drafts.set(String(v.contract_id), [...(drafts.get(String(v.contract_id)) ?? []), String(v.body ?? '')]);
  for (const [id, list] of drafts) {
    const x = byId.get(id); if (!x) continue;
    const all = [...list, String(x.body ?? '')];
    for (let i = 1; i < all.length; i++) for (const cl of compareClauses(all[i - 1], all[i])) if (cl.status !== 'same') clause(bucketOf(x), cl.name).changed++;
  }
  const templates = [...buckets.values()].map((b) => ({ id: b.id, name: b.name, agreements: b.agreements, asked: b.asked.size,
    clauses: [...b.clauses.values()].map((k) => ({ name: k.name, asks: k.asks, agreementsAsked: k.agreementsAsked.size, changed: k.changed, lastAt: k.lastAt, words: k.words }))
      .sort((p, r) => (r.agreementsAsked - p.agreementsAsked) || (r.asks - p.asks) || (r.changed - p.changed) || p.name.localeCompare(r.name)).slice(0, 20) }))
    .sort((p, r) => (p.id ? 0 : 1) - (r.id ? 0 : 1) || r.agreements - p.agreements);
  return { templates, agreements: contracts.length };
}

/** The drafts of one agreement for API v1 / MCP: every kept draft with its words, the current one, and open proposals. */
export async function contractDrafts(c: PoolClient, id: string) {
  const cur = (await c.query('select id, version, status, title, body, updated_at from pulse.contract where id=$1', [id])).rows[0] ?? fail(404, 'Contract not found');
  const kept = (await c.query(`select version, terms->>'title' title, coalesce(terms->>'body', terms->>'scope', '') body, changed_by_name, changed_at
    from pulse.contract_version where contract_id=$1 order by version`, [id])).rows;
  const proposals = (await c.query(`select id, base_version, title, body, note, via, proposed_by_name, created_at from pulse.contract_proposal
    where contract_id=$1 and decision is null order by created_at desc`, [id])).rows;
  const clauses = (body: string) => agreementClauses(body).map((x) => clauseName(x));
  return {
    current: { version: Number(cur.version), status: String(cur.status), title: String(cur.title), body: String(cur.body ?? ''), clauses: clauses(String(cur.body ?? '')),
      changedAt: new Date(cur.updated_at).toISOString() },
    versions: kept.map((v) => ({ version: Number(v.version), title: String(v.title ?? cur.title), body: String(v.body ?? ''), clauses: clauses(String(v.body ?? '')),
      changedBy: (v.changed_by_name as string | null) ?? null, changedAt: new Date(v.changed_at).toISOString() })),
    proposals: proposals.map((x) => ({ id: String(x.id), baseVersion: Number(x.base_version), title: (x.title as string | null) ?? null, body: String(x.body),
      note: (x.note as string | null) ?? null, via: String(x.via), by: (x.proposed_by_name as string | null) ?? null, at: new Date(x.created_at).toISOString() })),
  };
}

/** Two drafts of one agreement compared clause by clause, word by word (version 0 or none: today's words). */
export async function compareDrafts(c: PoolClient, id: string, from: number, to: number | null) {
  const d = await contractDrafts(c, id);
  const words = (v: number | null) => (v === null || v === d.current.version ? d.current.body : d.versions.find((x) => x.version === v)?.body ?? fail(404, `There is no draft ${v}`));
  return { from, to: to ?? d.current.version, clauses: compareClauses(words(from), words(to)) };
}

export async function proposeDraft(c: PoolClient, id: string, b: Row, via: 'app' | 'api' | 'mcp') {
  const body = String(b.body ?? '').replace(/\r\n?/g, '\n').slice(0, 100000);
  return (await c.query('select pulse.contract_propose($1,$2,$3,$4,$5) id', [id, b.title === undefined || b.title === null ? null : String(b.title).slice(0, 160), body,
    b.note === undefined || b.note === null ? null : String(b.note).slice(0, 1000), via])).rows[0].id as string;
}

export function registerContractWorkRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const may = async (c: PoolClient) => {
    const r = (await c.query('select pulse.contract_manager() m, pulse.contract_seller() s')).rows[0];
    if (!r.m && !r.s) fail(403, 'Admins, leadership, Finance and Sales make agreements');
    return { manager: r.m === true };
  };
  // Parties from our records (clients and vendors with their point of contact) and a person by @handle.
  app.get<{ Querystring: Record<string, string> }>('/api/v0/contracts/parties', (req) => tx(req, async (c) => {
    const me = await may(c);
    const words = q(req.query.q);
    const handle = words.replace(/^@/, '');
    const account = handle && me.manager ? (await c.query('select pulse.contract_find_account($1) a', [handle])).rows[0]?.a ?? null : null;
    return { records: await partyRecords(c, words), account };
  }));
  app.post<{ Params: { id: string; key: string }; Body: Row }>('/api/v0/contracts/:id/parties/:key/contact', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c) => said(async () => {
    const id = idOr404(req.params.id, 'Agreement'), key = idOr404(req.params.key, 'Side');
    await c.query('select pulse.contract_party_contact($1,$2,$3)', [id, key, JSON.stringify(pocInput(req.body ?? {}))]);
    return { ok: true };
  })));
  // What this agreement could link: projects, tasks (its project's first) and quotations or invoices the viewer can see.
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/v0/contracts/:id/link-options', (req) => tx(req, async (c) => {
    const id = idOr404(req.params.id, 'Agreement');
    if (!(await c.query('select pulse.contract_runner($1) r', [id])).rows[0].r) fail(403, 'Admins, leadership, Finance and the agreement\'s owner link work to it');
    const words = q(req.query.q), pat = like(words);
    const project = (await c.query('select project_id from pulse.contract_link where contract_id=$1 and project_id is not null limit 1', [id])).rows[0]?.project_id ?? null;
    const projects = (await c.query(`select p.id, coalesce(p.title, p.name) title, p.status from pulse.project p
      where p.deleted_at is null and ($1 = '' or coalesce(p.title, p.name) ilike $2)
        and not exists(select 1 from pulse.contract_link l where l.contract_id=$3 and l.project_id=p.id)
      order by p.status in ('active','onboarding') desc, coalesce(p.title, p.name) limit 8`, [words, pat, id])).rows;
    const tasks = (await c.query(`select t.id, t.title, t.status, coalesce(p.title, p.name) project from pulse.task t left join pulse.project p on p.id=t.project_id
      where ($1 = '' or t.title ilike $2) and not exists(select 1 from pulse.contract_link l where l.contract_id=$3 and l.task_id=t.id)
        and ($1 <> '' or t.project_id = $4)
      order by (t.project_id = $4) desc nulls last, t.status in ('done','cancelled'), t.title limit 8`, [words, pat, id, project])).rows;
    const invoices = (await c.query(`select d.id, d.number, d.doc_type "docType", d.status, d.total::float8 total, d.buyer->>'name' client from pulse.erp_document d
      where d.doc_type in ('quotation','proforma','invoice') and d.status not in ('draft','cancelled')
        and ($1 = '' or d.number ilike $2 or d.buyer->>'name' ilike $2)
        and not exists(select 1 from pulse.contract_link l where l.contract_id=$3 and l.erp_document_id=d.id)
      order by d.issue_date desc nulls last limit 8`, [words, pat, id])).rows;
    return { projects, tasks, invoices };
  }));
  // Both ways: the agreements linked to a project or a task (only for who runs them; others get an empty list).
  app.get<{ Querystring: Record<string, string> }>('/api/v0/contracts/for-work', (req) => tx(req, async (c) => {
    const projectId = req.query.projectId ? idOr404(req.query.projectId, 'Project') : null;
    const taskId = req.query.taskId ? idOr404(req.query.taskId, 'Task') : null;
    if (!projectId === !taskId) fail(400, 'Choose one project or task');
    const agreements = (await c.query(`select c.id, c.title, c.status, c.version, c.signed_at "signedAt", c.updated_at "updatedAt", c.currency,
        (select string_agg(p.name, ', ' order by p.position) from pulse.contract_party p where p.contract_id=c.id and p.party_org is distinct from c.org_id) "with",
        coalesce((select d.total from pulse.contract_side s join pulse.erp_document d on d.id=s.source_document_id where s.contract_id=c.id),
          (select sum((r->>'amountMinor')::bigint) from jsonb_array_elements(c.rates) r where r->>'unit' in ('one_off','deliverable')))::float8 "totalMinor",
        (select coalesce(sum(t.amount_minor),0) from pulse.contract_txn t where t.contract_id=c.id and t.status='paid')::float8 "paidMinor",
        (select to_char(min(t.due_on),'YYYY-MM-DD') from pulse.contract_txn t where t.contract_id=c.id and t.status='billed' and t.due_on is not null) "nextDue",
        (select t.amount_minor::float8 from pulse.contract_txn t where t.contract_id=c.id and t.status='billed' and t.due_on is not null order by t.due_on, t.created_at limit 1) "nextMinor"
      from pulse.contract_link l join pulse.contract c on c.id=l.contract_id
      where (l.project_id=$1 or l.task_id=$2) order by c.updated_at desc limit 20`, [projectId, taskId])).rows;
    return { agreements };
  }));
  // Proposed drafts: propose new words, then use them (a new draft) or drop them.
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/contracts/:id/proposals', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c) => said(async () =>
    ({ id: await proposeDraft(c, idOr404(req.params.id, 'Agreement'), req.body ?? {}, 'app') }))));
  app.post<{ Params: { id: string; pid: string }; Body: Row }>('/api/v0/contracts/:id/proposals/:pid', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c) => said(async () => {
    const id = idOr404(req.params.id, 'Agreement'), pid = idOr404(req.params.pid, 'Proposed draft');
    if (typeof req.body?.use !== 'boolean') fail(400, 'Use it or drop it');
    return { version: (await c.query('select pulse.contract_proposal_decide($1,$2,$3) v', [id, pid, req.body.use])).rows[0].v as number };
  })));
  // What clients change, per template (admins, leadership and Finance; read-only).
  app.get('/api/v0/contracts/insights', (req) => tx(req, async (c) => {
    if (!(await c.query('select pulse.contract_manager() m')).rows[0].m) fail(403, 'Admins, leadership and Finance see what clients change');
    return clauseInsights(c);
  }));
}
