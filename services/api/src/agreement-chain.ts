// AGREEMENTS round 3 and 4 (owner, 14–15 Nov 2026: "quote → accepted → agreement → invoice"; "show me step by step how
// things work … everything starts from there"). One contract flow, read from the quotation, the agreement or the invoice:
//   1 Lead          the client (or lead) the quotation is for
//   2 Quote         the quotation, from the detailed sheet, accepted by the client
//   3 Agreement sent  made from the quotation (pulse.contract_from_document) and sent to sign
//   4 Client reviews  they read it, comment or ask for changes clause by clause, and sign
//   5 Both accept   our side signs too (term by term, with the audit trail)
//   6 Invoice       the first monthly invoice, Billing's own draft from the quotation
//   7 Onboarding    the project and its tasks from the quotation (pulse.project_from_quote)
//   8 Live          every onboarding task done
// `step` is the index of the step that waits (0–7), 8 when all are done. The screens say who acts next.
//   GET  /api/v0/agreements/chain?documentId=… | ?contractId=…
//   POST /api/v0/agreements/chain/invoice {contractId}: the invoice draft from the agreement's quotation (Billing's own
//        createDraft: lines, prices and GST carry over), linked to the agreement. A retry opens the same invoice.
//   POST /api/v0/agreements/chain/onboarding {contractId}: the onboarding project and tasks from the quotation
//        (pulse.project_from_quote, the same as Billing's "Start the project"), linked to the agreement.
// Everything is read as the viewer under row security: someone who cannot see Billing sees no amounts, and an agreement
// they cannot open is not in their chain.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx } from './routes.js';
import { createDraft } from './erp.js';
import { linkWork } from './contracts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Doc = { id: string; number: string | null; docType: string; status: string; total: number | null; client: string | null; date: string | null; sourceId: string | null };
type Agreement = {
  id: string; title: string; status: string; signedAt: string | null;
  /** When it was first sent, first opened or answered by the other side; change requests still open; who has not signed. */
  sentAt: string | null; seenAt: string | null; asks: number; clientSigned: boolean; waitingFor: string[];
};
type Onboarding = { projectId: string; title: string; tasks: number; done: number };
export type Chain = {
  quote: Doc | null; agreement: Agreement | null; invoice: Doc | null; onboarding: Onboarding | null;
  /** The step that waits: 0 Lead … 7 Live; 8 when every step is done. */
  step: number;
  /** make: this person makes agreements at all (the card shows only to them, or once an agreement exists). */
  can: { agreement: boolean; invoice: boolean; onboarding: boolean; billing: boolean; make: boolean };
};

const DOC_SQL = `select d.id, d.number, d.doc_type "docType", d.status, d.total::float8 total, nullif(btrim(d.buyer->>'name'),'') client,
  to_char(d.issue_date,'YYYY-MM-DD') "date", d.source_id "sourceId" from pulse.erp_document d`;
// A quotation is accepted by the client; a proforma counts once it is issued (it asks for the money, nobody "accepts" it).
const ACCEPTED: Record<string, string[]> = {
  quotation: ['accepted', 'converted'],
  proforma: ['issued', 'sent', 'accepted', 'converted', 'part_paid', 'paid'],
};
export const accepted = (d: Pick<Doc, 'docType' | 'status'> | null) => !!d && (ACCEPTED[d.docType] ?? []).includes(d.status);

async function doc(c: PoolClient, id: string | null): Promise<Doc | null> {
  if (!id) return null;
  return ((await c.query(`${DOC_SQL} where d.id=$1`, [id])).rows[0] as Doc | undefined) ?? null;
}

/** The invoice made from this quotation: straight from it, or through the proforma made from it. Not a cancelled one. */
async function invoiceOf(c: PoolClient, quoteId: string): Promise<Doc | null> {
  return ((await c.query(`${DOC_SQL} where d.doc_type='invoice' and d.status<>'cancelled' and (d.source_id=$1
      or d.source_id in (select p.id from pulse.erp_document p where p.source_id=$1 and p.doc_type='proforma' and p.status<>'cancelled'))
    order by d.created_at limit 1`, [quoteId])).rows[0] as Doc | undefined) ?? null;
}

const AGREEMENT_SQL = `select k.id, k.title, k.status, k.signed_at "signedAt",
    (select min(e.at) from pulse.contract_event e where e.contract_id=k.id and e.kind='sent') "sentAt",
    (select min(e.at) from pulse.contract_event e where e.contract_id=k.id and e.kind in ('opened','commented','change_asked','signed','declined')
      and e.via='link') "seenAt",
    (select count(*) from pulse.contract_event e where e.contract_id=k.id and e.kind='change_asked' and e.resolved_at is null)::int asks,
    coalesce((select bool_and(p.accepted_version=k.version) from pulse.contract_party p where p.contract_id=k.id and p.role<>'provider'
      and p.party_org is distinct from k.home_org), false) "clientSigned",
    coalesce((select array_agg(p.name order by p.position) from pulse.contract_party p where p.contract_id=k.id
      and p.accepted_version is distinct from k.version and p.declined_at is null), '{}') "waitingFor"
  from pulse.contract k`;

/** The agreement made from this document, the newest one still alive (a cancelled or ended one is history). */
async function agreementOf(c: PoolClient, docId: string): Promise<Agreement | null> {
  return ((await c.query(`${AGREEMENT_SQL} join pulse.contract_side s on s.contract_id=k.id
    where s.source_document_id=$1 order by k.status in ('cancelled','ended'), k.created_at desc limit 1`, [docId])).rows[0] as Agreement | undefined) ?? null;
}

/** The onboarding project: started from the quotation (project_quote), the quotation's project, or one the paid invoice
 *  started; its tasks as this person sees them (row security). */
async function onboardingOf(c: PoolClient, quote: Doc | null, invoice: Doc | null): Promise<Onboarding | null> {
  const ids = [quote?.id, invoice?.id].filter(Boolean);
  if (!ids.length) return null;
  const p = (await c.query(`select p.id, coalesce(p.title,p.name) title from pulse.erp_document d
      left join pulse.project_quote q on q.org_id=d.org_id and q.document_id=d.id join pulse.project p on p.id=coalesce(q.project_id,d.project_id)
    where d.id=any($1::uuid[]) and p.deleted_at is null order by d.doc_type='quotation' desc limit 1`, [ids])).rows[0];
  if (!p) return null;
  const t = (await c.query(`select count(*) filter (where status<>'cancelled')::int tasks, count(*) filter (where status in ('done','accepted'))::int done
    from pulse.task where project_id=$1`, [p.id])).rows[0];
  return { projectId: p.id, title: p.title, tasks: t.tasks, done: t.done };
}

export async function chainOf(c: PoolClient, by: { documentId?: string | null; contractId?: string | null }): Promise<Chain> {
  const who = (await c.query(`select pulse.contract_manager() m, pulse.contract_seller() s, pulse.erp_can(false) r, pulse.erp_can(true) w`)).rows[0];
  let agreement: Agreement | null = null, start: Doc | null = null;
  if (by.contractId) {
    agreement = ((await c.query(`${AGREEMENT_SQL} where k.id=$1`, [by.contractId])).rows[0] as Agreement | undefined) ?? fail(404, 'Agreement not found');
    const src = (await c.query('select source_document_id d from pulse.contract_side where contract_id=$1', [by.contractId])).rows[0]?.d ?? null;
    start = who.r ? await doc(c, src) : null;
  } else {
    if (!who.r) fail(403, 'Billing is for leadership, Finance and Sales');
    start = (await doc(c, by.documentId ?? null)) ?? fail(404, 'Document not found');
  }
  // From an invoice: its quotation, if it was made from one, starts the chain.
  let quote: Doc | null = null, invoice: Doc | null = null;
  if (start?.docType === 'invoice') {
    invoice = start;
    const src = await doc(c, start.sourceId);
    quote = src && src.docType === 'proforma' && src.sourceId ? (await doc(c, src.sourceId)) ?? src : src;
  } else if (start) {
    quote = start;
    invoice = await invoiceOf(c, start.id);
  }
  if (!agreement && (quote || invoice)) agreement = await agreementOf(c, (quote ?? invoice)!.id);
  if (!agreement && quote && invoice) agreement = await agreementOf(c, invoice.id);
  const onboarding = await onboardingOf(c, quote, invoice);
  const live = agreement && agreement.status !== 'cancelled' ? agreement : null;
  const sent = !!live && live.status !== 'draft';
  const signed = live?.status === 'active' || live?.status === 'ended';
  // An invoice Billing made before everyone signed does not move the flow on: the agreement still waits for its signatures.
  const step = !quote ? (signed ? (invoice ? 6 : 5) : 2)
    : !accepted(quote) && !live && !invoice ? 1
    : !sent ? 2
    : !signed && !live!.clientSigned ? 3
    : !signed ? 4
    : !invoice ? 5
    : !onboarding ? 6
    : onboarding.done < onboarding.tasks ? 7 : 8;
  const run = agreement ? (await c.query('select pulse.contract_runner($1) r', [agreement.id])).rows[0].r === true : false;
  if (!who.r) { // Someone who runs the agreement but not Billing: where it is, without the amounts.
    for (const d of [quote, invoice]) if (d) d.total = null;
  }
  return {
    quote, agreement, invoice, onboarding, step,
    can: {
      // A stopped agreement is history: a new one can be made from the same quotation (contract_from_document).
      agreement: !live && !!quote && accepted(quote) && (who.m === true || who.s === true),
      invoice: step === 5 && !!quote && who.w === true && run,
      // project_from_quote starts from an accepted quotation (once its invoice is issued, the paid invoice starts it).
      onboarding: step === 6 && !onboarding && quote?.docType === 'quotation' && quote.status === 'accepted' && who.w === true && run,
      billing: who.r === true,
      make: who.m === true || who.s === true,
    },
  };
}

async function mustRun(c: PoolClient, contractId: string, what: string) {
  if (!(await c.query('select pulse.contract_runner($1) r', [contractId])).rows[0].r) fail(403, `Admins, leadership, Finance and the agreement's owner ${what}`);
}

/** The invoice draft from the agreement's quotation, once everyone signed; linked to the agreement. Idempotent. */
export async function invoiceFromAgreement(c: PoolClient, v: Parameters<typeof createDraft>[1], contractId: string) {
  const chain = await chainOf(c, { contractId });
  await mustRun(c, contractId, 'make its invoice');
  if (!chain.can.billing) fail(403, 'Billing is for leadership, Finance and Sales');
  const quote = chain.quote ?? fail(409, 'This agreement was not made from a quotation. Make the invoice in Billing.');
  if (chain.invoice) { await linkWork(c, contractId, { invoiceId: chain.invoice.id }); return { id: chain.invoice.id, existing: true }; }
  if (chain.agreement?.status !== 'active') fail(409, 'Everyone signs the agreement first. Then make the invoice.');
  await c.query('select pulse.erp_require(true)');
  await c.query('select pulse.erp_bootstrap()');
  const block = (await c.query("select pulse.erp_flow_block('invoice') b")).rows[0].b as { why: string; unlockBy: string[] } | null;
  if (block) fail(403, `${block.why}.${block.unlockBy.length ? ` ${block.unlockBy.join(', ')} can do it.` : ''}`);
  const made = await createDraft(c, v, { docType: 'invoice', sourceId: quote.id });
  await linkWork(c, contractId, { invoiceId: made.id });
  return made;
}

/** The onboarding project and its tasks from the agreement's quotation, once signed and invoiced; linked to the agreement. */
export async function onboardingFromAgreement(c: PoolClient, contractId: string) {
  const chain = await chainOf(c, { contractId });
  await mustRun(c, contractId, 'start its onboarding');
  if (chain.onboarding) { await linkWork(c, contractId, { projectId: chain.onboarding.projectId }); return { projectId: chain.onboarding.projectId, created: false, tasks: chain.onboarding.tasks }; }
  const quote = chain.quote?.docType === 'quotation' ? chain.quote : fail(409, 'This agreement was not made from a quotation. Start the project in Work.');
  if (chain.step < 6) fail(409, 'Everyone signs the agreement and the invoice is made first. Then start the onboarding.');
  if (quote.status !== 'accepted') fail(409, 'The invoice is issued, so the project starts when it is paid.');
  const r = (await c.query('select pulse.project_from_quote($1,null,null) r', [quote.id])).rows[0].r as { projectId: string; created: boolean; tasks: number };
  await linkWork(c, contractId, { projectId: r.projectId });
  return r;
}

export function registerAgreementChainRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Querystring: { documentId?: string; contractId?: string } }>('/api/v0/agreements/chain', (req) => tx(req, async (c) => {
    const { documentId, contractId } = req.query;
    if (contractId) return chainOf(c, { contractId: UUID.test(contractId) ? contractId : fail(404, 'Agreement not found') });
    return chainOf(c, { documentId: UUID.test(String(documentId)) ? documentId : fail(404, 'Document not found') });
  }));
  app.post<{ Body: { contractId?: string } }>('/api/v0/agreements/chain/invoice', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c, v) => {
    const id = UUID.test(String(req.body?.contractId)) ? String(req.body?.contractId) : fail(404, 'Agreement not found');
    return invoiceFromAgreement(c, v, id);
  }));
  app.post<{ Body: { contractId?: string } }>('/api/v0/agreements/chain/onboarding', { schema: { body: { type: 'object' } } }, (req) => tx(req, async (c) => {
    const id = UUID.test(String(req.body?.contractId)) ? String(req.body?.contractId) : fail(404, 'Agreement not found');
    return onboardingFromAgreement(c, id);
  }));
}
