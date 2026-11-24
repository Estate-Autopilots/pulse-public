// ERP-INVOICE: request checks and the mapping between stored rows and @pulse/invoice-doc's document input. Pure, so the
// unit tests cover what a draft save accepts and how a stored document becomes the model the PDF/DOCX writers draw.
import { addDays, cleanQtyDims, computeDocument, dimsMatch, dimsQty, stateFromGstin, STATES, validGstin, type Computed, type DocumentInput, type DocType, type LineInput, type QtyDim } from "@pulse/invoice-doc";
import { cleanSelection, type Selection } from "./rate-card-model.js";

export const DOC_TYPES: readonly DocType[] = ["invoice", "proforma", "quotation", "credit_note"];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DAY = /^\d{4}-\d{2}-\d{2}$/;
export class ErpInputError extends Error { statusCode = 400; }
const bad = (message: string): never => { throw new ErpInputError(message); };

const text = (v: unknown, max: number, field: string, required = false) => {
  if (v === undefined || v === null) return required ? bad(`${field} is required`) : null;
  if (typeof v !== "string") return bad(`${field} must be text`);
  const t = v.trim();
  if (required && !t) bad(`${field} is required`);
  if (t.length > max) bad(`${field} is longer than ${max} characters`);
  return t || null;
};
const day = (v: unknown, field: string) => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !DAY.test(v) || Number.isNaN(Date.parse(v))) return bad(`${field} is a date`);
  return v;
};
const paise = (v: unknown, field: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 1e12) bad(`${field} is an amount in paise`);
  return n;
};
export const GST = [0, 0.1, 0.25, 1.5, 3, 5, 6, 12, 18, 28, 40];

export type Buyer = { name: string; gstin: string | null; stateCode: string | null; address: string[]; contactName: string | null; email: string | null; phone: string | null };
/** A buyer as typed in the editor: a valid GSTIN decides the state; without one the state is chosen. */
export function cleanBuyer(b: unknown): Buyer {
  const o = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
  const gstin = text(o.gstin, 15, "GSTIN")?.toUpperCase() ?? null;
  if (gstin && !validGstin(gstin)) bad("That GSTIN is not valid: check the 15 characters");
  const state = gstin ? stateFromGstin(gstin) : (text(o.stateCode, 2, "State") ?? null);
  if (state && !STATES[state]) bad("Choose the client's state");
  const address = Array.isArray(o.address) ? o.address.map((x, i) => text(x, 160, `Address line ${i + 1}`)).filter((x): x is string => !!x).slice(0, 6) : [];
  return { name: text(o.name, 200, "Client name") ?? "", gstin, stateCode: state, address, contactName: text(o.contactName, 120, "Contact"), email: text(o.email, 200, "E-mail"), phone: text(o.phone, 40, "Phone") };
}

/** A line as saved. EST-1236: `parentIndex` makes it an add-on of the line at that position; `open` is an amount priced per
 *  site (installation, transport); `notNeeded` keeps it on the draft but out of the figures, the preview and the issued
 *  document. */
export type LineRow = { itemId: string | null; description: string; details: string; sac: string | null; unit: string | null; qty: number; rate: number; discount: number; discountPercent: number | null; gstRate: number;
  parentIndex: number | null; open: boolean; notNeeded: boolean; warrantyMonths: number | null; serials: string[];
  /** KAZUK-REST (1710): the rate card choice the line was built from (the database prices it from the card). */
  rateCard: Selection | null;
  /** QUOTE-BUILDER-4 (2498): the quantity in numbers (6 users × 6 months); qty is their product. Null: one number. */
  qtyDims: QtyDim[] | null } & PhaseFields & ChargeFields;
/** QUOTE-BUILDER (owner, 19-20 Nov 2026; migration 2490): an extra charge, under "Extra charges": fixed (in the total) or
 *  variable (transport per km: settled at the end, an estimate until confirmed); and why a line's price is away from its
 *  base (the catalogue price when it was added). */
export type Charge = "fixed" | "variable";
export type ChargeFields = { charge: Charge | null; confirmed: boolean; priceNote: string | null };
/** A variable charge not yet confirmed: an estimate, kept out of the document's total. */
export const isEstimate = (l: { charge?: unknown; confirmed?: unknown }) => l.charge === "variable" && l.confirmed !== true;
export const ESTIMATES_OPEN = "Confirm each charge that was an estimate (its final amount) before the invoice is issued";
/** The charge fields of a line as sent (each optional: an older client sends none and gets a plain line). */
export function cleanChargeFields(o: Record<string, unknown>, at: string): ChargeFields {
  const charge = o.charge === undefined || o.charge === null || o.charge === "" ? null : o.charge === "fixed" || o.charge === "variable" ? o.charge : bad(`${at}: a charge is fixed or variable`);
  if (charge && o.role) bad(`${at}: an extra charge is not an included, to-be-quoted or bonus line`);
  return { charge, confirmed: charge === "variable" && o.confirmed === true, priceNote: text(o.priceNote, 160, `${at} price note`) };
}
/** QUOTE-STRUCT (2252; Kazuk's build guide, 16 Nov 2026): the phase heading a line prints under, its free-line role, the
 *  package it came from with that package's default for it (what "changed" is measured against) and a bonus's value. */
export type PhaseFields = { phase: string | null; phaseOrder: number | null; phaseGroup: string | null; role: LineRole | null; packageId: string | null; packageLabel: string | null;
  packageDefault: { qty: number; rate: number | null; itemId: string | null; qtyDims?: QtyDim[]; discountPercent?: number } | null; listRate: number | null };
/** QUOTE-BUILDER-4: a package part's default numbers (5 users × 4 months) and prepaid percent, kept when valid. */
function defaultTerms(def: Record<string, unknown>, qty: number): { qtyDims?: QtyDim[]; discountPercent?: number } {
  let dims: QtyDim[] | null = null;
  try { dims = cleanQtyDims(def.qtyDims); } catch { dims = null; }
  const pct = Number(def.discountPercent);
  return { ...(dims && dimsMatch(dims, qty) ? { qtyDims: dims } : {}), ...(Number.isFinite(pct) && pct > 0 && pct < 100 ? { discountPercent: pct } : {}) };
}
export type LineRole = "included" | "to_quote" | "bonus";
export const LINE_ROLES: readonly LineRole[] = ["included", "to_quote", "bonus"];
/** The phase fields of a line as sent (each optional: an older client sends none and gets a plain line). */
export function cleanPhaseFields(o: Record<string, unknown>, at: string, rate: number): PhaseFields {
  const role = o.role === undefined || o.role === null || o.role === "" ? null : (LINE_ROLES as readonly string[]).includes(String(o.role)) ? String(o.role) as LineRole : bad(`${at}: choose included, to be quoted or bonus`);
  if (role && rate !== 0) bad(`${at}: an included, to-be-quoted or bonus line is priced at nothing`);
  const order = o.phaseOrder === undefined || o.phaseOrder === null || o.phaseOrder === "" ? null : Number(o.phaseOrder);
  if (order !== null && (!Number.isInteger(order) || order < 0 || order > 99)) bad(`${at}: a phase's order is 0 to 99`);
  const def = o.packageDefault && typeof o.packageDefault === "object" && !Array.isArray(o.packageDefault) ? o.packageDefault as Record<string, unknown> : null;
  const packageId = typeof o.packageId === "string" && UUID.test(o.packageId) ? o.packageId : null;
  const dq = def ? Number(def.qty ?? 1) : 1, dr = def && def.rate !== null && def.rate !== undefined ? Number(def.rate) : null;
  if (def && (!Number.isFinite(dq) || dq < 0 || dq > 1e9 || (dr !== null && (!Number.isInteger(dr) || dr < 0 || dr > 1e12)))) bad(`${at}: the package's default for this part is not valid`);
  const list = o.listRate === undefined || o.listRate === null || o.listRate === "" ? null : paise(o.listRate, `${at} value`);
  const phase = text(o.phase, 120, `${at} phase`);
  return { phase, phaseOrder: phase ? order : null, phaseGroup: phase ? text(o.phaseGroup, 60, `${at} sub-group`) : null, role, packageId,
    packageLabel: packageId ? text(o.packageLabel, 400, `${at} package`) : null,
    packageDefault: packageId && def ? { qty: dq, rate: dr, itemId: typeof def.itemId === "string" && UUID.test(def.itemId) ? def.itemId : null, ...defaultTerms(def, dq) } : null,
    listRate: role === "bonus" ? list : null };
}
/** BILLING-WL (4 Nov 2026): a serial as typed or scanned (trimmed, no inner spaces, upper case), as the database keeps it. */
export const cleanSerial = (s: string) => s.trim().replace(/\s+/g, "").toUpperCase();
const SERIAL = /^[A-Za-z0-9][A-Za-z0-9./_-]{0,59}$/;
export function cleanLines(lines: unknown): LineRow[] {
  if (!Array.isArray(lines)) return bad("Lines are a list");
  if (lines.length > 100) bad("A document has up to 100 lines");
  const rows = lines.map((raw, i): LineRow => {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const at = `Line ${i + 1}`;
    // QUOTE-BUILDER-4 (2498): numbers sent (6 users × 6 months) make the quantity when none is sent; numbers that do not
    // make the quantity sent are dropped (the quantity wins, and prints as one number).
    let qtyDims: QtyDim[] | null = null;
    try { qtyDims = cleanQtyDims(o.qtyDims); } catch (e) { bad(`${at}: ${(e as Error).message.charAt(0).toLowerCase()}${(e as Error).message.slice(1)}`); }
    const qty = Number(o.qty ?? (qtyDims ? dimsQty(qtyDims) : 1));
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1e9 || Math.abs(Math.round(qty * 1000) - qty * 1000) > 1e-7) bad(`${at}: the quantity is a positive number with up to three decimals`);
    if (qtyDims && !dimsMatch(qtyDims, qty)) qtyDims = null;
    const gstRate = Number(o.gstRate ?? 18);
    if (!GST.includes(gstRate)) bad(`${at}: choose a GST rate`);
    const sac = text(o.sac, 8, `${at} SAC/HSN`);
    if (sac && !/^\d{4,8}$/.test(sac)) bad(`${at}: SAC/HSN is 4 to 8 digits`);
    const percent = o.discountPercent === undefined || o.discountPercent === null || o.discountPercent === "" ? null : Number(o.discountPercent);
    if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) bad(`${at}: a discount is 0 to 100%`);
    const itemId = typeof o.itemId === "string" && UUID.test(o.itemId) ? o.itemId : null;
    const parentIndex = o.parentIndex === undefined || o.parentIndex === null || o.parentIndex === "" ? null : Number(o.parentIndex);
    if (parentIndex !== null && (!Number.isInteger(parentIndex) || parentIndex < 0 || parentIndex >= lines.length || parentIndex === i)) bad(`${at}: an add-on belongs to another line of this document`);
    // BILLING-WL: an extended-warranty line says the months it adds (it is an add-on of the line it extends); a line of
    // serialised stock carries the serial of each unit, once each.
    const months = o.warrantyMonths === undefined || o.warrantyMonths === null || o.warrantyMonths === "" ? null : Number(o.warrantyMonths);
    if (months !== null && (!Number.isInteger(months) || months < 1 || months > 600)) bad(`${at}: an extended warranty is 1 to 600 months`);
    if (months !== null && parentIndex === null) bad(`${at}: an extended warranty belongs to the line it extends`);
    const serials = Array.isArray(o.serials) ? o.serials.map((s) => (typeof s === "string" ? cleanSerial(s) : "")).filter(Boolean) : [];
    if (serials.length > 500) bad(`${at}: up to 500 serial numbers on a line`);
    const wrong = serials.find((s) => !SERIAL.test(s));
    if (wrong) bad(`${at}: serial number ${wrong.slice(0, 60)} has characters a serial does not use`);
    if (new Set(serials).size !== serials.length) bad(`${at}: a serial number is listed twice`);
    return { itemId, description: text(o.description, 300, `${at} description`, true)!, details: text(o.details, 1000, `${at} details`) ?? "",
      sac, unit: text(o.unit, 20, `${at} unit`), qty, rate: paise(o.rate ?? 0, `${at} rate`), discount: percent ? 0 : paise(o.discount ?? 0, `${at} discount`), discountPercent: percent || null, gstRate,
      parentIndex, open: o.open === true && !o.role && o.charge !== "variable", notNeeded: o.notNeeded === true, warrantyMonths: months, serials, rateCard: cleanSelection(o.rateCard, at), qtyDims,
      ...cleanPhaseFields(o, at, paise(o.rate ?? 0, `${at} rate`)), ...cleanChargeFields(o, at) };
  });
  const all = rows.flatMap((r) => r.itemId ? r.serials.map((s) => `${r.itemId}:${s}`) : []);
  if (new Set(all).size !== all.length) bad("A serial number is on two lines");
  for (const [i, l] of rows.entries()) {
    if (l.parentIndex === null) continue;
    const parent = rows[l.parentIndex];
    if (parent.parentIndex !== null) bad(`Line ${i + 1}: an add-on belongs to a main line, not to another add-on`);
    if (parent.notNeeded) l.notNeeded = true; // a main line that is not needed takes its add-ons with it
  }
  return rows;
}

/** The lines that count, with add-ons pointing at their main line's new position; `index` maps each line to its place
 *  among them (null: not needed). */
export function neededLines(lines: LineRow[]): { kept: LineRow[]; index: (number | null)[] } {
  const index: (number | null)[] = [];
  let n = 0;
  for (const l of lines) index.push(l.notNeeded ? null : n++);
  const kept = lines.filter((l) => !l.notNeeded).map((l) => ({ ...l, parentIndex: l.parentIndex === null ? null : index[l.parentIndex] }));
  return { kept, index };
}
/** Open amounts still at zero and not marked not needed: a document with any is not issued. */
export const unfilledOpen = (lines: LineRow[]) => lines.filter((l) => l.open && !l.notNeeded && l.rate === 0).length;
export const OPEN_UNFILLED = "Fill each open amount or mark it not needed";

/** An item's usual add-ons as saved: distinct item ids, not the item itself, up to 20. */
export function cleanAddOnIds(raw: unknown, itemId: string | null): string[] {
  if (!Array.isArray(raw)) return bad("Add-ons are a list");
  const ids = raw.map((x) => (typeof x === "string" && UUID.test(x) ? x : bad("Choose add-ons from the catalogue")));
  if (new Set(ids).size !== ids.length) bad("Each add-on is listed once");
  if (itemId && ids.includes(itemId)) bad("An item is not its own add-on");
  if (ids.length > 20) bad("An item has up to 20 add-ons");
  return ids;
}

export type DraftFields = {
  issueDate: string; dueDate: string | null; validUntil: string | null; buyer: Buyer; placeOfSupply: string | null; reference: Record<string, string>;
  notes: string; terms: string | null; reverseCharge: boolean; zeroRated: boolean; roundTotal: boolean; templateId: string | null; lines: LineRow[];
};
export function cleanDraft(body: Record<string, unknown>): DraftFields {
  const issueDate = day(body.issueDate, "Date") ?? bad("Choose the date");
  const ref = (body.reference && typeof body.reference === "object" ? body.reference : {}) as Record<string, unknown>;
  const reference: Record<string, string> = {};
  for (const k of ["project", "milestone", "po"]) { const v = text(ref[k], 160, k === "po" ? "PO / reference" : k); if (v) reference[k] = v; }
  const pos = text(body.placeOfSupply, 2, "Place of supply");
  if (pos && !STATES[pos]) bad("Choose the place of supply");
  const buyer = cleanBuyer(body.buyer);
  return {
    issueDate, dueDate: day(body.dueDate, "Due date"), validUntil: day(body.validUntil, "Valid until"), buyer,
    placeOfSupply: pos ?? buyer.stateCode, reference, notes: text(body.notes, 2000, "Notes") ?? "", terms: body.terms === null || body.terms === undefined ? null : text(body.terms, 3000, "Terms") ?? "",
    reverseCharge: body.reverseCharge === true, zeroRated: body.zeroRated === true, roundTotal: body.roundTotal !== false,
    templateId: typeof body.templateId === "string" && UUID.test(body.templateId) ? body.templateId : null, lines: cleanLines(body.lines ?? []),
  };
}

export const toLineInput = (l: LineRow): LineInput => ({ description: l.description, details: l.details, sac: l.sac, unit: l.unit, qty: l.qty, rate: l.rate,
  discount: l.discount, discountPercent: l.discountPercent, gstRate: l.gstRate, itemId: l.itemId });
/** VITALS-CLOSEOUT (owner, 15 Nov 2026): an invoice or credit note from a business with no GSTIN (not registered for
 *  GST). It charges no GST, prints as a plain "Invoice" and is issued like any other (migration 2097). */
/** QUOTE-FIXES round 3 (Mac orchestrator's decision, 21 Nov 2026: "the GST default follows the company's GSTIN"): a business
 *  with no GSTIN charges no GST on anything it drafts from now on (quotation, proforma, invoice, credit note); documents
 *  already issued keep what they say. */
export const noGstin = (seller: { gstin?: unknown } | null | undefined) => !String(seller?.gstin ?? "").trim();
export const unregisteredInvoice = (docType: unknown, seller: { gstin?: unknown } | null | undefined) =>
  (docType === "invoice" || docType === "credit_note") && !String(seller?.gstin ?? "").trim();

/** QUOTE-FIXES (Mac test 21 Nov 2026: QT/26-27/0021 ₹11,210 with 18% IGST became INV/26-27/0003 ₹9,500 with no GST). A
 *  company with no GSTIN charges no GST on its invoice (unregisteredInvoice), so a quotation or proforma that charged GST
 *  would turn into an invoice with a different total. The tax invoice waits until the GSTIN is set (or the quotation is
 *  revised without GST): the words to say, or null when nothing would change. */
export function gstDropped(company: { gstin?: unknown } | null | undefined, src: { number?: unknown; doc_type?: unknown; cgst?: unknown; sgst?: unknown; igst?: unknown },
  target: "invoice" | "proforma" = "invoice") {
  const tax = Number(src.cgst ?? 0) + Number(src.sgst ?? 0) + Number(src.igst ?? 0);
  if (!(tax > 0) || !noGstin(company)) return null;
  const name = typeof src.number === "string" && src.number ? src.number : src.doc_type === "proforma" ? "The proforma" : "The quotation";
  const gst = `₹${(tax / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  return `${name} charges ${gst} GST, but the company has no GSTIN in ERP settings, so a ${target === "proforma" ? "proforma" : "tax invoice"} from it cannot charge GST and the customer's total would change. `
    + `Add the company's GSTIN in ERP settings, then make the tax invoice. Not registered for GST? Revise ${typeof src.number === "string" && src.number ? src.number : "it"} without GST first.`;
}

/** The figures to store for a draft; zero-rated supplies are only for exports (place of supply 96). */
export function figures(sellerState: string, d: Pick<DraftFields, "lines" | "placeOfSupply" | "roundTotal" | "reverseCharge" | "zeroRated">): Computed {
  if (d.zeroRated && d.placeOfSupply !== "96") bad("Zero-rated (LUT) is for exports: set the place of supply to Outside India");
  try {
    return computeDocument({ lines: d.lines.map(toLineInput), sellerState, placeOfSupply: d.placeOfSupply, roundTotal: d.roundTotal, reverseCharge: d.reverseCharge, zeroRated: d.zeroRated });
  } catch (e) { return bad(e instanceof Error ? e.message : "These figures cannot be worked out"); } // a refusal of the arithmetic reads as a 400
}

type Row = Record<string, unknown>;
/** BILLING-WL (Akabod, 4 Nov 2026: "Q-0001 R2"): a quotation's number as printed and shown. The first approved copy is the
 *  number alone; each revision (1471, same number) adds R2, R3… so the customer's copy says which one they hold. */
export function displayNumber(d: Row): string | null {
  const n = (d.number as string | null) ?? null, rev = Number(d.revision ?? 0);
  return n && d.doc_type === "quotation" && rev > 0 ? `${n} R${rev + 1}` : n;
}
/** A line's printed details, with the extended warranty and the serial numbers sold on it (BILLING-WL). */
export function lineDetails(l: Row): string {
  const serials = Array.isArray(l.serials) ? (l.serials as string[]).filter(Boolean) : [];
  return [String(l.details ?? "").trim(), serials.length ? `Serial no. ${serials.join(", ")}` : ""].filter(Boolean).join("\n").slice(0, 4000);
}
const iso =(v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" ? v.slice(0, 10) : null);
/** A stored document and its lines as @pulse/invoice-doc's input. */
export function documentInput(d: Row, lines: Row[], against?: { number: string | null; date: unknown } | null): DocumentInput {
  return {
    docType: d.doc_type as DocType, status: String(d.status), number: displayNumber(d),
    issueDate: iso(d.issue_date)!, dueDate: iso(d.due_date), validUntil: iso(d.valid_until),
    seller: (d.seller ?? {}) as DocumentInput["seller"], buyer: (d.buyer ?? {}) as DocumentInput["buyer"], placeOfSupply: (d.place_of_supply as string) ?? null,
    reference: (d.reference ?? {}) as DocumentInput["reference"], against: against ? { number: against.number, date: iso(against.date) } : null,
    // QUOTE-BUILDER (2490): a variable charge not yet confirmed prints apart as an estimate, out of the total. The base
    // price, the difference and the price note are never part of the customer's copy.
    ...printedLines(lines.filter((l) => !l.not_needed)),
    notes: (d.notes as string) || null, terms: (d.terms as string | null) ?? null,
    reverseCharge: !!d.reverse_charge, zeroRated: !!d.zero_rated, roundTotal: d.round_total !== false, paid: Number(d.paid ?? 0), credited: Number(d.credited ?? 0),
  };
}
/** Stored lines as the renderer's lines and estimates (variable charges not confirmed yet). */
export function printedLines(ls: Row[]): { lines: LineInput[]; estimates?: LineInput[] } {
  const out = (l: Row): LineInput => ({ description: String(l.description), details: lineDetails(l), sac: (l.sac as string) ?? null, unit: (l.unit as string) ?? null,
      qty: Number(l.qty), rate: Number(l.rate), discount: Number(l.discount ?? 0), discountPercent: l.discount_percent === null || l.discount_percent === undefined ? null : Number(l.discount_percent),
      gstRate: Number(l.gst_rate),
      // QUOTE-STRUCT (2252): the phase heading, free-line role, package heading and bonus value the quotation prints
      // (only those a line has, so a plain line reads exactly as before).
      ...(l.phase ? { phase: String(l.phase), phaseOrder: l.phase_order === null || l.phase_order === undefined ? null : Number(l.phase_order), phaseGroup: (l.phase_group as string | null) ?? null } : {}),
      ...(l.line_role ? { role: l.line_role as LineRole } : {}), ...(l.package_label ? { packageLabel: String(l.package_label) } : {}),
      ...(l.list_rate !== null && l.list_rate !== undefined ? { listRate: Number(l.list_rate) } : {}),
      // QUOTE-BUILDER-4 (2498): "6 users × 6 months" instead of "× 36".
      ...(Array.isArray(l.qty_dims) ? { qtyDims: l.qty_dims as QtyDim[] } : {}) });
  const est = ls.filter(isEstimate);
  return { lines: ls.filter((l) => !isEstimate(l)).map(out), ...(est.length ? { estimates: est.map(out) } : {}) };
}

/** QUOTE-STRUCT (2252): a stored line as a new draft's line (a re-issue, or a proforma or invoice made from a quotation),
 *  with its phase heading, role and package. `withNotNeeded` keeps a line that is not needed (a re-issue of a draft-like
 *  copy); a line still to be quoted is left off a proforma or invoice (it was never sold). */
export function copyLine(l: Row, { withNotNeeded = false } = {}): Record<string, unknown> {
  return { itemId: l.item_id ?? null, description: l.description, details: l.details, sac: l.sac, unit: l.unit, qty: Number(l.qty), rate: Number(l.rate),
    discount: Number(l.discount ?? 0), discountPercent: l.discount_percent === null || l.discount_percent === undefined ? null : Number(l.discount_percent), gstRate: Number(l.gst_rate),
    parentIndex: l.parent_position ?? null, open: !!l.open, ...(withNotNeeded ? { notNeeded: !!l.not_needed } : {}), warrantyMonths: l.warranty_months ?? null,
    phase: l.phase ?? null, phaseOrder: l.phase_order ?? null, phaseGroup: l.phase_group ?? null, role: l.line_role ?? null, packageId: l.package_id ?? null,
    packageLabel: l.package_label ?? null, packageDefault: l.package_default ?? null, listRate: l.list_rate === null || l.list_rate === undefined ? null : Number(l.list_rate),
    charge: l.charge ?? null, confirmed: !!l.confirmed, priceNote: l.price_note ?? null, qtyDims: Array.isArray(l.qty_dims) ? l.qty_dims : null };
}
/** Lines copied onto a proforma or invoice: those to be quoted are left off, and add-ons keep pointing at their line. */
export function soldLines(ls: Row[]): Record<string, unknown>[] {
  const keep = ls.map((l) => l.line_role !== "to_quote");
  const at: (number | null)[] = []; let n = 0;
  for (const k of keep) at.push(k ? n++ : null);
  return ls.flatMap((l, i) => {
    if (!keep[i]) return [];
    const c = copyLine(l);
    const p = l.parent_position === null || l.parent_position === undefined ? null : at[Number(l.parent_position)];
    return [{ ...c, parentIndex: p ?? null }];
  });
}

/** Milestone instalments from a package's plan: each percent of the price, the last one taking the rounding. */
export function milestonePlan(price: number, plan: { label: string; percent: number; offsetDays?: number }[], startsOn: string | null) {
  const total = plan.reduce((n, p) => n + Number(p.percent || 0), 0);
  if (!plan.length || Math.abs(total - 100) > 0.001) return [{ label: "Full amount", amount: price, dueOn: startsOn }];
  let given = 0;
  return plan.map((p, i) => {
    const amount = i === plan.length - 1 ? price - given : Math.round(price * Number(p.percent) / 100 / 100) * 100;
    given += amount;
    return { label: p.label, amount, dueOn: startsOn ? addDays(startsOn, Number(p.offsetDays || 0)) : null };
  });
}

/** FIX-BILLING (BC-066, 19 Nov 2026): a quotation or proforma approved as it stands (the bell's Approve, the API, a
 * quotation from words) whose draft date is before the latest document numbered in its series (drafted yesterday,
 * approved after today's first one was numbered) is dated the day it is approved, instead of refusing the approver
 * with "date this one on or after it". Its validity and due dates move by the same number of days, so the customer
 * keeps the same window. Invoices and credit notes keep the date a person chose (GST). Null: leave the dates alone. */
export function approvalRedate(d: { docType: string; number: string | null; issueDate: string; validUntil: string | null; dueDate: string | null },
  seriesLastDate: string | null, today: string): { issueDate: string; validUntil: string | null; dueDate: string | null } | null {
  if ((d.docType !== "quotation" && d.docType !== "proforma") || d.number) return null;
  if (!seriesLastDate || !DAY.test(d.issueDate) || !DAY.test(seriesLastDate) || !DAY.test(today)) return null;
  if (d.issueDate >= seriesLastDate || seriesLastDate > today) return null;
  const shift = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d.issueDate}T00:00:00Z`)) / 864e5);
  const move = (x: string | null) => (x && DAY.test(x) ? addDays(x, shift) : x);
  return { issueDate: today, validUntil: move(d.validUntil), dueDate: move(d.dueDate) };
}
