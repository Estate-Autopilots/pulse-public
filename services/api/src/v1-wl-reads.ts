// WL-PROMISES (CEO room msgs 140, 154, 171): quote history with full lines, workflow-run reads and lead-create. They run
// as the principal, so row security and the billing rule decide what is seen. Money is in paise; no person fields on a quote.
import * as money from './v1-money.js';
import { PAGE_QUERY, pageResponse, pageV1 } from './v1-paging.js';
import { defineV1Operation, v1Fail, type V1Context } from './v1.js';
import { bool, change, int, maybe, member, num, object, one, rows, str, text, uuid, type Row } from './v1-kit.js';

// v1-money can still be loading when this module loads (v1-money -> v1 -> routes -> here, e.g. when a test imports
// v1-money first). Its exports are read when a request runs, never at import, so the order does not matter.
const seesBilling = (write: boolean) => (ctx: V1Context) => money.seesBilling(write)(ctx);
const billingReader = (ctx: V1Context) => money.billingReader(ctx);
const billingWriter = (ctx: V1Context) => money.billingWriter(ctx);

const paise = (v: unknown) => Math.round(Number(v ?? 0));
const maybeInt = { type: ['integer', 'null'] };
const iso = (v: unknown) => v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

const QUOTE = { id: uuid, number: maybe, status: str, revision: int, buyer: str, clientId: maybe, issueDate: maybe, validUntil: maybe,
  taxable: int, tax: int, total: int, updatedAt: str, revisionGroupId: uuid, revisionOf: maybe, supersededBy: maybe };
const QUOTE_COLS = `d.id,d.number,d.status,d.revision,coalesce(d.buyer->>'name','') buyer,d.client_id "clientId",to_char(d.issue_date,'YYYY-MM-DD') "issueDate",
  to_char(d.valid_until,'YYYY-MM-DD') "validUntil",d.taxable::float8 taxable,(d.cgst+d.sgst+d.igst)::float8 tax,d.total::float8 total,d.updated_at "updatedAt",
  coalesce(d.revision_group_id,d.id) "revisionGroupId",d.revision_of "revisionOf",d.superseded_by "supersededBy"`;
const quote = (r: Row) => ({ id: String(r.id), number: (r.number as string) ?? null, status: String(r.status), revision: Number(r.revision ?? 0), buyer: String(r.buyer),
  clientId: (r.clientId as string) ?? null, issueDate: (r.issueDate as string) ?? null, validUntil: (r.validUntil as string) ?? null,
  taxable: paise(r.taxable), tax: paise(r.tax), total: paise(r.total), updatedAt: String(iso(r.updatedAt)),
  revisionGroupId: String(r.revisionGroupId), revisionOf: (r.revisionOf as string) ?? null, supersededBy: (r.supersededBy as string) ?? null });
const LINE = object({ position: int, parentPosition: maybeInt, itemId: maybe, description: str, qty: num, rate: int, catalogueRate: maybeInt, discount: int, gstRate: num,
  taxable: int, cgst: int, sgst: int, igst: int, tax: int, total: int, notNeeded: bool });

defineV1Operation({ operationId: 'listQuotes', method: 'GET', path: '/api/v1/billing/quotes', scope: 'billing.read',
  summary: 'Quote history in a stable order with cursor paging; read one for its lines',
  query: object({ ...PAGE_QUERY, status: { enum: ['draft', 'issued', 'sent', 'accepted', 'declined', 'cancelled', 'converted'] }, clientId: uuid, revisionGroupId: uuid }, []),
  response: pageResponse(object(QUOTE)), available: seesBilling(false), authorize: billingReader,
  handler: (ctx, input) => pageV1(ctx, 'listQuotes', input, async (after, take) =>
    (await rows(ctx, `select ${QUOTE_COLS} from pulse.erp_document d where d.doc_type='quotation' and ($1::uuid is null or d.id>$1)
        and ($2::text is null or d.status=$2) and ($3::uuid is null or d.client_id=$3) and ($4::uuid is null or coalesce(d.revision_group_id,d.id)=$4) order by d.id limit $5`,
      [after, input.query.status ?? null, input.query.clientId ?? null, input.query.revisionGroupId ?? null, take])).map(quote)),
});
defineV1Operation({ operationId: 'getQuote', method: 'GET', path: '/api/v1/billing/quotes/{quoteId}', scope: 'billing.read',
  summary: 'One quote with every line: catalogue rate, discount, tax split and lines marked not needed',
  params: object({ quoteId: uuid }), response: object({ ...QUOTE, lines: { type: 'array', items: LINE } }), available: seesBilling(false), authorize: billingReader,
  handler: async (ctx, { params }) => {
    const d = (await rows(ctx, `select ${QUOTE_COLS} from pulse.erp_document d where d.id=$1 and d.doc_type='quotation'`, [params.quoteId]))[0];
    if (!d) v1Fail(404, 'Quote not found');
    const lines = await rows(ctx, `select position,parent_position "parentPosition",item_id "itemId",description,qty::float8 qty,rate::float8 rate,catalogue_rate::float8 "catalogueRate",
        coalesce(discount,0)::float8 discount,gst_rate::float8 "gstRate",taxable::float8 taxable,cgst::float8 cgst,sgst::float8 sgst,igst::float8 igst,total::float8 total,not_needed "notNeeded"
      from pulse.erp_line where document_id=$1 order by position`, [params.quoteId]);
    return { ...quote(d), lines: lines.map(l => ({ position: Number(l.position), parentPosition: l.parentPosition === null ? null : Number(l.parentPosition), itemId: (l.itemId as string) ?? null,
      description: String(l.description), qty: Number(l.qty), rate: paise(l.rate), catalogueRate: l.catalogueRate === null ? null : paise(l.catalogueRate), discount: paise(l.discount), gstRate: Number(l.gstRate),
      taxable: paise(l.taxable), cgst: paise(l.cgst), sgst: paise(l.sgst), igst: paise(l.igst), tax: paise(l.cgst) + paise(l.sgst) + paise(l.igst), total: paise(l.total), notNeeded: !!l.notNeeded })) };
  },
});

const RUN = { id: uuid, workflowId: maybe, name: maybe, status: str, clientId: maybe, projectId: maybe, startedVia: maybe, startedAt: maybe, finishedAt: maybe };
const RUN_COLS = `r.id,r.workflow_id "workflowId",r.name,r.status,r.client_id "clientId",r.project_id "projectId",r.started_via "startedVia",r.started_at "startedAt",r.finished_at "finishedAt"`;
const run = (r: Row) => ({ id: String(r.id), workflowId: (r.workflowId as string) ?? null, name: (r.name as string) ?? null, status: String(r.status), clientId: (r.clientId as string) ?? null,
  projectId: (r.projectId as string) ?? null, startedVia: (r.startedVia as string) ?? null, startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt) });
const STEP = object({ key: str, position: int, title: maybe, kind: maybe, status: str, taskId: maybe, outcome: maybe, startedAt: maybe, dueAt: maybe, doneAt: maybe });

defineV1Operation({ operationId: 'listWorkflowRuns', method: 'GET', path: '/api/v1/workflows/runs', scope: 'workflows.read',
  summary: 'Workflow runs you can see, by status or client, with cursor paging',
  query: object({ ...PAGE_QUERY, status: { type: 'string', pattern: '^[a-z_]{1,30}$' }, clientId: uuid }, []), response: pageResponse(object(RUN)), authorize: member,
  handler: (ctx, input) => pageV1(ctx, 'listWorkflowRuns', input, async (after, take) =>
    (await rows(ctx, `select ${RUN_COLS} from pulse.workflow_run r where ($1::uuid is null or r.id>$1) and ($2::text is null or r.status=$2)
        and ($3::uuid is null or r.client_id=$3) order by r.id limit $4`, [after, input.query.status ?? null, input.query.clientId ?? null, take])).map(run)),
});
defineV1Operation({ operationId: 'getWorkflowRun', method: 'GET', path: '/api/v1/workflows/runs/{runId}', scope: 'workflows.read',
  summary: 'One workflow run with its steps', params: object({ runId: uuid }), response: object({ ...RUN, steps: { type: 'array', items: STEP } }), authorize: member,
  handler: async (ctx, { params }) => {
    const r = (await rows(ctx, `select ${RUN_COLS} from pulse.workflow_run r where r.id=$1`, [params.runId]))[0];
    if (!r) v1Fail(404, 'Workflow run not found');
    const steps = await rows(ctx, `select step_key,position,title,kind,status,task_id,outcome,started_at,due_at,done_at from pulse.workflow_run_step where run_id=$1 order by position`, [params.runId]);
    return { ...run(r), steps: steps.map(s => ({ key: String(s.step_key), position: Number(s.position), title: (s.title as string) ?? null, kind: (s.kind as string) ?? null, status: String(s.status),
      taskId: (s.task_id as string) ?? null, outcome: (s.outcome as string) ?? null, startedAt: iso(s.started_at), dueAt: iso(s.due_at), doneAt: iso(s.done_at) })) };
  },
});

// Lead-create (msg 140): a new customer for a quotation, as a prospect client the assistant adds for the person. Its id is
// both leadId and clientId: it goes on POST /api/v1/service/quotes as leadId (or clientId) and on quotes/drafts.
defineV1Operation({ operationId: 'createQuoteLead', method: 'POST', path: '/api/v1/billing/quote-leads', scope: 'billing.write',
  summary: 'Add a new customer for a quotation (one per phone number); returns the leadId to draft the quotation for',
  body: object({ name: text(160), phone: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' }, area: text(80), address: text(300),
    requirement: text(1000, 0), salespersonId: uuid }, ['name', 'phone', 'salespersonId']),
  response: object({ leadId: uuid, clientId: uuid, changeId: maybe }), available: seesBilling(true), authorize: billingWriter,
  handler: async (ctx, { body }) => {
    const b = body as Row;
    if (!b.area && !b.address) v1Fail(400, 'Give the area or the address');
    const r = await one<{ id?: string; duplicate?: string }>(ctx, 'select pulse.v1_quote_lead_create($1) v', [JSON.stringify(b)]);
    if (r.duplicate) {
      // The existing id only when this person or AI member can already see that client.
      const seen = (await rows(ctx, 'select 1 from pulse.client where id=$1', [r.duplicate])).length > 0;
      v1Fail(409, seen ? `A customer with this phone already exists: existingLeadId ${r.duplicate}` : 'A customer with this phone already exists');
    }
    return { leadId: r.id!, clientId: r.id!, changeId: await change(ctx, 'client.create', r.id!, { name: String(b.name).trim() }) };
  },
});
