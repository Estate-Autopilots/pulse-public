// CHATS-2: the small decisions a WhatsApp-style chat makes on every row and bubble, kept pure so they are tested:
// the date chip over a day, the time in the list, the ticks, the one-line preview, labels for groups and presence,
// links shown by their domain, and the quoted part of a plain-text e-mail.
const IST = "Asia/Kolkata";
// CHAT-V3 (speed): the formatters are made once; building one per bubble was ~40% of opening a conversation.
const F = (locale, options) => new Intl.DateTimeFormat(locale, { ...options, timeZone: IST });
const DAY = F("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }), TIME = F("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
const WEEKDAY = F("en-IN", { weekday: "long" }), WEEKDAY_SHORT = F("en-IN", { weekday: "short" });
const LONG = F("en-IN", { day: "numeric", month: "long" }), LONG_YEAR = F("en-IN", { day: "numeric", month: "long", year: "numeric" });
const SHORT = F("en-IN", { day: "numeric", month: "short" }), SHORT_YEAR = F("en-IN", { day: "numeric", month: "short", year: "2-digit" });
const keys = new Map();
const dayKey = (d) => { const t = d.getTime(); let k = keys.get(t); if (k === undefined) { k = DAY.format(d); if (keys.size > 4000) keys.clear(); keys.set(t, k); } return k; };
const daysBetween = (a, b) => Math.round((Date.parse(`${dayKey(b)}T00:00:00Z`) - Date.parse(`${dayKey(a)}T00:00:00Z`)) / 86400000);

const FULL = F("en-IN", { dateStyle: "medium", timeStyle: "short" });
/** CHAT-V3: the full date and time a bubble's time shows on hover. */
export const fullTime = (iso) => FULL.format(new Date(iso));
/** "10:42 am" in India time. */
export function clock(iso) {
  return TIME.format(new Date(iso)).replace(/\s?(AM|PM)$/i, (m) => ` ${m.trim().toLowerCase()}`);
}
/** The chip over a day of messages: Today, Yesterday, the weekday within a week, else the date. */
export function dayChip(iso, now = new Date()) {
  const d = new Date(iso); const n = daysBetween(d, now);
  if (n <= 0) return "Today";
  if (n === 1) return "Yesterday";
  if (n < 7) return WEEKDAY.format(d);
  return (dayKey(d).slice(0, 4) !== dayKey(now).slice(0, 4) ? LONG_YEAR : LONG).format(d);
}
/** The time beside a conversation in the list. */
export function listTime(iso, now = new Date()) {
  if (!iso) return "";
  const d = new Date(iso); const n = daysBetween(d, now);
  if (n <= 0) return clock(iso);
  if (n === 1) return "Yesterday";
  if (n < 7) return WEEKDAY_SHORT.format(d);
  return (dayKey(d).slice(0, 4) !== dayKey(now).slice(0, 4) ? SHORT_YEAR : SHORT).format(d);
}
export const sameDay = (a, b) => dayKey(new Date(a)) === dayKey(new Date(b));

/** One tick sent, two delivered, two in colour read; a clock while sending and a warning when it failed. */
export function ticks(message, receipts, viewer) {
  if (message.authorId !== viewer || message.kind === "event" || message.removed) return null;
  if (message.failed) return "failed";
  if (message.pending) return "pending";
  const at = Date.parse(message.createdAt);
  if (receipts?.readThrough && Date.parse(receipts.readThrough) >= at) return "read";
  if (receipts?.deliveredThrough && Date.parse(receipts.deliveredThrough) >= at) return "delivered";
  return "sent";
}

const first = (name) => String(name ?? "").replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
/** The grey line under a conversation's name. */
export function preview(channel, viewer) {
  if (!channel.lastAt) return channel.kind === "direct" ? "Say hello" : channel.members ? `${channel.members} member${channel.members === 1 ? "" : "s"}` : "No messages yet";
  if (channel.moderationOnly) return "Moderation access";
  const who = channel.previewAuthorId === viewer ? "You" : channel.kind === "direct" ? "" : first(channel.previewAuthor);
  if (channel.previewRemoved) return `${who ? `${who}: ` : ""}This message was deleted`;
  // CHAT-VOICE: a call's line, as the person reading the list sees it (their missed call; my call nobody answered).
  const call = channel.previewAttachment?.call ? channel.previewAttachment : null;
  if (call && channel.previewKind === "event") {
    const kind = call.video ? "video call" : "voice call", mine = channel.previewAuthorId === viewer;
    const missed = call.state === "missed" || call.state === "busy";
    return `${call.video ? "🎥" : "📞"} ${missed ? (mine ? `${call.video ? "Video" : "Voice"} call · no answer` : `Missed ${kind}`) : channel.preview ?? ""}`.trim();
  }
  if (channel.previewKind === "event") return `${channel.previewAuthorId === viewer ? "You" : first(channel.previewAuthor)} ${channel.preview ?? ""}`.trim();
  const a = channel.previewAttachment;
  const voice = a?.voice ? `🎤 Voice message (${Math.floor(a.voice.seconds / 60)}:${String(Math.floor(a.voice.seconds % 60)).padStart(2, "0")})` : "";
  const body = channel.preview || (a ? (a.task ? `Task: ${a.name}` : voice || (a.id ? `📎 ${a.name}` : `🔗 ${a.name}`)) : "");
  return `${who ? `${who}: ` : ""}${body}`;
}
const KIND = { pod: "Pod", team: "Department", group: "Google group", custom: "Group" };
/** What kind of group a conversation is, said plainly. Direct messages have none. */
export const kindLabel = (kind) => KIND[kind] ?? null;

/** Pinned first (latest pin on top), then the latest conversation; the name breaks ties. */
export function sortChats(channels) {
  return [...channels].sort((a, b) => (b.pinnedAt ? 1 : 0) - (a.pinnedAt ? 1 : 0) || (a.pinnedAt && b.pinnedAt ? Date.parse(b.pinnedAt) - Date.parse(a.pinnedAt) : 0)
    || (b.lastAt ? Date.parse(b.lastAt) : 0) - (a.lastAt ? Date.parse(a.lastAt) : 0) || a.name.localeCompare(b.name));
}
/** All · Unread · Groups · People, and the search box (names, and the last message). CHAT-V3: also Pods (pods and
 *  departments), Clients (chats with people outside the company), AI (AI employees) and Archived; archived chats stay
 *  out of every other view unless searched for by name. */
export function filterChats(channels, filter, query = "") {
  const q = query.trim().toLowerCase();
  return channels.filter((c) => !c.moderationOnly && !c.duplicateOf
    && (filter === "archived" ? !!c.archivedAt : !c.archivedAt || !!q)
    && (filter === "unread" ? c.unread > 0 || (c.mentions ?? 0) > 0 || !!c.markedUnread : filter === "groups" ? c.kind !== "direct" : filter === "people" ? c.kind === "direct" && !c.peerAgent
      : filter === "pods" ? c.kind === "pod" || c.kind === "team" : filter === "clients" ? !!(c.clientFacing || c.withOrg) : filter === "ai" ? !!c.peerAgent : true)
    && (!q || c.name.toLowerCase().includes(q) || (kindLabel(c.kind) ?? "").toLowerCase() === q || String(c.preview ?? "").toLowerCase().includes(q)));
}

const STATES = {
  office: ["In the office", "green"], outside: ["On duty outside", "violet"], shoot: ["On a shoot", "orange"], wfh: ["Working from home", "teal"],
  break: ["On a break", "amber"], active: ["Active", "green"], away: ["Away", "idle"], offline: ["Offline", "off"], leave: ["On leave", "leave"],
};
/** The label and dot of a presence: do-not-disturb wins the colour, the place stays in the words. */
export function presenceLabel(p) {
  if (!p) return { label: "", tone: "off" };
  const [label, tone] = STATES[p.state] ?? STATES.offline;
  return { label: p.dnd ? `Do not disturb · ${label}` : label, tone: p.dnd ? "dnd" : tone, status: p.text ? `${p.emoji ? `${p.emoji} ` : ""}${p.text}` : "" };
}

/** "Last seen" for someone away or offline, from the last time Pulse was open. */
export function lastSeen(activeAt, now = new Date()) {
  if (!activeAt) return "";
  const minutes = Math.round((now.getTime() - Date.parse(activeAt)) / 60000);
  if (minutes < 1) return "Active now";
  if (minutes < 60) return `Active ${minutes} min ago`;
  return `Last seen ${daysBetween(new Date(activeAt), now) === 0 ? `today at ${clock(activeAt)}` : daysBetween(new Date(activeAt), now) === 1 ? `yesterday at ${clock(activeAt)}` : listTime(activeAt, now)}`;
}

/** The address a person recognises for a link: the domain, through redirect wrappers. */
export function linkDomain(href) {
  try {
    let u = new URL(href);
    const inner = (u.hostname === "www.google.com" && u.pathname === "/url") ? u.searchParams.get("q") : null;
    if (inner && /^https?:\/\//.test(inner)) u = new URL(inner);
    return u.hostname.replace(/^www\./, "");
  } catch { return href; }
}
/** A message body in pieces: plain text, links (long ones shown as their domain) and @mentions of real people. */
export function segments(body, usernames = []) {
  const known = new Set(usernames.map((u) => String(u).toLowerCase()));
  return String(body ?? "").split(/(https?:\/\/[^\s<>"]+|@[a-z0-9][a-z0-9._-]*)/gi).filter(Boolean).map((part) => {
    if (/^https?:\/\//i.test(part)) { const href = part.replace(/[),.;:!?]+$/, ""); return { type: "link", value: href, label: href.length > 48 ? linkDomain(href) : href, rest: part.slice(href.length) }; }
    if (part.startsWith("@") && known.has(part.slice(1).toLowerCase())) return { type: "mention", value: part };
    return { type: "text", value: part };
  }).reduce((out, s) => { const last = out.at(-1); if (s.type === "text" && last?.type === "text") last.value += s.value; else out.push(s); return out; }, []);
}

/** CHAT-V4: the one link in a message worth a preview card: the first public https address, not Pulse's own pages and
 *  not Google's files (those open in the side panel with their own title). Null when there is none. */
export function previewLink(body, origin = "") {
  for (const s of segments(body)) {
    if (s.type !== "link") continue;
    let u; try { u = new URL(s.value); } catch { continue; }
    if (u.protocol !== "https:" || (origin && u.origin === origin)) continue;
    if (/(^|\.)(docs|drive|meet|calendar)\.google\.com$/i.test(u.hostname) || /(^|\.)estateautopilots\.com$/i.test(u.hostname)) continue;
    return u.href;
  }
  return null;
}

/** CHAT-V4: people for "@" as it is typed, best first: a first name that starts with it, then any word of the name or the
 *  username that starts with it, then the rest that contain it (alphabetical within each). Only people with a username
 *  (the handle a mention writes), never the viewer. */
export function rankMentions(members, typed, viewer, limit = 8) {
  const q = String(typed ?? "").toLowerCase();
  const score = (p) => {
    const name = String(p.name ?? "").toLowerCase(), user = String(p.username ?? "").toLowerCase();
    if (!q) return 0;
    if (name.startsWith(q)) return 0;
    if (user.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    return `${name} ${user}`.includes(q) ? 2 : -1;
  };
  return members.filter((p) => p.id !== viewer && p.username).map((p) => [score(p), p]).filter(([s]) => s >= 0)
    .sort((a, b) => a[0] - b[0] || String(a[1].name).localeCompare(String(b[1].name))).slice(0, limit).map(([, p]) => p);
}

/** A plain-text e-mail split into what was written now and the quoted earlier message ("On … wrote:" and "> " lines). */
export function splitQuoted(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  let cut = lines.findIndex((line, i) => /^On .{6,200} wrote:\s*$/.test(line.trim()) || /^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(line.trim())
    || (/^>/.test(line) && lines.slice(i).every((l) => /^>|^\s*$/.test(l))) || /^From: .+/.test(line) && /^(Sent|Date): /.test(lines[i + 1] ?? ""));
  if (cut < 0) return { main: text, quoted: "" };
  while (cut > 0 && !lines[cut - 1].trim()) cut--;
  return { main: lines.slice(0, cut).join("\n").trimEnd(), quoted: lines.slice(cut).join("\n").trim() };
}

/** Members of a group under their department, the biggest department first; people without one last. */
export function byDepartment(members) {
  const groups = new Map();
  for (const m of members) { const k = m.team || "No department"; groups.set(k, [...(groups.get(k) ?? []), m]); }
  return [...groups.entries()].sort((a, b) => (a[0] === "No department") - (b[0] === "No department") || b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([department, people]) => ({ department, people: people.sort((x, y) => x.name.localeCompare(y.name)) }));
}

/** "2.4 MB" */
export function fileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}
