// UX-GAMIFY (owner, 9 Nov 2026): the game-feel kit's arithmetic, in one place (game.test.mjs). Levels from XP, streaks
// from the days something was done, a trend between two numbers, the parts of a day done, and money in lakh/crore
// (the same rupees() Goals uses). Pure: no clock, no browser; the caller passes "today" in the company's own zone.
export { rupees } from "./goals.mjs";

/** XP needed to go from level n to n+1: 100, 150, 200, ... (each level a little longer). @param {number} level */
export const levelSpan = (level) => 50 + 50 * Math.max(1, Math.floor(level));

/** The level for a total of XP, with how far into the level it is. @param {number} xp */
export function levelOf(xp) {
  let left = Math.max(0, Math.floor(Number(xp) || 0)), level = 1;
  while (left >= levelSpan(level) && level < 99) { left -= levelSpan(level); level += 1; }
  const span = levelSpan(level);
  return { level, into: left, span, toNext: span - left, pct: left / span };
}

const DAY = 86_400_000;
const dayNo = (iso) => Math.floor(Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) / DAY);

/**
 * Days in a row up to today (or up to yesterday, when today is not done yet: a streak is not lost before the day ends).
 * @param {readonly string[]} days  ISO dates (YYYY-MM-DD) on which it was done, any order, repeats allowed
 * @param {string} today  ISO date in the company's own zone
 * @param {{ weekends?: boolean }} [opts]  weekends: false skips Saturday and Sunday (they neither count nor break it)
 */
export function streakOf(days, today, opts = {}) {
  const set = new Set(days.map(dayNo).filter(Number.isFinite));
  const skip = (n) => opts.weekends === false && [0, 6].includes(new Date(n * DAY).getUTCDay());
  let n = dayNo(today); if (!Number.isFinite(n)) return { days: 0, today: false };
  const doneToday = set.has(n);
  if (!doneToday) { n -= 1; while (skip(n)) n -= 1; }
  let count = 0;
  for (let guard = 0; guard < 3660; guard += 1) {
    if (skip(n)) { n -= 1; continue; }
    if (!set.has(n)) break;
    count += 1; n -= 1;
  }
  return { days: count, today: doneToday };
}

/** Change from `before` to `now` as a rounded %, and whether that is good. @param {number} now @param {number} before @param {"up"|"down"} [better] */
export function trendOf(now, before, better = "up") {
  const a = Number(now) || 0, b = Number(before) || 0;
  if (!b) return { pct: null, dir: a ? "up" : "flat", good: a ? better === "up" : null };
  const pct = Math.round(((a - b) / Math.abs(b)) * 100);
  const dir = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  return { pct, dir, good: dir === "flat" ? null : (dir === better) };
}

/** "+12%" / "−8%" / "Same" for a trend. @param {{ pct: number | null, dir: string }} t */
export const trendText = (t) => t.pct === null ? (t.dir === "up" ? "New" : "Same") : t.pct === 0 ? "Same" : `${t.pct > 0 ? "+" : "−"}${Math.abs(t.pct)}%`;

/** Share of a day done, 0..1, and the words for it. @param {number} done @param {number} total */
export function dayDone(done, total) {
  const d = Math.max(0, Math.floor(Number(done) || 0)), t = Math.max(0, Math.floor(Number(total) || 0));
  if (!t) return { pct: 0, words: "Nothing planned yet", all: false };
  const pct = Math.min(1, d / t);
  return { pct, words: d >= t ? "All done today" : `${d} of ${t} done`, all: d >= t };
}
