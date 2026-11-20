// QUOTE-BUILDER-4 (Kazuk's 19 Nov test, VTI task 1514f831; owner order 20 Nov ~23:10 IST): a quantity in two (or three)
// numbers. Neeti is sold per user per month, so 6 users for 6 months is one line whose quantity is 36, but the quotation
// says "6 users × 6 months", never "× 36". The same holds for any business: units × floors, hours × people, rooms ×
// nights. The line keeps its quantity (the product, used by every sum) and its numbers (qtyDims) for the words.
//
// A prepaid discount by months (Neeti: 3–5 months 5 %, 6–9 months 10 %, 12 months 15 %) comes from the item's term
// tiers: the tier with the most months that the line's months reach.
//
// Plain ESM: the browser composer, the PDF model and the API run the same code.

const MAX_DIMS = 3;
const UNIT = /^[\p{L}][\p{L} .-]{0,19}$/u;

/** "user", "users" → "user"; "months" → "month"; "people" → "person". */
export function singular(word) {
  const w = String(word ?? '').trim().toLowerCase();
  if (w === 'people') return 'person';
  if (w === 'mo' || w === 'mos') return 'month';
  if (/ies$/.test(w) && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(ss|us)$/.test(w)) return w;
  return w.endsWith('s') && w.length > 2 ? w.slice(0, -1) : w;
}
/** "1 user", "6 users", "1 person", "3 people", "2 nights". */
export function counted(n, unit) {
  const one = singular(unit);
  const many = one === 'person' ? 'people' : /[^aeiou]y$/.test(one) ? `${one.slice(0, -1)}ies` : /(s|x|ch|sh)$/.test(one) ? `${one}es` : `${one}s`;
  return `${numberWord(n)} ${Number(n) === 1 ? one : many}`;
}
const numberWord = (n) => { const x = Number(n); return Number.isInteger(x) ? String(x) : String(Math.round(x * 1000) / 1000); };

/** The two (or three) numbers a unit is sold by: "user/month", "user per month", "users × months", "room-night" →
 *  ["user", "month"]; a plain unit ("nos", "month", "km") → null. */
export function dimsOfUnit(unit) {
  const u = String(unit ?? '').trim();
  if (!u || u.length > 40) return null;
  const parts = u.split(/\s*(?:\/|×|\bx\b|\*|\bper\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > MAX_DIMS || parts.some((p) => !UNIT.test(p) || /^\d/.test(p))) return null;
  return parts.map(singular);
}

/** A line's numbers as sent ([{n, unit}]), checked: 2 or 3 of them, each a positive number with up to three decimals and
 *  a short unit word. Null when absent; throws a RangeError with plain words when they are not valid. */
export function cleanQtyDims(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_DIMS) throw new RangeError('A quantity in parts has 2 or 3 numbers (users × months)');
  return raw.map((d) => {
    const n = Number(d?.n);
    const unit = singular(d?.unit);
    if (!Number.isFinite(n) || n <= 0 || n > 1e6 || Math.abs(Math.round(n * 1000) - n * 1000) > 1e-7) throw new RangeError('Each number of the quantity is a positive number with up to three decimals');
    if (!UNIT.test(unit)) throw new RangeError('Each number of the quantity says what it counts (users, months)');
    return { n, unit };
  });
}

/** The quantity the numbers make (users × months), to three decimals. */
export function dimsQty(dims) {
  const q = (dims ?? []).reduce((p, d) => p * Number(d.n), 1);
  return Math.round(q * 1000) / 1000;
}
/** Whether the numbers make exactly this quantity. */
export const dimsMatch = (dims, qty) => Array.isArray(dims) && dims.length >= 2 && Math.abs(dimsQty(dims) - Number(qty)) < 1e-6;

/** "6 users × 6 months". */
export function dimsText(dims) {
  return (dims ?? []).map((d) => counted(d.n, d.unit)).join(' × ');
}

/** The months in a line's numbers (the one counting months), or null. */
export function monthsOf(dims) {
  const m = (dims ?? []).find((d) => singular(d.unit) === 'month');
  return m ? Number(m.n) : null;
}

/** The numbers for a quantity sold in a two-part unit, when the months are known: 20 of "user/month" over 4 months →
 *  5 users × 4 months. Null when it does not split into whole units (it then stays one number). */
export function splitQty(qty, unit, months) {
  const names = dimsOfUnit(unit);
  if (!names || names.length !== 2 || !(Number(months) > 0)) return null;
  const at = names.indexOf('month');
  if (at < 0) return null;
  const other = Number(qty) / Number(months);
  // Whole users (seats, rooms): 7 over 4 months is not 1.75 users; it stays one number.
  if (!(other >= 1) || Math.abs(other - Math.round(other)) > 1e-9) return null;
  const n = Math.round(other);
  return at === 1 ? [{ n, unit: names[0] }, { n: Number(months), unit: 'month' }] : [{ n: Number(months), unit: 'month' }, { n, unit: names[1] }];
}

/** Term tiers as kept ([{months, percent}]), cleaned and in order of months. */
export function cleanTiers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => ({ months: Number(t?.months), percent: Number(t?.percent) }))
    .filter((t) => Number.isInteger(t.months) && t.months >= 1 && t.months <= 120 && Number.isFinite(t.percent) && t.percent >= 0 && t.percent < 100)
    .sort((a, b) => a.months - b.months);
}
/** The prepaid discount for so many months: the tier with the most months the line reaches (9 months with tiers 3, 6, 12
 *  → the 6-month tier). 0 below the first tier. */
export function termPercent(tiers, months) {
  let p = 0;
  for (const t of cleanTiers(tiers)) if (Number(months) >= t.months) p = t.percent;
  return p;
}
/** A price per unit after a percent off, to the paisa (half up). */
export const offRate = (rate, percent) => Math.round((Number(rate) * (100 - Number(percent || 0))) / 100);
