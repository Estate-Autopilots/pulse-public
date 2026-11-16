// KAZUK-REST (6 Nov 2026; Kazuk's Quotation Builder v2, A8): a rate card choice priced and turned into quotation lines,
// in the browser. The same arithmetic as the API's rate-card-model.ts and the database's pulse.erp_rate_card_calc
// (exact, rounded half up to the paisa); the database decides each saved line's rate-card price.

/** n with up to three decimals as thousandths. */
const milli = (n) => BigInt(Math.round(n * 1000));
const roundDiv = (num, den) => (num * 2n + den) / (den * 2n);

/** The price of one part of a choice in paise ("base" or "addon:<key>"), or null when the choice is not on the card. */
export function cardPrice(card, sel) {
  const x = Number(sel.x);
  if (!Number.isFinite(x) || x < card.xMin || x > card.xMax) return null;
  const t = card.talents.find((v) => v.key === sel.talent), p = card.periods.find((v) => v.key === sel.period);
  if (!t || !p) return null;
  const part = sel.part ?? "base";
  if (part === "base") return Number(roundDiv(BigInt(card.base) * milli(x) * milli(t.factor) * BigInt(p.months) * milli(p.factor), 1000000000n));
  const a = part.startsWith("addon:") ? card.addOns.find((v) => v.key === part.slice(6)) : undefined;
  return a ? a.price * (a.per === "month" ? p.months : 1) : null;
}

/** "month", "quarter", "6 months". */
export const periodUnit = (months) => (months === 1 ? "month" : months === 3 ? "quarter" : months === 12 ? "year" : `${months} months`);
const num = (n) => String(Number(n.toFixed(3)));

/** The lines a choice puts on the quotation: the service at its rate-card price and one line per add-on picked (an add-on
 *  of the main line). Each carries the choice, so the database prices it from the card. */
export function cardLines(card, sel) {
  const t = card.talents.find((v) => v.key === sel.talent), p = card.periods.find((v) => v.key === sel.period);
  const rate = cardPrice(card, { ...sel, part: "base" });
  if (!t || !p || rate === null) return null;
  const choice = { cardId: card.id, x: Number(sel.x), talent: t.key, period: p.key };
  const unit = periodUnit(p.months);
  const tax = { sac: card.sac ?? null, gstRate: card.gstRate ?? 18, qty: 1, discount: 0, discountPercent: null, open: false };
  const main = { ...tax, itemId: card.itemId, description: `${card.name} · ${t.label} · ${p.label}`.slice(0, 300), unit,
    details: `${card.xLabel} ${num(Number(sel.x))} · ${t.label} · ${p.months === 1 ? "1 month" : `${p.months} months`}`.slice(0, 1000), rate,
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
