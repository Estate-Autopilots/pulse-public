// PR-STUDIO-2: pure helpers for PR Studio's flow (Strategy -> Calendar -> Board -> Library -> Post kit -> Insights).
// Days are plain YYYY-MM-DD strings in the brand's own time zone (the API sends each slot's day and time already in it),
// so nothing here depends on the browser's clock or locale.

export const STAGES = ["idea", "draft", "design", "review", "approved", "scheduled", "posted", "measured"];
export const STAGE_WORDS = { idea: "Idea", draft: "Draft", design: "Design", review: "Review", approved: "Approved", scheduled: "Scheduled", posted: "Posted", measured: "Measured" };
export const CHANNELS = ["linkedin", "x", "instagram", "whatsapp_status", "newsletter"];
export const CHANNEL_WORDS = { linkedin: "LinkedIn", x: "X", instagram: "Instagram", whatsapp_status: "WhatsApp Status", newsletter: "Newsletter" };
export const VIEWS = ["strategy", "calendar", "board", "library", "kit", "insights"];
export const VIEW_WORDS = { strategy: "Strategy", calendar: "Calendar", board: "Board", library: "Library", kit: "Post kit", insights: "Insights" };
export const DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const PILLAR_HUES = ["#7c3aed", "#4f46e5", "#0ea5e9", "#10b981", "#f59e0b"];
export const METRIC_WORDS = { posts_per_week: "Posts a week", impressions: "Impressions (28 days)", avg_impressions: "Impressions a post", reactions: "Reactions (28 days)",
  comments: "Comments (28 days)", shares: "Shares (28 days)", saves: "Saves (28 days)", clicks: "Clicks (28 days)", followers: "Followers" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (s) => typeof s === "string" && DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const toDate = (day) => new Date(`${day}T00:00:00Z`);
const toDay = (d) => d.toISOString().slice(0, 10);

/** The day n days after (or before) a day. */
export function addDays(day, n) { const d = toDate(day); d.setUTCDate(d.getUTCDate() + n); return toDay(d); }
/** 1 = Monday … 7 = Sunday. */
export function dow(day) { const w = toDate(day).getUTCDay(); return w === 0 ? 7 : w; }
/** The Monday of a day's week. */
export function weekStart(day) { return addDays(day, 1 - dow(day)); }
/** The seven days of a day's week, Monday first. */
export function weekDays(day) { const s = weekStart(day); return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(s, i)); }
/** A month's calendar page: whole weeks, Monday first, from the week of the 1st to the week of the last day. */
export function monthGrid(day) {
  const first = `${day.slice(0, 7)}-01`;
  const d = toDate(first); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0);
  const last = toDay(d);
  const out = [];
  for (let x = weekStart(first); x <= addDays(weekStart(last), 6); x = addDays(x, 1)) out.push(x);
  return out;
}
export function addMonths(day, n) {
  const [y, m] = day.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`;
}
export const monthTitle = (day) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
/** "Tue 10 Nov" */
export const dayTitle = (day) => `${DOW_SHORT[dow(day) - 1]} ${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1].slice(0, 3)}`;
/** "10–16 Nov 2026" or "30 Nov – 6 Dec 2026" */
export function weekTitle(day) {
  const s = weekStart(day), e = addDays(s, 6);
  const m = (x) => MONTHS[Number(x.slice(5, 7)) - 1].slice(0, 3);
  return s.slice(5, 7) === e.slice(5, 7) ? `${Number(s.slice(8))}–${Number(e.slice(8))} ${m(e)} ${e.slice(0, 4)}` : `${Number(s.slice(8))} ${m(s)} – ${Number(e.slice(8))} ${m(e)} ${e.slice(0, 4)}`;
}
/** The window a calendar view shows. */
export function range(view, day) {
  if (view === "day") return { from: day, to: day };
  if (view === "week") { const s = weekStart(day); return { from: s, to: addDays(s, 6) }; }
  const g = monthGrid(day); return { from: g[0], to: g[g.length - 1] };
}
/** Where the arrows go. */
export function step(view, day, dir) {
  if (view === "day") return addDays(day, dir);
  if (view === "week") return addDays(day, 7 * dir);
  return addMonths(day, dir);
}
export const hourOf = (time) => (typeof time === "string" && /^\d{2}:\d{2}$/.test(time) ? Number(time.slice(0, 2)) : null);

/** The next stage on the board (null after Measured). */
export function nextStage(stage) { const i = STAGES.indexOf(stage); return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null; }
/** The one thing to do next on a post, in plain words. */
export function nextAction(post, okNeeded) {
  if (post.stage === "measured") return { to: "measured", label: "Update the numbers" };
  if (post.stage === "posted") return { to: "measured", label: "Log the numbers" };
  if (okNeeded) return { to: null, label: "Get their OK first" };
  if (post.stage === "approved" || post.stage === "scheduled") return { to: "posted", label: "Mark posted" };
  if (post.stage === "review") return { to: "approved", label: "Approve" };
  if (post.stage === "design") return { to: "review", label: "Send to review" };
  if (post.stage === "draft") return { to: "design", label: "Ready for design" };
  return { to: "draft", label: "Start the draft" };
}
/** The strategy's open slots on a day: what the rhythm says to post where, at what time. */
export function rhythm(channels, day) {
  const d = dow(day);
  const out = [];
  for (const ch of Array.isArray(channels) ? channels : []) {
    if (!Array.isArray(ch.days) || !ch.days.includes(d)) continue;
    for (const t of Array.isArray(ch.times) && ch.times.length ? ch.times.slice(0, 1) : ["09:00"]) out.push({ channel: ch.key, time: t });
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}
/** The best time for a channel (its first time in the strategy). */
export function bestTime(channels, channel) {
  const ch = (Array.isArray(channels) ? channels : []).find((c) => c.key === channel);
  return ch && Array.isArray(ch.times) && ch.times.length ? ch.times[0] : null;
}
/** The caption to copy: the caption, with the hashtags added once (a caption that already ends with them keeps them). */
export function captionToCopy(caption, hashtags) {
  const text = (caption ?? "").trim();
  const tags = (Array.isArray(hashtags) ? hashtags : []).filter((t) => !text.toLowerCase().includes(t.toLowerCase()));
  return tags.length ? `${text}\n\n${tags.join(" ")}`.trim() : text;
}
/** Hashtags written inside a caption (for a creative whose caption carries them). */
export function tagsIn(caption) { return [...new Set((caption ?? "").match(/#[A-Za-z][A-Za-z0-9_]{1,40}/g) ?? [])].slice(0, 30); }
/** Whole numbers with thousands separators, without the browser's locale. */
export function num(n) { const v = Math.round(Number(n) || 0); return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

// Strategy as editable lines ("Name — about — 30") and back.
const SEP = /\s+[—|]\s+/;
export function linesOf(rows, fields) { return (Array.isArray(rows) ? rows : []).map((r) => fields.map((f) => (Array.isArray(r[f]) ? r[f].join(", ") : r[f] ?? "")).join(" — ").replace(/( — )+$/, "")).join("\n"); }
export function rowsOf(text, fields) {
  return String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const parts = l.split(SEP);
    const r = {};
    fields.forEach((f, i) => { r[f] = i === fields.length - 1 ? parts.slice(i).join(" — ") : parts[i] ?? ""; });
    return r;
  });
}
