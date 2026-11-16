// DOCS-POLISH (owner, 14 Nov 2026): the reading view's rules with no screen, shared by the doc page and its PDF:
// a time written the same on the server and in the browser (no hydration mismatch), read time, which table cells are
// numbers (right-aligned) and which row is a total, initials for the owner's avatar. Tests: doc-read.test.mjs.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const parts = new Map();
/** "14 Nov, 1:32 pm" in the company's time zone (and the year when it is not this year's). Built from numeric parts, so a
 *  server render and the browser write exactly the same words whatever their own locale and zone (DOCS-RICH saw
 *  `toLocaleString` with the browser's zone differ from the server's: React's hydration mismatch on "last changed"). */
export function whenText(iso, zone, now = Date.now()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  let f = parts.get(zone);
  if (!f) {
    try { f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }); }
    catch { f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }); }
    parts.set(zone, f);
  }
  const p = (at) => Object.fromEntries(f.formatToParts(at).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  const t = p(d), n = p(new Date(now));
  const h = t.hour % 24, hour = h % 12 || 12;
  return `${t.day} ${MONTHS[t.month - 1]}${t.year !== n.year ? ` ${t.year}` : ""}, ${hour}:${String(t.minute).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** Minutes to read words at an easy pace (about 220 a minute), at least 1. */
export function readMinutes(text) {
  const words = (String(text ?? "").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  return Math.max(1, Math.round(words / 220));
}

/** A table cell that is a number as people write it (₹1,24,500 · 12% · -3.5 · 4.2 L · 1.1 Cr · 40,000/-): right-aligned. */
export function isNumberCell(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > 0 && t.length <= 32 && /^(₹|rs\.?|inr|\$|€|£)?\s?[-+−]?\s?(\d{1,3}(,\d{2,3})+|\d+)(\.\d+)?\s?(%|l|lakhs?|lacs?|cr|crores?|k|m|mn|bn|x)?\.?\s?(\/-)?$/i.test(t);
}
/** A table row that sums the others ("Total", "Grand total", "Subtotal"): drawn bold with a line above. */
export const isTotalRow = (label) => /^(grand\s+|sub-?)?totals?\b|^sum\b/i.test(String(label ?? "").trim());

/** Two letters for a person's avatar: "Kedab Mifos" → "KM". */
export function initials(name) {
  const w = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  return w.length ? (w.length === 1 ? w[0].slice(0, 2) : `${w[0][0]}${w[w.length - 1][0]}`).toUpperCase() : "";
}
