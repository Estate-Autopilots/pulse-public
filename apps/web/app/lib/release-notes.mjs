// RELEASE-COMMS (owner, 7 Nov 2026): the release notes on /whats-new and the "was updated" note after an update
// (services/api/src/whats-new.ts). Plain data and words: no React, no server-only imports.
import { lower, NEUTRAL_VOCABULARY } from "./words.mjs";

/** The audiences of a note, in the order the page shows them (the API's order). */
export const AUDIENCE_ORDER = ["owner", "managers", "salespeople", "hr", "clients", "everyone"];
/** The newest release this person has seen, per person on this browser (the update note shows once per release). */
export const SEEN_KEY = "pulse.whats-new.seen";
export const RELEASE_ZONE = "Asia/Kolkata";

/** The heading over one audience's part: the person's main audience is "For you"; the others say who they are for in
 *  the company's own words. @param {string} audience @param {string} main @param {Record<string, string> | null | undefined} [words] */
export function audienceHeading(audience, main, words) {
  if (audience === main && audience !== "everyone") return "For you";
  const w = { ...NEUTRAL_VOCABULARY, ...(words ?? {}) };
  return ({ owner: "For owners and admins", managers: `For managers and ${lower(w.team)} leads`, salespeople: "For sales",
    hr: "For HR", clients: `For ${lower(w.clients)}`, everyone: "For everyone" })[audience] ?? "For everyone";
}

/** An address inside the app ("/billing"), else null: a note never links out of it or runs anything.
 *  @param {unknown} href */
export function safeHref(href) {
  return typeof href === "string" && /^\/(?![/\\])[^\s<>"]{0,300}$/.test(href) ? href : null;
}

/** One line of a note, from {text, href} or a plain string. @param {unknown} item */
export function noteLine(item) {
  if (typeof item === "string") return item.trim() ? { text: item.trim(), href: null } : null;
  if (!item || typeof item !== "object") return null;
  const text = typeof item.text === "string" ? item.text.trim() : "";
  return text ? { text, href: safeHref(item.href) } : null;
}

/** A note's parts for this person, grouped by audience in page order, with their headings.
 *  @param {Record<string, unknown>} items @param {string} main @param {Record<string, string> | null | undefined} [words] */
export function noteGroups(items, main, words) {
  const order = [main, ...AUDIENCE_ORDER.filter((a) => a !== main)];
  return order.map((audience) => ({ audience, heading: audienceHeading(audience, main, words),
    lines: (Array.isArray(items?.[audience]) ? items[audience] : []).map(noteLine).filter(Boolean) })).filter((g) => g.lines.length);
}

/** When a release went out, in India time, e.g. "7 Nov 2026, 4:05 pm IST". @param {string} iso */
export function releasedAtText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.toLocaleString("en-IN", { timeZone: RELEASE_ZONE, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true })} IST`;
}

/** The share card a person sees on a release: their main audience's, else the next of theirs that has one.
 *  @param {Record<string, { text: string; imageUrl: string | null }>} share @param {string[]} audiences */
export function shareFor(share, audiences) {
  for (const a of audiences) { const s = share?.[a]; if (s && (s.text || s.imageUrl)) return { audience: a, text: s.text ?? "", imageUrl: s.imageUrl ?? null }; }
  return null;
}

/** "Send on WhatsApp": WhatsApp opens with the text ready; the person picks the chat. @param {string} text */
export const whatsAppLink = (text) => `https://wa.me/?text=${encodeURIComponent(text)}`;

/** Whether to show the "was updated" note, and what to remember. The first visit only remembers the newest release
 *  (a new person is not told about an update they never lived through); a newer release than the one remembered
 *  shows the note until it is closed or opened.
 *  @param {string | null | undefined} stored @param {number | null | undefined} newest */
export function updateNote(stored, newest) {
  if (typeof newest !== "number" || !Number.isFinite(newest)) return { show: false, remember: null };
  const seen = stored ? Number(stored) : NaN;
  if (!Number.isFinite(seen)) return { show: false, remember: String(newest) };
  return { show: newest > seen, remember: null };
}
