// ERP-INVOICE: request checks and the mapping between stored rows and @pulse/invoice-doc's document input. Pure, so the
// unit tests cover what a draft save accepts and how a stored document becomes the model the PDF/DOCX writers draw.
import { addDays, computeDocument, stateFromGstin, STATES, validGstin, type Computed, type DocumentInput, type DocType, type LineInput } from "@pulse/invoice-doc";

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
  parentIndex: number | null; open: boolean; notNeeded: boolean };
export function cleanLines(lines: unknown): LineRow[] {
  if (!Array.isArray(lines)) return bad("Lines are a list");
  if (lines.length > 100) bad("A document has up to 100 lines");
  const rows = lines.map((raw, i): LineRow => {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const at = `Line ${i + 1}`;
    const qty = Number(o.qty ?? 1);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1e9 || Math.abs(Math.round(qty * 1000) - qty * 1000) > 1e-7) bad(`${at}: the quantity is a positive number with up to three decimals`);
    const gstRate = Number(o.gstRate ?? 18);
    if (!GST.includes(gstRate)) bad(`${at}: choose a GST rate`);
    const sac = text(o.sac, 8, `${at} SAC/HSN`);
    if (sac && !/^\d{4,8}$/.test(sac)) bad(`${at}: SAC/HSN is 4 to 8 digits`);
    const percent = o.discountPercent === undefined || o.discountPercent === null || o.discountPercent === "" ? null : Number(o.discountPercent);
    if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) bad(`${at}: a discount is 0 to 100%`);
    const itemId = typeof o.itemId === "string" && UUID.test(o.itemId) ? o.itemId : null;
    const parentIndex = o.parentIndex === undefined || o.parentIndex === null || o.parentIndex === "" ? null : Number(o.parentIndex);
    if (parentIndex !== null && (!Number.isInteger(parentIndex) || parentIndex < 0 || parentIndex >= lines.length || parentIndex === i)) bad(`${at}: an add-on belongs to another line of this document`);
    return { itemId, description: text(o.description, 300, `${at} description`, true)!, details: text(o.details, 1000, `${at} details`) ?? "",
      sac, unit: text(o.unit, 20, `${at} unit`), qty, rate: paise(o.rate ?? 0, `${at} rate`), discount: percent ? 0 : paise(o.discount ?? 0, `${at} discount`), discountPercent: percent || null, gstRate,
      parentIndex, open: o.open === true, notNeeded: o.notNeeded === true };
  });
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
/** The figures to store for a draft; zero-rated supplies are only for exports (place of supply 96). */
export function figures(sellerState: string, d: Pick<DraftFields, "lines" | "placeOfSupply" | "roundTotal" | "reverseCharge" | "zeroRated">): Computed {
  if (d.zeroRated && d.placeOfSupply !== "96") bad("Zero-rated (LUT) is for exports: set the place of supply to Outside India");
  try {
    return computeDocument({ lines: d.lines.map(toLineInput), sellerState, placeOfSupply: d.placeOfSupply, roundTotal: d.roundTotal, reverseCharge: d.reverseCharge, zeroRated: d.zeroRated });
  } catch (e) { return bad(e instanceof Error ? e.message : "These figures cannot be worked out"); } // a refusal of the arithmetic reads as a 400
}

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" ? v.slice(0, 10) : null);
/** A stored document and its lines as @pulse/invoice-doc's input. */
export function documentInput(d: Row, lines: Row[], against?: { number: string | null; date: unknown } | null): DocumentInput {
  return {
    docType: d.doc_type as DocType, status: String(d.status), number: (d.number as string) ?? null,
    issueDate: iso(d.issue_date)!, dueDate: iso(d.due_date), validUntil: iso(d.valid_until),
    seller: (d.seller ?? {}) as DocumentInput["seller"], buyer: (d.buyer ?? {}) as DocumentInput["buyer"], placeOfSupply: (d.place_of_supply as string) ?? null,
    reference: (d.reference ?? {}) as DocumentInput["reference"], against: against ? { number: against.number, date: iso(against.date) } : null,
    lines: lines.filter((l) => !l.not_needed).map((l) => ({ description: String(l.description), details: String(l.details ?? ""), sac: (l.sac as string) ?? null, unit: (l.unit as string) ?? null,
      qty: Number(l.qty), rate: Number(l.rate), discount: Number(l.discount ?? 0), discountPercent: l.discount_percent === null || l.discount_percent === undefined ? null : Number(l.discount_percent),
      gstRate: Number(l.gst_rate) })),
    notes: (d.notes as string) || null, terms: (d.terms as string | null) ?? null,
    reverseCharge: !!d.reverse_charge, zeroRated: !!d.zero_rated, roundTotal: d.round_total !== false, paid: Number(d.paid ?? 0), credited: Number(d.credited ?? 0),
  };
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
