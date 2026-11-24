// QUOTE-BUILDER (owner, 19-20 Nov 2026; board 5, option C): what only the seller sees beside a quotation, proforma or
// invoice. Each line's base (the catalogue or rate-card price when the line was added) against the price given, the
// difference, and, for someone allowed to see cost, the margin; the extra charges split into fixed ones and estimates
// (variable charges not confirmed yet, which stay out of the total). Never part of the customer's copy: the document
// model (model.js) does not use this, and the renderer's input carries no base price, note or cost.
import { computeDocument } from './gst.js';

/** A variable charge not confirmed yet: an estimate, out of the document's total. */
export const isEstimate = (l) => l?.charge === 'variable' && l?.confirmed !== true;

const given = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
/** A line's amount before tax at `rate`, with the same arithmetic as the document (quantity to three decimals). */
const amountAt = (rate, l, withDiscount) => computeDocument({
  lines: [{ rate: Number(rate), qty: l.qty ?? 1, gstRate: 0, ...(withDiscount ? { discount: l.discount ?? 0, discountPercent: l.discountPercent ?? null } : {}) }],
  sellerState: '27', placeOfSupply: '27', roundTotal: false,
}).taxable;
const percentOf = (part, whole) => (whole ? Math.round((part * 1000) / whole) / 10 : 0);

/**
 * lines: the draft's lines as the composer or the API holds them ({ qty, rate, discount, discountPercent, catalogueRate,
 * charge, confirmed, notNeeded, role, cost }). `cost` is the item's unit cost in paise: pass it only for a viewer who may
 * see cost; margin is null unless every item line has one.
 */
export function priceComparison(lines = []) {
  const rows = [];
  let base = 0, yours = 0, all = 0, cost = 0, costKnown = true, items = 0, unpriced = 0, fixed = 0, estimate = 0, maxPercentOff = 0;
  for (const [index, l] of lines.entries()) {
    if (!l || l.notNeeded || !(Number(l.qty ?? 1) > 0)) continue;
    const mine = amountAt(l.rate ?? 0, l, true);
    if (l.charge) { if (isEstimate(l)) estimate += mine; else fixed += mine; continue; }
    if (l.role) continue; // included, to be quoted, bonus: priced at nothing on purpose
    items++;
    all += mine;
    if (given(l.cost)) cost += amountAt(l.cost, l, false); else costKnown = false;
    if (!given(l.catalogueRate)) { unpriced++; continue; }
    const at = amountAt(l.catalogueRate, l, false);
    const off = at - mine, percentOff = percentOf(off, at);
    base += at; yours += mine;
    if (percentOff > maxPercentOff) maxPercentOff = percentOff;
    rows.push({ index, base: at, yours: mine, off, percentOff });
  }
  const off = base - yours;
  const margin = items && costKnown ? all - cost : null;
  return {
    lines: rows, base, yours, off, percentOff: percentOf(off, base), changed: rows.filter((r) => r.off !== 0).length, maxPercentOff, unpriced,
    items: all, cost: items && costKnown ? cost : null, margin, marginPercent: margin === null ? null : percentOf(margin, all),
    charges: { fixed, estimate },
  };
}
