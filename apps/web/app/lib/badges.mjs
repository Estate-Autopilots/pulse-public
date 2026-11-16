// HR-PEOPLE (owner, 13 Nov 2026: "the red dots aren't on the screen where it should be. When I hover on the red dot …
// it says nothing … When I click on the red dot … there is no way to truly find" what it means). T1.1.3: every badge that
// counts things waiting for someone says on hover what is waiting, opens the page that lists exactly those things, and
// lights them on arrival. Plain data, no React: lib/badges.test.mjs checks every entry (its words, that its page exists
// and that the page marks the list with data-badge-target), and badge-arrival.tsx does the lighting.
//
// A badge element carries data-badge="<id>"; the list it counts carries data-badge-target="<id>". Release "what's new"
// dots are the other kind of red dot: new-dots-host.tsx says what changed and leads to it (shellDetail's notes, the trail).

/** `source`: the files that draw the badge (data-badge="<id>"); `target`: the files of the page it opens that mark the
 *  list it counts (data-badge-target="<id>"), both relative to apps/web/app.
 *  @typedef {{ where: string; href: string; source: string[]; target: string[]; say: (n: number) => string }} Badge */

const n1 = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** @type {Readonly<Record<string, Badge>>} */
export const BADGES = Object.freeze({
  "hr.attendance": {
    where: "HR desk › Time (tab count)", href: "/hr?tab=attendance&view=totals", source: ["hr/page.tsx"], target: ["hr/desk/attendance.tsx"],
    say: (n) => `${n1(n, "attendance correction waits", "attendance corrections wait")} for you to approve or reject`,
  },
  "hr.leave": {
    where: "HR desk › Time (tab count)", href: "/hr?tab=leave", source: ["hr/page.tsx"], target: ["hr/desk/leave.tsx"],
    say: (n) => `${n1(n, "leave request waits", "leave requests wait")} for you to approve or reject`,
  },
  "hr.approvals": {
    where: "HR desk › Approvals (tab count)", href: "/hr?tab=approvals", source: ["hr/page.tsx"], target: ["hr/flow-actions.tsx"],
    say: (n) => `${n1(n, "request waits", "requests wait")} for your decision`,
  },
  "hr.requests": {
    where: "HR desk › Approvals › Requests (count)", href: "/hr?tab=requests", source: ["hr/page.tsx"], target: ["hr/desk/requests.tsx"],
    say: (n) => `${n1(n, "HR request is", "HR requests are")} open: someone asked HR for help`,
  },
  "hr.waiting": {
    where: "HR desk › Overview › Waiting for you (count)", href: "/hr", source: ["hr/desk/dashboard.tsx"], target: ["hr/desk/dashboard.tsx"],
    say: (n) => `${n1(n, "thing waits", "things wait")} for your decision today`,
  },
  "tasks.reviews": {
    where: "Top bar › Reviews", href: "/tasks?view=reviews", source: ["tasks/review-chip.tsx"], target: ["tasks/page.tsx"],
    say: (n) => `${n1(n, "finished task waits", "finished tasks wait")} for your review`,
  },
});

/** The words a badge says on hover, for a count. Empty for no count (a badge with 0 shows nothing). */
export function badgeTip(id, n) {
  const b = BADGES[id];
  const k = Math.floor(Number(n) || 0);
  return b && k > 0 ? `${b.say(k)}. Click to see ${k === 1 ? "it" : "them"}.` : "";
}

/** Where a badge's click goes ("" for an unknown id). */
export const badgeHref = (id) => BADGES[id]?.href ?? "";

/** sessionStorage key: the badge just clicked, so the page it opens can light what it counted. */
export const BADGE_TRAVEL = "pulse.badge.travel";
/** A click older than this does not light anything (the person went somewhere else first). */
export const BADGE_TRAVEL_MS = 20_000;

/** The badge travel kept in this tab, if it is fresh and known. @param {unknown} raw @param {number} [now] */
export function badgeTravel(raw, now = Date.now()) {
  const t = raw && typeof raw === "object" ? /** @type {{ id?: unknown; at?: unknown }} */ (raw) : null;
  if (!t || typeof t.id !== "string" || !BADGES[t.id] || typeof t.at !== "number") return null;
  return now - t.at >= 0 && now - t.at < BADGE_TRAVEL_MS ? { id: t.id, at: t.at } : null;
}
