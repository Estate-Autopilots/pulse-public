import { ORG_TZ } from "./org-time.js";
import { companyLinkOrigin, companyOrigin } from "./tenant-context.js";
import { sharedAddress } from "./shared-address.js";
// ERP-INVOICE (owner, 11 Oct 2026): invoicing for the company inside Pulse. A catalog of services, products and packages
// (parts, deliverables, versions and price history), inventory for physical items, clients' billing profiles, client
// packages with milestones, templates with a live preview, and documents (invoice, proforma, quotation, credit note)
// from draft to paid, logged and exported (PDF, DOCX, Zoho Books CSV, Tally XML). The database decides who: leadership
// and the Finance role write, an Accountant reads; issued documents are numbered and kept there (0190_erp_invoice.sql).
// "Sent" records that someone handed the document over, or (BILLING-EMAIL) that a person e-mailed it from its page.
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { addDays, buildModel, DOC_LABELS, financialYear, FONT_URLS, numberProblem, renderDocx, renderPdf, sampleDocument, type Asset, type DocType, type Fonts } from "@pulse/invoice-doc";
import { fail, type Open, type Tx, type Viewer } from "./routes.js";
import { cleanBuyer, cleanDraft, DAY, displayNumber, documentInput, DOC_TYPES, ErpInputError, figures, GST, milestonePlan, UUID, cleanAddOnIds, neededLines, OPEN_UNFILLED, unfilledOpen } from "./erp-model.js";
import { salesRegisterCsv, tallyXml, zohoInvoicesCsv, type ExportDoc } from "./erp-exports.js";
import { ESIGN_OPTIONS, mirrorStatus } from "./erp-seams.js";
import { documentMail, finalBody, mailable, recipients, suggestions } from "./erp-mail.js";
import { sendMail } from "./mail-send.js";
import { clientMailFrom } from "./client-mail.js";

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

// KAZUK-FLOW (G1, 7 Nov 2026): `own` is a salesperson who sees only their own deals (1670 erp_own_only); `cost` is whether
// this person sees cost and margin (the sales roles do not: Kazuk, "only the owner should see the cost").
const can = async (c: PoolClient) => (await c.query("select pulse.erp_can(false) read,pulse.erp_can(true) write,pulse.erp_own_only() own,pulse.erp_sees_cost() cost")).rows[0] as
  { read: boolean; write: boolean; own: boolean; cost: boolean };
async function reader(c: PoolClient) { await c.query("select pulse.erp_require(false)"); await c.query("select pulse.erp_bootstrap()"); }
async function writer(c: PoolClient) { await c.query("select pulse.erp_require(true)"); await c.query("select pulse.erp_bootstrap()"); }
/** KAZUK-FLOW (G1): settings, templates, stock, exports, client packages and milestones stay with leadership and Finance;
 *  a salesperson's seat writes their own deals and the catalogue only (the database holds the same line, 1670). */
async function fullBilling(c: PoolClient, write = true) {
  if (write) await writer(c); else await reader(c);
  if ((await can(c)).own) fail(403, "This part of Billing is for leadership and the Finance role");
}
/** KAZUK-FLOW config (1671): the company's sales flow decides who may do a step; a step that stops this person says why
 *  and who can unlock it (names), in the refusal and on the page. */
const FLOW_STEPS = ["quote", "send", "approve", "price", "version", "accept", "lost", "proforma", "invoice", "payment", "handover"] as const;
type FlowBlock = { step: string; why: string; unlock: string[]; unlockBy: string[] };
const blockOf = async (c: PoolClient, step: string) => (await c.query("select pulse.erp_flow_block($1) b", [step])).rows[0].b as FlowBlock | null;
async function step(c: PoolClient, name: string) {
  const b = await blockOf(c, name);
  if (b) fail(403, `${b.why}.${b.unlockBy.length ? ` ${b.unlockBy.join(", ")} can do it or change the sales flow.` : " Leadership or an admin can change the sales flow in Billing settings."}`);
}
/** G3: the company's required fields for sending a quotation, by their names on screen; what is missing, in order. */
export const SEND_FIELDS: Record<string, string> = { name: "Company name", contactName: "Client name", phone: "Contact number", email: "Mail ID", siteLocation: "Project location" };
function sendMissing(required: unknown, buyer: Body, site: unknown) {
  const has = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  return (Array.isArray(required) ? required : []).filter((k): k is string => typeof k === "string" && k in SEND_FIELDS)
    .filter((k) => !has(k === "siteLocation" ? site : buyer[k])).map((k) => SEND_FIELDS[k]);
}
/** G10: a payment proof as uploaded (PNG, JPEG or PDF, up to 5 MB), checked to be what it says it is. */
function paymentProof(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Body;
  const mime = ["image/png", "image/jpeg", "application/pdf"].includes(String(p.mime)) ? String(p.mime) : fail(400, "The proof is a PNG or JPEG image or a PDF");
  const bytes = Buffer.from(String(p.data ?? ""), "base64");
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) fail(400, "The proof is up to 5 MB");
  const ok = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mime === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff : bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  if (!ok) fail(400, "That file is not the image or PDF it says it is");
  return { mime, bytes, name: str(p.name, 160) };
}
/** Cost and margin leave the answer for the sales roles (null, as for an item whose cost is not known). */
const noCost = <T extends Row>(rows: T[], keep: boolean): T[] => (keep ? rows : rows.map((r) => ({ ...r, cost: null })));
const log = (c: PoolClient, type: string, subject: string | null, kind: string, detail: Body = {}) =>
  c.query("select pulse.erp_log($1,$2,$3,$4)", [type, subject, kind, detail]);

async function settings(c: PoolClient) {
  const s = (await c.query("select company,inventory_enabled,due_days,round_total,updated_at,quote_approval,cost_visibility from pulse.erp_settings")).rows[0];
  return { company: s?.company ?? {}, inventoryEnabled: !!s?.inventory_enabled, dueDays: s?.due_days ?? 15, roundTotal: s?.round_total !== false, updatedAt: s?.updated_at ?? null,
    quoteApproval: !!s?.quote_approval,
    // KAZUK-FLOW (G2): one switch. Off ("none", Kazuk: the salesperson decides the price): no approve step anywhere, the
    // main button sends. On ("approver", Willow Lane): BILLING-WL's approval, unchanged.
    approvalMode: (s?.quote_approval ? "approver" : "none") as "approver" | "none",
    // KAZUK-FLOW: who sees catalogue cost and margin (owner, finance or everyone), the company's own setting.
    costVisibility: (s?.cost_visibility ?? "everyone") as "owner" | "finance" | "everyone" };
}
/** BILLING-WL (owner, 4 Nov 2026; Akabod: "Send on WhatsApp" must say what is missing instead of searching forever).
 *  Pulse sends nothing through the WhatsApp Business (Meta Cloud) API yet and has no setting to link a number, so the
 *  page says so plainly (no setting to look for: review, 5 Nov 2026) and offers the PDF and the customer's chat. */
const whatsappBusiness = () => ({ connected: false, next: "Sending from the company's own WhatsApp Business number is not part of Pulse yet. Send the PDF from your phone in the three steps below: it takes a minute." });
/** The approval of a draft (BILLING-WL): who may approve it, whether this person may, and whom they can send it to. */
async function approvalOf(c: PoolClient, v: Viewer, doc: Row) {
  const s = await settings(c);
  const lead = (await c.query("select pulse.viewer_is('leadership','admin') l")).rows[0].l as boolean;
  const approvers = (await c.query("select id,name,lead from pulse.erp_approvers()")).rows.filter((p: Row) => p.id !== v.person);
  // A quotation, and a proforma or invoice made from scratch (not from an approved quotation), as the database's gate.
  const required = s.quoteApproval && (doc.docType === "quotation" || ((doc.docType === "proforma" || doc.docType === "invoice") && !doc.sourceId));
  return { required, canApprove: !required || lead || doc.approvalTo === v.person, approvers, asked: doc.approvalAskedBy ? { by: doc.approvalAskedByName, to: doc.approvalToName,
    toId: doc.approvalTo, at: doc.approvalAskedAt, note: doc.approvalNote, mine: doc.approvalAskedBy === v.person, forMe: doc.approvalTo === v.person } : null };
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

// AGENT-API (4 Nov 2026): the columns, drafts, issue, catalogue and stock code below are shared with API v1 (v1-money.ts).
export const DOC_COLS = `d.id,d.doc_type "docType",d.status,d.number,d.fy,to_char(d.issue_date,'YYYY-MM-DD') "issueDate",to_char(d.due_date,'YYYY-MM-DD') "dueDate",
  to_char(d.valid_until,'YYYY-MM-DD') "validUntil",d.client_id "clientId",d.contact_person_id "contactPersonId",d.site_location "siteLocation",d.revision,d.reissue_of "reissueOf",d.project_id "projectId",d.engagement_id "engagementId",d.milestone_id "milestoneId",
  d.owner_approval "ownerApproval",d.salesperson_id "salespersonId",(select display_name from pulse.person where id=d.salesperson_id) "salespersonName",
  (d.service_key_id is not null) "fromServiceKey",d.against_id "againstId",d.source_id "sourceId",d.template_id "templateId",d.seller,d.buyer,d.place_of_supply "placeOfSupply",d.reference,d.notes,d.terms,
  d.reverse_charge "reverseCharge",d.zero_rated "zeroRated",d.round_total "roundTotal",d.tax_mode "taxMode",d.taxable::float8 taxable,d.cgst::float8 cgst,
  d.sgst::float8 sgst,d.igst::float8 igst,d.round_off::float8 "roundOff",d.total::float8 total,d.amount_words "amountWords",d.paid::float8 paid,d.credited::float8 credited,
  d.task_id "taskId",d.issued_at "issuedAt",d.sent_at "sentAt",d.cancelled_at "cancelledAt",d.cancel_reason "cancelReason",d.decision,d.created_at "createdAt",d.updated_at "updatedAt",
  (select display_name from pulse.person where id=d.created_by) "createdBy",(select display_name from pulse.person where id=d.issued_by) "issuedBy",
  d.sx_lead_id "sxLeadId",d.approval_to "approvalTo",(select display_name from pulse.person where id=d.approval_to) "approvalToName",d.approval_asked_by "approvalAskedBy",
  (select display_name from pulse.person where id=d.approval_asked_by) "approvalAskedByName",d.approval_asked_at "approvalAskedAt",d.approval_note "approvalNote",
  d.lost_reason "lostReason",d.lost_note "lostNote",d.negotiating_at "negotiatingAt",d.source_revision "sourceRevision",pulse.erp_deal_status(d.id) "dealStatus"`;
export const LINE_COLS = `id,item_id "itemId",description,details,sac,unit,qty::float8 qty,rate::float8 rate,discount::float8 discount,discount_percent::float8 "discountPercent",
  gst_rate::float8 "gstRate",taxable::float8 taxable,cgst::float8 cgst,sgst::float8 sgst,igst::float8 igst,total::float8 total,
  parent_position "parentIndex",(select p.id from pulse.erp_line p where p.document_id=erp_line.document_id and p.position=erp_line.parent_position) "parentLineId",
  open,not_needed "notNeeded",warranty_months "warrantyMonths",serials`;
/** EST-1236: an item's usual add-ons (active ones, in order) and whether it is an amount priced per site. Needs alias i.
 *  BILLING-WL (4 Nov 2026): its standard warranty, the extensions it sells and whether each unit has a serial number. */
const ITEM_EXTRAS = `(i.kind<>'package' and i.price=0) open,coalesce((select jsonb_agg(jsonb_build_object('itemId',x.id,'name',x.name,'price',x.price::float8) order by a.position)
  from pulse.erp_item_addon a join pulse.erp_item x on x.id=a.addon_id where a.item_id=i.id and x.status<>'archived'),'[]') "addOns",
  i.warranty_months "warrantyMonths",i.warranty_options "warrantyOptions",(i.serialised and i.track_stock) serialised`;
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
const fileName = (d: Row, ext: string) => `${(displayNumber(d) ?? `draft-${String(d.id).slice(0, 8)}`).replace(/[^A-Za-z0-9-]+/g, "-")}_${String(d.buyer?.name ?? "client").replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.${ext}`;

/** BILLING (4 Nov 2026): the client and contact a draft names, checked to be this company's records. */
async function partyIds(c: PoolClient, body: Body) {
  const setClient = "clientId" in body, setContact = "contactPersonId" in body, setSite = "siteLocation" in body;
  const clientId = optId(body.clientId);
  const contactId = optId(body.contactPersonId);
  if (clientId && !(await c.query("select 1 from pulse.client where id=$1", [clientId])).rows[0]) fail(400, "That client is not in Clients");
  if (contactId && !(await c.query("select 1 from pulse.person where id=$1 and side<>'staff'", [contactId])).rows[0]) fail(400, "That contact is not in Contacts");
  const site = setSite ? str(body.siteLocation, 300) || null : null;
  // BILLING-WL (4 Nov 2026): the Sales X-Ray lead the customer was picked from (this viewer must see it).
  const setLead = "sxLeadId" in body, leadId = optId(body.sxLeadId);
  if (leadId && !(await c.query("select 1 from pulse.sales_xray_lead where sx_lead_id=$1 and gone_at is null", [leadId])).rows[0]) fail(400, "That lead is not in Sales X-Ray's leads");
  // An older client of this API sends a clientId without the key meaning "set exactly": keep its coalesce.
  return { clientId, setClient: setClient && (clientId !== null || body.clientId === null), contactId, setContact, site, setSite, leadId, setLead };
}

/** Saves a draft's fields and lines with the figures @pulse/invoice-doc works out for them. Lines that are not needed are
 *  kept on a draft at zero and left out of its figures; issuing refuses unfilled open amounts and drops them. */
export async function saveDraft(c: PoolClient, v: Viewer, docId: string, body: Body, issuing = false) {
  const d = (await c.query("select id,status,doc_type,source_id,source_revision from pulse.erp_document where id=$1 for update", [docId])).rows[0];
  if (!d) fail(404, "Document not found");
  if (d.status !== "draft") fail(409, "An issued document cannot be edited; cancel it or issue a credit note");
  const f = cleanDraft(body);
  // KAZUK-FLOW G9: an invoice made from a quotation keeps its lines, quantities and prices where the flow locks them.
  if (d.source_id && (await c.query("select pulse.erp_lines_locked($1) l", [docId])).rows[0].l) {
    const key = (l: { description?: unknown; qty?: unknown; rate?: unknown; gstRate?: unknown; discountPercent?: unknown }) =>
      [String(l.description ?? "").trim(), Number(l.qty), Number(l.rate), Number(l.gstRate), Number(l.discountPercent ?? 0)].join("|");
    const src = (await c.query(`select description,qty::float8 qty,rate::float8 rate,gst_rate::float8 "gstRate",coalesce(discount_percent,0)::float8 "discountPercent",not_needed
      from pulse.erp_line where document_id=$1 order by position`, [d.source_id])).rows.filter((l: Row) => !l.not_needed).map(key);
    const mine = neededLines(f.lines).kept.map(key);
    if (src.join("\n") !== mine.join("\n")) {
      const q = (await c.query("select number from pulse.erp_document where id=$1", [d.source_id])).rows[0]?.number ?? "the quotation";
      fail(409, `The lines, quantities and prices come from ${q} V${(d.source_revision ?? 0) + 1} and stay as accepted: make a new version of the quotation to change them`);
    }
  }
  // G9: a GST-registered client's tax invoice carries their billing address too.
  if (issuing && d.doc_type === "invoice" && f.buyer.gstin && !(f.buyer.address ?? []).some((x: string) => x.trim())) fail(400, "Add the client's billing address: they are GST-registered");
  if (issuing) {
    if (unfilledOpen(f.lines)) fail(400, OPEN_UNFILLED);
    f.lines = neededLines(f.lines).kept;
  }
  const s = await settings(c);
  if (!/^\d{2}$/.test(String(s.company.stateCode ?? ""))) fail(400, "Set the company's state in ERP settings first");
  const { kept, index } = neededLines(f.lines);
  const fig = figures(String(s.company.stateCode), { ...f, lines: kept });
  // BILLING (owner, 4 Nov 2026): the client, point of contact and project location the composer picked (a key that is
  // not sent keeps what the draft has; null clears it, as when a new client is typed in instead).
  const who = await partyIds(c, body);
  await c.query(`update pulse.erp_document set issue_date=$2,due_date=$3,valid_until=$4,buyer=$5,place_of_supply=$6,reference=$7,notes=$8,terms=$9,reverse_charge=$10,
    zero_rated=$11,round_total=$12,template_id=coalesce($13,template_id),seller=$14,tax_mode=$15,taxable=$16,cgst=$17,sgst=$18,igst=$19,round_off=$20,total=$21,amount_words=$22,
    client_id=case when $25 then $23::uuid else client_id end,updated_by=$24,contact_person_id=case when $26 then $27::uuid else contact_person_id end,
    site_location=case when $28 then $29 else site_location end,sx_lead_id=case when $30 then $31::uuid else sx_lead_id end where id=$1`,
    [docId, f.issueDate, f.dueDate, f.validUntil, f.buyer, fig.placeOfSupply, f.reference, f.notes, f.terms, f.reverseCharge, f.zeroRated, f.roundTotal, f.templateId,
      s.company, fig.mode, fig.taxable, fig.cgst, fig.sgst, fig.igst, fig.roundOff, fig.total, fig.words, who.clientId, v.person, who.setClient, who.setContact, who.contactId,
      who.setSite, who.site, who.setLead, who.leadId]);
  const catalogueRates = (await c.query("select item_id,catalogue_rate from pulse.erp_line where document_id=$1 and catalogue_rate is not null order by position", [docId])).rows;
  await c.query("delete from pulse.erp_line where document_id=$1", [docId]);
  for (const [i, src] of f.lines.entries()) {
    const at = index[i];
    const l = at === null ? { discount: src.discount, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 } : fig.lines[at];
    await c.query(`insert into pulse.erp_line(org_id,document_id,position,item_id,description,details,sac,unit,qty,rate,discount,discount_percent,gst_rate,taxable,cgst,sgst,igst,total,
      parent_position,open,not_needed,catalogue_rate,warranty_months,serials) values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [docId, i, src.itemId, src.description, src.details, src.sac, src.unit, src.qty, src.rate, l.discount, src.discountPercent, src.gstRate, l.taxable, l.cgst, l.sgst, l.igst, l.total,
        src.parentIndex, src.open, src.notNeeded, catalogueRates.find(r => r.item_id === src.itemId)?.catalogue_rate ?? null, src.warrantyMonths, src.serials]);
  }
  return fig;
}

/** A new draft, filled from what Pulse knows: the project's client and billing profile, the milestone's package line,
 *  the quotation it converts or the invoice a credit note is against. */
export async function createDraft(c: PoolClient, v: Viewer, body: Body) {
  const docType = (DOC_TYPES as readonly string[]).includes(String(body.docType)) ? String(body.docType) as DocType : fail(400, "Choose the kind of document");
  const s = await settings(c);
  const issueDate = await today(c);
  let projectId = optId(body.projectId), clientId = optId(body.clientId), engagementId: string | null = null, milestoneId = optId(body.milestoneId);
  let lines: Body[] = [], reference: Record<string, string> = {}, buyer: Body | null = null, againstId: string | null = null, sourceId: string | null = null, placeOfSupply: string | null = null;
  // BILLING (owner, 4 Nov 2026): a quotation starts blank or for a client or contact picked from Clients and Contacts.
  let contactId = optId(body.contactPersonId), site: string | null = str(body.siteLocation, 300) || null;
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
    contactId = d.contact_person_id; site = d.site_location;
    lines = ls.map((l: Row) => ({ itemId: l.item_id, description: l.description, details: l.details, sac: l.sac, unit: l.unit, qty: Number(l.qty), rate: Number(l.rate), gstRate: Number(l.gst_rate) }));
  }
  // BILLING (owner, 4 Nov 2026): a cancelled quotation keeps its number; "Re-issue" copies it into a new draft that takes
  // the next number when it is approved (a re-issue already made is opened instead).
  let reissueOf: string | null = null;
  if (body.reissueOf) {
    const { d, lines: ls } = await loadDoc(c, id(body.reissueOf, "Document"));
    if (d.status !== "cancelled" || !["quotation", "proforma"].includes(d.doc_type)) fail(400, "Re-issue a cancelled quotation or proforma");
    if (docType !== d.doc_type) fail(400, "A re-issue is the same kind of document");
    const made = (await c.query("select id from pulse.erp_document where reissue_of=$1 and status<>'cancelled' order by created_at limit 1", [d.id])).rows[0];
    if (made) return { id: made.id as string, existing: true };
    reissueOf = d.id; projectId = d.project_id; clientId = d.client_id; buyer = d.buyer; placeOfSupply = d.place_of_supply; reference = { ...d.reference };
    contactId = d.contact_person_id; site = d.site_location;
    lines = ls.map((l: Row) => ({ itemId: l.item_id, description: l.description, details: l.details, sac: l.sac, unit: l.unit, qty: Number(l.qty), rate: Number(l.rate),
      discount: Number(l.discount), discountPercent: l.discount_percent === null ? null : Number(l.discount_percent), gstRate: Number(l.gst_rate),
      parentIndex: l.parent_position ?? null, open: !!l.open, notNeeded: !!l.not_needed, warrantyMonths: l.warranty_months ?? null }));
  }
  if (body.sourceId) {
    const { d, lines: ls } = await loadDoc(c, id(body.sourceId, "Document"));
    if (!["quotation", "proforma"].includes(d.doc_type) || !["issued", "sent", "accepted"].includes(d.status)) fail(400, "Convert an issued quotation or proforma");
    if (docType !== "invoice" && !(d.doc_type === "quotation" && docType === "proforma")) fail(400, "A quotation becomes a proforma or an invoice; a proforma becomes an invoice");
    // Billing redesign (EST-1237): a retried "Make proforma" opens the one already made instead of a second draft.
    const made = (await c.query("select id from pulse.erp_document where source_id=$1 and doc_type=$2 and status<>'cancelled' order by created_at limit 1", [d.id, docType])).rows[0];
    if (made) return { id: made.id as string, existing: true };
    sourceId = d.id; projectId = d.project_id; clientId = d.client_id; buyer = d.buyer; placeOfSupply = d.place_of_supply; reference = { ...d.reference };
    contactId = d.contact_person_id; site = d.site_location;
    engagementId = d.engagement_id; milestoneId = d.milestone_id;
    lines = ls.map((l: Row) => ({ itemId: l.item_id, description: l.description, details: l.details, sac: l.sac, unit: l.unit, qty: Number(l.qty), rate: Number(l.rate),
      discount: Number(l.discount), discountPercent: l.discount_percent === null ? null : Number(l.discount_percent), gstRate: Number(l.gst_rate),
      parentIndex: l.parent_position ?? null, open: !!l.open, warrantyMonths: l.warranty_months ?? null }));
  }
  if (projectId && !clientId) clientId = (await c.query("select client_id from pulse.project where id=$1", [projectId])).rows[0]?.client_id ?? null;
  if (projectId && !reference.project) reference.project = (await c.query("select coalesce(title,name) t from pulse.project where id=$1", [projectId])).rows[0]?.t ?? "";
  if (projectId && !site) site = (await c.query("select nullif(btrim(location),'') l from pulse.project where id=$1", [projectId])).rows[0]?.l ?? null;
  if (!buyer && (clientId || contactId)) {
    const picked = await partyPick(c, clientId, contactId);
    clientId = picked.clientId; contactId = picked.contactPersonId; buyer = picked.buyer; site ??= picked.siteLocation;
  }
  // BILLING-WL (4 Nov 2026): a quotation for a Sales X-Ray lead starts with the lead's name, company, phone and e-mail.
  const sxLeadId = optId(body.sxLeadId);
  if (!buyer && sxLeadId) {
    const picked = await leadPick(c, sxLeadId);
    buyer = picked.buyer; contactId ??= picked.contactPersonId; site ??= picked.siteLocation;
  }
  if (!buyer && body.buyer && typeof body.buyer === "object") buyer = cleanBuyer(body.buyer) as unknown as Body; // a new client typed in
  const leadFrom = sourceId ?? reissueOf;
  const sxLead = sxLeadId ?? (leadFrom ? (await c.query("select sx_lead_id from pulse.erp_document where id=$1", [leadFrom])).rows[0]?.sx_lead_id ?? null : null);
  const t = await templateFor(c, null, docType);
  const draft = {
    issueDate, dueDate: ["invoice", "proforma"].includes(docType) ? addDays(issueDate, s.dueDays) : null, validUntil: docType === "quotation" ? addDays(issueDate, 30) : null,
    buyer: buyer ?? { name: "" }, placeOfSupply: placeOfSupply ?? (buyer?.stateCode as string | undefined) ?? s.company.stateCode ?? null, reference, notes: "", terms: null,
    roundTotal: s.roundTotal, templateId: t?.id ?? null, lines,
  };
  const docId = (await c.query(`insert into pulse.erp_document(org_id,doc_type,client_id,project_id,engagement_id,milestone_id,against_id,source_id,template_id,seller,created_by,updated_by,
    contact_person_id,site_location,reissue_of,sx_lead_id) values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14) returning id`,
    [docType, clientId, projectId, engagementId, milestoneId, againstId, sourceId, t?.id ?? null, s.company, v.person, contactId, site, reissueOf, sxLead])).rows[0].id as string;
  try { await saveDraft(c, v, docId, draft); } catch (e) { if (!(e instanceof ErpInputError)) throw e; } // an incomplete prefill stays a draft to finish
  if (milestoneId && docType === "invoice") await c.query("update pulse.erp_milestone set document_id=$2 where id=$1", [milestoneId, docId]);
  if (reissueOf) await log(c, "document", reissueOf, "reissued", { documentId: docId });
  await log(c, "document", docId, "created", { docType, from: reissueOf ? "reissue" : sourceId ? "conversion" : againstId ? "invoice" : milestoneId ? "milestone" : projectId ? "project" : clientId ? "client" : sxLeadId ? "lead" : contactId ? "contact" : "blank" });
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

/** BILLING (4 Nov 2026): what a document for a client or a contact starts with. A contact of a client bills that client
 *  (the contact as the point of contact); a contact on their own (a lead) is billed by name; the project location is the
 *  client's latest project's. */
async function partyPick(c: PoolClient, clientIdIn: string | null, contactIdIn: string | null) {
  const contactOf = async (personId: string) => (await c.query(`select p.id,p.display_name name,cp.email,cp.phone,cp.city,
      (select cc.client_id from pulse.client_contact cc where cc.person_id=p.id order by cc.is_primary desc limit 1) "clientId"
      from pulse.person p left join pulse.contact_profile cp on cp.person_id=p.id where p.id=$1 and p.side<>'staff'`, [personId])).rows[0] as Row | undefined;
  const picked = contactIdIn ? await contactOf(contactIdIn) : undefined;
  if (contactIdIn && !picked) fail(400, "That contact is not in Contacts");
  if (clientIdIn && !(await c.query("select 1 from pulse.client where id=$1", [clientIdIn])).rows[0]) fail(400, "That client is not in Clients");
  const clientId: string | null = clientIdIn ?? picked?.clientId ?? null;
  // A client's point of contact: the billing profile's, else the client's primary contact, else its first linked one.
  const pocId = picked ? null : clientId ? (await c.query(`select coalesce((select contact_person_id from pulse.erp_party where client_id=$1),(select primary_contact_id from pulse.client where id=$1),
      (select person_id from pulse.client_contact where client_id=$1 order by is_primary desc limit 1)) id`, [clientId])).rows[0]?.id ?? null : null;
  const contact = picked ?? (pocId ? await contactOf(pocId) : undefined);
  let buyer: Body = clientId ? await buyerFor(c, clientId) : { name: contact?.name ?? "", address: [] };
  if (contact) buyer = { ...buyer, contactName: picked ? contact.name : buyer.contactName ?? contact.name, email: (picked ? contact.email : buyer.email) ?? contact.email ?? buyer.email ?? null,
    phone: (picked ? contact.phone : buyer.phone) ?? contact.phone ?? buyer.phone ?? null };
  const siteLocation = clientId ? (await c.query(`select nullif(btrim(location),'') l from pulse.project where client_id=$1 and location is not null and deleted_at is null
      order by starts_on desc nulls last,start_month desc nulls last limit 1`, [clientId])).rows[0]?.l ?? contact?.city ?? null : contact?.city ?? null;
  return { clientId, contactPersonId: (contact?.id ?? null) as string | null, buyer, siteLocation: siteLocation as string | null };
}

/** BILLING-WL (owner, 4 Nov 2026; Akabod: a lead from Meta ads, the website or the DMS, or one added by hand, is billed
 *  like a client). A Sales X-Ray lead as the customer: its client when the lead is linked to one; else the contact with its
 *  phone or e-mail when Contacts has one (the existing profile); else its name, company, phone and e-mail, booked when the
 *  quotation is approved. */
async function leadPick(c: PoolClient, leadId: string) {
  const l = (await c.query("select sx_lead_id id,name,company,city,phone,email,client_id from pulse.sales_xray_lead where sx_lead_id=$1 and gone_at is null", [leadId])).rows[0];
  if (!l) fail(400, "That lead is not in Sales X-Ray's leads");
  if (l.client_id) return { ...(await partyPick(c, l.client_id, null)), sxLeadId: l.id as string };
  const twins = (await c.query("select pulse.erp_party_twins($1,$2) t", [l.email, l.phone])).rows[0].t as { contacts: Row[] };
  if (twins.contacts[0]) return { ...(await partyPick(c, null, twins.contacts[0].id)), sxLeadId: l.id as string };
  const person = String(l.name ?? "").trim(), company = String(l.company ?? "").trim();
  const buyer: Body = { name: company || person, contactName: company && person ? person : null, phone: l.phone ?? null, email: l.email ?? null, address: [] };
  return { clientId: null as string | null, contactPersonId: null as string | null, buyer, siteLocation: (l.city ?? null) as string | null, sxLeadId: l.id as string };
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
export async function assignees(c: PoolClient) {
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

/** Issue: recompute and save the figures, number it in the database, then file the PDF exactly as exported. */
export async function issueDocument(c: PoolClient, v: Viewer, docId: string, draft: Body | null = null) {
  const cur = (await c.query(`select ${DOC_COLS} from pulse.erp_document d where d.id=$1`, [docId])).rows[0];
  if (!cur) fail(404, "Document not found");
  if (cur.status !== "draft") fail(409, "Only a draft is issued");
  const lines = (await c.query(`select ${LINE_COLS} from pulse.erp_line where document_id=$1 order by position`, [docId])).rows;
  await saveDraft(c, v, docId, { ...cur, ...(draft ?? { lines, terms: cur.terms }) }, true);
  const d = (await c.query("select template_id,doc_type from pulse.erp_document where id=$1", [docId])).rows[0];
  const t = await templateFor(c, d.template_id, d.doc_type);
  const issued = (await c.query("select pulse.erp_document_issue($1,$2) r", [docId, { design: { ...(t?.design ?? {}), logoId: t?.logo_id ?? null, signatureId: t?.signature_id ?? null, templateName: t?.name ?? null } }])).rows[0].r;
  const { bytes } = await render(c, docId, "pdf");
  const sha = (await c.query("select pulse.erp_document_file_put($1,$2) s", [docId, Buffer.from(bytes)])).rows[0].s;
  // BILLING (owner, 4 Nov 2026): an issued invoice means the client enrolled: book them and their point of contact in
  // Clients and Contacts. A booking that cannot be made (a contact without a name) never stops the invoice.
  let booked: unknown = null;
  // BILLING-WL (Akabod, 4 Nov 2026: "saving the quotation creates the client profile, no double entry"): an approved
  // quotation or proforma books its customer too, as a Prospect (the invoice makes them Active), on their story.
  if (["invoice", "quotation", "proforma"].includes(d.doc_type)) {
    await c.query("savepoint erp_book");
    try { booked = (await c.query("select pulse.erp_book_client($1) b", [docId])).rows[0].b; await c.query("release savepoint erp_book"); }
    catch { await c.query("rollback to savepoint erp_book"); }
  }
  return { ...issued, sha256: sha, booked };
}

/** A new catalogue item (the screen's form and API v1's add_catalog_item). */
export async function createItem(c: PoolClient, v: Viewer, body: Body) {
  const i = cleanItem(body);
  const itemId = (await c.query(`insert into pulse.erp_item(org_id,kind,code,name,description,sac,unit,price,gst_rate,cost,track_stock,reorder_level,milestones,setup,status,source,created_by,updated_by,
    warranty_months,warranty_options,serialised)
    values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'{"type":"manual"}',$15,$15,$16,$17,$18) returning id`,
    [i.kind, i.code, i.name, i.description, i.sac, i.unit, i.price, i.gstRate, i.cost, i.trackStock, i.reorder, JSON.stringify(i.milestones), i.setup, i.status, v.person,
      i.warrantyMonths, JSON.stringify(i.warrantyOptions), i.serialised])).rows[0].id as string;
  if (body.addOnIds !== undefined) await setAddOns(c, itemId, body.addOnIds);
  await log(c, "item", itemId, "created", { kind: i.kind, name: i.name });
  return { id: itemId };
}

/** Stock in, out or an adjustment for one item (the screen and API v1's record_stock_in / set_stock_count). */
export async function stockMove(c: PoolClient, v: Viewer, itemId: string, b: Body) {
  // BILLING-WL (4 Nov 2026): stock in of a serialised item names each unit (the database checks and keeps them).
  if (b.kind === "in" && Array.isArray(b.serials)) {
    const unit = b.unitCost === null || b.unitCost === undefined || b.unitCost === "" ? null : Number(b.unitCost);
    if (unit !== null && (!Number.isInteger(unit) || unit < 0)) fail(400, "The unit cost is an amount in paise");
    return (await c.query("select pulse.erp_stock_receive($1,$2,$3,$4,$5,$6) r", [itemId, null, (b.serials as unknown[]).map((x) => str(x, 80)), str(b.note, 500),
      typeof b.onDate === "string" && DAY.test(b.onDate) ? b.onDate : null, unit])).rows[0].r;
  }
  const kind = ["in", "out", "adjust"].includes(String(b.kind)) ? String(b.kind) : fail(400, "Choose stock in, out or an adjustment");
  const qty = Number(b.qty);
  if (!Number.isFinite(qty) || qty === 0 || (kind !== "adjust" && qty < 0)) fail(400, "Enter the quantity");
  const unitCost = b.unitCost === null || b.unitCost === undefined || b.unitCost === "" ? null : Number(b.unitCost);
  if (unitCost !== null && (!Number.isInteger(unitCost) || unitCost < 0)) fail(400, "The unit cost is an amount in paise");
  const moveId = (await c.query(`insert into pulse.erp_stock_move(org_id,item_id,kind,qty,unit_cost,note,on_date,created_by) values(pulse.current_org(),$1,$2,$3,$4,$5,coalesce($6::date,(now() at time zone ${ORG_TZ})::date),$7) returning id`,
    [itemId, kind, qty, unitCost, str(b.note, 500), typeof b.onDate === "string" && DAY.test(b.onDate) ? b.onDate : null, v.person])).rows[0].id as string;
  await log(c, "stock", itemId, kind, { qty });
  return { id: moveId, onHand: Number((await c.query("select pulse.erp_on_hand($1) n", [itemId])).rows[0].n) };
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
  // BILLING-WL (4 Nov 2026): the standard warranty, the extensions sold with it, and serial numbers per unit.
  const warrantyMonths = b.warrantyMonths === null || b.warrantyMonths === undefined || b.warrantyMonths === "" ? null : Number(b.warrantyMonths);
  if (warrantyMonths !== null && (!Number.isInteger(warrantyMonths) || warrantyMonths < 0 || warrantyMonths > 600)) fail(400, "The warranty is a number of months");
  const warrantyOptions = (Array.isArray(b.warrantyOptions) ? b.warrantyOptions : []).slice(0, 7).map((o: Body) => ({ months: Number(o?.months), price: Number(o?.price) }));
  if (warrantyOptions.length > 6) fail(400, "Up to six warranty extensions");
  if (warrantyOptions.some((o) => !Number.isInteger(o.months) || o.months < 1 || o.months > 600 || !Number.isInteger(o.price) || o.price < 0)) fail(400, "An extension is its months and its price in paise");
  if (new Set(warrantyOptions.map((o) => o.months)).size !== warrantyOptions.length) fail(400, "Each extension is a different number of months");
  const serialised = trackStock && b.serialised === true;
  const milestones = Array.isArray(b.milestones) ? b.milestones.slice(0, 24).map((m: Body) => ({ label: str(m.label, 120) || "Instalment", percent: Number(m.percent) || 0, offsetDays: Math.max(0, Math.min(1095, Number(m.offsetDays) || 0)) })) : [];
  if (milestones.length && Math.abs(milestones.reduce((n, m) => n + m.percent, 0) - 100) > 0.001) fail(400, "Milestone percentages add up to 100");
  return { kind, name, code, sac, unit: str(b.unit, 20) || (kind === "service" ? "nos" : "nos"), description: str(b.description, 4000), setup: str(b.setup, 4000),
    price, cost, gstRate: gst, status, trackStock, reorder, milestones, warrantyMonths, warrantyOptions: warrantyOptions.sort((x, y) => x.months - y.months), serialised };
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
    const { write, own, cost } = await can(c);
    // BILLING-WL (4 Nov 2026): what the home starts with, as Work → My day does: drafts sent to this person for approval,
    // approved documents not yet sent to the customer, and the drafts this person sent and still waits on.
    const forMe = (await c.query(`select ${DOC_COLS} from pulse.erp_document d where d.status='draft' and d.approval_to=$1 order by d.approval_asked_at desc limit 10`, [v.person])).rows;
    const toSend = (await c.query(`select ${DOC_COLS} from pulse.erp_document d where d.status='issued' and d.doc_type in ('quotation','proforma','invoice') order by d.issued_at desc limit 10`)).rows;
    const waiting = (await c.query(`select ${DOC_COLS} from pulse.erp_document d where d.status='draft' and d.approval_asked_by=$1 order by d.approval_asked_at desc limit 10`, [v.person])).rows;
    return { canWrite: write, ownOnly: own, seesCost: cost, approvalMode: s.approvalMode, accountant: v.role === "accountant", today: t, fy: fy.label, settings: { company: s.company, inventoryEnabled: s.inventoryEnabled }, kpis: { ...k, collected },
      due, recent, overdue, lowStock, catalog, assignees: write ? await assignees(c) : [], mirror: mirrorStatus(), forMe, toSend, waiting };
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
    const canSetApproval = (await c.query("select pulse.viewer_is('leadership','admin') l")).rows[0].l as boolean;
    return { ...(await settings(c)), fy: fy.label, today: await today(c), series, defaults, canWrite: (await can(c)).write, canSetApproval, mirror: mirrorStatus(), esign: ESIGN_OPTIONS };
  }));
  app.post<{ Body: Body }>("/api/v0/erp/settings", (req) => tx(req, async (c, v) => {
    await fullBilling(c);
    const b = req.body ?? {};
    const co = (b.company && typeof b.company === "object" ? b.company : {}) as Body;
    const buyerLike = cleanBuyer({ gstin: co.gstin, stateCode: co.stateCode });
    const company = { legalName: str(co.legalName, 200), tradeName: str(co.tradeName, 200), gstin: buyerLike.gstin, stateCode: buyerLike.stateCode ?? "27",
      pan: buyerLike.gstin ? buyerLike.gstin.slice(2, 12) : str(co.pan, 10).toUpperCase() || null,
      address: Array.isArray(co.address) ? co.address.map((x) => str(x, 160)).filter(Boolean).slice(0, 5) : [], email: str(co.email, 200), phone: str(co.phone, 40), website: str(co.website, 120) };
    if (!company.legalName) fail(400, "The company's legal name is required");
    const dueDays = Math.max(0, Math.min(365, Number(b.dueDays ?? 15) || 0));
    // Only leadership or an admin turns "quotations wait for approval" on or off (review, 5 Nov 2026; the database checks it too).
    if (typeof b.quoteApproval === "boolean" && b.quoteApproval !== (await settings(c)).quoteApproval
      && !(await c.query("select pulse.viewer_is('leadership','admin') l")).rows[0].l) fail(403, "Only leadership or an admin can change whether quotations wait for approval");
    // KAZUK-FLOW: who sees cost and margin, changed by leadership or an admin only (the database checks it too).
    const costVisibility = ["owner", "finance", "everyone"].includes(String(b.costVisibility)) ? String(b.costVisibility) : null;
    if (costVisibility && costVisibility !== (await settings(c)).costVisibility
      && !(await c.query("select pulse.viewer_is('leadership','admin') l")).rows[0].l) fail(403, "Only leadership or an admin changes who sees cost and margin");
    await c.query(`update pulse.erp_settings set company=$1,inventory_enabled=$2,due_days=$3,round_total=$4,updated_by=$5,updated_at=now(),
      quote_approval=coalesce($6,quote_approval),cost_visibility=coalesce($7,cost_visibility)`, [company, b.inventoryEnabled === true, dueDays, b.roundTotal !== false, v.person,
      typeof b.quoteApproval === "boolean" ? b.quoteApproval : null, costVisibility]);
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

  // KAZUK-FLOW config (1671): the company's sales flow (a preset, EA or Willow Lane, or its own steps). Billing's readers
  // read it with what stops them; leadership or an admin changes it (the database checks and logs it).
  app.get("/api/v0/erp/flow", (req) => tx(req, async (c) => {
    await reader(c);
    const f = (await c.query("select preset,updated_at \"updatedAt\" from pulse.erp_flow")).rows[0];
    const steps: Record<string, unknown> = {};
    for (const k of FLOW_STEPS) steps[k] = { ...(await c.query("select pulse.erp_flow_step($1) s", [k])).rows[0].s, block: await blockOf(c, k) };
    const lead = (await c.query("select pulse.viewer_is('leadership','admin') l")).rows[0].l as boolean;
    return { preset: f?.preset ?? null, updatedAt: f?.updatedAt ?? null, steps, canSet: lead && (await can(c)).write, approvalMode: (await settings(c)).approvalMode };
  }));
  app.post<{ Body: Body }>("/api/v0/erp/flow", (req) => tx(req, async (c) => {
    await writer(c);
    const b = req.body ?? {};
    const preset = b.preset === "ea" || b.preset === "wl" ? b.preset : null;
    const steps = b.steps && typeof b.steps === "object" && !Array.isArray(b.steps) ? b.steps : null;
    return (await c.query("select pulse.erp_flow_save($1) r", [{ ...(preset ? { preset } : {}), ...(steps ? { steps } : {}) }])).rows[0].r;
  }));

  // ---------------------------------------------------------------------------------------------------- catalog
  app.get("/api/v0/erp/items", (req) => tx(req, async (c) => {
    await reader(c);
    const items = (await c.query(`select i.id,i.kind,i.code,i.name,i.description,i.sac,i.unit,i.price::float8 price,i.gst_rate::float8 "gstRate",i.cost::float8 cost,
      i.track_stock "trackStock",i.reorder_level::float8 "reorderLevel",i.status,i.version,i.source,i.updated_at "updatedAt",(i.created_by=pulse.current_viewer()) mine,
      (select count(*)::int from pulse.erp_package_part p where p.package_id=i.id) parts,
      case when i.track_stock then pulse.erp_on_hand(i.id)::float8 end "onHand",
      (select count(*)::int from pulse.erp_engagement e where e.package_id=i.id) sold,${ITEM_EXTRAS}
      from pulse.erp_item i order by i.status='archived',i.kind='package' desc,i.name`)).rows;
    // KAZUK-FLOW (G4): cost and margin are the owner's; "Start clean" is offered to leadership and admins.
    const seat = await can(c), s = await settings(c);
    const lead = (await c.query("select pulse.viewer_is('leadership','admin') l")).rows[0].l as boolean;
    const drafted = items.filter((i: Row) => i.status === "draft" && i.source?.type !== "manual").length;
    return { items: noCost(items, seat.cost), inventoryEnabled: s.inventoryEnabled, canWrite: seat.write, ownOnly: seat.own, seesCost: seat.cost, approvalMode: s.approvalMode,
      startClean: lead && seat.write ? drafted : 0 };
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
    // BILLING-WL: the serial numbers of a serialised item, in stock first, then the latest sold.
    const serials = item.serialised ? (await c.query(`select s.serial,s.status,to_char(s.updated_at,'YYYY-MM-DD') "on",d.number,d.id "documentId",d.buyer->>'name' "soldTo"
      from pulse.erp_stock_serial s left join pulse.erp_document d on d.id=s.document_id where s.item_id=$1 and s.status<>'removed'
      order by s.status='in_stock' desc,s.updated_at desc,s.serial limit 500`, [itemId])).rows : [];
    const seat = await can(c);
    return { item: seat.cost ? item : { ...item, cost: null }, parts: noCost(parts, seat.cost), versions: noCost(versions, seat.cost),
      moves: seat.cost ? moves : moves.map((m: Row) => ({ ...m, unitCost: null })), usedIn, engagements, options, serials, inventoryEnabled: (await settings(c)).inventoryEnabled,
      // A salesperson changes the items they added (the database refuses the rest).
      canWrite: seat.write && (!seat.own || (await c.query("select pulse.erp_item_mine($1) m", [itemId])).rows[0].m as boolean), seesCost: seat.cost,
      ownOnly: seat.own, approvalMode: (await settings(c)).approvalMode };
  }));
  app.post<{ Body: Body }>("/api/v0/erp/items", (req) => tx(req, async (c, v) => {
    await writer(c);
    const seat = await can(c), s = await settings(c);
    // KAZUK-FLOW (G4): with approval off an item is usable at once (no "To approve"); a salesperson types no cost.
    const b = { ...(req.body ?? {}) } as Body;
    if (s.approvalMode === "none" && b.status !== "archived") b.status = "active";
    if (!seat.cost) b.cost = null;
    return createItem(c, v, b);
  }));
  // KAZUK-FLOW (G4, Kazuk: "I'll remove the clutter and add the final items myself"): archive every item drafted for the
  // company, keeping it and its history (leadership or an admin; the database checks and logs it).
  app.post("/api/v0/erp/catalog/start-clean", (req) => tx(req, async (c) => {
    await writer(c);
    return { archived: (await c.query("select pulse.erp_catalog_start_clean() n")).rows[0].n as number };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/items/:id", (req) => tx(req, async (c, v) => {
    await writer(c);
    const itemId = id(req.params.id, "Item");
    const before = (await c.query("select kind,price,cost,warranty_months,warranty_options,serialised from pulse.erp_item where id=$1", [itemId])).rows[0];
    if (!before) fail(404, "Item not found");
    // An older page that does not send the warranty or the serial switch keeps what the item has.
    const i = cleanItem({ warrantyMonths: before.warranty_months, warrantyOptions: before.warranty_options, serialised: before.serialised, ...req.body, kind: before.kind });
    // KAZUK-FLOW (G4): a seat that does not see the cost keeps it as it is; with approval off a saved draft is in use.
    if (!(await can(c)).cost) i.cost = before.cost === null ? null : Number(before.cost);
    if (i.status === "draft" && (await settings(c)).approvalMode === "none") i.status = "active";
    if (before.serialised && !i.serialised && (await c.query("select 1 from pulse.erp_stock_serial where item_id=$1 and status='in_stock' limit 1", [itemId])).rows[0])
      fail(409, "Units with serial numbers are in stock: sell or count them out before turning serial numbers off");
    await c.query(`update pulse.erp_item set code=$2,name=$3,description=$4,sac=$5,unit=$6,price=$7,gst_rate=$8,cost=$9,track_stock=$10,reorder_level=$11,milestones=$12,setup=$13,status=$14,updated_by=$15,
      warranty_months=$16,warranty_options=$17,serialised=$18 where id=$1`,
      [itemId, i.code, i.name, i.description, i.sac, i.unit, i.price, i.gstRate, i.cost, i.trackStock, i.reorder, JSON.stringify(i.milestones), i.setup, i.status, v.person,
        i.warrantyMonths, JSON.stringify(i.warrantyOptions), i.serialised]);
    if (req.body?.addOnIds !== undefined) await setAddOns(c, itemId, req.body.addOnIds);
    await log(c, "item", itemId, "saved", Number(before.price) !== i.price ? { price: [Number(before.price), i.price] } : {});
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/items/:id/parts", (req) => tx(req, async (c) => {
    await writer(c);
    const keepCost = !(await can(c)).cost;
    const parts = Array.isArray(req.body?.parts) ? req.body.parts : fail(400, "Parts are a list");
    const clean = (parts as Body[]).map((p, n) => {
      const label = str(p.label, 160) || fail(400, `Part ${n + 1}: name it`);
      const quantity = Number(p.quantity ?? 1);
      if (!Number.isFinite(quantity) || quantity <= 0) fail(400, `Part ${n + 1}: the quantity is a positive number`);
      const money = (x: unknown) => (x === null || x === undefined || x === "" ? null : Number.isInteger(Number(x)) && Number(x) >= 0 ? Number(x) : fail(400, `Part ${n + 1}: amounts are in paise`));
      return { label, itemId: optId(p.itemId), quantity, unit: str(p.unit, 20), deliverables: Array.isArray(p.deliverables) ? p.deliverables.map((x) => str(x, 200)).filter(Boolean).slice(0, 20) : [],
        where: str(p.where, 1000), setup: str(p.setup, 2000), derives: str(p.derives, 1000), price: money(p.price), cost: keepCost ? null : money(p.cost) };
    });
    // KAZUK-FLOW (G4): a seat that does not see part costs keeps each part's cost where the part stays (same position and name).
    if (keepCost) {
      const was = (await c.query("select position,label,cost::float8 cost from pulse.erp_package_part where package_id=$1", [id(req.params.id, "Package")])).rows;
      clean.forEach((x, n) => { const w = was.find((r: Row) => r.position === n && r.label === x.label); if (w) x.cost = w.cost; });
    }
    return { parts: (await c.query("select pulse.erp_parts_set($1,$2) n", [id(req.params.id, "Package"), JSON.stringify(clean)])).rows[0].n };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/items/:id/stock", (req) => tx(req, async (c, v) => {
    await fullBilling(c);
    return stockMove(c, v, id(req.params.id, "Item"), req.body ?? {});
  }));

  // BILLING-WL (Akabod, 4 Nov 2026: "stock is editable, so you can set the current stock"): what is on the shelf today,
  // a number or the serial numbers in stock; the difference is one adjustment, kept in the item's moves.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/items/:id/stock/set", (req) => tx(req, async (c) => {
    await fullBilling(c);
    const b = req.body ?? {};
    const qty = b.qty === undefined || b.qty === null || b.qty === "" ? null : Number(b.qty);
    if (qty !== null && !Number.isFinite(qty)) fail(400, "Enter the stock on hand now (0 or more)");
    return (await c.query("select pulse.erp_stock_set($1,$2,$3,$4) r", [id(req.params.id, "Item"), qty, Array.isArray(b.serials) ? (b.serials as unknown[]).map((x) => str(x, 80)) : null,
      str(b.note, 500) || null])).rows[0].r;
  }));
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>("/api/v0/erp/items/:id/serials", (req) => tx(req, async (c) => {
    await reader(c);
    const status = ["in_stock", "sold", "removed"].includes(String(req.query.status)) ? String(req.query.status) : null;
    return { serials: (await c.query(`select s.serial,s.status,to_char(s.updated_at,'YYYY-MM-DD') "on",d.number,d.id "documentId",d.buyer->>'name' "soldTo"
      from pulse.erp_stock_serial s left join pulse.erp_document d on d.id=s.document_id where s.item_id=$1 and ($2::text is null or s.status=$2)
      order by s.status='in_stock' desc,s.updated_at desc,s.serial limit 1000`, [id(req.params.id, "Item"), status])).rows };
  }));
  // Opening stock from a sheet (rows as tools/billing/stock-import.py reads them); a dry run unless apply is true.
  app.post<{ Body: Body }>("/api/v0/erp/stock/import", (req) => tx(req, async (c) => {
    await fullBilling(c);
    if (!Array.isArray(req.body?.rows)) fail(400, "The sheet is a list of rows");
    return (await c.query("select pulse.erp_stock_import($1,$2) r", [JSON.stringify(req.body!.rows), req.body?.apply === true])).rows[0].r;
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
    await fullBilling(c);
    const from = optId(req.body?.copyOf);
    const base = from ? (await c.query("select name,design,logo_id,signature_id,doc_types from pulse.erp_template where id=$1", [from])).rows[0] : null;
    const name = str(req.body?.name, 80) || (base ? `${base.name} copy` : "New template");
    const tid = (await c.query(`insert into pulse.erp_template(org_id,name,design,logo_id,signature_id,doc_types,created_by,updated_by) values(pulse.current_org(),$1,$2,$3,$4,coalesce($5::text[],'{invoice,proforma,quotation,credit_note}'::text[]),$6,$6) returning id`,
      [name, base?.design ?? { style: "line" }, base?.logo_id ?? null, base?.signature_id ?? null, base?.doc_types ?? null, v.person])).rows[0].id;
    await log(c, "template", tid, "created", { name });
    return { id: tid };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/templates/:id", (req) => tx(req, async (c, v) => {
    await fullBilling(c);
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
    await fullBilling(c);
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
  // BILLING (owner, 4 Nov 2026): "Select client" searches Clients and Contacts (leads included), so a quotation never
  // waits for a client project. Without a search: the clients and contacts billed most recently, then the newest.
  // BILLING (review, 4 Nov 2026): for Billing's writers only (the picker fills a draft); the Accountant reads Billing but
  // never Contacts, so the leads' phones and e-mails stay out of reach.
  // BILLING-WL (owner, 4 Nov 2026; Akabod: "Ajay" and "Asohiv Mifos" were not found though they exist): one forgiving
  // search over clients, contacts and Sales X-Ray's leads (those the viewer may see, not yet a client and not already a
  // contact) by name, company, phone, e-mail or GSTIN, in any case, spacing or word order, best match first.
  app.get<{ Querystring: { q?: string } }>("/api/v0/erp/parties", (req) => tx(req, async (c) => {
    await writer(c);
    const q = str(req.query.q, 80);
    // A phone is searched only once four digits are typed, so "12" does not match every number.
    const ph = q.replace(/\D/g, "").length >= 4;
    const clients = (await c.query(`select * from (select c.id,c.display_name name,c.company_name "companyName",c.city,x.gstin,(x.client_id is not null) billing,c.status,
      coalesce(x.contact_name,pc.display_name) "contactName",coalesce(x.phone,cp.phone,c.phone) phone,coalesce(x.email,cp.email,c.email) email,
      (select max(d.updated_at) from pulse.erp_document d where d.client_id=c.id) "lastBilled",c.updated_at,
      case when $1='' then 1 else pulse.search_score($1,array[c.display_name,c.company_name,x.legal_name,x.gstin,pc.display_name,x.contact_name,c.email,x.email,cp.email,
        case when $2 then c.phone end,case when $2 then x.phone end,case when $2 then cp.phone end]) end score
      from pulse.client c left join pulse.erp_party x on x.client_id=c.id left join pulse.person pc on pc.id=c.primary_contact_id
      left join pulse.contact_profile cp on cp.person_id=c.primary_contact_id
      where c.client_type is distinct from 'internal' and not exists(select 1 from pulse.record_merge m where m.entity_type='client' and m.gone_id=c.id and m.undone_at is null)) r
      where score>0 order by score desc,"lastBilled" desc nulls last,updated_at desc limit 12`, [q, ph])).rows;
    const contacts = (await c.query(`select * from (select p.id,p.display_name name,cp.designation,cp.contact_type "contactType",cp.email,cp.phone,cp.city,
      cl.id "clientId",cl.display_name "clientName",cp.updated_at,(select max(d.updated_at) from pulse.erp_document d where d.contact_person_id=p.id) "lastBilled",
      case when $1='' then 1 else pulse.search_score($1,array[p.display_name,cp.email,cl.display_name,cl.company_name,case when $2 then cp.phone end]) end score
      from pulse.contact_profile cp join pulse.person p on p.id=cp.person_id
      left join lateral (select cc.client_id from pulse.client_contact cc where cc.person_id=p.id order by cc.is_primary desc limit 1) l on true
      left join pulse.client cl on cl.id=l.client_id
      where p.side<>'staff' and p.status='active' and not exists(select 1 from pulse.record_merge m where m.entity_type='contact' and m.gone_id=p.id and m.undone_at is null)) r
      where score>0 order by score desc,"lastBilled" desc nulls last,updated_at desc limit 12`, [q, ph])).rows;
    const leads = (await c.query(`select * from (select l.sx_lead_id id,l.name,l.company,l.city,l.phone,l.email,l.stage_label stage,l.source_label source,l.owner_name owner,l.sx_created_at,
      case when $1='' then 1 else pulse.search_score($1,array[l.name,l.company,l.email,case when $2 then l.phone end]) end score
      from pulse.sales_xray_lead l
      where l.gone_at is null and l.client_id is null and not exists(select 1 from pulse.contact_profile cp join pulse.person p on p.id=cp.person_id and p.side<>'staff'
        where (l.email is not null and lower(cp.email)=lower(l.email)) or (length(regexp_replace(coalesce(l.phone,''),'\\D','','g'))>=10
          and right(regexp_replace(coalesce(cp.phone,''),'\\D','','g'),10)=right(regexp_replace(l.phone,'\\D','','g'),10)))) r
      where score>0 order by score desc,sx_created_at desc nulls last limit $3`, [q, ph, q ? 8 : 5])).rows;
    return { clients, contacts, leads };
  }));
  app.get<{ Querystring: { client?: string; contact?: string; lead?: string } }>("/api/v0/erp/parties/pick", (req) => tx(req, async (c) => {
    await writer(c);
    if (optId(req.query.lead)) return leadPick(c, optId(req.query.lead)!);
    if (!optId(req.query.client) && !optId(req.query.contact)) fail(400, "Choose a client or a contact");
    return partyPick(c, optId(req.query.client), optId(req.query.contact));
  }));
  // BILLING-WL: who a customer typed in already is (the same e-mail or phone), so the composer offers that profile
  // instead of a second one.
  app.get<{ Querystring: { email?: string; phone?: string } }>("/api/v0/erp/parties/twins", (req) => tx(req, async (c) => {
    await writer(c);
    return (await c.query("select pulse.erp_party_twins($1,$2) t", [str(req.query.email, 200) || null, str(req.query.phone, 40) || null])).rows[0].t;
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
    await fullBilling(c);
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
    await fullBilling(c);
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
    await fullBilling(c);
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
    const seat = await can(c);
    return { documents: rows, today: await today(c), canWrite: seat.write, ownOnly: seat.own, approvalMode: (await settings(c)).approvalMode };
  }));
  app.post<{ Body: Body }>("/api/v0/erp/documents", (req) => tx(req, async (c, v) => {
    await writer(c);
    if (req.body?.docType === "quotation") await step(c, "quote");
    return createDraft(c, v, req.body ?? {});
  }));
  app.get<{ Params: { id: string } }>("/api/v0/erp/documents/:id", (req) => tx(req, async (c, v) => {
    await reader(c);
    const docId = id(req.params.id, "Document");
    const doc = (await c.query(`select ${DOC_COLS} from pulse.erp_document d where d.id=$1`, [docId])).rows[0];
    if (!doc) fail(404, "Document not found");
    const lines = (await c.query(`select ${LINE_COLS} from pulse.erp_line where document_id=$1 order by position`, [docId])).rows;
    const payments = (await c.query(`select p.id,to_char(p.received_on,'YYYY-MM-DD') "receivedOn",p.amount::float8 amount,p.tds::float8 tds,p.method,p.reference,p.bank_line_key "bankLineKey",p.note,
      to_jsonb(p)->>'account' account,p.voided_at "voidedAt",(select f.mime from pulse.erp_payment_file f where f.payment_id=p.id) "proofMime",p.void_reason "voidReason",x.display_name "by" from pulse.erp_payment p left join pulse.person x on x.id=p.created_by where p.document_id=$1 order by p.received_on`, [docId])).rows;
    const events = (await c.query(`select e.kind,e.detail,e.at,p.display_name actor from pulse.erp_event e left join pulse.person p on p.id=e.actor where e.subject_id=$1 order by e.at desc limit 100`, [docId])).rows;
    const related = (await c.query(`select ${DOC_COLS} from pulse.erp_document d where d.against_id=$1 or d.source_id=$1 or d.id=(select against_id from pulse.erp_document where id=$1)
      or d.id=(select source_id from pulse.erp_document where id=$1) order by d.created_at`, [docId])).rows;
    const file = (await c.query("select sha256,created_at \"createdAt\",octet_length(bytes)::int size from pulse.erp_document_file where document_id=$1 and kind='pdf'", [docId])).rows[0] ?? null;
    const template = await templateFor(c, doc.templateId, doc.docType);
    const templates = (await c.query(`select id,name,doc_types "docTypes",design,logo_id "logoId",signature_id "signatureId" from pulse.erp_template where not archived order by created_at`)).rows;
    const orgLogo = !!(await c.query("select 1 from pulse.org_brand where org_id=pulse.current_org() and logo_png is not null")).rows[0];
    const task = doc.taskId ? (await c.query(`select t.id,t.title,t.status,to_char(t.due_at,'YYYY-MM-DD') "dueOn",p.display_name assignee from pulse.task t left join pulse.person p on p.id=t.assignee_person_id where t.id=$1`, [doc.taskId])).rows[0] ?? null : null;
    const links = (await c.query(`select created_at "createdAt",expires_at "expiresAt",revoked_at "revokedAt",opened_at "openedAt",decided_at "decidedAt",decision,signer_name "signer" from pulse.erp_accept_link where document_id=$1 order by created_at desc`, [docId])).rows;
    const { write, own } = await can(c);
    const bank = write && !own && doc.docType === "invoice" && !["draft", "cancelled", "paid"].includes(doc.status) ? (await c.query("select pulse.erp_bank_hints($1) h", [docId])).rows[0].h : [];
    const items = (await c.query(`select i.id,i.kind,i.name,i.description,i.sac,i.unit,i.price::float8 price,i.gst_rate::float8 "gstRate",i.status,i.code,${ITEM_EXTRAS},
      case when i.track_stock then pulse.erp_on_hand(i.id)::float8 end "onHand"
      from pulse.erp_item i where i.status<>'archived' order by i.kind='package' desc,i.name`)).rows;
    // FIN-LIVE's registers (sales register, collections, reconcile) take issued invoices at each sync.
    const financeSyncedAt = (await c.query("select pulse.erp_finance_synced_at() t")).rows[0].t;
    // FINANCE-TRUTH (4 Nov 2026): the accounts a payment can arrive in (the GST account named) and the base and GST still due.
    const paymentAccounts = doc.docType === "invoice" ? (await c.query("select pulse.finance_accounts() a")).rows[0].a : null;
    const due = doc.docType === "invoice" && doc.status !== "draft" ? (await c.query("select pulse.erp_invoice_due($1) d", [docId])).rows[0].d : null;
    // BILLING (owner, 4 Nov 2026): the approved copies a revised quotation keeps, and the project its paid invoice started.
    const versions = (await c.query(`select r.revision,r.created_at "filedAt",r.reason,r.reason_kind "reasonKind",r.snapshot->>'sent_at' "sentAt",(r.snapshot->>'total')::float8 total,to_char((r.snapshot->>'issued_at')::timestamptz,'YYYY-MM-DD') "approvedOn",
      r.snapshot->>'status' status,(r.pdf is not null) pdf,p.display_name "by" from pulse.erp_document_revision r left join pulse.person p on p.id=r.created_by
      where r.document_id=$1 order by r.revision desc`, [docId])).rows;
    const startedProject = (await c.query(`select p.id,coalesce(p.title,p.name) title,(p.lead_person_id is not null) assigned,(select display_name from pulse.person where id=p.lead_person_id) owner
      from pulse.project_quote q join pulse.project p on p.id=q.project_id and p.deleted_at is null where q.document_id=any(array[$1::uuid,$2::uuid]) order by q.linked_at limit 1`,
      [docId, doc.sourceId ?? docId])).rows[0] ?? null;
    const reissue = (await c.query(`select id,number,status from pulse.erp_document where reissue_of=$1 and status<>'cancelled' order by created_at limit 1`, [docId])).rows[0] ?? null;
    // A paid invoice that started no project by itself (blank, or the client already has a live project) offers to start one.
    const projectOffer = doc.docType === "invoice" && !startedProject ? (await c.query(`select coalesce(e.detail->>'reason','failed') reason,e.detail->>'project' project from pulse.erp_event e
      where e.subject_id=$1 and e.kind in ('project_offered','project_failed') order by e.at desc limit 1`, [docId])).rows[0] ?? null : null;
    // BILLING-WL (4 Nov 2026): the serial numbers in stock for a draft tax invoice's serialised items, the approval, and
    // whether WhatsApp Business is linked (it is not yet: the page says so and offers the PDF instead).
    const s = await settings(c);
    const stockSerials = doc.docType === "invoice" && doc.status === "draft" && write && s.inventoryEnabled ? Object.fromEntries((await c.query(`select s.item_id,array_agg(s.serial order by s.created_at,s.serial) serials
      from pulse.erp_stock_serial s join pulse.erp_item i on i.id=s.item_id and i.serialised where s.status='in_stock' group by s.item_id`)).rows.map((r: Row) => [r.item_id, r.serials.slice(0, 300)])) : {};
    const approval = write && doc.status === "draft" && s.approvalMode !== "none" ? await approvalOf(c, v, doc) : null;
    return { document: doc, lines, payments, events, related, file, task, links, bank, items, templates, financeSyncedAt, orgLogo, paymentAccounts, due, versions, startedProject, reissue, projectOffer,
      stockSerials, approval, whatsapp: whatsappBusiness(), inventoryEnabled: s.inventoryEnabled, approvalMode: s.approvalMode, ownOnly: own,
      // KAZUK-FLOW config (1671): the steps of the company's sales flow that stop this person, each with why and who unlocks.
      sendRequired: (await c.query("select pulse.erp_flow_step('send') s")).rows[0].s?.required ?? [],
      // KAZUK-FLOW (1688): the company's flow hides proforma from some roles (EA's preset: the sales role).
      proformaHidden: (await c.query("select pulse.viewer_is(variadic array(select jsonb_array_elements_text(coalesce(pulse.erp_flow_step('proforma')->'hiddenFor','[]'::jsonb)))) h")).rows[0].h as boolean,
      linesLocked: doc.status === "draft" ? (await c.query("select pulse.erp_lines_locked($1) l", [docId])).rows[0].l as boolean : false,
      blocks: write ? Object.fromEntries((await Promise.all(["send", "version", "accept", "lost", "invoice", "payment", "handover"].map(async (k) => [k, await blockOf(c, k)] as const)))
        .filter(([, b]) => b)) : {},
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
    // KAZUK-FLOW config (G3): what the company's flow requires on a quotation before it is numbered and sent.
    const cur = (await c.query("select doc_type,buyer,site_location from pulse.erp_document where id=$1", [id(req.params.id, "Document")])).rows[0];
    if (cur?.doc_type === "quotation") {
      const draft = (req.body?.draft && typeof req.body.draft === "object" ? req.body.draft : {}) as Body;
      const missing = sendMissing((await c.query("select pulse.erp_flow_step('send') s")).rows[0].s?.required, (draft.buyer as Body | undefined) ?? cur.buyer ?? {},
        "siteLocation" in draft ? draft.siteLocation : cur.site_location);
      if (missing.length) fail(400, `${missing[0]} is needed to send${missing.length > 1 ? ` (also ${missing.slice(1).join(", ").toLowerCase()})` : ""}`);
    }
    return issueDocument(c, v, id(req.params.id, "Document"), req.body?.draft && typeof req.body.draft === "object" ? req.body.draft as Body : null);
  }));
  // BILLING-WL (Akabod, 4 Nov 2026: the salesperson drafts it and sends it to their manager or the owner, who approves it
  // in one click; the salesperson is told). Asking again is a reminder.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/approval", (req) => tx(req, async (c, v) => {
    await writer(c);
    const docId = id(req.params.id, "Document");
    if (req.body?.draft && typeof req.body.draft === "object") await saveDraft(c, v, docId, req.body.draft as Body);
    return (await c.query("select pulse.erp_approval_ask($1,$2,$3) r", [docId, id(req.body?.to, "Approver"), str(req.body?.note, 500) || null])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/mark", (req) => tx(req, async (c) => {
    await writer(c);
    // KAZUK-FLOW G7: "negotiating" (the customer replied, the deal goes on) and "lost" with its reason.
    if (req.body?.action === "negotiating") { await step(c, "accept"); return { status: (await c.query("select pulse.erp_quote_negotiating($1,$2) s", [id(req.params.id, "Document"), str(req.body?.note, 500) || null])).rows[0].s }; }
    if (req.body?.action === "lost") { await step(c, "lost"); return { status: (await c.query("select pulse.erp_quote_lost($1,$2,$3) s", [id(req.params.id, "Document"), str(req.body?.reason, 20), str(req.body?.note, 500) || null])).rows[0].s }; }
    const action = ["sent", "cancel", "accepted", "declined"].includes(String(req.body?.action)) ? String(req.body?.action) : fail(400, "Choose what happened");
    const flowStep = ({ sent: "send", accepted: "accept", declined: "lost" } as Record<string, string>)[action];
    if (flowStep) await step(c, flowStep);
    return { status: (await c.query("select pulse.erp_document_mark($1,$2,$3) s", [id(req.params.id, "Document"), action, str(req.body?.note, 500) || null])).rows[0].s };
  }));
  // BILLING (owner, 4 Nov 2026): revise the same quotation after negotiation (the approved copy is kept as a version), undo
  // a revision not approved yet, re-issue a cancelled one under the next number, start a paid invoice's project by hand.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/revise", (req) => tx(req, async (c) => {
    await writer(c);
    await step(c, "version");
    // KAZUK-FLOW G8: a new version says why (price, scope, timeline, other) beside its note.
    if (req.body?.kind !== undefined) return (await c.query("select pulse.erp_quote_new_version($1,$2,$3) r", [id(req.params.id, "Document"), str(req.body.kind, 20), str(req.body?.note, 400) || null])).rows[0].r;
    return (await c.query("select pulse.erp_quote_revise($1,$2) r", [id(req.params.id, "Document"), str(req.body?.reason, 500) || null])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/revise/undo", (req) => tx(req, async (c) => {
    await writer(c);
    return (await c.query("select pulse.erp_quote_revise_undo($1) r", [id(req.params.id, "Document")])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/reissue", (req) => tx(req, async (c, v) => {
    await writer(c);
    const d = (await c.query("select doc_type from pulse.erp_document where id=$1", [id(req.params.id, "Document")])).rows[0] ?? fail(404, "Document not found");
    return createDraft(c, v, { docType: d.doc_type, reissueOf: req.params.id });
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/project", (req) => tx(req, async (c) => {
    await writer(c);
    await step(c, "handover");
    // KAZUK-FLOW (G1): only a document this person sees (a salesperson's own deal).
    if (!(await c.query("select 1 from pulse.erp_document where id=$1", [id(req.params.id, "Invoice")])).rows[0]) fail(404, "Invoice not found");
    return (await c.query("select pulse.erp_project_start($1) r", [id(req.params.id, "Invoice")])).rows[0].r;
  }));
  app.get<{ Params: { id: string; rev: string } }>("/api/v0/erp/documents/:id/versions/:rev/pdf", async (req, reply) => {
    const r = await tx(req, async (c) => {
      await reader(c);
      const row = (await c.query("select r.pdf,d.number from pulse.erp_document_revision r join pulse.erp_document d on d.id=r.document_id where r.document_id=$1 and r.revision=$2",
        [id(req.params.id, "Document"), Number.parseInt(req.params.rev, 10) || 0])).rows[0];
      if (!row?.pdf) fail(404, "That version has no filed copy");
      return row as { pdf: Buffer; number: string };
    });
    // BILLING-WL: the copy by the name it was printed under (the first is the number alone, then R2, R3…).
    const rev = Number.parseInt(req.params.rev, 10) || 0;
    const name = `${String(r.number).replace(/[^A-Za-z0-9-]+/g, "-")}${rev ? `-R${rev + 1}` : ""}.pdf`;
    return reply.header("content-type", "application/pdf").header("content-disposition", `attachment; filename="${name}"`).send(r.pdf);
  });
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/payments", { bodyLimit: 8 * 1024 * 1024 }, (req) => tx(req, async (c, v) => {
    await writer(c);
    await step(c, "payment");
    const b = req.body ?? {};
    // KAZUK-FLOW G10: the proof (a screenshot or PDF of the transfer) and, where the flow asks it of the salesperson, the UTR.
    const proof = paymentProof(b.proof);
    if ((await c.query("select pulse.erp_flow_step('payment') s")).rows[0].s?.proofRequired && (await can(c)).own) {
      if (!str(b.reference, 120)) fail(400, "Enter the UTR or reference of the payment");
      if (!proof) fail(400, "Add the payment proof: a screenshot or PDF of the transfer");
    }
    const pid = (await c.query("select pulse.erp_payment_add($1,$2) id", [id(req.params.id, "Document"), { amount: Number(b.amount), tds: Number(b.tds ?? 0),
      receivedOn: typeof b.receivedOn === "string" && DAY.test(b.receivedOn) ? b.receivedOn : null, method: str(b.method, 20) || "bank", reference: str(b.reference, 120),
      bankLineKey: str(b.bankLineKey, 200) || null, note: str(b.note, 500) }])).rows[0].id as string;
    // FINANCE-TRUTH: the account it arrived in (a payment into the GST account pays the invoice's GST first).
    if (str(b.account, 80)) await c.query("select pulse.erp_payment_account($1,$2)", [pid, str(b.account, 80)]);
    if (proof) await c.query(`insert into pulse.erp_payment_file(org_id,payment_id,document_id,mime,name,bytes,sha256,created_by) values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7)`,
      [pid, id(req.params.id, "Document"), proof.mime, proof.name, proof.bytes, createHash("sha256").update(proof.bytes).digest("hex"), v.person]);
    return { id: pid, proof: !!proof };
  }));
  // The proof as uploaded, for whoever reads the payment.
  app.get<{ Params: { id: string } }>("/api/v0/erp/payments/:id/proof", async (req, reply) => {
    const r = await tx(req, async (c) => { await reader(c); return (await c.query("select bytes,mime,name from pulse.erp_payment_file where payment_id=$1", [id(req.params.id, "Payment")])).rows[0]; });
    if (!r) fail(404, "No proof on this payment");
    reply.header("cache-control", "private, no-store").header("content-disposition", `inline; filename="${String(r.name || "payment-proof").replace(/[^A-Za-z0-9._-]+/g, "-")}"`);
    return reply.type(r.mime).send(r.bytes);
  });
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
    return { url: `${companyLinkOrigin((await c.query("select pulse.org_public_host() h")).rows[0]?.h)}/accept/${token}`, days };
  }));
  // BILLING-EMAIL (owner, 5 Nov 2026; Kazuk: e-mail is his main channel): send an approved quotation, proforma or tax
  // invoice by e-mail from its page. The composer starts from the customer's addresses and a message in plain words
  // (GET); the person changes what they like and presses Send (POST): nothing is ever sent without that. The filed PDF
  // goes attached and a quotation carries the customer's acceptance link. Sending goes through the platform's one mail
  // path (mail-send.ts: the company's sender, the sink in tests and CI, the allow-list off production). Only Billing's
  // writers (leadership and the Finance role, the database's erp_can) send. Once it went out, the document is marked
  // sent and the activity log says who sent it, when and to whom.
  app.get<{ Params: { id: string } }>("/api/v0/erp/documents/:id/email", (req) => tx(req, async (c, v) => {
    await writer(c);
    const d = (await c.query(`select ${DOC_COLS} from pulse.erp_document d where d.id=$1`, [id(req.params.id, "Document")])).rows[0] ?? fail(404, "Document not found");
    if (!mailable(d.docType, d.status)) fail(409, "Only an approved quotation, proforma or tax invoice is sent by e-mail");
    const party = d.clientId ? (await c.query("select x.email,coalesce(x.contact_name,c.display_name) name from pulse.erp_party x join pulse.client c on c.id=x.client_id where x.client_id=$1", [d.clientId])).rows[0] : null;
    const contact = d.contactPersonId ? (await c.query("select p.display_name name,cp.email from pulse.person p join pulse.contact_profile cp on cp.person_id=p.id where p.id=$1", [d.contactPersonId])).rows[0] : null;
    const me = v.person ? (await c.query("select display_name from pulse.person where id=$1", [v.person])).rows[0]?.display_name as string | undefined : undefined;
    const number = displayNumber({ number: d.number, doc_type: d.docType, revision: d.revision });
    const draft = documentMail({ ...d, number, balance: d.total - d.paid - d.credited }, { name: me ?? null });
    const sent = (await c.query(`select e.at,e.detail->'to' "to",p.display_name "by" from pulse.erp_event e left join pulse.person p on p.id=e.actor
      where e.subject_id=$1 and e.kind='emailed' order by e.at desc limit 5`, [d.id])).rows;
    return { to: suggestions([{ email: d.buyer?.email, name: d.buyer?.contactName ?? d.buyer?.name, source: "document" }, { email: party?.email, name: party?.name, source: "billing" },
      { email: contact?.email, name: contact?.name, source: "contact" }]), subject: draft.subject, body: draft.body, file: fileName({ id: d.id, number: d.number, doc_type: d.docType, revision: d.revision, buyer: d.buyer }, "pdf"),
      acceptLink: d.docType === "quotation" && ["issued", "sent"].includes(d.status), replyTo: v.email, sent };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/email", async (req) => {
    const b = req.body ?? {};
    // 1. Who may, what goes: the document (approved, not closed), its filed PDF and, for a quotation, a fresh acceptance link.
    const ready = await tx(req, async (c, v) => {
      await writer(c);
      const docId = id(req.params.id, "Document");
      const to = recipients(b.to);
      const subject = str(b.subject, 200).replace(/[\r\n]+/g, " ");
      if (!subject) fail(400, "Write a subject");
      const body = typeof b.body === "string" ? b.body : "";
      if (body.trim().length < 2) fail(400, "Write the message");
      const d = (await c.query("select id,doc_type,status,number,revision,buyer,seller from pulse.erp_document where id=$1", [docId])).rows[0] ?? fail(404, "Document not found");
      if (!mailable(d.doc_type, d.status)) fail(409, "Only an approved quotation, proforma or tax invoice is sent by e-mail");
      await step(c, "send");
      const stored = (await c.query("select bytes from pulse.erp_document_file where document_id=$1 and kind='pdf'", [docId])).rows[0];
      const pdf = stored ? Buffer.from(stored.bytes) : Buffer.from((await render(c, docId, "pdf")).bytes);
      let link: string | null = null;
      if (d.doc_type === "quotation" && b.acceptLink !== false && ["issued", "sent"].includes(d.status)) {
        const token = randomBytes(32).toString("base64url");
        await c.query("select pulse.erp_accept_link_create($1,$2,$3)", [docId, createHash("sha256").update(token).digest("hex"), 30]);
        link = `${companyLinkOrigin((await c.query("select pulse.org_public_host() h")).rows[0]?.h)}/accept/${token}`;
      }
      const fromName = String(d.seller?.tradeName || d.seller?.legalName || "").replace(/[\r\n"<>]/g, "").trim().slice(0, 80) || undefined;
      return { d, to, subject, body: finalBody(body, link), link: !!link, file: { filename: fileName(d, "pdf"), contentType: "application/pdf" as const, base64: pdf.toString("base64") },
        fromName, replyTo: v.email };
    });
    // 2. Send, one message per address (each sees only their own), after the read is committed.
    const from = clientMailFrom();
    const sent: string[] = [], failed: string[] = [];
    for (const to of ready.to) {
      const ok = await sendMail({ kind: "org", to, title: ready.subject, body: ready.body, attachments: [ready.file],
        ...(from ? { installSender: { from, fromName: ready.fromName, replyTo: ready.replyTo } } : {}) });
      (ok ? sent : failed).push(to);
    }
    // 3. What happened, in the document's log; nothing is marked sent unless at least one message went out.
    if (!sent.length) {
      await tx(req, async (c) => { await writer(c); await log(c, "document", ready.d.id, "email_failed", { to: failed }); });
      return fail(409, "The e-mail could not be sent, so nothing was marked sent. Check the address, or the company's mail in Settings → Mail, and try again; or download the PDF and send it yourself.");
    }
    return tx(req, async (c) => {
      await writer(c);
      const status = ready.d.status === "issued"
        ? (await c.query("select pulse.erp_document_mark($1,'sent',$2) s", [ready.d.id, `E-mailed to ${sent.join(", ")}`.slice(0, 500)])).rows[0].s as string : ready.d.status;
      await log(c, "document", ready.d.id, "emailed", { to: sent, ...(failed.length ? { failed } : {}), subject: ready.subject, file: ready.file.filename, acceptLink: ready.link, revision: ready.d.revision ?? 0 });
      return { sent, failed, status, acceptLink: ready.link };
    });
  });
  // KAZUK-FLOW G5 (Kazuk: "one click sends the PDF on WhatsApp and e-mail; log the time and both channels"): the page
  // opens the customer's WhatsApp with the PDF's link (Pulse does not message from a WhatsApp Business number yet) and
  // records it here, one 'whatsapp_sent' line per send with the version; the e-mail goes through the route above.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/erp/documents/:id/channel", (req) => tx(req, async (c) => {
    await writer(c);
    await step(c, "send");
    if (req.body?.channel !== "whatsapp") fail(400, "Say which channel: whatsapp");
    const d = (await c.query("select id,doc_type,status,revision from pulse.erp_document where id=$1", [id(req.params.id, "Document")])).rows[0] ?? fail(404, "Document not found");
    if (!mailable(d.doc_type, d.status)) fail(409, "Send a numbered quotation, proforma or tax invoice");
    const status = d.status === "issued" ? (await c.query("select pulse.erp_document_mark($1,'sent','Sent on WhatsApp') s", [d.id])).rows[0].s as string : d.status;
    await log(c, "document", d.id, "whatsapp_sent", { revision: d.revision ?? 0 });
    return { status };
  }));
  for (const format of ["pdf", "docx"] as const) {
    app.get<{ Params: { id: string }; Querystring: { inline?: string } }>(`/api/v0/erp/documents/:id/${format}`, async (req, reply) => {
      const inline = format === "pdf" && req.query.inline === "1"; // the page's own preview: viewed, not exported
      const out = await tx(req, async (c) => {
        await reader(c);
        const docId = id(req.params.id, "Document");
        const stored = format === "pdf" ? (await c.query("select f.bytes,d.number,d.buyer,d.id,d.doc_type,d.revision from pulse.erp_document_file f join pulse.erp_document d on d.id=f.document_id where f.document_id=$1 and f.kind='pdf'", [docId])).rows[0] : null;
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
      await fullBilling(c, false);
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
  // ACCEPT-SHARED (1625): on the shared address a hosted company's link is found by its exact token hash and the request
  // runs in that company; pulse.erp_accept_bind reads this flag once and clears it. A company's own address never sets it.
  const openLink = <T>(run: (c: PoolClient) => Promise<T>) => open(async (c) => {
    await c.query("select set_config('pulse.erp_accept_reach',$1,true)", [sharedAddress() ? "1" : ""]);
    return run(c);
  });
  const hashOf = (token: string) => (/^[A-Za-z0-9_-]{43}$/.test(token) ? createHash("sha256").update(token).digest("hex") : null);
  app.get<{ Params: { token: string } }>("/api/v0/accept/:token", async (req) => {
    const h = hashOf(req.params.token) ?? fail(404, "This link is not valid");
    const r = await openLink(async (c) => (await c.query("select pulse.erp_accept_open($1) r", [h])).rows[0].r);
    return r ?? fail(404, "This link is not valid or has expired");
  });
  app.get<{ Params: { token: string } }>("/api/v0/accept/:token/pdf", async (req, reply) => {
    const h = hashOf(req.params.token) ?? fail(404, "This link is not valid");
    const bytes = await openLink(async (c) => (await c.query("select pulse.erp_accept_file($1) b", [h])).rows[0].b);
    if (!bytes) fail(404, "This link is not valid or has expired");
    reply.header("cache-control", "private, no-store");
    return reply.type("application/pdf").send(bytes);
  });
  app.post<{ Params: { token: string }; Body: Body }>("/api/v0/accept/:token", async (req) => {
    const h = hashOf(req.params.token) ?? fail(404, "This link is not valid");
    const ip = String(req.headers["x-pulse-client-ip"] ?? req.ip ?? "");
    return openLink(async (c) => (await c.query("select pulse.erp_accept_decide($1,$2,$3,$4,$5,$6) r", [h, String(req.body?.decision ?? ""), str(req.body?.name, 120), str(req.body?.note, 1000),
      createHash("sha256").update(`erp-accept:${ip}`).digest("hex"), str(req.headers["user-agent"], 300)])).rows[0].r);
  });
}
