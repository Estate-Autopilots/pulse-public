// QUOTE-STRUCT (Kazuk, 16 Nov 2026: "VitalsOS Quotations: Phase-wise Package Editing: Build Guide"): a package added to a
// quotation opens into its parts, one editable line each, under the company's phases. Pure, so quote-phases.test.mjs
// covers how a package opens, what counts as changed from its default, and how lines group. The catalogue package itself
// never changes; the lines belong to this quotation only.
//
// Pricing rules (the guide): a part's price comes from the package (per unit), else from its catalogue item; a part
// priced at nothing whose item has a price is a bonus (its value struck through); one with no price anywhere is "To be
// quoted" (never priced silently at zero) unless its item is marked Included; a monthly service's quantity is its months.
// QUOTE-BUILDER-4 (Kazuk, 19 Nov): a part sold per user per month opens in two numbers (5 users × 4 months, from the
// package's months), priced at the item's price with the prepaid discount for those months (its term tiers).
import { counted, dimsMatch, dimsOfUnit, dimsQty, monthsOf, offRate, splitQty, termPercent } from "./qty-dims.js";

/** Where an item prints: its phase's name and order and its sub-group (null when the company has no such phase). */
export function phaseOf(phases, item) {
  const at = (phases ?? []).findIndex((p) => p.key === item?.phase);
  if (at < 0) return { phase: null, phaseOrder: null, phaseGroup: null };
  const p = phases[at];
  return { phase: p.name, phaseOrder: at, phaseGroup: item.phaseGroup && (p.groups ?? []).includes(item.phaseGroup) ? item.phaseGroup : null };
}

/** "Growth Package · your calling team…": the package's name and, when it is short, its description. */
export function packageLabel(pkg) {
  const name = String(pkg?.name ?? "").trim() || "Package";
  const note = String(pkg?.description ?? "").replace(/\s+/g, " ").trim();
  return (note && note.length <= 160 && !/^includes:/i.test(note) ? `${name} · ${note}` : name).slice(0, 400);
}

/** Whether a package opens into parts on a quotation: it has parts, and at least one of them is priced (a package of
 *  unpriced deliverables stays one line, as before). */
export function opensIntoParts(parts) {
  return (parts ?? []).some((p) => (p.price ?? null) !== null || Number(p.itemPrice) > 0);
}

/** A package's months: "4-month term", "Growth · 4 months" in its name or description, else its longest monthly part. */
export function packageMonths(pkg, parts) {
  const said = /\b(\d{1,2})\s*-?\s*(?:months?|mo)\b/i.exec(`${pkg?.name ?? ""} ${pkg?.description ?? ""}`);
  if (said && Number(said[1]) > 0) return Number(said[1]);
  const monthly = (parts ?? []).filter((p) => MONTHLY.test(String(p.unit ?? p.itemUnit ?? "").trim())).map((p) => Number(p.quantity) || 0);
  return monthly.length ? Math.max(...monthly) : null;
}
const MONTHLY = /^(month|months|mo|monthly|per month|pm)$/i;

/** QUOTE-BUILDER-4: a line in two numbers, priced per unit with its prepaid discount for its months. `listRate` is the
 *  item's price per unit (₹1,199 a user a month); `tiers` its term tiers. The discount is the line's percent off, so
 *  a change of months changes the discount, never "the price". */
export function termFields(qtyDims, listRate, tiers) {
  const pct = termPercent(tiers, monthsOf(qtyDims));
  return { rate: listRate, discount: 0, discountPercent: pct > 0 ? pct : null };
}
/** The prepaid percent a line's months give (0 when it has no numbers or tiers). */
export const autoPercent = (line, tiers) => (Array.isArray(line?.qtyDims) ? termPercent(tiers, monthsOf(line.qtyDims)) : 0);

/** The starting numbers of an item sold in a two-part unit ("user/month" → 1 user × `months` months), or null. */
export function startDims(unit, months = 1) {
  const names = dimsOfUnit(unit);
  if (!names || names.length !== 2) return null;
  return names.map((u) => ({ n: u === "month" ? Math.max(1, Math.round(Number(months) || 1)) : 1, unit: u }));
}

/** A line given new numbers: its quantity follows (users × months) and, while its percent off is the prepaid discount for
 *  its months, that discount follows the new months (Neeti: 4 → 6 months takes 5 % to 10 %). A percent the seller typed
 *  stays. */
export function withDims(line, dims, tiers) {
  const before = autoPercent(line, tiers), after = termPercent(tiers, monthsOf(dims));
  const auto = Math.abs(Number(line?.discountPercent ?? 0) - before) < 1e-9;
  return { qtyDims: dims, qty: dimsQty(dims), ...(auto ? { discountPercent: after > 0 ? after : null, discount: 0 } : {}) };
}

/** The quotation lines a package opens into, in the package's order, each with its phase and the package's default.
 *  `termTiersOf(itemId)` gives an item's term tiers (QUOTE-BUILDER-4), when known. */
export function packageLines(pkg, parts, phases, termTiersOf = () => []) {
  const pkgPhase = phaseOf(phases, pkg);
  const months = packageMonths(pkg, parts);
  // A package sold at nothing ("Bonuses included (₹0)") gives its parts free: a part with no price there is a bonus.
  const free = pkg.price !== undefined && pkg.price !== null && Number(pkg.price) === 0;
  return (parts ?? []).map((part) => {
    const own = part.price === null || part.price === undefined ? null : Number(part.price);
    const itemPrice = Number(part.itemPrice) > 0 ? Number(part.itemPrice) : null;
    const price = own ?? itemPrice;
    const role = part.included ? "included" : price === null ? (free ? "bonus" : "to_quote") : price === 0 ? (itemPrice || free ? "bonus" : "included") : null;
    const where = part.phase ? phaseOf(phases, part) : pkgPhase;
    const qty = Number(part.quantity) > 0 ? Number(part.quantity) : 1;
    const unit = part.unit ?? part.itemUnit ?? null;
    // Two numbers when the unit is sold so (user/month) and the quantity splits over the package's months.
    const qtyDims = dimsOfUnit(unit) ? splitQty(qty, unit, months) : null;
    let rate = role ? 0 : price, discountPercent = null;
    // A part priced at its item's price less the prepaid discount for its months (Kazuk's ₹1,139.05 = ₹1,199 − 5 %) is
    // kept as the item's price with that discount, so more months move the discount, not the price.
    if (qtyDims && !role && itemPrice) {
      const pct = termPercent(termTiersOf(part.itemId), monthsOf(qtyDims));
      if (pct > 0 && offRate(itemPrice, pct) === price) { rate = itemPrice; discountPercent = pct; }
    }
    return {
      itemId: part.itemId ?? null, description: String(part.label || part.itemName || "Part").slice(0, 300), details: "", sac: part.sac ?? pkg.sac ?? null,
      unit, qty, rate, discount: 0, discountPercent, gstRate: Number(part.gstRate ?? pkg.gstRate ?? 18),
      open: false, notNeeded: false, ...where, role, packageId: pkg.id, packageLabel: packageLabel(pkg),
      packageDefault: { qty, rate, itemId: part.itemId ?? null, ...(qtyDims ? { qtyDims } : {}), ...(discountPercent ? { discountPercent } : {}) }, listRate: role === "bonus" ? itemPrice : null,
      ...(qtyDims ? { qtyDims } : {}),
    };
  });
}

/** What changed on a part line from its package's default: added, removed, +1 / −2 (or "+1 user", "+2 months" for a line
 *  in numbers), price changed, swapped. A swap at the new item's own price is "swapped" only (Kazuk, 19 Nov: it read
 *  "price changed" too); `tiers` lets a prepaid discount for more months count as no price change. */
export function changes(line, tiers = []) {
  if (!line?.packageId) return [];
  const d = line.packageDefault;
  if (!d) return ["added"];
  if (line.notNeeded) return ["removed"];
  const out = [];
  const swapped = (d.itemId ?? null) !== (line.itemId ?? null);
  if (swapped) out.push("swapped");
  const dims = dimsMatch(line.qtyDims, line.qty) ? line.qtyDims : null, was = dims && dimsMatch(d.qtyDims, d.qty) ? d.qtyDims : null;
  if (dims && was && was.length === dims.length) {
    for (const [i, x] of dims.entries()) {
      const dn = Number(x.n) - Number(was[i].n);
      if (Math.abs(dn) > 1e-9) out.push(`${dn > 0 ? "+" : "−"}${counted(Math.abs(dn), x.unit)}`);
    }
  } else {
    const dq = Number(line.qty) - Number(d.qty);
    if (Math.abs(dq) > 1e-9) out.push(`${dq > 0 ? "+" : "−"}${Math.round(Math.abs(dq) * 1000) / 1000}`);
  }
  // The price a part is measured against: the package's for it, or after a swap the new item's own (catalogueRate).
  const ref = swapped ? (line.catalogueRate ?? null) : d.rate;
  // A percent off that is neither the package's nor the prepaid discount for the line's months is the seller's own price.
  const pct = Number(line.discountPercent ?? 0), auto = dims ? termPercent(tiers, monthsOf(dims)) : 0, given = swapped ? 0 : Number(d.discountPercent ?? 0);
  if (ref !== null && ref !== undefined && !line.role && (Number(line.rate) !== Number(ref) || (Math.abs(pct - auto) > 1e-9 && Math.abs(pct - given) > 1e-9))) out.push("price changed");
  return out;
}

/** A package's price on this quotation: the sum of its kept, priced lines (quantity × price, less a percent off). */
export function packageTotal(lines, packageId) {
  return (lines ?? []).filter((l) => l.packageId === packageId && !l.notNeeded && !l.role && Number(l.qty) > 0)
    .reduce((n, l) => n + Math.round(Number(l.rate) * Number(l.qty) * (1 - Number(l.discountPercent ?? 0) / 100)), 0);
}

/** Lines grouped the way the quotation prints them: phases in their order (sub-groups inside), then lines with no phase
 *  ("Other items" once any line has a phase), then bonuses. `key` stays stable while lines change. */
export function groupLines(lines) {
  const groups = [];
  const find = (key, make) => groups.find((g) => g.key === key) ?? (groups.push(make()), groups.at(-1));
  const anyPhase = (lines ?? []).some((l) => l.phase);
  for (const [i, l] of (lines ?? []).entries()) {
    const g = l.role === "bonus" ? find("bonus", () => ({ key: "bonus", name: "Bonuses included", order: 10000, first: i, lines: [] }))
      : l.phase ? find(`p:${l.phase}`, () => ({ key: `p:${l.phase}`, name: l.phase, order: Number.isFinite(Number(l.phaseOrder)) && l.phaseOrder !== null ? Number(l.phaseOrder) : 1000, first: i, lines: [] }))
      : find("other", () => ({ key: "other", name: anyPhase ? "Other items" : null, order: 5000, first: i, lines: [] }));
    g.lines.push(l);
  }
  for (const g of groups) if (g.key === "other" && anyPhase) g.name = "Other items";
  return groups.sort((a, b) => a.order - b.order || a.first - b.first).map((g) => ({ key: g.key, name: g.name, lines: g.lines,
    subGroups: [...new Set(g.lines.map((l) => l.phaseGroup ?? ""))] }));
}

/** Whether a catalogue item is offered on a quotation: only an active one (an older API sends no status). */
export const offered = (item) => (item?.status ?? "active") === "active";

/** Variants a part can be swapped for: other active catalogue items in the same phase and sub-group (Standard → Luxury). */
export function swapOptions(line, items) {
  const me = (items ?? []).find((i) => i.id === line?.itemId);
  if (!me?.phase) return [];
  // QUOTE-BUILDER-4 (Kazuk, 19 Nov): only active items are offered; a draft or archived one never is.
  return (items ?? []).filter((i) => i.id !== me.id && i.kind !== "package" && offered(i) && i.phase === me.phase && (i.phaseGroup ?? null) === (me.phaseGroup ?? null));
}

/** A line moved to another catalogue item (a swap): its name, price, tax and unit follow the new item; quantity, phase and
 *  package stay. A variant with no price is To be quoted; an Included one prints Included. */
export function swapTo(line, item) {
  const price = Number(item.price) > 0 ? Number(item.price) : null;
  const role = item.included ? "included" : price === null ? "to_quote" : null;
  // QUOTE-BUILDER-4: the new item's price is its base (a swap at catalogue price is no price change); a line in numbers
  // (Neeti Professional → AI) keeps its users, months and prepaid discount when the new item is sold the same way.
  const keepDims = Array.isArray(line.qtyDims) && String(item.unit ?? "").trim().toLowerCase() === String(line.unit ?? "").trim().toLowerCase();
  return { ...line, itemId: item.id, description: String(item.name).slice(0, 300), sac: item.sac ?? line.sac ?? null, unit: item.unit ?? line.unit ?? null,
    gstRate: Number(item.gstRate ?? line.gstRate ?? 18), rate: role ? 0 : price, role, open: false, listRate: null, catalogueRate: role ? null : price,
    ...(keepDims ? {} : { qtyDims: null, discountPercent: null }) };
}
