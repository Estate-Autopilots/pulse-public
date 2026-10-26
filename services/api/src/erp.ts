import { ORG_TZ } from "./org-time.js";
import { companyOrigin } from "./tenant-context.js";
// ERP-INVOICE (owner, 11 Oct 2026): invoicing for the company inside Pulse. A catalog of services, products and packages
// (parts, deliverables, versions and price history), inventory for physical items, clients' billing profiles, client
// packages with milestones, templates with a live preview, and documents (invoice, proforma, quotation, credit note)
// from draft to paid, logged and exported (PDF, DOCX, Zoho Books CSV, Tally XML). The database decides who: leadership
// and the Finance role write, an Accountant reads; issued documents are numbered and kept there (0190_erp_invoice.sql).
// Pulse never e-mails a client: "Sent" records that someone handed the document over.
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { addDays, buildModel, DOC_LABELS, financialYear, FONT_URLS, numberProblem, renderDocx, renderPdf, sampleDocument, type Asset, type DocType, type Fonts } from "@pulse/invoice-doc";
import { fail, type Open, type Tx, type Viewer } from "./routes.js";
import { cleanBuyer, cleanDraft, DAY, documentInput, DOC_TYPES, ErpInputError, figures, GST, milestonePlan, UUID, cleanAddOnIds, neededLines, OPEN_UNFILLED, unfilledOpen } from "./erp-model.js";
import { salesRegisterCsv, tallyXml, zohoInvoicesCsv, type ExportDoc } from "./erp-exports.js";
import { ESIGN_OPTIONS, mirrorStatus } from "./erp-seams.js";

type Body = Record<string, unknown>;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Today on the company's calendar (its time zone; India for EA). */
const today = async (c: PoolClient) => (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d as string;
const id = (v: unknown, what: string) => (typeof v === "string" && UUID.test(v) ? v : fail(404, `${what} not found`));
const optId = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : null);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const iso = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" ? v.slice(0, 10) : null);

let fontsLoading: Promise<Fonts> | null = null;
const fonts = () => (fontsLoading ??= Promise.all([readFile(FONT_URLS.regular), readFile(FONT_URLS.semibold)]).then(([regular, semibold]) => ({ regular, semibold })));

const can = async (c: PoolClient) => (await c.query("select pulse.erp_can(false) read,pulse.erp_can(true) write")).rows[0] as { read: boolean; write: boolean };
async function reader(c: PoolClient) { await c.query("select pulse.erp_require(false)"); await c.query("select pulse.erp_bootstrap()"); }
async function writer(c: PoolClient) { await c.query("select pulse.erp_require(true)"); await c.query("select pulse.erp_bootstrap()"); }
const log = (c: PoolClient, type: string, subject: string | null, kind: string, detail: Body = {}) =>
  c.query("select pulse.erp_log($1,$2,$3,$4)", [type, subject, kind, detail]);

async function settings(c: PoolClient) {
  const s = (await c.query("select company,inventory_enabled,due_days,round_total,updated_at from pulse.erp_settings")).rows[0];
  return { company: s?.company ?? {}, inventoryEnabled: !!s?.inventory_enabled, dueDays: s?.due_days ?? 15, roundTotal: s?.round_total !== false, updatedAt: s?.updated_at ?? null };
}
/** The template for a document: its own, else the default for its type, else the first. */
async function templateFor(c: PoolClient, templateId: string | null, docType: string) {
  const t = (await c.query(`select id,name,design,logo_id,signature_id,doc_types from pulse.erp_template where not archived and
    ($1::uuid is not null and id=$1 or $1::uuid is null and id=(select template_id from pulse.erp_template_default where doc_type=$2))
    union all (select id,name,design,logo_id,signature_id,doc_types from pulse.erp_template where not archived order by created_at limit 1) limit 1`, [templateId, docType])).rows[0];
  return t ?? null;
}
/** The logo (the template's, else the organisation's PNG logo) and the signature image. */
async function assetsFor(c: PoolClient, logoId: string | null, signatureId: string | null): Promise<{ logo: Asset | null; signature: Asset | null }> {
  const get = async (assetId: string | null) => assetId ? (await c.query("select bytes,mime from pulse.erp_asset where id=$1", [assetId])).rows[0] : null;
  const logo = (await get(logoId)) ?? (await c.query("select logo_png bytes,'image/png' mime from pulse.org_brand where org_id=pulse.current_org() and logo_png is not null")).rows[0] ?? null;
  const signature = await get(signatureId);
  const asset = (r: Row | null) => (r ? { bytes: new Uint8Array(r.bytes as Buffer), mime: String(r.mime) } : null);
  return { logo: asset(logo), signature: asset(signature) };
}

const DOC_COLS = `d.id,d.doc_type "docType",d.status,d.number,d.fy,to_char(d.issue_date,'YYYY-MM-DD') "issueDate",to_char(d.due_date,'YYYY-MM-DD') "dueDate",
  to_char(d.valid_until,'YYYY-MM-DD') "validUntil",d.client_id "clientId",d.project_id "projectId",d.engagement_id "engagementId",d.milestone_id "milestoneId",
  d.owner_approval "ownerApproval",d.salesperson_id "salespersonId",(select display_name from pulse.person where id=d.salesperson_id) "salespersonName",
  (d.service_key_id is not null) "fromServiceKey",d.against_id "againstId",d.source_id "sourceId",d.template_id "templateId",d.seller,d.buyer,d.place_of_supply "placeOfSupply",d.reference,d.notes,d.terms,
  d.reverse_charge "reverseCharge",d.zero_rated "zeroRated",d.round_total "roundTotal",d.tax_mode "taxMode",d.taxable::float8 taxable,d.cgst::float8 cgst,
  d.sgst::float8 sgst,d.igst::float8 igst,d.round_off::float8 "roundOff",d.total::float8 total,d.amount_words "amountWords",d.paid::float8 paid,d.credited::float8 credited,
  d.task_id "taskId",d.issued_at "issuedAt",d.sent_at "sentAt",d.cancelled_at "cancelledAt",d.cancel_reason "cancelReason",d.decision,d.created_at "createdAt",d.updated_at "updatedAt",
  (select display_name from pulse.person where id=d.created_by) "createdBy",(select display_name from pulse.person where id=d.issued_by) "issuedBy"`;
const LINE_COLS = `id,item_id "itemId",description,details,sac,unit,qty::float8 qty,rate::float8 rate,discount::float8 discount,discount_percent::float8 "discountPercent",
  gst_rate::float8 "gstRate",taxable::float8 taxable,cgst::float8 cgst,sgst::float8 sgst,igst::float8 igst,total::float8 total,
  parent_position "parentIndex",(select p.id from pulse.erp_line p where p.document_id=erp_line.document_id and p.position=erp_line.parent_position) "parentLineId",
  open,not_needed "notNeeded"`;
/** EST-1236: an item's usual add-ons (active ones, in order) and whether it is an amount priced per site. Needs alias i. */
const ITEM_EXTRAS = `(i.kind<>'package' and i.price=0) open,coalesce((select jsonb_agg(jsonb_build_object('itemId',x.id,'name',x.name,'price',x.price::float8) order by a.position)
  from pulse.erp_item_addon a join pulse.erp_item x on x.id=a.addon_id where a.item_id=i.id and x.status<>'archived'),'[]') "addOns"`;
/** Replaces an item's usual add-ons: other active, non-package items of this catalogue, in the order given. */
async function setAddOns(c: PoolClient, itemId: string, raw: unknown) {
  const ids = cleanAddOnIds(raw, itemId);
  if (ids.length && (await c.query("select count(*)::int n from pulse.erp_item where id=any($1::uuid[]) and kind<>'package' and status<>'archived'", [ids])).rows[0].n !== ids.length)
    fail(400, "Add-ons are active items of this catalogue, not packages");
  await c.query("delete from pulse.erp_item_addon where item_id=$1", [itemId]);
  for (const [n, addOn] of ids.entries()) await c.query("insert into pulse.erp_item_addon(org_id,item_id,addon_id,position) values(pulse.current_org(),$1,$2,$3)", [itemId, addOn, n]);
}

async function loadDoc(c: PoolClient, docId: string) {
  const d = (await c.query("select * from pulse.erp_document where id=$1", [docId])).rows[0];
  if (!d) fail(404, "Document not found");
  const lines = (await c.query("select * from pulse.erp_line where document_id=$1 order by position", [docId])).rows;
  const against = d.against_id ? (await c.query("select number,issue_date date from pulse.erp_document where id=$1", [d.against_id])).rows[0] : null;
  return { d, lines, against };
}
/** Renders a document: an issued one with the design frozen at issue, a draft with its template as it is now. */
async function render(c: PoolClient, docId: string, format: "pdf" | "docx") {
  const { d, lines, against } = await loadDoc(c, docId);
  let design = d.design as Row | null, logoId: string | null = design?.logoId ?? null, signatureId: string | null = design?.signatureId ?? null;
  if (!design) {
    const t = await templateFor(c, d.template_id, d.doc_type);
    design = t?.design ?? {};
    logoId = t?.logo_id ?? null; signatureId = t?.signature_id ?? null;
  }
  const model = buildModel(design, documentInput(d, lines, against), await assetsFor(c, logoId, signatureId));
  const bytes = format === "pdf" ? (await renderPdf(model, { fonts: await fonts() })).bytes : await renderDocx(model, { fonts: await fonts() });
  return { d, bytes };
}
const fileName = (d: Row, ext: string) => `${(d.number ?? `draft-${String(d.id).slice(0, 8)}`).replace(/[^A-Za-z0-9-]+/g, "-")}_${String(d.buyer?.name ?? "client").replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.${ext}`;

/** Saves a draft's fields and lines with the figures @pulse/invoice-doc works out for them. Lines that are not needed are
 *  kept on a draft at zero and left out of its figures; issuing refuses unfilled open amounts and drops them. */
async function saveDraft(c: PoolClient, v: Viewer, docId: string, body: Body, issuing = false) {
  const d = (await c.query("select id,status,doc_type from pulse.erp_document where id=$1 for update", [docId])).rows[0];
  if (!d) fail(404, "Document not found");
  if (d.status !== "draft") fail(409, "An issued document cannot be edited; cancel it or issue a credit note");
  const f = cleanDraft(body);
  if (issuing) {
    if (unfilledOpen(f.lines)) fail(400, OPEN_UNFILLED);
    f.lines = neededLines(f.lines).kept;
  }
  const s = await settings(c);
  if (!/^\d{2}$/.test(String(s.company.stateCode ?? ""))) fail(400, "Set the company's state in ERP settings first");
  const { kept, index } = neededLines(f.lines);
  const fig = figures(String(s.company.stateCode), { ...f, lines: kept });
  await c.query(`update pulse.erp_document set issue_date=$2,due_date=$3,valid_until=$4,buyer=$5,place_of_supply=$6,reference=$7,notes=$8,terms=$9,reverse_charge=$10,
    zero_rated=$11,round_total=$12,template_id=coalesce($13,template_id),seller=$14,tax_mode=$15,taxable=$16,cgst=$17,sgst=$18,igst=$19,round_off=$20,total=$21,amount_words=$22,
    client_id=coalesce($23,client_id),updated_by=$24 where id=$1`,
    [docId, f.issueDate, f.dueDate, f.validUntil, f.buyer, fig.placeOfSupply, f.reference, f.notes, f.terms, f.reverseCharge, f.zeroRated, f.roundTotal, f.templateId,
      s.company, fig.mode, fig.taxable, fig.cgst, fig.sgst, fig.igst, fig.roundOff, fig.total, fig.words, optId(body.clientId), v.person]);
  const catalogueRates = (await c.query("select item_id,catalogue_rate from pulse.erp_line where document_id=$1 and catalogue_rate is not null order by position", [docId])).rows;
  await c.query("delete from pulse.erp_line where document_id=$1", [docId]);
  for (const [i, src] of f.lines.entries()) {
    const at = index[i];
    const l = at === null ? { discount: src.discount, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 } : fig.lines[at];
    await c.query(`insert into pulse.erp_line(org_id,document_id,position,item_id,description,details,sac,unit,qty,rate,discount,discount_percent,gst_rate,taxable,cgst,sgst,igst,total,
      parent_position,open,not_needed,catalogue_rate) values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [docId, i, src.itemId, src.description, src.details, src.sac, src.unit, src.qty, src.rate, l.discount, src.discountPercent, src.gstRate, l.taxable, l.cgst, l.sgst, l.igst, l.total,
        src.parentIndex, src.open, src.notNeeded, catalogueRates.find(r => r.item_id === src.itemId)?.catalogue_rate ?? null]);
  }
  return fig;
}

/** A new draft, filled from what Pulse knows: the project's client and billing profile, the milestone's package line,
 *  the quotation it converts or the invoice a credit note is against. */
async function createDraft(c: PoolClient, v: Viewer, body: Body) {
  const docType = (DOC_TYPES as readonly string[]).includes(String(body.docType)) ? String(body.docType) as DocType : fail(400, "Choose the kind of document");
  const s = await settings(c);
  const issueDate = await today(c);
  let projectId = optId(body.projectId), clientId = optId(body.clientId), engagementId: string | null = null, milestoneId = optId(body.milestoneId);
  let lines: Body[] = [], reference: Record<string, string> = {}, buyer: Body | null = null, againstId: string | null = null, sourceId: string | null = null, placeOfSupply: string | null = null;
  if (milestoneId) {
    const m = (await c.query(`select m.*,e.project_id,e.client_id,e.name engagement,e.gst_rate,e.package_id,(select count(*) from pulse.erp_milestone x where x.engagement_id=e.id)::int of,
      i.sac,i.unit,coalesce(pr.title,pr.name) project from pulse.erp_milestone m join pulse.erp_engagement e on e.id=m.engagement_id left join pulse.erp_item i on i.id=e.package_id
      left join pulse.project pr on pr.id=e.project_id where m.id=$1`, [milestoneId])).rows[0];
    if (!m) fail(404, "Milestone not found");
    if (m.document_id && docType === "invoice") {
      const existing = (await c.query("select id,status from pulse.erp_document where id=$1", [m.document_id])).rows[0];
      if (existing && existing.status !== "cancelled") return { id: existing.id as string, existing: true };
    }
    projectId = m.project_id; clientId = m.client_id; engagementId = m.engagement_id;
    const parts = m.package_id ? (await c.query("select label,quantity::float8 qty,unit,deliverables from pulse.erp_package_part where package_id=$1 order by position", [m.package_id])).rows : [];
    lines = [{ description: `${m.engagement}: ${m.label}`.slice(0, 300), details: parts.map((p: Row) => `${p.label}${p.qty !== 1 ? ` × ${p.qty}` : ""}`).join(", ").slice(0, 1000),
      sac: m.sac, unit: "milestone", qty: 1, rate: Number(m.amount), gstRate: Number(m.gst_rate) }];
    reference = { project: m.project ?? "", milestone: `${m.label} (${m.position + 1} of ${m.of})` };
  }
  if (body.againstId) {
    if (docType !== "credit_note") fail(400, "Only a credit note is against an invoice");
    const { d, lines: ls } = await loadDoc(c, id(body.againstId, "Invoice"));
    if (d.doc_type !== "invoice" || ["draft", "cancelled"].includes(d.status)) fail(400, "A credit note is against an issued invoice");
    againstId = d.id; projectId = d.project_id; clientId = d.client_id; buyer = d.buyer; placeOfSupply = d.place_of_supply; reference = { ...d.reference };
    lines = ls.map((l: Row) => ({ itemId: l.item_id, description: l.description, details: l.details, sac: l.sac, unit: l.unit, qty: Number(l.qty), rate: Number(l.rate), gstRate: Number(l.gst_rate) }));
  }
  if (body.sourceId) {
    const { d, lines: ls } = await loadDoc(c, id(body.sourceId, "Document"));
    if (!["quotation", "proforma"].includes(d.doc_type) || !["issued", "sent", "accepted"].includes(d.status)) fail(400, "Convert an issued quotation or proforma");
    if (docType !== "invoice" && !(d.doc_type === "quotation" && docType === "proforma")) fail(400, "A quotation becomes a proforma or an invoice; a proforma becomes an invoice");
    // Billing redesign (EST-1237): a retried "Make proforma" opens the one already made instead of a second draft.
    const made = (await c.query("select id from pulse.erp_document where source_id=$1 and doc_type=$2 and status<>'cancelled' order by created_at limit 1", [d.id, docType])).rows[0];
    if (made) return { id: made.id as string, existing: true };
    sourceId = d.id; projectId = d.project_id; clientId = d.client_id; buyer = d.buyer; placeOfSupply = d.place_of_supply; reference = { ...d.reference };
    engagementId = d.engagement_id; milestoneId = d.milestone_id;
    lines = ls.map((l: Row) => ({ itemId: l.item_id, description: l.description, details: l.details, sac: l.sac, unit: l.unit, qty: Number(l.qty), rate: Number(l.rate),
      discount: Number(l.discount), discountPercent: l.discount_percent === null ? null : Number(l.discount_percent), gstRate: Number(l.gst_rate),
      parentIndex: l.parent_position ?? null, open: !!l.open }));
  }
  if (projectId && !clientId) clientId = (await c.query("select client_id from pulse.project where id=$1", [projectId])).rows[0]?.client_id ?? null;
  if (projectId && !reference.project) reference.project = (await c.query("select coalesce(title,name) t from pulse.project where id=$1", [projectId])).rows[0]?.t ?? "";
  if (!buyer && clientId) buyer = await buyerFor(c, clientId);
  const t = await templateFor(c, null, docType);
  const draft = {
    issueDate, dueDate: ["invoice", "proforma"].includes(docType) ? addDays(issueDate, s.dueDays) : null, validUntil: docType === "quotation" ? addDays(issueDate, 30) : null,
    buyer: buyer ?? { name: "" }, placeOfSupply: placeOfSupply ?? (buyer?.stateCode as string | undefined) ?? s.company.stateCode ?? null, reference, notes: "", terms: null,
    roundTotal: s.roundTotal, templateId: t?.id ?? null, lines,
  };
  const docId = (await c.query(`insert into pulse.erp_document(org_id,doc_type,client_id,project_id,engagement_id,milestone_id,against_id,source_id,template_id,seller,created_by,updated_by)
    values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) returning id`, [docType, clientId, projectId, engagementId, milestoneId, againstId, sourceId, t?.id ?? null, s.company, v.person])).rows[0].id as string;
  try { await saveDraft(c, v, docId, draft); } catch (e) { if (!(e instanceof ErpInputError)) throw e; } // an incomplete prefill stays a draft to finish
  if (milestoneId && docType === "invoice") await c.query("update pulse.erp_milestone set document_id=$2 where id=$1", [milestoneId, docId]);
  await log(c, "document", docId, "created", { docType, from: sourceId ? "conversion" : againstId ? "invoice" : milestoneId ? "milestone" : projectId ? "project" : "blank" });
  return { id: docId, existing: false };
}
/** The billing profile, else what the client record and FIN-LIVE's past invoices say. */
async function buyerFor(c: PoolClient, clientId: string): Promise<Body> {
  const p = (await c.query("select legal_name,gstin,state_code,address,email,phone,contact_name,contact_person_id from pulse.erp_party where client_id=$1", [clientId])).rows[0];
  if (p) return { name: p.legal_name, gstin: p.gstin, stateCode: p.state_code, address: p.address, email: p.email, phone: p.phone, contactName: p.contact_name };
  const cl = (await c.query(`select c.display_name,c.company_name,c.email,c.phone,c.city,pc.display_name contact,cp.email contact_email,cp.phone contact_phone
    from pulse.client c left join pulse.person pc on pc.id=c.primary_contact_id left join pulse.contact_profile cp on cp.person_id=c.primary_contact_id where c.id=$1`, [clientId])).rows[0];
  if (!cl) return { name: "" };
  const hint = ((await c.query("select pulse.erp_party_hints($1) h", [clientId])).rows[0].h as Row[])[0];
  const b = cleanBuyer({ gstin: hint?.gstin ?? null });
  return { name: hint?.name ?? cl.company_name ?? cl.display_name, gstin: b.gstin, stateCode: b.stateCode, address: cl.city ? [cl.city] : [], email: cl.contact_email ?? cl.email,
    phone: cl.contact_phone ?? cl.phone, contactName: cl.contact };
}

async function exportDocs(c: PoolClient, from: string, to: string): Promise<ExportDoc[]> {
  const docs = (await c.query(`select d.*,a.number against_number from pulse.erp_document d left join pulse.erp_document a on a.id=d.against_id
    where d.status<>'draft' and d.doc_type in ('invoice','credit_note') and d.issue_date between $1 and $2 order by d.issue_date,d.number`, [from, to])).rows;
  const lines = (await c.query("select * from pulse.erp_line where document_id=any($1) order by document_id,position", [docs.map((d) => d.id)])).rows;
  return docs.map((d) => ({ docType: d.doc_type, number: d.number, status: d.status, issueDate: iso(d.issue_date)!, dueDate: iso(d.due_date), against: d.against_number ?? null,
    buyer: d.buyer, placeOfSupply: d.place_of_supply, taxMode: d.tax_mode, taxable: Number(d.taxable), cgst: Number(d.cgst), sgst: Number(d.sgst), igst: Number(d.igst),
    roundOff: Number(d.round_off), total: Number(d.total), paid: Number(d.paid), credited: Number(d.credited), notes: d.notes || null, terms: d.terms,
    lines: lines.filter((l) => l.document_id === d.id).map((l) => ({ description: l.description, details: l.details, sac: l.sac, unit: l.unit, qty: Number(l.qty), rate: Number(l.rate),
      discount: Number(l.discount), gstRate: Number(l.gst_rate), taxable: Number(l.taxable), cgst: Number(l.cgst), sgst: Number(l.sgst), igst: Number(l.igst), total: Number(l.total) })) }));
}

/** People who may be given an invoice task: they can write in ERP (leadership, Finance, admins with the money grants). */
async function assignees(c: PoolClient) {
  return (await c.query(`select distinct p.id,p.display_name name from pulse.person p join pulse.role_assignment r on r.person_id=p.id
    where p.side='staff' and p.status='active' and current_date between r.valid_from and coalesce(r.valid_to,'infinity')
      and (r.role_key in ('leadership','finance') or r.role_key='admin' and exists(select 1 from pulse.money_permission m where m.person_id=p.id and m.permission='money.plan.write' and m.revoked_at is null))
    order by 2`)).rows;
}

/** Creates the "Generate invoice" task for a draft (its draft linked as proof), assigned to one person. */
async function invoiceTask(c: PoolClient, docId: string, body: Body) {
  const d = (await c.query(`select d.id,d.status,d.doc_type,d.project_id,d.milestone_id,d.task_id,d.reference,coalesce(pr.title,pr.name) project,m.position,
    (select count(*) from pulse.erp_milestone x where x.engagement_id=m.engagement_id)::int of from pulse.erp_document d left join pulse.project pr on pr.id=d.project_id
    left join pulse.erp_milestone m on m.id=d.milestone_id where d.id=$1`, [docId])).rows[0];
  if (!d) fail(404, "Document not found");
  if (d.status !== "draft") fail(409, "The task is for a draft that still has to be issued");
  if (d.task_id) fail(409, "This draft already has a task");
  const assignee = id(body.assigneeId, "Person");
  if (!(await assignees(c)).some((p: Row) => p.id === assignee)) fail(400, "Give invoice tasks to leadership or someone with the Finance role");
  const due = typeof body.dueOn === "string" && DAY.test(body.dueOn) ? body.dueOn : null;
  const noun = DOC_LABELS[d.doc_type as DocType].noun;
  const title = `Generate ${noun} for ${d.project ?? (d.reference?.project || "the client")}${d.milestone_id ? ` milestone ${d.position + 1}` : ""}`.slice(0, 300);
  const taskId = (await c.query("select pulse.task_save(null,$1) id", [{ title, assigneeId: assignee, projectId: d.project_id, ...(due ? { dueOn: due } : {}),
    notes: `Open the draft in ERP, check the client, lines and GST, then issue it. The task is done when the ${noun} is issued.` }])).rows[0].id as string;
  const base = companyOrigin();
  await c.query("select pulse.task_proof_add($1,$2,$3)", [taskId, `${noun[0].toUpperCase()}${noun.slice(1)} draft`, `${base}/erp/documents/${docId}`]);
  await c.query("update pulse.erp_document set task_id=$2 where id=$1", [docId, taskId]);
  if (d.milestone_id) await c.query("update pulse.erp_milestone set task_id=$2 where id=$1", [d.milestone_id, taskId]);
  await log(c, "document", docId, "task", { taskId, assignee });
  return taskId;
}

const ITEM_KINDS = ["service", "product", "consumable", "package"];
function cleanItem(b: Body) {
  const kind = ITEM_KINDS.includes(String(b.kind)) ? String(b.kind) : fail(400, "Choose service, product, consumable or package");
  const name = str(b.name, 160) || fail(400, "Name the item");
  const sac = str(b.sac, 8) || null;
  if (sac && !/^\d{4,8}$/.test(sac)) fail(400, "SAC/HSN is 4 to 8 digits");
  const price = Number(b.price ?? 0), cost = b.cost === null || b.cost === undefined || b.cost === "" ? null : Number(b.cost);
  if (!Number.isInteger(price) || price < 0 || (cost !== null && (!Number.isInteger(cost) || cost < 0))) fail(400, "Prices are amounts in paise");
  const gst = Number(b.gstRate ?? 18);
  if (!GST.includes(gst)) fail(400, "Choose a GST rate");
  const code = str(b.code, 40) || null;
  if (code && !/^[A-Za-z0-9._/-]+$/.test(code)) fail(400, "A code uses letters, digits and . _ / -");
  const status = ["draft", "active", "archived"].includes(String(b.status)) ? String(b.status) : "draft";
  const trackStock = kind !== "package" && kind !== "service" && b.trackStock === true;
  const reorder = trackStock && b.reorderLevel !== null && b.reorderLevel !== undefined && b.reorderLevel !== "" ? Number(b.reorderLevel) : null;
  if (reorder !== null && (!Number.isFinite(reorder) || reorder < 0)) fail(400, "The low-stock level is a number");
  const milestones = Array.isArray(b.milestones) ? b.milestones.slice(0, 24).map((m: Body) => ({ label: str(m.label, 120) || "Instalment", percent: Number(m.percent) || 0, offsetDays: Math.max(0, Math.min(1095, Number(m.offsetDays) || 0)) })) : [];
  if (milestones.length && Math.abs(milestones.reduce((n, m) => n + m.percent, 0) - 100) > 0.001) fail(400, "Milestone percentages add up to 100");
  return { kind, name, code, sac, unit: str(b.unit, 20) || (kind === "service" ? "nos" : "nos"), description: str(b.description, 4000), setup: str(b.setup, 4000),
    price, cost, gstRate: gst, status, trackStock, reorder, milestones };
}

export function registerErpRoutes(app: FastifyInstance, { tx, open }: { tx: Tx; open: Open }) {
  // ------------------------------------------------------------------------------------------------- overview
  app.get("/api/v0/erp", (req) => tx(req, async (c, v) => {
    await reader(c);
    const s = await settings(c);
    const t = await today(c), fy = financialYear(t);
    const k = (await c.query(`select count(*) filter (where status='draft')::int drafts,
      coalesce(sum(total) filter (where doc_type='invoice' and status not in ('draft','cancelled') and issue_date>=$1),0)::float8 invoiced,
      coalesce(sum(total-paid-credited) filter (where doc_type='invoice' and status in ('issued','sent','part_paid')),0)::float8 outstanding,
      coalesce(sum(total-paid-credited) filter (where doc_type='invoice' and status in ('issued','sent','part_paid') and due_date<$2),0)::float8 overdue,
      count(*) filter (where doc_type='invoice' and status in ('issued','sent','part_paid') and due_date<$2)::int "overdueCount",
      count(*) filter (where doc_type='quotation' and status in ('issued','sent'))::int "openQuotes"
      from pulse.erp_document`, [fy.start, t])).rows[0];
    const collected = (await c.query("select coalesce(sum(amount+tds),0)::float8 n from pulse.erp_payment where voided_at is null and received_on>=date_trunc('month',$1::date)", [t])).rows[0].n;
    // Invoices due from milestones: due within two weeks (or past) and not yet issued.
    const due = (await c.query(`select m.id,m.label,m.amount::float8 amount,to_char(m.due_on,'YYYY-MM-DD') "dueOn",m.position,e.id "engagementId",e.name engagement,
      e.project_id "projectId",coalesce(pr.title,pr.name) project,cl.display_name client,d.id "documentId",d.status "documentStatus",
      t.id "taskId",t.status "taskStatus",(select display_name from pulse.person where id=t.assignee_person_id) assignee
      from pulse.erp_milestone m join pulse.erp_engagement e on e.id=m.engagement_id and e.status='active' left join pulse.project pr on pr.id=e.project_id
      left join pulse.client cl on cl.id=e.client_id left join pulse.erp_document d on d.id=m.document_id left join pulse.task t on t.id=m.task_id
      where (d.id is null or d.status in ('draft','cancelled')) and m.due_on<=$1::date+14 order by m.due_on,e.name limit 50`, [t])).rows;
    const recent = (await c.query(`select ${DOC_COLS} from pulse.erp_document d order by d.updated_at desc limit 8`)).rows;
    const overdue = (await c.query(`select ${DOC_COLS} from pulse.erp_document d where doc_type='invoice' and status in ('issued','sent','part_paid') and due_date<$1 order by due_date limit 20`, [t])).rows;
    const lowStock = s.inventoryEnabled ? (await c.query(`select i.id,i.name,i.unit,i.reorder_level::float8 "reorderLevel",pulse.erp_on_hand(i.id)::float8 "onHand" from pulse.erp_item i
      where i.track_stock and i.status<>'archived' and pulse.erp_on_hand(i.id)<=coalesce(i.reorder_level,0) order by i.name`)).rows : [];
    const catalog = (await c.query("select count(*) filter (where kind<>'package')::int items,count(*) filter (where kind='package')::int packages,count(*) filter (where status='draft')::int drafts from pulse.erp_item where status<>'archived'")).rows[0];
    const { write } = await can(c);
    return { canWrite: write, accountant: v.role === "accountant", today: t, fy: fy.label, settings: { company: s.company, inventoryEnabled: s.inventoryEnabled }, kpis: { ...k, collected },
      due, recent, overdue, lowStock, catalog, assignees: write ? await assignees(c) : [], mirror: mirrorStatus() };
  }));
  app.get("/api/v0/erp/log", (req) => tx(req, async (c) => {
    await reader(c);
    return { events: (await c.query(`select e.id,e.subject_type "subjectType",e.subject_id "subjectId",e.kind,e.detail,e.at,p.display_name actor,
      d.number,d.doc_type "docType",i.name item from pulse.erp_event e left join pulse.person p on p.id=e.actor left join pulse.erp_document d on d.id=e.subject_id
      left join pulse.erp_item i on i.id=e.subject_id order by e.at desc limit 200`)).rows };
  }));

  // ------------------------------------------------------------------------------------------------- settings
  app.get("/api/v0/erp/settings", (req) => tx(req, async (c) => {
    await reader(c);
    const fy = financialYear(await today(c));
    const series = (await c.query(`select doc_type "docType",fy,pattern,next_no "nextNo",to_char(last_date,'YYYY-MM-DD') "lastDate" from pulse.erp_series order by fy desc,doc_type`)).rows;
    const defaults = (await c.query("select doc_type \"docType\",template_id \"templateId\" from pulse.erp_template_default")).rows;
    return { ...(await settings(c)), fy: fy.label, today: await today(c), series, defaults, canWrite: (await can(c)).write, mirror: mirrorStatus(), esign: ESIGN_OPTIONS };
  }));
  app.post<{ Body: Body }>("/api/v0/erp/settings", (req) => tx(req, async (c, v) => {
    await writer(c);
    const b = req.body ?? {};
    const co = (b.company && typeof b.company === "object" ? b.company : {}) as Body;
    const buyerLike = cleanBuyer({ gstin: co.gstin, stateCode: co.stateCode });
    const company = { legalName: str(co.legalName, 200), tradeName: str(co.tradeName, 200), gstin: buyerLike.gstin, stateCode: buyerLike.stateCode ?? "27",
      pan: buyerLike.gstin ? buyerLike.gstin.slice(2, 12) : str(co.pan, 10).toUpperCase() || null,
      address: Array.isArray(co.address) ? co.address.map((x) => str(x, 160)).filter(Boolean).slice(0, 5) : [], email: str(co.email, 200), phone: str(co.phone, 40), website: str(co.website, 120) };
    if (!company.legalName) fail(400, "The company's legal name is required");
    const dueDays = Math.max(0, Math.min(365, Number(b.dueDays ?? 15) || 0));
    await c.query(`update pulse.erp_settings set company=$1,inventory_enabled=$2,due_days=$3,round_total=$4,updated_by=$5,updated_at=now()`,
      [company, b.inventoryEnabled === true, dueDays, b.roundTotal !== false, v.person]);
    // Numbering patterns for this financial year, while nothing is numbered in them yet.
    const fy = financialYear(await today(c));
    for (const [docType, pattern] of Object.entries((b.patterns && typeof b.patterns === "object" ? b.patterns : {}) as Record<string, unknown>)) {
      if (!(DOC_TYPES as readonly string[]).includes(docType) || typeof pattern !== "string") continue;
      const problem = numberProblem(pattern.trim(), fy);
      if (problem) fail(400, `${DOC_LABELS[docType as DocType].title}: ${problem}`);
      const r = await c.query(`insert into pulse.erp_series(org_id,doc_type,fy,pattern) values(pulse.current_org(),$1,$2,$3)
        on conflict(org_id,doc_type,fy) do update set pattern=excluded.pattern where erp_series.next_no=1 returning id`, [docType, fy.label, pattern.trim()]);
      if (!r.rowCount) {
        const now = (await c.query("select pattern from pulse.erp_series where doc_type=$1 and fy=$2", [docType, fy.label])).rows[0]?.pattern;
        if (now !== pattern.trim()) fail(409, `${DOC_LABELS[docType as DocType].title} numbers have started this year; the pattern stays until next April`);
      }
    }
    await log(c, "settings", null, "saved", { inventory: b.inventoryEnabled === true });
    return settings(c);
  }));

  // ---------------------------------------------------------------------------------------------------- catalog
  app.get("/api/v0/erp/items", (req) => tx(req, async (c) => {
    await reader(c);
    const items = (await c.query(`select i.id,i.kind,i.code,i.name,i.description,i.sac,i.unit,i.price::float8 price,i.gst_rate::float8 "gstRate",i.cost::float8 cost,
      i.track_stock "trackStock",i.reorder_level::float8 "reorderLevel",i.status,i.version,i.source,i.updated_at "updatedAt",
      (select count(*)::int from pulse.erp_package_part p where p.package_id=i.id) parts,
      case when i.track_stock then pulse.erp_on_hand(i.id)::float8 end "onHand",
      (select count(*)::int from pulse.erp_engagement e where e.package_id=i.id) sold,${ITEM_EXTRAS}
      from pulse.erp_item i order by i.status='archived',i.kind='package' desc,i.name`)).rows;
    return { items, inventoryEnabled: (await settings(c)).inventoryEnabled, canWrite: (await can(c)).write };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/erp/items/:id", (req) => tx(req, async (c) => {
    await reader(c);
    const itemId = id(req.params.id, "Item");
    const item = (await c.query(`select i.id,i.kind,i.code,i.name,i.description,i.sac,i.unit,i.price::float8 price,i.gst_rate::float8 "gstRate",i.cost::float8 cost,i.track_stock "trackStock",
      i.reorder_level::float8 "reorderLevel",i.milestones,i.setup,i.status,i.version,i.source,i.created_at "createdAt",i.updated_at "updatedAt",
      case when i.track_stock then pulse.erp_on_hand(i.id)::float8 end "onHand",${ITEM_EXTRAS} from pulse.erp_item i where i.id=$1`, [itemId])).rows[0];
    if (!item) fail(404, "Item not found");
    const parts = (await c.query(`select p.id,p.item_id "itemId",i.name "itemName",i.price::float8 "itemPrice",p.label,p.quantity::float8 quantity,p.unit,p.deliverables,p.where_text "where",
      p.setup,p.derives,p.price::float8 price,p.cost::float8 cost from pulse.erp_package_part p left join pulse.erp_item i on i.id=p.item_id where p.package_id=$1 order by p.position`, [itemId])).rows;
    const versions = (await c.query(`select v.version,v.changed_at "changedAt",p.display_name "changedBy",(v.snapshot->>'price')::float8 price,(v.snapshot->>'cost')::float8 cost,
      v.snapshot->>'status' status,v.snapshot->>'name' name,jsonb_array_length(coalesce(v.snapshot->'parts','[]'))::int parts
      from pulse.erp_item_version v left join pulse.person p on p.id=v.changed_by where v.item_id=$1 order by v.version desc`, [itemId])).rows;
    const usedIn = (await c.query(`select distinct i.id,i.name from pulse.erp_package_part p join pulse.erp_item i on i.id=p.package_id where p.item_id=$1 order by i.name`, [itemId])).rows;
    const moves = (await c.query(`select m.id,m.kind,m.qty::float8 qty,m.unit_cost::float8 "unitCost",m.note,to_char(m.on_date,'YYYY-MM-DD') "onDate",p.display_name "by"
      from pulse.erp_stock_move m left join pulse.person p on p.id=m.created_by where m.item_id=$1 order by m.on_date desc,m.created_at desc limit 100`, [itemId])).rows;
    const engagements = (await c.query(`select e.id,e.name,e.price::float8 price,e.package_version "packageVersion",e.status,e.project_id "projectId",coalesce(pr.title,pr.name) project
      from pulse.erp_engagement e left join pulse.project pr on pr.id=e.project_id where e.package_id=$1 order by e.created_at desc limit 50`, [itemId])).rows;
    const options = (await c.query(`select id,name,kind,unit,price::float8 price,sac from pulse.erp_item where kind<>'package' and status<>'archived' and id<>$1 order by name`, [itemId])).rows;
    return { item, parts, versions, usedIn, moves, engagements, options, inventoryEnabled: (await settings(c)).inventoryEnabled, canWrite: (await can(c)).write };
  }));
  app.post<{ Body: Body }>("/api/v0/erp/items", (req) => tx(req, async (c, v) => {
    await writer(c);
    const i = cleanItem(req.body ?? {});
    const itemId = (await c.query(`insert into pulse.erp_item(org_id,kind,code,name,description,sac,unit,price,gst_rate,cost,track_stock,reorder_level,milestones,setup,status,source,created_by,updated_by)
      values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'{"type":"manual"}',$15,$15) returning id`,
      [i.kind, i.code, i.name, i.description, i.sac, i.unit, i.price, i.gstRate, i.cost, i.trackStock, i.reorder, JSON.stringify(i.milestones), i.setup, i.status, v.person])).rows[0].id;
    if (req.body?.addOnIds !== undefined) await setAddOns(c, itemId, req.body.addOnIds);
    await log(c, "item", itemId, "created", { kind: i.kind, name: i.name });
    return { id: itemId };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/items/:id", (req) => tx(req, async (c, v) => {
    await writer(c);
    const itemId = id(req.params.id, "Item");
    const before = (await c.query("select kind,price from pulse.erp_item where id=$1", [itemId])).rows[0];
    if (!before) fail(404, "Item not found");
    const i = cleanItem({ ...req.body, kind: before.kind });
    await c.query(`update pulse.erp_item set code=$2,name=$3,description=$4,sac=$5,unit=$6,price=$7,gst_rate=$8,cost=$9,track_stock=$10,reorder_level=$11,milestones=$12,setup=$13,status=$14,updated_by=$15 where id=$1`,
      [itemId, i.code, i.name, i.description, i.sac, i.unit, i.price, i.gstRate, i.cost, i.trackStock, i.reorder, JSON.stringify(i.milestones), i.setup, i.status, v.person]);
    if (req.body?.addOnIds !== undefined) await setAddOns(c, itemId, req.body.addOnIds);
    await log(c, "item", itemId, "saved", Number(before.price) !== i.price ? { price: [Number(before.price), i.price] } : {});
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/items/:id/parts", (req) => tx(req, async (c) => {
    await writer(c);
    const parts = Array.isArray(req.body?.parts) ? req.body.parts : fail(400, "Parts are a list");
    const clean = (parts as Body[]).map((p, n) => {
      const label = str(p.label, 160) || fail(400, `Part ${n + 1}: name it`);
      const quantity = Number(p.quantity ?? 1);
      if (!Number.isFinite(quantity) || quantity <= 0) fail(400, `Part ${n + 1}: the quantity is a positive number`);
      const money = (x: unknown) => (x === null || x === undefined || x === "" ? null : Number.isInteger(Number(x)) && Number(x) >= 0 ? Number(x) : fail(400, `Part ${n + 1}: amounts are in paise`));
      return { label, itemId: optId(p.itemId), quantity, unit: str(p.unit, 20), deliverables: Array.isArray(p.deliverables) ? p.deliverables.map((x) => str(x, 200)).filter(Boolean).slice(0, 20) : [],
        where: str(p.where, 1000), setup: str(p.setup, 2000), derives: str(p.derives, 1000), price: money(p.price), cost: money(p.cost) };
    });
    return { parts: (await c.query("select pulse.erp_parts_set($1,$2) n", [id(req.params.id, "Package"), JSON.stringify(clean)])).rows[0].n };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/items/:id/stock", (req) => tx(req, async (c, v) => {
    await writer(c);
    const b = req.body ?? {};
    const kind = ["in", "out", "adjust"].includes(String(b.kind)) ? String(b.kind) : fail(400, "Choose stock in, out or an adjustment");
    const qty = Number(b.qty);
    if (!Number.isFinite(qty) || qty === 0 || (kind !== "adjust" && qty < 0)) fail(400, "Enter the quantity");
    const unitCost = b.unitCost === null || b.unitCost === undefined || b.unitCost === "" ? null : Number(b.unitCost);
    if (unitCost !== null && (!Number.isInteger(unitCost) || unitCost < 0)) fail(400, "The unit cost is an amount in paise");
    const moveId = (await c.query(`insert into pulse.erp_stock_move(org_id,item_id,kind,qty,unit_cost,note,on_date,created_by) values(pulse.current_org(),$1,$2,$3,$4,$5,coalesce($6::date,(now() at time zone ${ORG_TZ})::date),$7) returning id`,
      [id(req.params.id, "Item"), kind, qty, unitCost, str(b.note, 500), typeof b.onDate === "string" && DAY.test(b.onDate) ? b.onDate : null, v.person])).rows[0].id;
    await log(c, "stock", req.params.id, kind, { qty });
    return { id: moveId, onHand: Number((await c.query("select pulse.erp_on_hand($1) n", [req.params.id])).rows[0].n) };
  }));

  // -------------------------------------------------------------------------------------------------- templates
  app.get("/api/v0/erp/templates", (req) => tx(req, async (c) => {
    await reader(c);
    const templates = (await c.query(`select t.id,t.name,t.doc_types "docTypes",t.design,t.logo_id "logoId",t.signature_id "signatureId",t.archived,t.updated_at "updatedAt",
      coalesce((select array_agg(doc_type) from pulse.erp_template_default x where x.template_id=t.id),'{}') "defaultFor" from pulse.erp_template t order by t.archived,t.created_at`)).rows;
    const s = await settings(c);
    const brand = (await c.query("select logo_png is not null png from pulse.org_brand where org_id=pulse.current_org()")).rows[0];
    return { templates, company: s.company, orgLogo: !!brand?.png, sample: sampleDocument(s.company), canWrite: (await can(c)).write };
  }));
  app.post<{ Body: Body }>("/api/v0/erp/templates", (req) => tx(req, async (c, v) => {
    await writer(c);
    const from = optId(req.body?.copyOf);
    const base = from ? (await c.query("select name,design,logo_id,signature_id,doc_types from pulse.erp_template where id=$1", [from])).rows[0] : null;
    const name = str(req.body?.name, 80) || (base ? `${base.name} copy` : "New template");
    const tid = (await c.query(`insert into pulse.erp_template(org_id,name,design,logo_id,signature_id,doc_types,created_by,updated_by) values(pulse.current_org(),$1,$2,$3,$4,coalesce($5::text[],'{invoice,proforma,quotation,credit_note}'::text[]),$6,$6) returning id`,
      [name, base?.design ?? { style: "line" }, base?.logo_id ?? null, base?.signature_id ?? null, base?.doc_types ?? null, v.person])).rows[0].id;
    await log(c, "template", tid, "created", { name });
    return { id: tid };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/templates/:id", (req) => tx(req, async (c, v) => {
    await writer(c);
    const tid = id(req.params.id, "Template");
    const b = req.body ?? {};
    const docTypes = Array.isArray(b.docTypes) ? b.docTypes.filter((x) => (DOC_TYPES as readonly string[]).includes(String(x))) : null;
    if (docTypes && !docTypes.length) fail(400, "A template is for at least one kind of document");
    const design = b.design && typeof b.design === "object" ? b.design : null;
    if (design && JSON.stringify(design).length > 20000) fail(400, "The template is too large");
    const r = await c.query(`update pulse.erp_template set name=coalesce(nullif($2,''),name),design=coalesce($3,design),doc_types=coalesce($4,doc_types),
      logo_id=case when $5 then $6::uuid else logo_id end,signature_id=case when $7 then $8::uuid else signature_id end,archived=coalesce($9,archived),updated_by=$10,updated_at=now() where id=$1`,
      [tid, str(b.name, 80), design, docTypes, "logoId" in b, optId(b.logoId), "signatureId" in b, optId(b.signatureId), typeof b.archived === "boolean" ? b.archived : null, v.person]);
    if (!r.rowCount) fail(404, "Template not found");
    for (const t of Array.isArray(b.defaultFor) ? b.defaultFor : []) {
      if (!(DOC_TYPES as readonly string[]).includes(String(t))) continue;
      await c.query(`insert into pulse.erp_template_default(org_id,doc_type,template_id) values(pulse.current_org(),$1,$2) on conflict(org_id,doc_type) do update set template_id=excluded.template_id`, [t, tid]);
    }
    await log(c, "template", tid, "saved", { defaults: b.defaultFor ?? [] });
    return { ok: true };
  }));
  app.post<{ Body: Body }>("/api/v0/erp/assets", (req) => tx(req, async (c, v) => {
    await writer(c);
    const kind = req.body?.kind === "signature" ? "signature" : req.body?.kind === "logo" ? "logo" : fail(400, "Upload a logo or a signature");
    const mime = ["image/png", "image/jpeg"].includes(String(req.body?.mime)) ? String(req.body?.mime) : fail(400, "Use a PNG or JPEG image");
    const bytes = Buffer.from(String(req.body?.data ?? ""), "base64");
    if (!bytes.length || bytes.length > 400000) fail(400, "Images up to 400 KB");
    const ok = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!ok) fail(400, "That file is not the image it says it is");
    const aid = (await c.query(`insert into pulse.erp_asset(org_id,kind,mime,bytes,sha256,created_by) values(pulse.current_org(),$1,$2,$3,$4,$5) returning id`,
      [kind, mime, bytes, createHash("sha256").update(bytes).digest("hex"), v.person])).rows[0].id;
    return { id: aid };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/erp/assets/:id", async (req, reply) => {
    const r = await tx(req, async (c) => { await reader(c);
      if (req.params.id === "org-logo") return (await c.query("select logo_png bytes,'image/png' mime from pulse.org_brand where org_id=pulse.current_org() and logo_png is not null")).rows[0];
      return (await c.query("select bytes,mime from pulse.erp_asset where id=$1", [id(req.params.id, "Image")])).rows[0]; });
    if (!r) fail(404, "Image not found");
    reply.header("cache-control", "private, max-age=3600");
    return reply.type(r.mime).send(r.bytes);
  });

  // ---------------------------------------------------------------------------------- projects and billing data
  app.get<{ Querystring: { q?: string } }>("/api/v0/erp/projects", (req) => tx(req, async (c) => {
    await reader(c);
    const q = str(req.query.q, 80);
    const rows = (await c.query(`select p.id,coalesce(p.title,p.name) title,p.location,to_char(p.start_month,'YYYY-MM') "month",c.id "clientId",c.display_name client,
      (select count(*)::int from pulse.erp_engagement e where e.project_id=p.id) engagements,(select count(*)::int from pulse.erp_document d where d.project_id=p.id) documents,
      exists(select 1 from pulse.erp_party x where x.client_id=p.client_id) billing
      from pulse.project p left join pulse.client c on c.id=p.client_id
      where p.kind='client_work' and ($1='' or coalesce(p.title,p.name) ilike '%'||$1||'%' or c.display_name ilike '%'||$1||'%' or c.company_name ilike '%'||$1||'%')
      order by (select count(*) from pulse.erp_engagement e where e.project_id=p.id) desc,p.start_month desc nulls last limit 40`, [q])).rows;
    return { projects: rows };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/erp/projects/:id", (req) => tx(req, async (c) => {
    await reader(c);
    const projectId = id(req.params.id, "Project");
    const project = (await c.query(`select p.id,coalesce(p.title,p.name) title,p.name folder,p.location,to_char(p.start_month,'YYYY-MM') "month",p.client_id "clientId" from pulse.project p where p.id=$1`, [projectId])).rows[0];
    if (!project) fail(404, "Project not found");
    const client = project.clientId ? (await c.query(`select id,display_name name,company_name "companyName",email,phone,city from pulse.client where id=$1`, [project.clientId])).rows[0] : null;
    const party = client ? (await c.query(`select legal_name "legalName",gstin,state_code "stateCode",address,email,phone,contact_person_id "contactPersonId",contact_name "contactName",notes,source,updated_at "updatedAt"
      from pulse.erp_party where client_id=$1`, [client.id])).rows[0] ?? null : null;
    const { write } = await can(c);
    const hints = client && write ? (await c.query("select pulse.erp_party_hints($1) h", [client.id])).rows[0].h : [];
    const contacts = client ? (await c.query(`select p.id,p.display_name name,cp.designation,cp.email,cp.phone,cc.is_primary "primary",'client' via from pulse.client_contact cc join pulse.person p on p.id=cc.person_id
      left join pulse.contact_profile cp on cp.person_id=p.id where cc.client_id=$1
      union all select p.id,p.display_name,cp.designation,cp.email,cp.phone,false,x.role from pulse.project_contact x join pulse.person p on p.id=x.person_id
      left join pulse.contact_profile cp on cp.person_id=p.id where x.project_id=$2 and not exists(select 1 from pulse.client_contact cc where cc.client_id=$1 and cc.person_id=x.person_id)
      order by 5 desc,2`, [client.id, projectId])).rows : [];
    const engagements = (await c.query(`select e.id,e.name,e.package_id "packageId",e.package_version "packageVersion",e.price::float8 price,e.gst_rate::float8 "gstRate",to_char(e.starts_on,'YYYY-MM-DD') "startsOn",e.status,
      coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'position',m.position,'label',m.label,'amount',m.amount,'dueOn',to_char(m.due_on,'YYYY-MM-DD'),'documentId',m.document_id,
        'documentStatus',d.status,'number',d.number,'taskId',m.task_id,'taskStatus',t.status,'assignee',(select display_name from pulse.person where id=t.assignee_person_id)) order by m.position)
        from pulse.erp_milestone m left join pulse.erp_document d on d.id=m.document_id left join pulse.task t on t.id=m.task_id where m.engagement_id=e.id),'[]') milestones
      from pulse.erp_engagement e where e.project_id=$1 order by e.created_at`, [projectId])).rows;
    const documents = (await c.query(`select ${DOC_COLS} from pulse.erp_document d where d.project_id=$1 order by d.created_at desc`, [projectId])).rows;
    const packages = (await c.query(`select id,name,price::float8 price,gst_rate::float8 "gstRate",milestones,status,version from pulse.erp_item where kind='package' and status<>'archived' order by status='active' desc,name`)).rows;
    return { project, client, party, hints, contacts, engagements, documents, packages, canWrite: write };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/parties/:id", (req) => tx(req, async (c, v) => {
    await writer(c);
    const clientId = id(req.params.id, "Client");
    const b = cleanBuyer(req.body);
    if (!b.name) fail(400, "The client's legal name is required");
    const contact = optId(req.body?.contactPersonId);
    await c.query(`insert into pulse.erp_party(org_id,client_id,legal_name,gstin,state_code,address,email,phone,contact_person_id,contact_name,notes,source,updated_by)
      values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(client_id) do update set legal_name=excluded.legal_name,gstin=excluded.gstin,state_code=excluded.state_code,
      address=excluded.address,email=excluded.email,phone=excluded.phone,contact_person_id=excluded.contact_person_id,contact_name=excluded.contact_name,notes=excluded.notes,
      source=excluded.source,updated_by=excluded.updated_by,updated_at=now()`,
      [clientId, b.name, b.gstin, b.stateCode, b.address, b.email, b.phone, contact, b.contactName, str(req.body?.notes, 1000), { type: "manual", hint: str(req.body?.hint, 40) || null }, v.person]);
    await log(c, "party", clientId, "saved", { gstin: !!b.gstin });
    return { ok: true };
  }));
  app.post<{ Body: Body }>("/api/v0/erp/engagements", (req) => tx(req, async (c, v) => {
    await writer(c);
    const b = req.body ?? {};
    const projectId = id(b.projectId, "Project");
    const project = (await c.query("select client_id,coalesce(title,name) title from pulse.project where id=$1", [projectId])).rows[0];
    if (!project) fail(404, "Project not found");
    const pkg = optId(b.packageId) ? (await c.query("select id,name,price,gst_rate,milestones,version from pulse.erp_item where id=$1 and kind='package'", [b.packageId])).rows[0] : null;
    if (b.packageId && !pkg) fail(400, "Choose a package from the catalog");
    const price = b.price === undefined ? Number(pkg?.price ?? 0) : Number(b.price);
    if (!Number.isInteger(price) || price < 0) fail(400, "The price is an amount in paise");
    const gst = Number(b.gstRate ?? pkg?.gst_rate ?? 18);
    if (!GST.includes(gst)) fail(400, "Choose a GST rate");
    const startsOn = typeof b.startsOn === "string" && DAY.test(b.startsOn) ? b.startsOn : await today(c);
    const plan = Array.isArray(b.milestones) && b.milestones.length ? (b.milestones as Body[]).map((m) => ({ label: str(m.label, 160) || "Instalment", amount: Number(m.amount), dueOn: typeof m.dueOn === "string" && DAY.test(m.dueOn) ? m.dueOn : null }))
      : milestonePlan(price, pkg?.milestones ?? [], startsOn);
    if (plan.some((m) => !Number.isInteger(m.amount) || m.amount < 0) || plan.reduce((n, m) => n + m.amount, 0) !== price) fail(400, "The milestones add up to the price");
    const eid = (await c.query(`insert into pulse.erp_engagement(org_id,project_id,client_id,package_id,package_version,name,price,gst_rate,starts_on,created_by)
      values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [projectId, project.client_id, pkg?.id ?? null, pkg?.version ?? null,
      str(b.name, 200) || pkg?.name || `${project.title} package`, price, gst, startsOn, v.person])).rows[0].id;
    for (const [i, m] of plan.entries()) await c.query("insert into pulse.erp_milestone(org_id,engagement_id,position,label,amount,due_on) values(pulse.current_org(),$1,$2,$3,$4,$5)", [eid, i, m.label, m.amount, m.dueOn]);
    await log(c, "engagement", eid, "created", { projectId, price, milestones: plan.length });
    return { id: eid };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/engagements/:id", (req) => tx(req, async (c) => {
    await writer(c);
    const eid = id(req.params.id, "Client package");
    const b = req.body ?? {};
    if (["active", "completed", "cancelled"].includes(String(b.status))) await c.query("update pulse.erp_engagement set status=$2,updated_at=now() where id=$1", [eid, b.status]);
    for (const m of Array.isArray(b.milestones) ? b.milestones as Body[] : []) {
      const mid = id(m.id, "Milestone");
      const locked = (await c.query("select d.status from pulse.erp_milestone x join pulse.erp_document d on d.id=x.document_id where x.id=$1 and d.status not in ('draft','cancelled')", [mid])).rows[0];
      if (locked && m.amount !== undefined) fail(409, "An invoiced milestone keeps its amount");
      await c.query("update pulse.erp_milestone set label=coalesce(nullif($2,''),label),due_on=coalesce($3::date,due_on),amount=coalesce($4,amount) where id=$1 and engagement_id=$5",
        [mid, str(m.label, 160), typeof m.dueOn === "string" && DAY.test(m.dueOn) ? m.dueOn : null, m.amount === undefined ? null : Number(m.amount), eid]);
    }
    await log(c, "engagement", eid, "saved");
    return { ok: true };
  }));
  // A milestone's invoice: the draft (made once), and optionally the task for one person to generate it.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/milestones/:id/invoice", (req) => tx(req, async (c, v) => {
    await writer(c);
    const made = await createDraft(c, v, { docType: "invoice", milestoneId: id(req.params.id, "Milestone") });
    const taskId = req.body?.assigneeId ? await invoiceTask(c, made.id, req.body) : null;
    return { id: made.id, existing: made.existing, taskId };
  }));

  // -------------------------------------------------------------------------------------------------- documents
  app.get<{ Querystring: { type?: string; status?: string; q?: string } }>("/api/v0/erp/documents", (req) => tx(req, async (c) => {
    await reader(c);
    const type = (DOC_TYPES as readonly string[]).includes(String(req.query.type)) ? String(req.query.type) : null;
    const rows = (await c.query(`select ${DOC_COLS},coalesce(pr.title,pr.name) project from pulse.erp_document d left join pulse.project pr on pr.id=d.project_id
      where ($1::text is null or d.doc_type=$1) order by d.status='draft' desc,d.issue_date desc,d.number desc nulls first limit 500`, [type])).rows;
    return { documents: rows, today: await today(c), canWrite: (await can(c)).write };
  }));
  app.post<{ Body: Body }>("/api/v0/erp/documents", (req) => tx(req, async (c, v) => {
    await writer(c);
    return createDraft(c, v, req.body ?? {});
  }));
  app.get<{ Params: { id: string } }>("/api/v0/erp/documents/:id", (req) => tx(req, async (c) => {
    await reader(c);
    const docId = id(req.params.id, "Document");
    const doc = (await c.query(`select ${DOC_COLS} from pulse.erp_document d where d.id=$1`, [docId])).rows[0];
    if (!doc) fail(404, "Document not found");
    const lines = (await c.query(`select ${LINE_COLS} from pulse.erp_line where document_id=$1 order by position`, [docId])).rows;
    const payments = (await c.query(`select p.id,to_char(p.received_on,'YYYY-MM-DD') "receivedOn",p.amount::float8 amount,p.tds::float8 tds,p.method,p.reference,p.bank_line_key "bankLineKey",p.note,
      p.voided_at "voidedAt",p.void_reason "voidReason",x.display_name "by" from pulse.erp_payment p left join pulse.person x on x.id=p.created_by where p.document_id=$1 order by p.received_on`, [docId])).rows;
    const events = (await c.query(`select e.kind,e.detail,e.at,p.display_name actor from pulse.erp_event e left join pulse.person p on p.id=e.actor where e.subject_id=$1 order by e.at desc limit 100`, [docId])).rows;
    const related = (await c.query(`select ${DOC_COLS} from pulse.erp_document d where d.against_id=$1 or d.source_id=$1 or d.id=(select against_id from pulse.erp_document where id=$1)
      or d.id=(select source_id from pulse.erp_document where id=$1) order by d.created_at`, [docId])).rows;
    const file = (await c.query("select sha256,created_at \"createdAt\",octet_length(bytes)::int size from pulse.erp_document_file where document_id=$1 and kind='pdf'", [docId])).rows[0] ?? null;
    const template = await templateFor(c, doc.templateId, doc.docType);
    const templates = (await c.query(`select id,name,doc_types "docTypes",design,logo_id "logoId",signature_id "signatureId" from pulse.erp_template where not archived order by created_at`)).rows;
    const orgLogo = !!(await c.query("select 1 from pulse.org_brand where org_id=pulse.current_org() and logo_png is not null")).rows[0];
    const task = doc.taskId ? (await c.query(`select t.id,t.title,t.status,to_char(t.due_at,'YYYY-MM-DD') "dueOn",p.display_name assignee from pulse.task t left join pulse.person p on p.id=t.assignee_person_id where t.id=$1`, [doc.taskId])).rows[0] ?? null : null;
    const links = (await c.query(`select created_at "createdAt",expires_at "expiresAt",revoked_at "revokedAt",opened_at "openedAt",decided_at "decidedAt",decision,signer_name "signer" from pulse.erp_accept_link where document_id=$1 order by created_at desc`, [docId])).rows;
    const { write } = await can(c);
    const bank = write && doc.docType === "invoice" && !["draft", "cancelled", "paid"].includes(doc.status) ? (await c.query("select pulse.erp_bank_hints($1) h", [docId])).rows[0].h : [];
    const items = (await c.query(`select i.id,i.kind,i.name,i.description,i.sac,i.unit,i.price::float8 price,i.gst_rate::float8 "gstRate",i.status,i.code,${ITEM_EXTRAS}
      from pulse.erp_item i where i.status<>'archived' order by i.kind='package' desc,i.name`)).rows;
    // FIN-LIVE's registers (sales register, collections, reconcile) take issued invoices at each sync.
    const financeSyncedAt = (await c.query("select pulse.erp_finance_synced_at() t")).rows[0].t;
    return { document: doc, lines, payments, events, related, file, task, links, bank, items, templates, financeSyncedAt, orgLogo,
      template: template ? { id: template.id, name: template.name, design: template.design, logoId: template.logo_id, signatureId: template.signature_id } : null,
      company: (await settings(c)).company, canWrite: write, today: await today(c), assignees: write && doc.status === "draft" && !doc.taskId ? await assignees(c) : [] };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id", (req) => tx(req, async (c, v) => {
    await writer(c);
    const docId = id(req.params.id, "Document");
    const fig = await saveDraft(c, v, docId, req.body ?? {});
    await log(c, "document", docId, "edited", { total: fig.total, lines: fig.lines.length });
    return { ok: true, total: fig.total, mode: fig.mode };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/delete", (req) => tx(req, async (c) => {
    await writer(c);
    const docId = id(req.params.id, "Document");
    const d = (await c.query("select status,task_id from pulse.erp_document where id=$1", [docId])).rows[0];
    if (!d) fail(404, "Document not found");
    if (d.status !== "draft") fail(409, "An issued document is kept; cancel it or issue a credit note");
    if (d.task_id) fail(409, "This draft is attached to a task; finish or cancel the task first");
    await c.query("delete from pulse.erp_document where id=$1", [docId]);
    await log(c, "document", docId, "deleted");
    return { ok: true };
  }));
  // Issue: recompute and save the figures, number it in the database, then file the PDF exactly as exported.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/issue", (req) => tx(req, async (c, v) => {
    await writer(c);
    const docId = id(req.params.id, "Document");
    const cur = (await c.query(`select ${DOC_COLS} from pulse.erp_document d where d.id=$1`, [docId])).rows[0];
    if (!cur) fail(404, "Document not found");
    if (cur.status !== "draft") fail(409, "Only a draft is issued");
    const lines = (await c.query(`select ${LINE_COLS} from pulse.erp_line where document_id=$1 order by position`, [docId])).rows;
    await saveDraft(c, v, docId, { ...cur, ...(req.body?.draft && typeof req.body.draft === "object" ? req.body.draft as Body : { lines, terms: cur.terms }) }, true);
    const d = (await c.query("select template_id,doc_type from pulse.erp_document where id=$1", [docId])).rows[0];
    const t = await templateFor(c, d.template_id, d.doc_type);
    const issued = (await c.query("select pulse.erp_document_issue($1,$2) r", [docId, { design: { ...(t?.design ?? {}), logoId: t?.logo_id ?? null, signatureId: t?.signature_id ?? null, templateName: t?.name ?? null } }])).rows[0].r;
    const { bytes } = await render(c, docId, "pdf");
    const sha = (await c.query("select pulse.erp_document_file_put($1,$2) s", [docId, Buffer.from(bytes)])).rows[0].s;
    return { ...issued, sha256: sha };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/mark", (req) => tx(req, async (c) => {
    await writer(c);
    const action = ["sent", "cancel", "accepted", "declined"].includes(String(req.body?.action)) ? String(req.body?.action) : fail(400, "Choose what happened");
    return { status: (await c.query("select pulse.erp_document_mark($1,$2,$3) s", [id(req.params.id, "Document"), action, str(req.body?.note, 500) || null])).rows[0].s };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/payments", (req) => tx(req, async (c) => {
    await writer(c);
    const b = req.body ?? {};
    return { id: (await c.query("select pulse.erp_payment_add($1,$2) id", [id(req.params.id, "Document"), { amount: Number(b.amount), tds: Number(b.tds ?? 0),
      receivedOn: typeof b.receivedOn === "string" && DAY.test(b.receivedOn) ? b.receivedOn : null, method: str(b.method, 20) || "bank", reference: str(b.reference, 120),
      bankLineKey: str(b.bankLineKey, 200) || null, note: str(b.note, 500) }])).rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/payments/:id/void", (req) => tx(req, async (c) => {
    await writer(c);
    await c.query("select pulse.erp_payment_void($1,$2)", [id(req.params.id, "Payment"), str(req.body?.reason, 300)]);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/task", (req) => tx(req, async (c) => {
    await writer(c);
    return { taskId: await invoiceTask(c, id(req.params.id, "Document"), req.body ?? {}) };
  }));
  // The client's acceptance link: the token is shown once; only its hash is stored. Pulse does not send it.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/link", (req) => tx(req, async (c) => {
    await writer(c);
    const token = randomBytes(32).toString("base64url");
    const days = Math.max(1, Math.min(90, Number(req.body?.days ?? 30) || 30));
    await c.query("select pulse.erp_accept_link_create($1,$2,$3)", [id(req.params.id, "Document"), createHash("sha256").update(token).digest("hex"), days]);
    return { url: `${companyOrigin()}/accept/${token}`, days };
  }));
  for (const format of ["pdf", "docx"] as const) {
    app.get<{ Params: { id: string }; Querystring: { inline?: string } }>(`/api/v0/erp/documents/:id/${format}`, async (req, reply) => {
      const inline = format === "pdf" && req.query.inline === "1"; // the page's own preview: viewed, not exported
      const out = await tx(req, async (c) => {
        await reader(c);
        const docId = id(req.params.id, "Document");
        const stored = format === "pdf" ? (await c.query("select f.bytes,d.number,d.buyer,d.id from pulse.erp_document_file f join pulse.erp_document d on d.id=f.document_id where f.document_id=$1 and f.kind='pdf'", [docId])).rows[0] : null;
        const r = stored ? { d: stored, bytes: new Uint8Array(stored.bytes) } : await render(c, docId, format);
        if (!inline) await log(c, "document", docId, "exported", { format, issuedCopy: !!stored });
        return r;
      });
      reply.header("cache-control", "private, no-store");
      reply.header("content-disposition", `${inline ? "inline" : "attachment"}; filename="${fileName(out.d, format)}"`);
      return reply.type(format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document").send(Buffer.from(out.bytes));
    });
  }
  app.get<{ Params: { format: string }; Querystring: { from?: string; to?: string } }>("/api/v0/erp/exports/:format", async (req, reply) => {
    const formats: Record<string, [string, string]> = { "sales-register": ["text/csv; charset=utf-8", "csv"], "zoho-books": ["text/csv; charset=utf-8", "csv"], tally: ["application/xml; charset=utf-8", "xml"] };
    let f: [string, string] = ["", ""], from = "", to = "";
    const body = await tx(req, async (c) => {
      await reader(c);
      const fy = financialYear(await today(c));
      from = DAY.test(String(req.query.from)) ? String(req.query.from) : fy.start; to = DAY.test(String(req.query.to)) ? String(req.query.to) : fy.end;
      f = formats[req.params.format] ?? fail(404, "Choose the sales register, Zoho Books or Tally");
      const docs = await exportDocs(c, from, to);
      await log(c, "settings", null, "exported", { format: req.params.format, from, to, documents: docs.length });
      const company = String((await settings(c)).company.legalName ?? "Company");
      return req.params.format === "tally" ? tallyXml(company, docs) : req.params.format === "zoho-books" ? zohoInvoicesCsv(docs) : salesRegisterCsv(docs);
    });
    reply.header("cache-control", "private, no-store").header("content-disposition", `attachment; filename="${req.params.format}-${from}-${to}.${f[1]}"`);
    return reply.type(f[0]).send(body);
  });

  // ------------------------------------------------------------------------------- the client's link (signed out)
  const hashOf = (token: string) => (/^[A-Za-z0-9_-]{43}$/.test(token) ? createHash("sha256").update(token).digest("hex") : null);
  app.get<{ Params: { token: string } }>("/api/v0/accept/:token", async (req) => {
    const h = hashOf(req.params.token) ?? fail(404, "This link is not valid");
    const r = await open(async (c) => (await c.query("select pulse.erp_accept_open($1) r", [h])).rows[0].r);
    return r ?? fail(404, "This link is not valid or has expired");
  });
  app.get<{ Params: { token: string } }>("/api/v0/accept/:token/pdf", async (req, reply) => {
    const h = hashOf(req.params.token) ?? fail(404, "This link is not valid");
    const bytes = await open(async (c) => (await c.query("select pulse.erp_accept_file($1) b", [h])).rows[0].b);
    if (!bytes) fail(404, "This link is not valid or has expired");
    reply.header("cache-control", "private, no-store");
    return reply.type("application/pdf").send(bytes);
  });
  app.post<{ Params: { token: string }; Body: Body }>("/api/v0/accept/:token", async (req) => {
    const h = hashOf(req.params.token) ?? fail(404, "This link is not valid");
    const ip = String(req.headers["x-pulse-client-ip"] ?? req.ip ?? "");
    return open(async (c) => (await c.query("select pulse.erp_accept_decide($1,$2,$3,$4,$5,$6) r", [h, String(req.body?.decision ?? ""), str(req.body?.name, 120), str(req.body?.note, 1000),
      createHash("sha256").update(`erp-accept:${ip}`).digest("hex"), str(req.headers["user-agent"], 300)])).rows[0].r);
  });
}
