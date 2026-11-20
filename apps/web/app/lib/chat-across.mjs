// CHAT-ALL (owner, 18 Nov 2026): the chat list across every company of the account. "All" puts every company's chats in
// one list, each tagged with its company; a company shows its own chats and the chats another company shares with it
// (CONNECT: they live in the other company, read through the account's guest seat there, and show in both).
// Pure: tested in chat-across.test.mjs.

/** The companies the switch offers: my companies (by name), then personal space; not guest seats. The order never
 *  depends on the company this tab is in, so the chips stay in place after opening another company's chat. */
export function switchSeats(seats) {
  return (seats ?? []).filter((s) => !s.guest).sort((a, b) => (a.personal ? 1 : 0) - (b.personal ? 1 : 0) || String(a.name).localeCompare(String(b.name)) || String(a.org).localeCompare(String(b.org)));
}

/** The colour the sidebar gives a company without a logo (ui-shell orgHue, orgs/labels.ts): the same hue here. */
const nameHue = (name) => { let h = 7; for (const c of String(name ?? "")) h = (h * 31 + (c.codePointAt(0) ?? 0)) % 360; return h; };
/** A company's colour: the sidebar's, moved on only when it is too close to one of my other companies' (in the switch's
 *  order, then guest seats; as the founder view does), so two companies never look alike. A company not in the read:
 *  the sidebar's colour of its name. */
export function hueOf(org, seats, name) {
  const hues = [];
  for (const s of [...switchSeats(seats), ...(seats ?? []).filter((x) => x.guest)]) {
    let h = nameHue(s.name);
    for (let k = 0; k < 8 && hues.some((x) => Math.min(Math.abs(x - h), 360 - Math.abs(x - h)) < 40); k++) h = (h + 67) % 360;
    hues.push(h);
    if (s.org === org) return h;
  }
  return nameHue(name ?? org);
}

/** The switch shows when the account has two companies or more (locked ones count: they can be opened). */
export const hasSwitch = (seats) => switchSeats(seats).length >= 2;

/** The scope kept in this browser: "all" (every company), or "one" (the company this tab is in: its own list and the
 *  chats shared with it). Picking another company moves the tab there, so "one" is always the company the page is in
 *  (the header, the list and the start screen agree). Returns "all", the current company's id, or "current" (one
 *  company only: no switch). Anything else kept (an older company id) means "one". */
export function validScope(scope, seats) {
  if (!hasSwitch(seats)) return "current";
  if (scope === "all" || scope == null) return "all";
  return (seats ?? []).find((s) => s.current)?.org ?? "all";
}

const tag = (c, s, remote, seats) => ({ ...c, org: s.org, orgName: s.name, orgMark: s.mark ?? null, orgHue: hueOf(s.org, seats), remote,
  // Another company's chat: its photos and people live there, so the row draws initials (no photo, no presence).
  ...(remote ? { photoAt: null, peerPhotoAt: null, peerId: null, here: s.viewer ?? null } : {}) });

/** The chats of the scope: "current" (the page's own list, untagged), "all", or one company's id. */
export function scopeChannels(current, seats, scope) {
  const cur = (seats ?? []).find((s) => s.current);
  if (scope === "current" || !cur || !hasSwitch(seats)) return current;
  const out = [], seen = new Set();
  const add = (c) => { if (!seen.has(c.id)) { seen.add(c.id); out.push(c); } };
  const ok = (seats ?? []).filter((s) => s.state === "ok" && !s.current);
  const sharedTo = (s) => new Set((s.shared ?? []).map((x) => x.ref));
  if (scope === "all") {
    for (const c of current) add(tag(c, cur, false, seats));
    for (const s of ok) for (const c of s.channels ?? []) add(tag(c, s, true, seats));
    return out;
  }
  const home = (seats ?? []).find((s) => s.org === scope);
  if (!home) return current;
  if (home.current) for (const c of current) add(c); else if (home.state === "ok") for (const c of home.channels ?? []) add(tag(c, home, true, seats));
  // CONNECT: chats another company shares with this one, from my guest seat in that company.
  const refs = sharedTo(home);
  if (refs.size) for (const s of ok.filter((x) => x.guest)) for (const c of s.channels ?? []) if (refs.has(c.id)) add(tag(c, s, true, seats));
  return out;
}

const mutedNow = (until, now) => !!until && Date.parse(until) > now;
/** A chat that raises a badge: unread (or marked unread), not muted, not archived. */
export const counts = (c, now = Date.now()) => !c.archivedAt && !mutedNow(c.mutedUntil, now) && (c.unread > 0 || !!c.markedUnread);

/** Unread chats per company for the switch, and their sum for "All" (each chat once). */
export function scopeTotals(current, seats, now = Date.now()) {
  const out = { all: 0 };
  if (!hasSwitch(seats)) return out;
  const seen = new Set();
  for (const s of switchSeats(seats)) {
    if (s.state === "locked") { out[s.org] = 0; continue; }
    const list = scopeChannels(current, seats, s.org);
    let n = 0;
    for (const c of list) if (counts(c, now)) { n++; if (!seen.has(c.id)) { seen.add(c.id); out.all++; } }
    out[s.org] = n;
  }
  // Guest-seat chats no company of mine lists (a shared chat whose company of mine I am not in here) still count in All.
  for (const s of (seats ?? []).filter((x) => x.guest && x.state === "ok")) for (const c of s.channels ?? []) if (!seen.has(c.id) && counts(c, now)) { seen.add(c.id); out.all++; }
  return out;
}

/** Another company's chats that have news since the last read (unread went up, not muted): for a quiet "New message in …". */
export function newsSince(before, seats, now = Date.now()) {
  if (!before) return [];
  const out = [];
  for (const s of seats ?? []) {
    if (s.current || s.state !== "ok") continue;
    for (const c of s.channels ?? []) {
      const was = before.get(c.id) ?? 0;
      if (c.unread > was && !c.archivedAt && !mutedNow(c.mutedUntil, now)) out.push({ ...c, org: s.org, orgName: s.name });
    }
  }
  return out;
}

/** Unread per chat of the other companies, to compare with the next read. */
export function unreadMap(seats) {
  const m = new Map();
  for (const s of seats ?? []) if (!s.current && s.state === "ok") for (const c of s.channels ?? []) m.set(c.id, c.unread ?? 0);
  return m;
}

/** A cached read belongs to this account when the person signed in here is one of its seats' people (another person's
 *  cache on a shared browser is never shown). */
export function cacheFits(cache, viewer) {
  return !!cache && Array.isArray(cache.seats) && !!viewer && cache.seats.some((s) => s.viewer === viewer);
}

/** What is kept in this browser: the read, with the current company's own list in its place (so a read made in one
 *  company still draws every list after a switch to another). */
export function toCache(read, current) {
  return { ...read, seats: read.seats.map((s) => s.current ? { ...s, state: "ok", channels: current.slice(0, 150) } : s) };
}
/** A kept read, seen from the company this tab is in now: the one whose person is signed in here is the current one. */
export function rebase(cache, viewer) {
  if (!cache) return null;
  return { ...cache, seats: cache.seats.map((s) => s.viewer === viewer ? { ...s, current: true, state: "current", channels: [] } : { ...s, current: false }) };
}

/** The company's short name for a chip ("Estate Autopilots" stays; "Vitals Technology Private Limited" -> "Vitals Technology"). */
export function chipName(name) {
  const n = String(name ?? "").replace(/\s+(private|pvt\.?)\s+(limited|ltd\.?)$/i, "").replace(/\s+(llp|limited|ltd\.?|inc\.?|llc)$/i, "").trim();
  return n.length > 22 ? `${n.slice(0, 20).trimEnd()}…` : n || "Company";
}
