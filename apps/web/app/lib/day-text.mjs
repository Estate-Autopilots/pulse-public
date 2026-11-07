// UI-POLISH (R017): a day as people in India write and read it. Pulse shows a date as "24 Oct 2026" (dd MMM yyyy) on
// every form, whatever the browser's language (an en-US phone showed native date fields as 10/24/2026). Typing accepts
// what people type: "24 Oct", "24 october 2026", "24/10/2026" (day first), "24-10-26", "2026-10-24". Pure, so tested
// (day-text.test.mjs) and shared by the kit's DateField.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const pad = (n) => String(n).padStart(2, "0");
/** A real calendar day as YYYY-MM-DD, or null (31 Feb is not one). */
function day(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d > last ? null : `${y}-${pad(m)}-${pad(d)}`;
}
const year = (s, today) => (s === undefined || s === "" ? Number(String(today ?? "").slice(0, 4)) || new Date().getUTCFullYear() : s.length === 2 ? 2000 + Number(s) : Number(s));
const month = (s) => { const t = s.toLowerCase().replace(/\.$/, ""); if (t.length < 3) return 0; const i = LONG.findIndex((m) => m.startsWith(t)); return i + 1; };

/** "2026-10-24" → "24 Oct 2026"; anything that is not a day → "". */
export function formatDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? "?"} ${m[1]}` : "";
}

/** What someone typed → "YYYY-MM-DD"; "" for an empty field; null when it is not a day. A year left out is `today`'s. */
export function parseDay(text, today) {
  const t = String(text ?? "").trim().replace(/\s+/g, " ").replace(/,/g, "");
  if (!t) return "";
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return day(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(t);
  if (m) return day(year(m[3], today), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})(?:st|nd|rd|th)? ?-?([a-z]{3,9}\.?)-? ?(\d{2}|\d{4})?$/i.exec(t);
  if (m) return day(year(m[3], today), month(m[2]), Number(m[1]));
  m = /^([a-z]{3,9}\.?) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/i.exec(t);
  if (m) return day(year(m[3], today), month(m[1]), Number(m[2]));
  return null;
}
