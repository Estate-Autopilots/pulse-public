// QUOTE-BUILDER (owner, 19-20 Nov 2026; board 5, option C "Quote + AI assistant"): pure pieces of the quotation builder,
// shared by the composer's routes (erp.ts) and API v1 (v1-money.ts), so the unit tests cover them without a database.
//  - splitFigures: a draft's figures with its estimates (variable charges not confirmed) kept out of the total.
//  - the AI's change card: what an AI employee proposes for a draft (change a price, add or change a charge, a quantity,
//    take a line off), checked when proposed and again when a person taps Apply; nothing changes before that.
//  - the telemetry a save writes: a price set away from the base, a charge added or confirmed.
import type { Computed } from "@pulse/invoice-doc";
import { ErpInputError, figures, GST, isEstimate, type DraftFields, type LineRow } from "./erp-model.js";

const bad = (message: string): never => { throw new ErpInputError(message); };
type Row = Record<string, unknown>;

/** The figures to store: the fixed lines' (the document's total) and the estimates' sum with their GST (never rounded). */
export function splitFigures(sellerState: string, d: Pick<DraftFields, "placeOfSupply" | "roundTotal" | "reverseCharge" | "zeroRated">, kept: LineRow[]) {
  const est = kept.map(isEstimate);
  const fig = figures(sellerState, { ...d, lines: kept.filter((_, i) => !est[i]) });
  const ef = est.some(Boolean) ? figures(sellerState, { ...d, roundTotal: false, lines: kept.filter((_, i) => est[i]) }) : null;
  let a = 0, b = 0;
  const lines: Computed["lines"] = est.map((e) => (e ? ef!.lines[b++] : fig.lines[a++]));
  return { fig, estimate: ef ? ef.total : 0, lines };
}

/** ₹1,04,500 or ₹11.80, as people read it. */
export function rupees(paise: number) {
  const neg = paise < 0, p = Math.abs(Math.round(paise)), whole = Math.floor(p / 100), part = p % 100;
  const s = String(whole), last3 = s.slice(-3), rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${neg ? "−" : ""}₹${rest ? `${rest},${last3}` : last3}${part ? `.${String(part).padStart(2, "0")}` : ""}`;
}
const qtyText = (q: number) => (Number.isInteger(q) ? String(q) : String(Math.round(q * 1000) / 1000));

// ------------------------------------------------------------------------------------------------ the AI's change card
export type Change =
  | { op: "price"; line: number; expect: string; rate: number | null; percentOff: number | null; note: string | null }
  | { op: "add_charge"; description: string; qty: number; unit: string | null; rate: number; gstRate: number; variable: boolean; note: string | null }
  | { op: "edit_charge"; line: number; expect: string; rate: number | null; qty: number | null; variable: boolean | null; confirmed: boolean | null }
  | { op: "qty"; line: number; expect: string; qty: number }
  | { op: "remove"; line: number; expect: string };
export const CHANGE_OPS = ["price", "add_charge", "edit_charge", "qty", "remove"] as const;
export const STALE = "The quotation changed since this was proposed: ask the assistant again";

const str = (v: unknown, max: number, field: string, required = false): string | null => {
  if (v === undefined || v === null || v === "") return required ? bad(`${field} is required`) : null;
  if (typeof v !== "string") return bad(`${field} must be text`);
  const t = v.trim().replace(/\s+/g, " ");
  if (required && !t) bad(`${field} is required`);
  if (t.length > max) bad(`${field} is longer than ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(t)) bad(`${field} has characters that cannot be printed`);
  return t || null;
};
const paise = (v: unknown, field: string) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 1e12 ? n : bad(`${field} is an amount in paise (₹1 = 100)`);
};
const quantity = (v: unknown, field: string) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1e9 && Math.abs(Math.round(n * 1000) - n * 1000) < 1e-7 ? n : bad(`${field} is a positive number with up to three decimals`);
};
/** The lines a person sees on the document (not those marked not needed), each with its index among all the lines. */
const shown = (lines: LineRow[]) => lines.map((l, i) => ({ l, i })).filter((x) => !x.l.notNeeded);
function target(lines: LineRow[], raw: unknown, at: string) {
  const n = Number(raw), list = shown(lines);
  if (!Number.isInteger(n) || n < 1 || n > list.length) bad(`${at}: line is 1 to ${list.length} (the lines as get_billing_document lists them)`);
  return list[n - 1];
}

/** A proposal's changes as sent, checked against the draft as it is now; each change that names a line keeps that line's
 *  description (`expect`), so Apply refuses if the draft has changed under it. */
export function cleanChanges(raw: unknown, lines: LineRow[]): Change[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) bad("Propose 1 to 20 changes");
  return (raw as unknown[]).map((c, k): Change => {
    const o = (c && typeof c === "object" ? c : {}) as Row, at = `Change ${k + 1}`;
    const op = String(o.op ?? "");
    if (op === "add_charge") {
      const gstRate = o.gstRate === undefined || o.gstRate === null ? 18 : Number(o.gstRate);
      if (!GST.includes(gstRate)) bad(`${at}: choose a GST rate`);
      return { op, description: str(o.description, 300, `${at} description`, true)!, qty: o.qty === undefined || o.qty === null ? 1 : quantity(o.qty, `${at} quantity`),
        unit: str(o.unit, 20, `${at} unit`), rate: paise(o.rate, `${at} rate`), gstRate, variable: o.variable === true, note: str(o.note, 160, `${at} note`) };
    }
    if (!(CHANGE_OPS as readonly string[]).includes(op)) bad(`${at}: op is price, add_charge, edit_charge, qty or remove`);
    const { l } = target(lines, o.line, at), expect = l.description;
    if (op === "price") {
      if (l.charge) bad(`${at}: line ${o.line} is an extra charge: use edit_charge`);
      if (l.role) bad(`${at}: line ${o.line} is priced at nothing on purpose (included, to be quoted or a bonus)`);
      const hasRate = o.rate !== undefined && o.rate !== null, hasPct = o.percentOff !== undefined && o.percentOff !== null;
      if (hasRate === hasPct) bad(`${at}: give the new price as rate (paise) or percentOff, not both`);
      const pct = hasPct ? Number(o.percentOff) : null;
      if (pct !== null && (!Number.isFinite(pct) || pct <= 0 || pct >= 100 || Math.round(pct * 100) !== pct * 100)) bad(`${at}: percentOff is more than 0 and less than 100, up to two decimals`);
      return { op, line: Number(o.line), expect, rate: hasRate ? paise(o.rate, `${at} rate`) : null, percentOff: pct, note: str(o.note, 160, `${at} note`) };
    }
    if (op === "edit_charge") {
      if (!l.charge) bad(`${at}: line ${o.line} is not an extra charge: use price or qty`);
      const ch = { rate: o.rate === undefined || o.rate === null ? null : paise(o.rate, `${at} rate`), qty: o.qty === undefined || o.qty === null ? null : quantity(o.qty, `${at} quantity`),
        variable: typeof o.variable === "boolean" ? o.variable : null, confirmed: typeof o.confirmed === "boolean" ? o.confirmed : null };
      if (ch.rate === null && ch.qty === null && ch.variable === null && ch.confirmed === null) bad(`${at}: say what changes (rate, qty, variable or confirmed)`);
      if (ch.confirmed && (ch.variable === false || (ch.variable === null && l.charge !== "variable"))) bad(`${at}: only a variable charge is confirmed`);
      return { op, line: Number(o.line), expect, ...ch };
    }
    if (op === "qty") return { op, line: Number(o.line), expect, qty: quantity(o.qty, `${at} quantity`) };
    return { op: "remove", line: Number(o.line), expect };
  });
}

/** The draft's lines with the changes made. `bases[i]` is line i's base (its catalogue price when added), for percentOff. */
export function applyChanges(lines: LineRow[], changes: Change[], bases: (number | null)[] = []): LineRow[] {
  const out = lines.map((l) => ({ ...l }));
  // Lines are named as they were shown when the card was made: resolve every target first, then change.
  const before = shown(out);
  const at = (c: { line: number; expect: string }) => {
    const hit = before[c.line - 1];
    if (!hit || hit.l.description !== c.expect) bad(STALE);
    return hit;
  };
  const resolved = changes.map((c) => (c.op === "add_charge" ? null : at(c)));
  for (const [k, c] of changes.entries()) {
    const hit = resolved[k];
    if (c.op === "add_charge") {
      out.push({ itemId: null, description: c.description, details: "", sac: null, unit: c.unit, qty: c.qty, rate: c.rate, discount: 0, discountPercent: null, gstRate: c.gstRate,
        parentIndex: null, open: false, notNeeded: false, warrantyMonths: null, serials: [], rateCard: null, phase: null, phaseOrder: null, phaseGroup: null, role: null,
        packageId: null, packageLabel: null, packageDefault: null, listRate: null, charge: c.variable ? "variable" : "fixed", confirmed: false, priceNote: c.note, qtyDims: null });
      continue;
    }
    const l = out[hit!.i];
    if (c.op === "price") {
      const base = bases[hit!.i] ?? l.rate;
      l.rate = c.rate ?? Math.round((base * (100 - c.percentOff!)) / 100);
      l.discount = 0; l.discountPercent = null;
      if (c.note) l.priceNote = c.note;
    } else if (c.op === "edit_charge") {
      if (c.rate !== null) l.rate = c.rate;
      if (c.qty !== null) l.qty = c.qty;
      if (c.variable !== null) { l.charge = c.variable ? "variable" : "fixed"; if (!c.variable) l.confirmed = false; }
      if (c.confirmed !== null) l.confirmed = c.confirmed && l.charge === "variable";
    } else if (c.op === "qty") l.qty = c.qty;
    else if (c.op === "remove") l.notNeeded = true;
  }
  return out;
}

/** One change in plain words, as the card and the AI's answer say it ("Hybrid inverter: ₹1,10,000 → ₹1,04,500 (−5%)"). */
export function describeChange(c: Change, lines: LineRow[], bases: (number | null)[] = []): string {
  const each = (rate: number, qty: number, unit: string | null) => (qty === 1 && !unit ? rupees(rate) : `${rupees(rate)}${unit ? `/${unit}` : ""} × ${qtyText(qty)}${unit ? ` ${unit}` : ""} · ${rupees(Math.round(rate * qty))}`);
  if (c.op === "add_charge") return `Add ${c.description} · ${each(c.rate, c.qty, c.unit)}${c.variable ? " (estimate, settled at the end)" : ""}`;
  const hit = shown(lines)[c.line - 1], l = hit?.l;
  const name = l?.description ?? c.expect;
  if (c.op === "price") {
    const from = l?.rate ?? 0, base = (hit ? bases[hit.i] : null) ?? from;
    const to = c.rate ?? Math.round((base * (100 - c.percentOff!)) / 100);
    const pct = base ? Math.round(((base - to) * 1000) / base) / 10 : 0;
    return `${name}: ${rupees(from)} → ${rupees(to)}${pct > 0 ? ` (−${pct}%)` : pct < 0 ? ` (+${-pct}%)` : ""}`;
  }
  if (c.op === "edit_charge") {
    const parts = [c.rate !== null && l ? `${rupees(l.rate)} → ${rupees(c.rate)}` : null, c.qty !== null && l ? `quantity ${qtyText(l.qty)} → ${qtyText(c.qty)}` : null,
      c.variable === true ? "settled at the end (estimate)" : c.variable === false ? "a fixed amount" : null, c.confirmed === true ? "confirmed: the final amount" : c.confirmed === false ? "back to an estimate" : null];
    return `${name}: ${parts.filter(Boolean).join(", ")}`;
  }
  if (c.op === "qty") return `${name}: quantity ${l ? qtyText(l.qty) : "?"} → ${qtyText(c.qty)}`;
  return `Take off ${name}`;
}

// ------------------------------------------------------------------------------------------------ telemetry
export type BuilderEvent = { kind: "billing.price_override" | "billing.variable_charge" | "billing.ai_proposal"; name: string; value: number; detail: Row };
/** What a save changed that the owner asked to measure: a line priced away from its base (new or a new price), a charge
 *  added, a charge confirmed. `before` is the stored rows (snake case), `after` the saved lines with each one's base.
 *  Amounts only: never a description, client or note. */
export function builderEvents(docType: string, by: "person" | "ai", before: Row[], after: { line: LineRow; base: number | null }[]): BuilderEvent[] {
  const ev: BuilderEvent[] = [];
  const priced = new Set(before.filter((r) => r.item_id).map((r) => `${r.item_id}|${Number(r.rate)}`));
  const charges = new Map(before.filter((r) => r.charge).map((r) => [String(r.description), r]));
  for (const { line: l, base } of after) {
    if (l.notNeeded) continue;
    if (l.itemId && !l.charge && !l.role && base !== null && l.rate !== base && !priced.has(`${l.itemId}|${l.rate}`)) {
      ev.push({ kind: "billing.price_override", name: docType, value: base - l.rate,
        detail: { by, base, rate: l.rate, percentOff: base ? Math.round(((base - l.rate) * 1000) / base) / 10 : 0, note: !!l.priceNote } });
    }
    if (l.charge) {
      const was = charges.get(l.description);
      if (!was) ev.push({ kind: "billing.variable_charge", name: docType, value: l.rate, detail: { by, step: "added", charge: l.charge, unit: l.unit ?? null } });
      else if (l.charge === "variable" && l.confirmed && !was.confirmed) {
        ev.push({ kind: "billing.variable_charge", name: docType, value: l.rate, detail: { by, step: "confirmed", estimate: Number(was.rate), final: l.rate } });
      }
    }
  }
  return ev;
}
