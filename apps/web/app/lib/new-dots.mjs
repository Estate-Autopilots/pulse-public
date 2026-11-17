// NEW-DOTS (owner, 8 Nov 2026): the red "new" dots' data on the web side (new-dots-host.tsx, /whats-new, Settings →
// Notifications). The API decides what is unseen and for whom (services/api/src/new-dots.ts); the shell decides where
// the dots go (packages/ui-shell/src/new-dots.ts). Plain data and words: no React, no server-only imports.

/** window event: ask the host to read the list again, or (detail = a state from the API) to use this one. */
export const NEW_DOTS_REFRESH = "pulse:new-dots-refresh";

/** The unseen list for the What's new page: one line per changed page, or per changed thing on a page (NEW-DOTS-2: its
 *  `anchor`), with the newest release's words for it, newest first, and how many releases changed it.
 *  @param {{ note: number; route: string; anchor?: string; text: string; headline: string; releasedAt: string }[]} items */
export function unseenLines(items) {
  const byThing = new Map();
  for (const i of Array.isArray(items) ? items : []) {
    if (!i || typeof i.route !== "string" || typeof i.text !== "string") continue;
    const anchor = typeof i.anchor === "string" ? i.anchor : "";
    const key = `${i.route} ${anchor}`;
    const had = byThing.get(key);
    if (had) had.releases += 1;
    else byThing.set(key, { route: i.route, anchor, text: i.text, headline: i.headline ?? "", releasedAt: i.releasedAt ?? "", releases: 1 });
  }
  return [...byThing.values()];
}

/** The heading over the list: "3 new things for you" (plain words, singular when one). @param {number} n */
export const unseenHeading = (n) => (n === 1 ? "1 new thing for you" : `${n} new things for you`);
