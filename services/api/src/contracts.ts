// CONNECTORS-CONTRACTS (owner, 6 Nov 2026): contracts between two parties, a company or a person on each side
// (docs/spec/CONTRACTS.md, migration 1583). One model serves the screens (/api/v0/contracts…, below) and API v1 / MCP /
// the CLI (v1-contracts.ts). Who sees and changes what is decided in the database (contract_manager, contract_can_see,
// the contract_* functions under forced row security); this file shapes input and the answers.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx } from './routes.js';
import { TEMPLATES, templateOf } from './contract-templates.js';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const KINDS = ['employment', 'retainer', 'services', 'revenue_share', 'equity'] as const;
export const ROLES = ['provider', 'client', 'employer', 'employee', 'partner'] as const;
export const SCHEDULES = ['monthly', 'quarterly', 'milestones', 'on_delivery', 'one_off'] as const;
export const UNITS = ['month', 'hour', 'deliverable', 'one_off', 'percent'] as const;
export const TXN_KINDS = ['invoice', 'retainer', 'payout', 'payment'] as const;
export const contractId = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(404, 'Contract not found');

export type Party = { id: string | null; key: string; kind: 'company' | 'person'; role: string; name: string; orgId: string | null; personId: string | null;
  onPulse: boolean; acceptedAt: string | null; acceptedVersion: number | null; acceptedBy: string | null; acceptedNote: string | null; current: boolean; mine: boolean };
export type Txn = { id: string | null; key: string; kind: string; payer: string; payee: string; label: string; amountMinor: number; currency: string; status: string;
  dueOn: string | null; paidOn: string | null; erpDocumentId: string | null; finEntryId: string | null };
export type Totals = { currency: string; billedMinor: number; paidMinor: number; outstandingMinor: number }[];
export type Contract = { id: string | null; key: string; here: boolean; heldBy: string | null; status: string; version: number; kind: string; title: string; scope: string;
  deliverables: string[]; rates: { label: string; amountMinor: number; unit: string }[]; currency: string; schedule: string; startsOn: string | null;
  endsOn: string | null; noticeDays: number | null; template: string | null; endedOn: string | null; endReason: string | null; updatedAt: string;
  parties: Party[]; transactions: Txn[]; totals: Totals; canManage: boolean; canAccept: boolean; myParty: string | null;
  side: { notes: string | null; ownerId: string | null; owner: string | null; clientId: string | null } | null };

/** Billed, paid and outstanding per currency (void transactions count for nothing). */
export function totalsOf(txns: Pick<Txn, 'amountMinor' | 'currency' | 'status'>[]): Totals {
  const by = new Map<string, { billed: number; paid: number }>();
  for (const t of txns) {
    if (t.status === 'void') continue;
    const x = by.get(t.currency) ?? { billed: 0, paid: 0 };
    x.billed += t.amountMinor;
    if (t.status === 'paid') x.paid += t.amountMinor;
    by.set(t.currency, x);
  }
  return [...by].map(([currency, x]) => ({ currency, billedMinor: x.billed, paidMinor: x.paid, outstandingMinor: x.billed - x.paid }));
}

const str = (v: unknown) => v === null || v === undefined ? null : String(v);
/** A date column: pg reads 'YYYY-MM-DD' as local midnight, so its local parts are the day (never toISOString, which shifts it). */
const day = (v: unknown) => v === null || v === undefined ? null : v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10);

function contractOut(r: Row, parties: Row[], txns: Row[], me: { manager: boolean; viewer: string | null; account: string | null }): Contract {
  const version = Number(r.version);
  const ps: Party[] = parties.map((p) => {
    const mine = (!!me.viewer && p.party_person_id === me.viewer) || (!!me.account && p.party_account === me.account);
    return { id: str(p.id), key: String(p.party_key), kind: p.kind as Party['kind'], role: String(p.role), name: String(p.name), orgId: str(p.party_org),
      personId: str(p.party_person_id), onPulse: !!(p.party_org || p.party_person_id || p.party_account),
      acceptedAt: p.accepted_at ? new Date(p.accepted_at as string).toISOString() : null, acceptedVersion: p.accepted_version === null ? null : Number(p.accepted_version),
      acceptedBy: str(p.accepted_by_name), acceptedNote: str(p.accepted_note), current: Number(p.accepted_version) === version, mine };
  });
  const ts: Txn[] = txns.map((t) => ({ id: str(t.id), key: String(t.txn_key), kind: String(t.kind), payer: String(t.payer_key), payee: String(t.payee_key),
    label: String(t.label), amountMinor: Number(t.amount_minor), currency: String(t.currency), status: String(t.status), dueOn: day(t.due_on), paidOn: day(t.paid_on),
    erpDocumentId: str(t.erp_document_id), finEntryId: str(t.fin_entry_id) }));
  const ours = ps.find((p) => p.mine) ?? null;
  const live = ['proposed', 'active'].includes(String(r.status));
  const companyUs = ps.find((p) => p.kind === 'company' && p.orgId === r.org_id);
  const canAccept = live && ((!!ours && !ours.current) || (me.manager && !!companyUs && !companyUs.current) || (me.manager && ps.some((p) => !p.onPulse && !p.current)));
  return { id: String(r.id), key: String(r.contract_key), here: true, heldBy: null, status: String(r.status), version, kind: String(r.kind), title: String(r.title),
    scope: String(r.scope ?? ''), deliverables: (r.deliverables as string[]) ?? [], rates: (r.rates as Contract['rates']) ?? [], currency: String(r.currency),
    schedule: String(r.schedule), startsOn: day(r.starts_on), endsOn: day(r.ends_on), noticeDays: r.notice_days === null ? null : Number(r.notice_days),
    template: str(r.template), endedOn: day(r.ended_on), endReason: str(r.end_reason), updatedAt: new Date(r.updated_at as string).toISOString(),
    parties: ps, transactions: ts, totals: totalsOf(ts), canManage: me.manager, canAccept, myParty: ours?.key ?? null,
    side: me.manager ? { notes: str(r.notes), ownerId: str(r.owner_person_id), owner: str(r.owner), clientId: str(r.client_id) } : null };
}

async function who(c: PoolClient) {
  const r = (await c.query('select pulse.contract_manager() manager, pulse.current_viewer() viewer, pulse.account_of_viewer() account')).rows[0];
  return { manager: r.manager === true, viewer: str(r.viewer), account: str(r.account) };
}

/** The company's contracts the viewer may see (managers: all; a person: the ones naming them, once sent). */
export async function listContracts(c: PoolClient, f: { status?: string; kind?: string; after?: string | null; take?: number } = {}): Promise<Contract[]> {
  const me = await who(c);
  const rows = (await c.query(`select c.*,s.notes,s.owner_person_id,s.client_id,o.display_name owner from pulse.contract c
      left join pulse.contract_side s on s.contract_id=c.id left join pulse.person o on o.id=s.owner_person_id
    where ($1::text is null or c.status=$1) and ($2::text is null or c.kind=$2) and ($3::uuid is null or c.id>$3)
    order by ${f.after !== undefined ? 'c.id' : `array_position(array['proposed','draft','active','ended','cancelled'],c.status),c.updated_at desc`} limit $4`,
    [f.status ?? null, f.kind ?? null, f.after ?? null, Math.min(Math.max(f.take ?? 100, 1), 200)])).rows;
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const parties = (await c.query('select * from pulse.contract_party where contract_id=any($1) order by position', [ids])).rows;
  const txns = (await c.query('select * from pulse.contract_txn where contract_id=any($1) order by created_at', [ids])).rows;
  return rows.map((r) => contractOut(r, parties.filter((p) => p.contract_id === r.id), txns.filter((t) => t.contract_id === r.id), me));
}

export type Version = { version: number; terms: Row; changedBy: string | null; changedAt: string };
export type Link = { id: string; kind: 'project' | 'task' | 'invoice' | 'goal'; refId: string; title: string; status: string | null };
export type ContractDetail = { contract: Contract; versions: Version[]; links: Link[] };

/** One contract held by this company, or (by its key) one held elsewhere that names the viewer: the shared part only. */
export async function getContract(c: PoolClient, idOrKey: string): Promise<ContractDetail> {
  const id = contractId(idOrKey);
  const here = (await listContractsById(c, id))[0];
  if (here) {
    const versions = (await c.query(`select version,terms,changed_by_name,changed_at from pulse.contract_version where contract_id=$1 order by version desc`, [here.id])).rows
      .map((v) => ({ version: Number(v.version), terms: v.terms as Row, changedBy: str(v.changed_by_name), changedAt: new Date(v.changed_at).toISOString() }));
    const links = (await c.query(`select l.id,case when l.project_id is not null then 'project' when l.task_id is not null then 'task' when l.goal_id is not null then 'goal' else 'invoice' end kind,
        coalesce(l.project_id,l.task_id,l.erp_document_id,l.goal_id) ref,coalesce(coalesce(p.title,p.name),t.title,g.title,d.number,'Hidden from you') title,coalesce(p.status,t.status,g.status,d.status) status
      from pulse.contract_link l left join pulse.project p on p.id=l.project_id left join pulse.task t on t.id=l.task_id left join pulse.erp_document d on d.id=l.erp_document_id
        left join pulse.goal g on g.id=l.goal_id
      where l.contract_id=$1 order by l.added_at`, [here.id])).rows
      .map((l) => ({ id: String(l.id), kind: l.kind, refId: String(l.ref), title: String(l.title ?? 'Invoice (draft)'), status: str(l.status) }));
    return { contract: here, versions, links };
  }
  const elsewhere = (await myContracts(c)).find((x) => x.key === id || x.id === id);
  return elsewhere ? { contract: elsewhere, versions: [], links: [] } : fail(404, 'Contract not found');
}

async function listContractsById(c: PoolClient, id: string) {
  const me = await who(c);
  const rows = (await c.query(`select c.*,s.notes,s.owner_person_id,s.client_id,o.display_name owner from pulse.contract c left join pulse.contract_side s on s.contract_id=c.id
    left join pulse.person o on o.id=s.owner_person_id where c.id=$1 or c.contract_key=$1`, [id])).rows;
  if (!rows.length) return [];
  const parties = (await c.query('select * from pulse.contract_party where contract_id=$1 order by position', [rows[0].id])).rows;
  const txns = (await c.query('select * from pulse.contract_txn where contract_id=$1 order by created_at', [rows[0].id])).rows;
  return [contractOut(rows[0], parties, txns, me)];
}

/** Your contracts in every company where you are a party: the shared part (pulse.my_contracts). */
export async function myContracts(c: PoolClient): Promise<Contract[]> {
  const list = ((await c.query('select pulse.my_contracts() r')).rows[0]?.r ?? []) as Row[];
  return list.map((r) => {
    const version = Number(r.version);
    const parties: Party[] = ((r.parties as Row[]) ?? []).map((p) => ({ id: null, key: String(p.key), kind: p.kind as Party['kind'], role: String(p.role), name: String(p.name),
      orgId: null, personId: null, onPulse: true, acceptedAt: str(p.acceptedAt), acceptedVersion: p.acceptedVersion === null ? null : Number(p.acceptedVersion),
      acceptedBy: str(p.acceptedBy), acceptedNote: null, current: Number(p.acceptedVersion) === version, mine: p.key === r.myParty }));
    const txns: Txn[] = ((r.transactions as Row[]) ?? []).map((t) => ({ id: null, key: String(t.key), kind: String(t.kind), payer: String(t.payer), payee: String(t.payee),
      label: String(t.label), amountMinor: Number(t.amountMinor), currency: String(t.currency), status: String(t.status), dueOn: str(t.dueOn), paidOn: str(t.paidOn),
      erpDocumentId: null, finEntryId: null }));
    const mine = parties.find((p) => p.mine);
    return { id: str(r.id), key: String(r.key), here: r.here === true, heldBy: str(r.heldBy), status: String(r.status), version, kind: String(r.kind), title: String(r.title),
      scope: String(r.scope ?? ''), deliverables: (r.deliverables as string[]) ?? [], rates: (r.rates as Contract['rates']) ?? [], currency: String(r.currency),
      schedule: String(r.schedule), startsOn: str(r.startsOn), endsOn: str(r.endsOn), noticeDays: r.noticeDays === null ? null : Number(r.noticeDays), template: null,
      endedOn: null, endReason: null, updatedAt: String(r.updatedAt), parties, transactions: txns, totals: totalsOf(txns), canManage: false,
      canAccept: ['proposed', 'active'].includes(String(r.status)) && !!mine && !mine.current, myParty: mine?.key ?? null, side: null };
  });
}

// ------------------------------------------------------------------------------------------------ input
const text = (v: unknown, max: number) => v === null || v === undefined ? undefined : String(v).trim().slice(0, max);
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T | undefined => v === undefined ? undefined : list.includes(v as T) ? v as T : fail(400, what);
const date = (v: unknown, what: string) => v === undefined ? undefined : v === null || v === '' ? null : DAY.test(String(v)) ? String(v) : fail(400, `${what} is YYYY-MM-DD`);
const minor = (v: unknown, what: string) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 9e12 ? n : fail(400, `${what} is a whole number of paise`); };

/** The terms and parties as the database takes them; only what was sent. */
export function termsInput(b: Row): Row {
  const out: Row = {};
  const kind = oneOf(b.kind, KINDS, 'A contract is employment, retainer, services, revenue share or equity');
  if (kind) out.kind = kind;
  const title = text(b.title, 160); if (title !== undefined) out.title = title || fail(400, 'Give the contract a name');
  const scope = text(b.scope, 20000); if (scope !== undefined) out.scope = scope;
  if (b.deliverables !== undefined) {
    if (!Array.isArray(b.deliverables) || b.deliverables.length > 100) fail(400, 'Deliverables are a list of up to 100');
    out.deliverables = (b.deliverables as unknown[]).map((d) => String(d).trim().slice(0, 300)).filter(Boolean);
  }
  if (b.rates !== undefined) {
    if (!Array.isArray(b.rates) || b.rates.length > 50) fail(400, 'Rates are a list of up to 50 lines');
    out.rates = (b.rates as Row[]).map((r) => ({ label: text(r?.label, 120) || fail(400, 'Each rate needs a label'), amountMinor: minor(r?.amountMinor, 'A rate'),
      unit: oneOf(r?.unit ?? 'one_off', UNITS, 'A rate is per month, hour, deliverable, one-off or a percent') }));
  }
  if (b.currency !== undefined) out.currency = /^[A-Z]{3}$/.test(String(b.currency)) ? String(b.currency) : fail(400, 'The currency is a three-letter code such as INR');
  const schedule = oneOf(b.schedule, SCHEDULES, 'The schedule is monthly, quarterly, milestones, on delivery or one-off'); if (schedule) out.schedule = schedule;
  const starts = date(b.startsOn, 'The start date'); if (starts !== undefined) out.startsOn = starts;
  const ends = date(b.endsOn, 'The end date'); if (ends !== undefined) out.endsOn = ends;
  if (b.noticeDays !== undefined) out.noticeDays = b.noticeDays === null ? null : Number.isInteger(Number(b.noticeDays)) && Number(b.noticeDays) >= 0 && Number(b.noticeDays) <= 3650 ? Number(b.noticeDays) : fail(400, 'Notice is 0 to 3650 days');
  if (b.template !== undefined) out.template = b.template === null ? null : templateOf(b.template)?.key ?? fail(400, 'Unknown template');
  if (b.notes !== undefined) out.notes = text(b.notes, 5000) ?? null;
  if (b.clientId !== undefined) out.clientId = b.clientId === null || UUID.test(String(b.clientId)) ? b.clientId : fail(400, 'Choose the client or vendor record');
  if (b.ownerId !== undefined) out.ownerId = b.ownerId === null || UUID.test(String(b.ownerId)) ? b.ownerId : fail(400, 'Choose a person');
  if (b.parties !== undefined) {
    if (!Array.isArray(b.parties) || b.parties.length < 2 || b.parties.length > 20) fail(400, 'Name at least two parties');
    out.parties = (b.parties as Row[]).map((p) => {
      const kind = oneOf(p?.kind, ['company', 'person'] as const, 'A party is a company or a person') ?? fail(400, 'A party is a company or a person');
      const role = oneOf(p?.role, ROLES, 'A party is provider, client, employer, employee or partner') ?? fail(400, 'Give each party its role');
      const ids = ['orgId', 'personId', 'accountId'].filter((k) => p?.[k]);
      for (const k of ids) if (!UUID.test(String(p[k]))) fail(400, 'Choose the party from the list');
      if (!ids.length && !text(p?.name, 160)) fail(400, 'Name each party');
      return { kind, role, name: text(p?.name, 160) ?? null, orgId: p?.orgId ?? null, personId: p?.personId ?? null, accountId: p?.accountId ?? null };
    });
  }
  return out;
}

/** Make a contract from a template (or blank) or change one. The database refuses what the viewer may not do. */
export async function saveContract(c: PoolClient, id: string | null, b: Row): Promise<string> {
  const t = id ? null : templateOf(b.template);
  const base: Row = t ? { kind: t.kind, title: t.title, scope: t.scope, deliverables: t.deliverables, rates: t.rates, schedule: t.schedule, noticeDays: t.noticeDays, template: t.key } : {};
  return (await c.query('select pulse.contract_save($1,$2) id', [id, JSON.stringify({ ...base, ...termsInput(b) })])).rows[0].id;
}
export const sendContract = async (c: PoolClient, id: string) => (await c.query('select pulse.contract_send($1) s', [contractId(id)])).rows[0].s as string;
/** Accept: a contract held here by its id (optionally one party: an off-Pulse company, with a note); one held elsewhere by its key. */
export async function acceptContract(c: PoolClient, idOrKey: string, b: Row = {}): Promise<string> {
  const id = contractId(idOrKey);
  const here = (await c.query('select id from pulse.contract where id=$1 or contract_key=$1', [id])).rows[0]?.id;
  if (here) return (await c.query('select pulse.contract_accept($1,$2,$3) s', [here, b.partyId && UUID.test(String(b.partyId)) ? b.partyId : null, text(b.note, 300) ?? null])).rows[0].s;
  return (await c.query('select pulse.contract_accept_account($1) s', [id])).rows[0].s;
}
export async function addTxn(c: PoolClient, id: string, b: Row): Promise<string> {
  const body = { kind: oneOf(b.kind, TXN_KINDS, 'A transaction is an invoice, retainer, payout or payment') ?? 'invoice',
    payerKey: UUID.test(String(b.payerKey)) ? b.payerKey : fail(400, 'Choose who pays'), payeeKey: UUID.test(String(b.payeeKey)) ? b.payeeKey : fail(400, 'Choose who is paid'),
    label: text(b.label, 160) || fail(400, 'Say what it is for'), amountMinor: minor(b.amountMinor, 'The amount') || fail(400, 'The amount is more than zero'),
    currency: b.currency === undefined ? undefined : /^[A-Z]{3}$/.test(String(b.currency)) ? b.currency : fail(400, 'The currency is a three-letter code'),
    status: oneOf(b.status, ['billed', 'paid'] as const, 'A new transaction is billed or paid'), dueOn: date(b.dueOn, 'The due date'), paidOn: date(b.paidOn, 'The paid date'),
    erpDocumentId: b.erpDocumentId && UUID.test(String(b.erpDocumentId)) ? b.erpDocumentId : undefined,
    finEntryId: b.finEntryId && UUID.test(String(b.finEntryId)) ? b.finEntryId : undefined };
  return (await c.query('select pulse.contract_txn_add($1,$2) id', [contractId(id), JSON.stringify(body)])).rows[0].id;
}
export async function setTxn(c: PoolClient, id: string, txn: string, b: Row): Promise<void> {
  const body: Row = {};
  const status = oneOf(b.status, ['billed', 'paid', 'void'] as const, 'A transaction is billed, paid or void'); if (status) body.status = status;
  const paid = date(b.paidOn, 'The paid date'); if (paid) body.paidOn = paid;
  for (const k of ['erpDocumentId', 'finEntryId']) if (b[k] !== undefined) body[k] = b[k] === null || b[k] === '' ? null : UUID.test(String(b[k])) ? b[k] : fail(400, 'Choose a record from the list');
  await c.query('select pulse.contract_txn_set($1,$2,$3)', [contractId(id), UUID.test(txn) ? txn : fail(404, 'No such transaction'), JSON.stringify(body)]);
}
export async function linkWork(c: PoolClient, id: string, b: Row): Promise<string> {
  const ref = (k: string) => b[k] ? (UUID.test(String(b[k])) ? String(b[k]) : fail(400, 'Choose from the list')) : null;
  const [projectId, taskId, invoiceId, goalId] = [ref('projectId'), ref('taskId'), ref('invoiceId'), ref('goalId')];
  if ([projectId, taskId, invoiceId, goalId].filter(Boolean).length !== 1) fail(400, 'Choose one project, task, invoice or goal');
  const had = (await c.query('select id from pulse.contract_link where contract_id=$1 and coalesce(project_id,task_id,erp_document_id,goal_id)=$2', [contractId(id), projectId ?? taskId ?? invoiceId ?? goalId])).rows[0];
  if (had) return String(had.id);
  try {
    return (await c.query(`insert into pulse.contract_link(org_id,contract_id,project_id,task_id,erp_document_id,goal_id,added_by) values(pulse.current_org(),$1,$2,$3,$4,$5,pulse.current_viewer()) returning id`,
      [id, projectId, taskId, invoiceId, goalId])).rows[0].id;
  } catch (e) { if ((e as { code?: string }).code === '42501') fail(403, 'Admins, leadership and Finance link work to a contract, and only work they can see'); throw e; }
}
export async function unlinkWork(c: PoolClient, id: string, linkId: string): Promise<void> {
  const r = await c.query('delete from pulse.contract_link where contract_id=$1 and id=$2 returning id', [contractId(id), UUID.test(linkId) ? linkId : fail(404, 'No such link')]);
  if (!r.rowCount) fail(404, 'No such link on this contract');
}
export const endContract = async (c: PoolClient, id: string, b: Row) =>
  (await c.query('select pulse.contract_end($1,$2,$3) s', [contractId(id), date(b.endsOn, 'The end date') ?? null, text(b.reason, 500) ?? null])).rows[0].s as string;

/** What the new-contract form offers: templates, this company, its people, and whether the viewer makes contracts. */
export async function contractChoices(c: PoolClient) {
  const r = (await c.query(`select pulse.contract_manager() manager,pulse.current_org() org,(select name from pulse.org where id=pulse.current_org()) name,
    (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name) order by p.display_name),'[]') from pulse.person p
      where p.side in ('staff','freelancer') and p.status='active') people`)).rows[0];
  return { canManage: r.manager === true, us: { id: String(r.org), name: String(r.name) }, people: r.manager ? r.people : [],
    templates: TEMPLATES.map((t) => ({ key: t.key, kind: t.kind, name: t.name, summary: t.summary, roles: t.roles })) };
}

// ------------------------------------------------------------------------------------------------ screens
const body = { type: 'object' } as const;
export function registerContractRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Querystring: Record<string, string> }>('/api/v0/contracts', req => tx(req, async c => {
    const [company, mine, choices] = await Promise.all([listContracts(c, { status: req.query.status || undefined }), myContracts(c), contractChoices(c)]);
    return { company: choices.canManage ? company : [], mine, ...choices };
  }));
  app.get('/api/v0/contracts/mine', req => tx(req, async c => ({ mine: await myContracts(c) })));
  app.get<{ Querystring: Record<string, string> }>('/api/v0/contracts-find', req => tx(req, async c => {
    const q = String(req.query.q ?? '').trim().slice(0, 200);
    if (!q) return { account: null, company: null };
    const r = (await c.query('select pulse.contract_find_account($1) a, pulse.contract_find_org($1) o', [q])).rows[0];
    return { account: r.a ?? null, company: r.o ?? null };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/contracts/:id', req => tx(req, async c => ({ ...(await getContract(c, req.params.id)), ...(await contractChoices(c)) })));
  app.post<{ Body: Row }>('/api/v0/contracts', { schema: { body } }, req => tx(req, async c => ({ contract: (await getContract(c, await saveContract(c, null, req.body ?? {}))).contract })));
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/contracts/:id', { schema: { body } }, req => tx(req, async c =>
    ({ contract: (await getContract(c, await saveContract(c, contractId(req.params.id), req.body ?? {}))).contract })));
  app.post<{ Params: { id: string } }>('/api/v0/contracts/:id/send', req => tx(req, async c => ({ status: await sendContract(c, req.params.id) })));
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/contracts/:id/accept', { schema: { body } }, req => tx(req, async c => ({ status: await acceptContract(c, req.params.id, req.body ?? {}) })));
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/contracts/:id/end', { schema: { body } }, req => tx(req, async c => ({ status: await endContract(c, req.params.id, req.body ?? {}) })));
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/contracts/:id/transactions', { schema: { body } }, req => tx(req, async c => ({ id: await addTxn(c, req.params.id, req.body ?? {}) })));
  app.post<{ Params: { id: string; txn: string }; Body: Row }>('/api/v0/contracts/:id/transactions/:txn', { schema: { body } }, req => tx(req, async c => {
    await setTxn(c, req.params.id, req.params.txn, req.body ?? {}); return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Row }>('/api/v0/contracts/:id/links', { schema: { body } }, req => tx(req, async c => ({ id: await linkWork(c, contractId(req.params.id), req.body ?? {}) })));
  app.post<{ Params: { id: string; linkId: string } }>('/api/v0/contracts/:id/links/:linkId/remove', req => tx(req, async c => { await unlinkWork(c, req.params.id, req.params.linkId); return { ok: true }; }));
}
