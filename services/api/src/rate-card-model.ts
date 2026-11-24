// KAZUK-REST (6 Nov 2026, migration 1710; Kazuk's Quotation Builder v2, A8): a rate card per service, checked and priced.
// Pure, so test/kazuk-rest-rate-cards.test.mjs covers what a card accepts and the price of each part. The database prices
// the same way (pulse.erp_rate_card_calc, exact numeric rounded to the paisa) and is the one that decides a line's price.

export type Talent = { key: string; label: string; factor: number };
export type Period = { key: string; label: string; months: number; factor: number };
export type CardAddOn = { key: string; label: string; price: number; per: "month" | "once" };
export type CardInput = { itemId: string; name: string; base: number; xLabel: string; xMin: number; xMax: number; talents: Talent[]; periods: Period[]; addOns: CardAddOn[] };
/** What a line was built from: the card, which part (the base or one add-on), X, the talent level and the period. */
export type Selection = { cardId: string; part: string; x: number; talent: string; period: string };

export class RateCardError extends Error { statusCode = 400; }
const bad = (m: string): never => { throw new RateCardError(m); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[a-z][a-z0-9-]{0,30}$/;
const MAX = 100_000_000_000; // ₹100 crore in paise: a card's base or add-on
const label = (v: unknown, max: number, what: string) => {
  const t = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  if (!t) bad(`Name the ${what}`);
  if (t.length > max) bad(`The ${what} is longer than ${max} characters`);
  return t;
};
/** Up to three decimals, as numeric(…,3) keeps it. */
const dec3 = (v: unknown, what: string, min: number, max: number) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n < min || n > max || Math.abs(Math.round(n * 1000) - n * 1000) > 1e-7) bad(`${what} is a number from ${min} to ${max} with up to three decimals`);
  return n;
};
/** QUOTE-STRUCT (Kazuk's bug list, 16 Nov 2026: "capped at 10 with 3 decimals"): a talent or period factor is up to 1000
 *  with up to six decimals, so an exact price ratio needs no made-up base (the database prices with exact numerics). */
export const FACTOR_MAX = 1000;
const dec6 = (v: unknown, what: string, min: number, max: number) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n < min || n > max || Math.abs(Math.round(n * 1e6) - n * 1e6) > 1e-5) bad(`${what} is a number from ${min} to ${max} with up to six decimals`);
  return n;
};
const paise = (v: unknown, what: string, min: number) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > MAX) bad(`${what} is an amount in paise`);
  return n;
};
const keyOf = (v: unknown, fallback: string, what: string) => {
  const k = typeof v === "string" && v ? v : fallback.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^(\d)/, "x$1").slice(0, 31);
  if (!KEY.test(k)) bad(`Give the ${what} a short key (letters, digits and dashes)`);
  return k;
};
function list<T extends { key: string }>(v: unknown, what: string, min: number, max: number, each: (o: Record<string, unknown>, i: number) => T): T[] {
  if (!Array.isArray(v)) return bad(`The ${what}s are a list`);
  if (v.length < min) bad(`Add at least ${min} ${what}`);
  if (v.length > max) bad(`A rate card has up to ${max} ${what}s`);
  const out = v.map((x, i) => each((x && typeof x === "object" ? x : {}) as Record<string, unknown>, i));
  if (new Set(out.map((x) => x.key)).size !== out.length) bad(`Two ${what}s have the same name`);
  return out;
}

/** A rate card as an admin typed it. */
export function cleanCard(body: unknown): CardInput {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const itemId = typeof b.itemId === "string" && UUID.test(b.itemId) ? b.itemId : bad("Choose the service from the catalogue");
  const xMin = dec3(b.xMin ?? 1, "The lowest X", 0.001, 1000), xMax = dec3(b.xMax ?? 10, "The highest X", 0.001, 1000);
  if (xMax < xMin) bad("The highest X is at least the lowest");
  return {
    itemId, name: label(b.name, 120, "rate card"), base: paise(b.base, "The base price per month", 1), xLabel: label(b.xLabel ?? "Scale", 40, "multiplier"), xMin, xMax,
    talents: list(b.talents, "talent level", 1, 8, (o) => { const l = label(o.label, 60, "talent level"); return { key: keyOf(o.key, l, "talent level"), label: l, factor: dec6(o.factor, `${l}'s factor`, 0.000001, FACTOR_MAX) }; }),
    periods: list(b.periods, "period", 1, 8, (o) => {
      const l = label(o.label, 60, "period"), months = Number(o.months);
      if (!Number.isInteger(months) || months < 1 || months > 12) bad(`${l} is 1 to 12 months`);
      return { key: keyOf(o.key, l, "period"), label: l, months, factor: dec6(o.factor ?? 1, `${l}'s factor`, 0.000001, FACTOR_MAX) };
    }),
    addOns: list(b.addOns ?? [], "add-on", 0, 12, (o) => { const l = label(o.label, 80, "add-on"); return { key: keyOf(o.key, l, "add-on"), label: l, price: paise(o.price, `${l}'s price`, 0), per: o.per === "once" ? "once" : "month" }; }),
  };
}

/** The choice a document line carries (erp_line.rate_card), or null for a line not built from a rate card. */
export function cleanSelection(v: unknown, at = "Line"): Selection | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return bad(`${at}: the rate card choice is not valid`);
  const o = v as Record<string, unknown>;
  const cardId = typeof o.cardId === "string" && UUID.test(o.cardId) ? o.cardId : bad(`${at}: choose a rate card`);
  const part = o.part === undefined || o.part === "base" ? "base" : typeof o.part === "string" && /^addon:[a-z][a-z0-9-]{0,30}$/.test(o.part) ? o.part : bad(`${at}: choose the base or an add-on of the rate card`);
  const x = dec3(o.x, `${at}: X`, 0.001, 1000);
  const talent = typeof o.talent === "string" && KEY.test(o.talent) ? o.talent : bad(`${at}: choose a talent level`);
  const period = typeof o.period === "string" && KEY.test(o.period) ? o.period : bad(`${at}: choose a period`);
  return { cardId, part, x, talent, period };
}

/** n with up to three decimals as thousandths (exact); a factor with up to six as millionths. */
const milli = (n: number) => BigInt(Math.round(n * 1000));
const micro = (n: number) => BigInt(Math.round(n * 1e6));
/** Rounds a non-negative BigInt ratio half up, as Postgres' round(numeric) does for positive numbers. */
const roundDiv = (num: bigint, den: bigint) => (num * 2n + den) / (den * 2n);

/** The price of one part of a choice, in paise: base × X × talent × months × period factor, or an add-on's price ×
 *  months (per month) or once. The same numbers as the database's. */
export function partPrice(card: Pick<CardInput, "base" | "xMin" | "xMax" | "talents" | "periods" | "addOns"> & { xLabel?: string }, sel: Omit<Selection, "cardId">): number {
  if (sel.x < card.xMin || sel.x > card.xMax) bad(`Choose ${(card.xLabel ?? "X").toLowerCase()} from ${card.xMin} to ${card.xMax}`);
  const t = card.talents.find((x) => x.key === sel.talent), p = card.periods.find((x) => x.key === sel.period);
  if (!t || !p) return bad("Choose a talent level and a period from the rate card");
  let v: bigint;
  if (sel.part === "base") v = roundDiv(BigInt(card.base) * milli(sel.x) * micro(t.factor) * BigInt(p.months) * micro(p.factor), 1_000_000_000_000_000n);
  else {
    const a = sel.part.startsWith("addon:") ? card.addOns.find((x) => x.key === sel.part.slice(6)) : undefined;
    if (!a) return bad("That add-on is not on the rate card");
    v = BigInt(a.price) * BigInt(a.per === "month" ? p.months : 1);
  }
  if (v > 1_000_000_000_000n) bad("That rate card price is too large");
  return Number(v);
}

/** QUOTE-STRUCT (Kazuk's build guide: "Rate card base price and factors: owner, admin and finance only"): what a seat
 *  that does not see cost reads of a card. The base and the factors stay out; each talent level × period's price for one
 *  X comes instead, in millionths of a paisa as text (exact), so the composer still prices any X as the database does. */
export function hiddenCard<T extends { base: number; talents: Talent[]; periods: Period[] }>(card: T) {
  const units: Record<string, Record<string, string>> = {};
  for (const t of card.talents) {
    units[t.key] = {};
    for (const p of card.periods) units[t.key][p.key] = (BigInt(card.base) * micro(t.factor) * BigInt(p.months) * micro(p.factor)).toString();
  }
  return { ...card, base: null, talents: card.talents.map((t) => ({ key: t.key, label: t.label, factor: null })),
    periods: card.periods.map((p) => ({ key: p.key, label: p.label, months: p.months, factor: null })), units };
}
