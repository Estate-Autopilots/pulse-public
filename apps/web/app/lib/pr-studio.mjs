// PR-STUDIO (owner, 6 Nov 2026): PR Studio's screen helpers (services/api/src/pr-studio.ts, migration 1597): the calendar
// grid, the words for kinds, channels and tones, the links that open an app with the text in (nothing is sent: the person
// presses send), image sizes per shape, and line wrapping for the brand images (pr-studio.test.mjs).

/** @typedef {"release" | "feature" | "bug" | "task" | "goal" | "meeting" | "note"} Kind */
/** @typedef {"whatsapp" | "telegram" | "email" | "linkedin" | "x"} Channel */
/** @typedef {"1:1" | "4:5" | "9:16" | "16:9"} Ratio */

/** @type {Record<Kind, string>} */
export const KIND_WORDS = { release: "Release", feature: "Feature", bug: "Bug fixed", task: "Tasks done", goal: "Goal", meeting: "Meeting", note: "Note" };
/** @type {Record<Channel, string>} */
export const CHANNEL_WORDS = { whatsapp: "WhatsApp", telegram: "Telegram", email: "E-mail", linkedin: "LinkedIn", x: "X" };
export const TONE_WORDS = { warm: "Warm", formal: "Formal", bold: "Bold", plain: "Plain" };
/** @type {Record<Ratio, string>} */
export const RATIO_WORDS = { "1:1": "Square 1:1", "4:5": "Portrait 4:5", "9:16": "Story 9:16", "16:9": "Wide 16:9" };

/** Pixel size of a brand image of a shape. @param {Ratio} ratio */
export function ratioSize(ratio) {
  if (ratio === "4:5") return { width: 1080, height: 1350 };
  if (ratio === "9:16") return { width: 1080, height: 1920 };
  if (ratio === "16:9") return { width: 1920, height: 1080 };
  return { width: 1080, height: 1080 };
}

const DAY = 86400000;
const iso = (/** @type {number} */ t) => new Date(t).toISOString().slice(0, 10);
const at = (/** @type {string} */ d) => Date.parse(`${d}T00:00:00Z`);
/** Monday of a day's week. @param {string} d YYYY-MM-DD */
export const mondayOf = (d) => iso(at(d) - ((new Date(at(d)).getUTCDay() + 6) % 7) * DAY);
/** A day moved by n days. @param {string} d @param {number} n */
export const addDays = (d, n) => iso(at(d) + n * DAY);

/** The month's calendar: whole weeks from the Monday on or before the 1st to the Sunday on or after its last day.
 *  @param {string} month YYYY-MM @param {string} today YYYY-MM-DD */
export function monthGrid(month, today) {
  const first = `${month}-01`;
  const next = new Date(at(first));
  next.setUTCMonth(next.getUTCMonth() + 1);
  const last = iso(next.getTime() - DAY);
  /** @type {{ day: string; inMonth: boolean; today: boolean; past: boolean }[][]} */
  const weeks = [];
  let d = mondayOf(first);
  while (d <= last) {
    /** @type {{ day: string; inMonth: boolean; today: boolean; past: boolean }[]} */
    const week = [];
    for (let i = 0; i < 7; i++, d = addDays(d, 1)) week.push({ day: d, inMonth: d.startsWith(month), today: d === today, past: d < today });
    weeks.push(week);
  }
  return weeks;
}

/** The seven days of a day's week. @param {string} d @param {string} today */
export const weekGrid = (d, today) => Array.from({ length: 7 }, (_, i) => { const day = addDays(mondayOf(d), i); return { day, inMonth: true, today: day === today, past: day < today }; });

/** The month before or after. @param {string} month YYYY-MM @param {number} n */
export function shiftMonth(month, n) {
  const t = new Date(at(`${month}-01`));
  t.setUTCMonth(t.getUTCMonth() + n);
  return t.toISOString().slice(0, 7);
}

const MONTH = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const SHORT = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
/** @param {string} month YYYY-MM */
export const monthName = (month) => MONTH.format(new Date(at(`${month}-01`)));
/** @param {string} d YYYY-MM-DD */
export const dayName = (d) => SHORT.format(new Date(at(d)));

/** A link that opens the app with the words in it. Nothing is sent from Pulse: the person chooses the chat and presses send.
 *  @param {Channel} channel @param {string} text @param {string} [subject] */
export function shareHref(channel, text, subject = "") {
  const t = encodeURIComponent(text);
  if (channel === "whatsapp") return `https://wa.me/?text=${t}`;
  if (channel === "telegram") return `https://t.me/share/url?url=${encodeURIComponent(" ")}&text=${t}`;
  if (channel === "email") return `mailto:?subject=${encodeURIComponent(subject)}&body=${t}`;
  if (channel === "x") return `https://x.com/intent/post?text=${encodeURIComponent(text.slice(0, 270))}`;
  return "https://www.linkedin.com/feed/?shareActive=true";
}

/** WhatsApp's *bold* and _italic_ taken out, for e-mail and LinkedIn. @param {string} text */
export const plainText = (text) => text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/gm, "$1$2").replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/gm, "$1$2");

/** Words wrapped to a width, at most maxLines lines (the last one ends with "…" when cut).
 *  @param {(s: string) => number} measure @param {string} text @param {number} width @param {number} maxLines */
export function wrapLines(measure, text, width, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  /** @type {string[]} */
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (measure(next) <= width || !cur) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let lastLine = kept[maxLines - 1];
  while (lastLine.length > 1 && measure(`${lastLine}…`) > width) lastLine = lastLine.slice(0, -1).trimEnd();
  kept[maxLines - 1] = `${lastLine}…`;
  return kept;
}

/** Days told in a row, said kindly. @param {number} n */
export const streakWords = (n) => n === 0 ? "Tell one thing today to start a streak" : n === 1 ? "1 day told" : `${n} days told in a row`;
