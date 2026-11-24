// CHAT-GROUPS (owner report EA #4, 28 Oct 2026; built 22 Nov 2026): team chat groups by category. The server decides
// each group's category (db 2530: what it is filed under, else what Pulse knows of it); this file draws the Groups tab
// from that: one section per category in the company's order, "Other groups" last, a group's icon and colour, and the
// company's "who may make groups" in plain words. Also the company switch guard (USER-INSIGHT L2, 21 Nov: Chats
// crashed right after switching company: the old page kept syncing after its tab had moved, and drew the other
// company's answers). Pure: tested in chat-groups.test.mjs.

/** The five built-in categories, as the server lists them (chat_builtin_categories). */
export const BUILTIN = [
  { id: "announcements", name: "Announcements", icon: "megaphone", colour: "violet", builtin: true },
  { id: "projects", name: "Projects", icon: "folder-kanban", colour: "blue", builtin: true },
  { id: "teams", name: "Teams", icon: "users", colour: "green", builtin: true },
  { id: "clients", name: "Clients", icon: "briefcase", colour: "amber", builtin: true },
  { id: "bugs", name: "Bugs and support", icon: "bug", colour: "red", builtin: true },
];
/** The icons and colours a group or category may take (chat_group_icons, chat_group_colours). */
export const ICONS = ["hash", "users", "folder-kanban", "briefcase", "bug", "megaphone", "building-2", "palette", "camera", "film", "pen-tool", "truck", "wallet", "life-buoy", "sparkles", "calendar"];
export const COLOURS = ["slate", "blue", "green", "amber", "red", "violet", "teal", "pink"];
export const OTHER = { id: "other", name: "Other groups", icon: "hash", colour: "slate", builtin: true };

const muted = (until, now) => !!until && Date.parse(until) > now;
const raises = (c, now) => !c.archivedAt && !muted(c.mutedUntil, now) && (c.unread > 0 || !!c.markedUnread);
const known = (categories, key) => !!key && (categories ?? []).some((x) => x.id === key);

/** The Groups tab's sections: each category with groups (the company's order), then "Other groups"; a section keeps the
 *  order its groups came in (pinned first, latest next) and counts the groups that raise a badge. Direct chats are left out. */
export function groupSections(channels, categories, now = Date.now()) {
  const cats = categories?.length ? categories : BUILTIN;
  const by = new Map();
  for (const c of channels ?? []) {
    if (c.kind === "direct") continue;
    const key = known(cats, c.category) ? c.category : OTHER.id;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(c);
  }
  return [...cats, OTHER].filter((cat) => by.has(cat.id))
    .map((cat) => { const list = by.get(cat.id); return { ...cat, channels: list, unread: list.filter((c) => raises(c, now)).length }; });
}

/** One category's groups ("all": every group; "other": the ones in no category). */
export function inCategory(channels, key, categories = BUILTIN) {
  const groups = (channels ?? []).filter((c) => c.kind !== "direct");
  if (key === "all") return groups;
  if (key === OTHER.id) return groups.filter((c) => !known(categories, c.category));
  return groups.filter((c) => c.category === key);
}

/** A group's icon and colour: its own, else its category's, else a calm default. */
export function groupLook(channel, categories) {
  const cat = (categories ?? BUILTIN).find((x) => x.id === channel?.category) ?? null;
  const icon = ICONS.includes(channel?.icon) ? channel.icon : cat?.icon ?? OTHER.icon;
  const colour = COLOURS.includes(channel?.colour) ? channel.colour : cat?.colour ?? OTHER.colour;
  return { icon, colour };
}

/** Is a section open? Folded ones stay folded, except while searching (a match is never hidden). */
export const sectionOpen = (key, folded, searching) => searching || !folded?.has(key);

/** The company's "who may make groups", for the person reading it. */
export function creatorsLine(creators, canCreate) {
  if (creators === "everyone") return "Everyone here can make groups.";
  if (canCreate) return creators === "managers" ? "Managers and leadership make groups here, and you can." : "Only leadership can make groups here, and you can.";
  return creators === "managers" ? "Managers and leadership make groups here. Ask for one and a manager approves it."
    : "Leadership makes groups here. Ask for one and leadership approves it.";
}

/** L2: a list read for another company (the tab moved while this page still shows the old one) is not this page's. */
export const listFits = (pageViewer, data) => !pageViewer || !data || !data.viewer || data.viewer === pageViewer;

/** VITALS-SWEEP (Kazuk's crashes, 21 and 23 Nov): only a whole list may replace the one on screen or come back from the
 *  saved copy. A body that broke off mid-download reached the page as {} (no conversations, no people) and the page broke. */
export const listWhole = (data) => !!data && Array.isArray(data.channels) && Array.isArray(data.people);

/** L2: whether this tab is on its way to another company (the shell says so with "pulse:org-moving"; detail null: the
 *  move did not happen). While it moves, Chats stops syncing: every call already goes to the other company. */
export function watchMoving(target = typeof window === "undefined" ? null : window) {
  let moving = false;
  const on = (e) => { moving = !!e?.detail; };
  target?.addEventListener?.("pulse:org-moving", on);
  return { now: () => moving, stop: () => target?.removeEventListener?.("pulse:org-moving", on) };
}
