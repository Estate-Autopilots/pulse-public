// KAZUK-REST (6 Nov 2026; Kazuk's Quotation Builder v2, A8): a rate card choice priced and turned into quotation lines,
// in the browser. The same arithmetic as the API's rate-card-model.ts and the database's pulse.erp_rate_card_calc
// (exact, rounded half up to the paisa); the database decides each saved line's rate-card price.
import { counted } from "@pulse/invoice-doc/qty-dims";

/** n with up to three decimals as thousandths; a factor with up to six as millionths (QUOTE-STRUCT). */
const milli = (n) => BigInt(Math.round(n * 1000));
const micro = (n) => BigInt(Math.round(n * 1e6));
const roundDiv = (num, den) => (num * 2n + den) / (den * 2n);

/** The price of one part of a choice in paise ("base" or "addon:<key>"), or null when the choice is not on the card. */
export function cardPrice(card, sel) {
  const x = Number(sel.x);
  if (!Number.isFinite(x) || x < card.xMin || x > card.xMax) return null;
  const t = card.talents.find((v) => v.key === sel.talent), p = card.periods.find((v) => v.key === sel.period);
  if (!t || !p) return null;
  const part = sel.part ?? "base";
  // QUOTE-STRUCT: a seat that does not see cost gets each level × period's price for one X (millionths of a paisa), not
  // the base and factors; the price of any X is the same as the database's.
  const unit = card.units?.[t.key]?.[p.key];
  if (part === "base" && unit !== undefined) return Number(roundDiv(BigInt(unit) * milli(x), 1000000000000000n));
  if (part === "base") return card.base === null || card.base === undefined || t.factor === null || p.factor === null ? null
    : Number(roundDiv(BigInt(card.base) * milli(x) * micro(t.factor) * BigInt(p.months) * micro(p.factor), 1000000000000000n));
  const a = part.startsWith("addon:") ? card.addOns.find((v) => v.key === part.slice(6)) : undefined;
  return a ? a.price * (a.per === "month" ? p.months : 1) : null;
}

/** "month", "quarter", "6 months". */
export const periodUnit = (months) => (months === 1 ? "month" : months === 3 ? "quarter" : months === 12 ? "year" : `${months} months`);
const num = (n) => String(Number(n.toFixed(3)));

/** QUOTE-BUILDER-4: a card named "Phase 4: Sales Intelligence System™ — Neeti CRM" prints under its phase heading, so its
 *  line says "Neeti CRM". */
export const cardName = (name) => String(name ?? "").replace(/^phase\s*\d+\s*:[^—–]*[—–]\s*/i, "").trim() || String(name ?? "");
/** QUOTE-BUILDER-4 (Kazuk, 19 Nov: the Neeti card's line "leaves out the users"): when the card counts something in one
 *  word (Users, Seats, Projects), its line says how many for how long: "6 users × 6 months" (one project is not said). */
function countWords(card, x, months) {
  const label = String(card.xLabel ?? "").trim();
  if (!/^[A-Za-z]{2,20}$/.test(label) || /^(scale|x|factor|multiplier|level)$/i.test(label)) return null;
  const many = x !== 1 || /^(users?|seats?|people|persons?|members?|licen[cs]es?)$/i.test(label) ? `${counted(x, label)} × ` : "";
  return `${many}${counted(months, "month")}`;
}

/** The lines a choice puts on the quotation: the service at its rate-card price and one line per add-on picked (an add-on
 *  of the main line). Each carries the choice, so the database prices it from the card. */
export function cardLines(card, sel) {
  const t = card.talents.find((v) => v.key === sel.talent), p = card.periods.find((v) => v.key === sel.period);
  const rate = cardPrice(card, { ...sel, part: "base" });
  if (!t || !p || rate === null) return null;
  const choice = { cardId: card.id, x: Number(sel.x), talent: t.key, period: p.key };
  const unit = periodUnit(p.months);
  const tax = { sac: card.sac ?? null, gstRate: card.gstRate ?? 18, qty: 1, discount: 0, discountPercent: null, open: false };
  const words = countWords(card, Number(sel.x), p.months);
  // "6 months (10% prepaid)" → "10% prepaid" under the line; the months are in its name already.
  const note = words ? (/\(([^)]{1,60})\)/.exec(p.label)?.[1] ?? "") : null;
  const main = { ...tax, itemId: card.itemId, description: (words ? `${cardName(card.name)} · ${t.label} · ${words}` : `${cardName(card.name)} · ${t.label} · ${p.label}`).slice(0, 300), unit,
    details: (note ?? `${card.xLabel} ${num(Number(sel.x))} · ${t.label} · ${p.months === 1 ? "1 month" : `${p.months} months`}`).slice(0, 1000), rate,
    rateCard: { ...choice, part: "base" }, catalogueRate: rate };
  const addOns = (sel.addOns ?? []).flatMap((key) => {
    const a = card.addOns.find((v) => v.key === key);
    if (!a) return [];
    const price = cardPrice(card, { ...sel, part: `addon:${a.key}` });
    return [{ ...tax, itemId: card.itemId, description: `${a.label} (${card.name})`.slice(0, 300), unit: a.per === "month" ? unit : "once",
      details: a.per === "month" ? `${p.months === 1 ? "1 month" : `${p.months} months`} with ${card.name}` : `Once, with ${card.name}`, rate: price,
      rateCard: { ...choice, part: `addon:${a.key}` }, catalogueRate: price }];
  });
  return { main, addOns };
}
