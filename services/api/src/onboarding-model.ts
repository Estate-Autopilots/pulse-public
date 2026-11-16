// PRESENCE-ONBOARD: checks and masks for what people enter about themselves. Pure functions, unit-tested.
//
// Government IDs (Aadhaar Act 2016 and UIDAI regulations; DPDP Act 2023 and Rules 2025): a full Aadhaar number never
// leaves this module. It is checked here (12 digits, not starting 0 or 1, Verhoeff check digit) and only the masked
// form "XXXX XXXX 1234" is passed to the database. PAN likewise: "XXXXXX234F". Bank account numbers are encrypted in
// the database and shown as "Bank ••••1234".

const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],
  [5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],
  [4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
/** The Verhoeff check UIDAI uses for the last digit of an Aadhaar number. */
export function verhoeff(digits: string): boolean {
  let c = 0;
  [...digits].reverse().forEach((ch, i) => { c = D[c][P[i % 8][Number(ch)]]; });
  return c === 0;
}
export type Masked = { ok: true; masked: string } | { ok: false; error: string };
/** "2345 6789 0124" → "XXXX XXXX 0124", or why it is not an Aadhaar number. Spaces and dashes are allowed. */
export function maskAadhaar(raw: unknown): Masked {
  const s = String(raw ?? "").replace(/[\s-]/g, "");
  if (/^X{8}\d{4}$/i.test(s)) return { ok: true, masked: `XXXX XXXX ${s.slice(-4)}` };   // already masked (from the masked PDF)
  if (!/^\d{12}$/.test(s)) return { ok: false, error: "An Aadhaar number has 12 digits" };
  if (/^[01]/.test(s) || !verhoeff(s)) return { ok: false, error: "That Aadhaar number does not look right. Check the digits" };
  return { ok: true, masked: `XXXX XXXX ${s.slice(-4)}` };
}
/** "ABCDE1234F" → "XXXXXX234F". */
export function maskPan(raw: unknown): Masked {
  const s = String(raw ?? "").replace(/\s/g, "").toUpperCase();
  if (/^X{6}\d{3}[A-Z]$/.test(s)) return { ok: true, masked: s };
  if (!/^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/.test(s)) return { ok: false, error: "A PAN looks like ABCDE1234F" };
  return { ok: true, masked: `XXXXXX${s.slice(-4)}` };
}

export type Bank = { holder: string; bank: string; ifsc: string; account: string; branch?: string; upi?: string };
/** What may be shown and stored in the clear: never the account number (four digits) or the whole UPI ID. */
export type BankSummary = { holder: string; bank: string; branch: string | null; ifsc: string; last4: string; upi: string | null };
const UPI = /^[a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9]{1,63}$/;
/** "ruvin.k@okhdfcbank" → "ra•••.k@okhdfcbank"-style: the handle stays, the name is mostly hidden (and never five
 *  digits in a row, so a phone-number UPI ID does not leak the number). */
export function maskUpi(upi: string): string {
  const [name, handle] = upi.split("@");
  const shown = name.length > 6 ? `${name.slice(0, 2)}•••${name.slice(-2)}` : `${name.slice(0, 1)}•••`;
  return `${shown}@${handle}`;
}
/** Bank details for payroll: the account goes to the database encrypted; the screen shows the masked line only.
 *  PEOPLE-CONTACTS adds the branch (from the IFSC) and an optional UPI ID, and the summary that may be shown. */
export function checkBank(raw: Record<string, unknown>): { ok: true; account: Bank; masked: string; summary: BankSummary } | { ok: false; error: string } {
  const holder = String(raw.holder ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const bank = String(raw.bank ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const branch = String(raw.branch ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const ifsc = String(raw.ifsc ?? "").replace(/\s/g, "").toUpperCase();
  const account = String(raw.account ?? "").replace(/[\s-]/g, "");
  const confirm = raw.confirm === undefined ? account : String(raw.confirm ?? "").replace(/[\s-]/g, "");
  const upi = String(raw.upi ?? "").replace(/\s/g, "").toLowerCase();
  if (holder.length < 2) return { ok: false, error: "Write the account holder's name as the bank has it" };
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return { ok: false, error: "An IFSC looks like HDFC0001234 (11 characters, the fifth is a zero)" };
  if (!/^\d{9,18}$/.test(account)) return { ok: false, error: "An account number has 9 to 18 digits" };
  if (confirm !== account) return { ok: false, error: "The two account numbers are different" };
  if (/^0+$/.test(account)) return { ok: false, error: "Check the account number" };
  if (upi && !UPI.test(upi)) return { ok: false, error: "A UPI ID looks like name@bank" };
  const name = bank || ifsc.slice(0, 4);
  return { ok: true, account: { holder, bank: name, ifsc, account, ...(branch ? { branch } : {}), ...(upi ? { upi } : {}) }, masked: `${name} ••••${account.slice(-4)}`,
    summary: { holder, bank: name, branch: branch || null, ifsc, last4: account.slice(-4), upi: upi ? maskUpi(upi) : null } };
}

const PHONE = /^\+?[0-9][0-9 -]{7,15}$/;
/** ONBOARD-GATE: an Indian mobile as "+91 90000 12345" (10 digits starting 6-9, with or without +91 / 0), or another
 *  country's number kept as typed when it starts with + and its code. Null when it is not a phone number. */
export function indianPhone(raw: string): string | null {
  const s = raw.replace(/[\s()-]/g, "");
  const m = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(s);
  if (m) return `+91 ${m[1].slice(0, 5)} ${m[1].slice(5)}`;
  if (/^\+(?!91)[1-9]\d{7,14}$/.test(s) && PHONE.test(raw)) return raw.replace(/\s+/g, " ").trim();
  return null;
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Personal details as typed: trimmed, bounded and checked. Only the fields sent are returned. */
export function cleanDetails(raw: Record<string, unknown>, today: string): { ok: true; data: Record<string, string> } | { ok: false; error: string } {
  const out: Record<string, string> = {};
  const take = (key: string, max: number) => { if (key in raw) out[key] = String(raw[key] ?? "").replace(/\s+/g, " ").trim().slice(0, max); };
  for (const [k, m] of [["legalName", 120], ["preferredName", 60], ["address", 300], ["city", 60], ["pincode", 10], ["bloodGroup", 4], ["emergencyName", 80], ["emergencyRelation", 40], ["emergencyPhone", 24], ["fatherName", 80], ["personalEmail", 120], ["personalPhone", 24], ["dob", 10]] as const) take(k, m);
  if (out.dob) {
    const year = Number(today.slice(0, 4));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.dob) || Number.isNaN(Date.parse(out.dob)) || Number(out.dob.slice(0, 4)) < year - 80 || out.dob > `${year - 15}${today.slice(4)}`) return { ok: false, error: "Check the date of birth" };
  }
  if (out.pincode && !/^\d{6}$/.test(out.pincode)) return { ok: false, error: "A PIN code has 6 digits" };
  if (out.bloodGroup && !/^(A|B|AB|O)[+-]$/.test(out.bloodGroup.toUpperCase())) return { ok: false, error: "Blood group like O+ or AB-" };
  if (out.bloodGroup) out.bloodGroup = out.bloodGroup.toUpperCase();
  for (const k of ["personalPhone", "emergencyPhone"]) if (out[k]) {
    const phone = indianPhone(out[k]);
    if (!phone) return { ok: false, error: k === "personalPhone" ? "Enter your WhatsApp number like +91 90000 12345" : "Enter the emergency contact's phone like +91 90000 12345" };
    out[k] = phone;
  }
  for (const k of ["legalName", "preferredName"]) if (out[k] && !/^[\p{L}][\p{L}\p{M} .'-]*$/u.test(out[k])) return { ok: false, error: k === "legalName" ? "Write your full legal name in letters" : "Write the name you go by in letters" };
  if (out.personalEmail && !EMAIL.test(out.personalEmail)) return { ok: false, error: "Check the email address" };
  return { ok: true, data: out };
}

/** What "fix it before" means for a month: the cut-off date HR set, and whether that month is already closed. */
export function payrollWindow(month: string, today: string, cutoffDay: number | null) {
  if (!cutoffDay) return { cutoffDate: null, closed: month < today.slice(0, 7), daysLeft: null };
  const cutoffDate = `${month}-${String(cutoffDay).padStart(2, "0")}`;
  const daysLeft = Math.round((Date.parse(`${cutoffDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  return { cutoffDate, closed: daysLeft < 0, daysLeft: Math.max(0, daysLeft) };
}

/** "Missing" keys from the database, in the words the person and HR see. */
export const MISSING_LABEL: Record<string, string> = {
  dob: "Date of birth", phone: "Phone", email: "Personal email", address: "Address", emergency: "Emergency contact",
  bank: "Bank details", photo: "Photo", legalName: "Legal name", preferredName: "Preferred name", city: "City",
  work: "Role and team confirmed", skills: "Skills and tools",
};
export const missingLabel = (key: string, kinds: { kind: string; label: string }[] = []) =>
  key.startsWith("doc:") ? kinds.find((k) => k.kind === key.slice(4))?.label ?? key.slice(4) : MISSING_LABEL[key] ?? key;
