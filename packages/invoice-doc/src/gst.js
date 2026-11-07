// ERP-INVOICE: Indian GST arithmetic for invoices, credit notes, proformas and quotations. Plain ESM so the browser
// (live preview), the API (issue, export) and the tests run the same code. Money is integer paise throughout; rates are
// percentages (18, 5, 0.25). Rounding is half away from zero at each step a printed figure is made.

/** GST state codes (the first two digits of a GSTIN) and whether the territory charges UTGST instead of SGST. */
export const STATES = Object.freeze({
  '01': { name: 'Jammu and Kashmir' }, '02': { name: 'Himachal Pradesh' }, '03': { name: 'Punjab' },
  '04': { name: 'Chandigarh', ut: true }, '05': { name: 'Uttarakhand' }, '06': { name: 'Haryana' }, '07': { name: 'Delhi' },
  '08': { name: 'Rajasthan' }, '09': { name: 'Uttar Pradesh' }, '10': { name: 'Bihar' }, '11': { name: 'Sikkim' },
  '12': { name: 'Arunachal Pradesh' }, '13': { name: 'Nagaland' }, '14': { name: 'Manipur' }, '15': { name: 'Mizoram' },
  '16': { name: 'Tripura' }, '17': { name: 'Meghalaya' }, '18': { name: 'Assam' }, '19': { name: 'West Bengal' },
  '20': { name: 'Jharkhand' }, '21': { name: 'Odisha' }, '22': { name: 'Chhattisgarh' }, '23': { name: 'Madhya Pradesh' },
  '24': { name: 'Gujarat' }, '26': { name: 'Dadra and Nagar Haveli and Daman and Diu', ut: true }, '27': { name: 'Maharashtra' },
  '29': { name: 'Karnataka' }, '30': { name: 'Goa' }, '31': { name: 'Lakshadweep', ut: true }, '32': { name: 'Kerala' },
  '33': { name: 'Tamil Nadu' }, '34': { name: 'Puducherry' }, '35': { name: 'Andaman and Nicobar Islands', ut: true },
  '36': { name: 'Telangana' }, '37': { name: 'Andhra Pradesh' }, '38': { name: 'Ladakh', ut: true },
  '97': { name: 'Other Territory', ut: true }, '96': { name: 'Outside India (export)' },
});
export const GST_RATES = Object.freeze([0, 0.1, 0.25, 1.5, 3, 5, 6, 12, 18, 28, 40]);
export const EXPORT_STATE = '96';

export const stateName = (code) => STATES[code]?.name ?? null;
/** "Maharashtra (27)", the way GST invoices print a place of supply. */
export const stateLabel = (code) => (STATES[code] ? `${STATES[code].name} (${code})` : '');

const GSTIN_SHAPE = /^(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])Z([0-9A-Z])$/;
const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** The GSTIN check character: alternate weights 1 and 2 over base 36, folding each product's quotient into the sum. */
export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = B36.indexOf(first14[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return B36[(36 - (sum % 36)) % 36];
}
/** A well-formed GSTIN with a known state code and a correct check character. */
export function validGstin(value) {
  const g = String(value ?? '').trim().toUpperCase();
  const m = GSTIN_SHAPE.exec(g);
  return !!m && !!STATES[m[1]] && m[1] !== EXPORT_STATE && gstinCheckChar(g.slice(0, 14)) === g[14];
}
export const stateFromGstin = (gstin) => (validGstin(gstin) ? String(gstin).trim().toUpperCase().slice(0, 2) : null);
/** The PAN inside a GSTIN (characters 3–12). */
export const panFromGstin = (gstin) => (validGstin(gstin) ? String(gstin).trim().toUpperCase().slice(2, 12) : null);

/** a / b rounded half away from zero, on BigInt so large figures stay exact. */
export function divRound(a, b) {
  const x = BigInt(a), y = BigInt(b);
  if (y === 0n) throw new RangeError('Division by zero');
  const negative = (x < 0n) !== (y < 0n);
  const ax = x < 0n ? -x : x, ay = y < 0n ? -y : y;
  const q = (2n * ax + ay) / (2n * ay);
  return Number(negative ? -q : q);
}
/** A percentage as parts per million (18 → 180000), refusing more than four decimals. */
export function perMillion(percent) {
  const n = Number(percent);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new RangeError('A rate is a percentage between 0 and 100');
  const micro = Math.round(n * 10000);
  if (Math.abs(micro - n * 10000) > 1e-6) throw new RangeError('A rate has at most four decimals');
  return micro;
}
/** Quantities carry up to three decimals (1.5 hours, 0.25 kg). */
export function milli(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) throw new RangeError('A quantity is a positive number');
  const m = Math.round(n * 1000);
  if (Math.abs(m - n * 1000) > 1e-6) throw new RangeError('A quantity has at most three decimals');
  return m;
}

/**
 * Whether a supply is intra-state (CGST + SGST/UTGST) or inter-state (IGST). The place of supply decides: for a
 * registered buyer it is the state of their GSTIN; for exports (96) IGST applies, or nothing under a LUT.
 */
export function taxMode(sellerState, placeOfSupply) {
  if (!STATES[sellerState]) throw new RangeError('The seller needs a GST state code');
  const pos = placeOfSupply || sellerState;
  if (!STATES[pos]) throw new RangeError('Unknown place of supply');
  return pos === sellerState ? 'intra' : 'inter';
}

/**
 * Every figure an invoice prints, worked out from its lines.
 * - amount = rate × quantity; a discount (percent or paise) comes off before tax; taxable = amount − discount.
 * - Tax is computed per line and per component (CGST and SGST each at half the rate, or IGST at the full rate) and each
 *   is rounded to the paisa; totals are the sums of the printed line figures, so the page always adds up.
 * - The grand total is rounded to the rupee by default, with the difference shown as "Round off" (±0.50 at most).
 */
export function computeDocument({ lines = [], sellerState, placeOfSupply, roundTotal = true, reverseCharge = false, zeroRated = false } = {}) {
  const mode = taxMode(sellerState, placeOfSupply);
  const pos = placeOfSupply || sellerState;
  const split = STATES[pos].ut ? 'UTGST' : 'SGST';
  const out = [];
  for (const [index, line] of lines.entries()) {
    const rate = Number(line.rate);
    if (!Number.isInteger(rate) || rate < 0) throw new RangeError(`Line ${index + 1}: the rate is whole paise, not negative`);
    const qtyMilli = milli(line.qty ?? 1);
    const amount = divRound(BigInt(rate) * BigInt(qtyMilli), 1000);
    let discount = 0;
    if (line.discountPercent != null && line.discountPercent !== '' && Number(line.discountPercent) !== 0) {
      discount = divRound(BigInt(amount) * BigInt(perMillion(line.discountPercent)), 1_000_000);
    } else if (line.discount != null && line.discount !== '') {
      discount = Number(line.discount);
      if (!Number.isInteger(discount) || discount < 0) throw new RangeError(`Line ${index + 1}: a discount is whole paise`);
    }
    if (discount > amount) throw new RangeError(`Line ${index + 1}: the discount is more than the amount`);
    const taxable = amount - discount;
    const gstRate = zeroRated ? 0 : Number(line.gstRate ?? 0);
    const micro = perMillion(gstRate);
    let cgst = 0, sgst = 0, igst = 0;
    if (mode === 'intra') {
      cgst = divRound(BigInt(taxable) * BigInt(micro), 2_000_000);
      sgst = cgst;
    } else {
      igst = divRound(BigInt(taxable) * BigInt(micro), 1_000_000);
    }
    const tax = cgst + sgst + igst;
    out.push({ ...line, qtyMilli, amount, discount, taxable, gstRate, cgst, sgst, igst, tax, total: taxable + tax });
  }
  const sum = (key) => out.reduce((n, l) => n + l[key], 0);
  const taxable = sum('taxable'), cgst = sum('cgst'), sgst = sum('sgst'), igst = sum('igst'), discount = sum('discount'), amount = sum('amount');
  const tax = cgst + sgst + igst;
  // Under reverse charge the buyer pays the tax to the government; the invoice still shows it.
  const exact = taxable + (reverseCharge ? 0 : tax);
  const total = roundTotal ? divRound(exact, 100) * 100 : exact;
  const group = (keyOf) => {
    const map = new Map();
    for (const l of out) {
      const key = keyOf(l);
      const g = map.get(key) ?? { sac: l.sac ?? '', gstRate: l.gstRate, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
      for (const k of ['taxable', 'cgst', 'sgst', 'igst', 'tax']) g[k] += l[k];
      map.set(key, g);
    }
    return [...map.values()];
  };
  return {
    mode, placeOfSupply: pos, split, reverseCharge: !!reverseCharge, zeroRated: !!zeroRated,
    lines: out, amount, discount, taxable, cgst, sgst, igst, tax, exact, roundOff: total - exact, total,
    words: amountInWords(total),
    byRate: group((l) => String(l.gstRate)).sort((a, b) => a.gstRate - b.gstRate),
    bySac: group((l) => `${l.sac ?? ''}|${l.gstRate}`),
  };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function belowHundred(n) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}
function belowThousand(n) {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? belowHundred(r) : ''].filter(Boolean).join(' ');
}
/** Whole rupees in the Indian system: crore, lakh, thousand, hundred ("One Crore Twenty Lakh Five Thousand"). */
export function rupeesInWords(rupees) {
  let n = Math.floor(Math.abs(Number(rupees)));
  if (!Number.isSafeInteger(n)) throw new RangeError('Amount out of range');
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 1e7);
  n %= 1e7;
  if (crore) parts.push(`${crore >= 1000 ? rupeesInWords(crore) : belowThousand(crore)} Crore`);
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (n) parts.push(belowThousand(n));
  return parts.join(' ');
}
/** "Rupees One Lakh Eighteen Thousand Only", "Rupees Ten and Fifty Paise Only". */
export function amountInWords(paise) {
  const p = Math.round(Math.abs(Number(paise)));
  const rupees = Math.floor(p / 100), rest = p % 100;
  return `Rupees ${rupeesInWords(rupees)}${rest ? ` and ${belowHundred(rest)} Paise` : ''} Only`;
}

/** Indian digit grouping without Intl, so the browser and the server print the same characters: 1,18,000.00. */
export function formatAmount(paise, { decimals = true } = {}) {
  const n = Math.round(Number(paise) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = String(Math.floor(abs / 100));
  const last3 = whole.slice(-3), rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${sign}${grouped}${decimals ? `.${String(abs % 100).padStart(2, '0')}` : ''}`;
}
export const formatInr = (paise, options) => `₹${formatAmount(paise, options)}`;
/** Rupees typed by a person ("1,18,000.50", "118000") to paise; null when it is not a figure. */
export function toPaise(text) {
  const t = String(text ?? '').replace(/[₹,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ''] = t.replace('-', '').split('.');
  const p = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return t.startsWith('-') ? -p : p;
}

/** India's financial year (April–March) of a date: { label: "2026-27", short: "26-27", start, end }. */
export function financialYear(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day ?? ''));
  if (!m) throw new RangeError('A date is YYYY-MM-DD');
  const y = Number(m[1]), start = Number(m[2]) >= 4 ? y : y - 1;
  const next = String((start + 1) % 100).padStart(2, '0');
  return { label: `${start}-${next}`, short: `${String(start % 100).padStart(2, '0')}-${next}`, start: `${start}-04-01`, end: `${start + 1}-03-31` };
}

/** A document number from a series pattern: {FY} = 26-27, {FYYYY} = 2026-27, {N:3} = 007. */
export function formatDocNumber(pattern, fy, n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('A document number counts from 1');
  return String(pattern).replace(/\{FYYYY\}/g, fy.label).replace(/\{FY\}/g, fy.short)
    .replace(/\{N(?::(\d))?\}/g, (_, pad) => String(n).padStart(Number(pad ?? 1), '0'));
}
/** GST rule 46: at most 16 characters, letters, digits, "-" and "/", unique per financial year. */
export function numberProblem(pattern, fy) {
  if (!/\{N(?::\d)?\}/.test(pattern)) return 'Put {N} (the running number) in the pattern';
  const sample = formatDocNumber(pattern, fy, 9999);
  if (sample.length > 16) return `Numbers may have 16 characters at most; this pattern makes ${sample.length}`;
  if (!/^[A-Za-z0-9/-]+$/.test(sample)) return 'Use only letters, digits, "-" and "/"';
  return null;
}

/** Days added to a YYYY-MM-DD date, in UTC so no time zone moves it. */
export function addDays(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "11 Oct 2026" (hand-written month names: en-IN prints "Sept"). */
export function formatDate(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day ?? ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}
