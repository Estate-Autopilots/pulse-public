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
/** AI-AGENTS-2: a preview line without Markdown marks: **bold** and __bold__ lose their stars, `code` its ticks, a
 *  heading its hashes. Single stars stay (a WhatsApp *bold* or a sum like 2*3 is what the person typed). */
export const plainPreview = (s) => String(s ?? "").replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1").replace(/`([^`\n]+)`/g, "$1").replace(/^ {0,3}#{1,6} +/gm, "");
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
  // VISIBLE: a WhatsApp group notice moved into Pulse names who in its own words ("Asha added Ravi"); its author is the
  // "WhatsApp" placeholder, which the list put in front ("WhatsApp Asha added Ravi").
  if (channel.previewKind === "event") return channel.previewImported ? String(channel.preview ?? "").trim() : `${channel.previewAuthorId === viewer ? "You" : first(channel.previewAuthor)} ${channel.preview ?? ""}`.trim();
  const a = channel.previewAttachment;
  const voice = a?.voice ? `🎤 Voice message (${Math.floor(a.voice.seconds / 60)}:${String(Math.floor(a.voice.seconds % 60)).padStart(2, "0")})` : "";
  // VISIBLE: media the WhatsApp export left out has no file and often no name ("Povubi: 🔗 undefined").
  // AI-AGENTS-2: an AI's answer is Markdown; the one-line preview drops its marks (**bold**, `code`, "### ") so it reads as words.
  const body = (channel.preview ? plainPreview(channel.preview) : "") || (a ? (a.task ? `Task: ${a.name}` : a.omitted ? `📎 ${a.name || OMITTED[a.omitted] || "Media"} (not in the WhatsApp export)` : voice || (a.id ? `📎 ${a.name || "File"}` : `🔗 ${a.name || "Link"}`)) : "");
  return `${who ? `${who}: ` : ""}${body}`;
}
const OMITTED = { image: "Photo", video: "Video", audio: "Audio", voice: "Voice message", document: "Document", sticker: "Sticker", gif: "GIF", contact: "Contact card" };
const KIND = { pod: "Team", team: "Department", group: "Google group", custom: "Group" };
/** What kind of group a conversation is, said plainly. Direct messages have none. */
export const kindLabel = (kind) => KIND[kind] ?? null;

/** Pinned first (latest pin on top), then the latest conversation; the name breaks ties. */
export function sortChats(channels) {
  return [...channels].sort((a, b) => (b.pinnedAt ? 1 : 0) - (a.pinnedAt ? 1 : 0) || (a.pinnedAt && b.pinnedAt ? Date.parse(b.pinnedAt) - Date.parse(a.pinnedAt) : 0)
    || (b.lastAt ? Date.parse(b.lastAt) : 0) - (a.lastAt ? Date.parse(a.lastAt) : 0) || a.name.localeCompare(b.name));
}
/** All · Unread · Groups · People, and the search box (names, and the last message). CHAT-V3: also Pods (pods and
 *  departments), Clients (chats with people outside the company; VISIBLE: and clients' groups moved from WhatsApp), AI
 *  (AI employees) and Archived; archived chats stay out of every other view unless searched for by name. */
/** WL-ONBOARD (17 Nov 2026): search text folded: lower case, accents off ("bhra" finds "bhrātā", as Sakobe typed). */
export const foldText = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

export function filterChats(channels, filter, query = "") {
  const q = foldText(query.trim());
  return channels.filter((c) => !c.moderationOnly && !c.duplicateOf
    && (filter === "archived" ? !!c.archivedAt : !c.archivedAt || !!q)
    && (filter === "unread" ? c.unread > 0 || (c.mentions ?? 0) > 0 || !!c.markedUnread : filter === "groups" ? c.kind !== "direct" : filter === "people" ? c.kind === "direct" && !c.peerAgent
      : filter === "pods" ? c.kind === "pod" || c.kind === "team" : filter === "clients" ? !!(c.clientFacing || c.withOrg || c.clientGroup) : filter === "ai" ? !!c.peerAgent : true)
    && (!q || nameMatches(`${c.name} ${c.peerUsername ?? ""}`, query) || (kindLabel(c.kind) ?? "").toLowerCase() === q || foldText(c.preview).includes(q)));
}

// WL-ONBOARD-FIX (17 Nov 2026): names are spelt many ways in India. Sakobe searched Chats for bhrātā as "bhra", then
// wondered aloud whether it is "b r a" or "b h a"; others write bharata, bhrata or भ्राता. Devanagari is read as Latin
// letters, then a loose form (no h, w as v, a doubled letter once) and, for three consonants or more, the consonants
// alone from the start of a word (bharata, bhrata, bhrātā and भ्राता are all "brt").
const DEV_C = { "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n", "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n", "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "ळ": "l", "व": "v", "श": "sh", "ष": "sh", "स": "s", "ह": "h" };
const DEV_V = { "अ": "a", "आ": "aa", "इ": "i", "ई": "ii", "उ": "u", "ऊ": "uu", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o" };
const DEV_M = { "ा": "aa", "ि": "i", "ी": "ii", "ु": "u", "ू": "uu", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o" };
const VIRAMA = "्", NUKTA = "़";
/** Devanagari in Latin letters (भ्राता → bhraataa); anything else as it is. */
export function romanize(s) {
  const t = String(s ?? "").normalize("NFD");
  if (!/[ऀ-ॿ]/.test(t)) return t;
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (DEV_C[ch]) {
      let j = i + 1; while (t[j] === NUKTA) j++;
      out += DEV_C[ch];
      if (t[j] === VIRAMA) i = j;
      else if (DEV_M[t[j]]) { out += DEV_M[t[j]]; i = j; }
      else { out += "a"; i = j - 1; }
    } else if (DEV_V[ch]) out += DEV_V[ch];
    else if (ch === "ं" || ch === "ँ") out += "n";
    else if (ch === "ः") out += "h";
    else if (ch !== NUKTA && ch !== VIRAMA && !DEV_M[ch]) out += ch;
  }
  return out;
}
const loose = (s) => foldText(romanize(s)).replace(/h/g, "").replace(/w/g, "v").replace(/([a-z])\1+/g, "$1");
const consonants = (s) => loose(s).replace(/[aeiouy]/g, "").replace(/[^a-z0-9]/g, "");
/** Whether a name (with its username) matches what was typed: as written, accents off, in Devanagari, or a near
 *  spelling of a word's start. */
export function nameMatches(text, query) {
  const q = foldText(query).trim();
  if (!q) return true;
  if (foldText(text).includes(q)) return true;
  const lq = loose(query).trim();
  if (lq && loose(text).includes(lq)) return true;
  const cq = consonants(query);
  if (cq.length < 3 || /\s/.test(q)) return false;
  return romanize(text).split(/[^\p{L}\p{N}]+/u).some((w) => w && consonants(w).startsWith(cq));
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

/** The address a person recognises for a link: the domain, through redirect wrappers. ARTHA-FIX: a Pulse page given as
 *  its own address (a doc or a task an AI employee attached) says what it is and that it opens beside the chat. */
export function linkDomain(href) {
  if (typeof href === "string" && /^\/(?!\/)/.test(href)) return /^\/docs\/[\w-]+/.test(href) ? "Pulse doc · opens beside the chat" : "Pulse · opens beside the chat";
  try {
    let u = new URL(href);
    const inner = (u.hostname === "www.google.com" && u.pathname === "/url") ? u.searchParams.get("q") : null;
    if (inner && /^https?:\/\//.test(inner)) u = new URL(inner);
    return u.hostname.replace(/^www\./, "");
  } catch { return href; }
}
/** AI-AGENTS-2: whether an AI employee's message has Markdown worth typesetting (a list, a heading, a fence, a quote,
 *  bold or inline code). Plain sentences stay the plain paragraph they were. */
export function looksLikeMarkdown(body) {
  const s = String(body ?? "");
  return /^ {0,3}(?:[-*+] |\d{1,3}[.)] |#{1,6} |```|> )/m.test(s) || /\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`/.test(s);
}
/** A message body in pieces: plain text, links (long ones shown as their domain) and @mentions of real people. */
export function segments(body, usernames = [], mentioned = null) {
  // IDENTITY-UNIFY: a mentioned person's old usernames (from before their one @handle) still mark old messages.
  const known = new Set([...usernames, ...(mentioned ?? []).flatMap((p) => [p?.username, ...(p?.aliases ?? [])])].filter(Boolean).map((u) => String(u).toLowerCase()));
  // WA-NATIVE: a mention of someone without a username (a client contact met in WhatsApp) reads "@Their Name"; the
  // message says whom it mentions, so only those names are marked, the longest first.
  const names = [...new Set((mentioned ?? []).map((p) => p?.name).filter(Boolean).map(String))].sort((a, b) => b.length - a.length);
  const named = new Set(names.map((n) => n.toLowerCase()));
  const split = names.length ? new RegExp(`(https?:\\/\\/[^\\s<>"]+|@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w])|@[a-z0-9][a-z0-9._-]*)`, "gi")
    : /(https?:\/\/[^\s<>"]+|@[a-z0-9][a-z0-9._-]*)/gi;
  return String(body ?? "").split(split).filter(Boolean).flatMap((part) => {
    // DOCS-MCP: a doc tagged in chat reads "Open the doc", not the address's domain.
    if (/^https?:\/\//i.test(part)) { const href = part.replace(/[),.;:!?]+$/, ""); return [{ type: "link", value: href, label: /\/docs\/[0-9a-f]{8}-[0-9a-f-]{27}$/.test(href) ? "Open the doc" : href.length > 48 ? linkDomain(href) : href, rest: part.slice(href.length) }]; }
    if (part.startsWith("@") && (known.has(part.slice(1).toLowerCase()) || named.has(part.slice(1).toLowerCase()))) return [{ type: "mention", value: part }];
    // A sentence's full stop (or a dash) right after a username is not part of it: "@asha.k." marks "@asha.k".
    const bare = part.startsWith("@") ? part.replace(/[._-]+$/, "") : part;
    if (bare !== part && known.has(bare.slice(1).toLowerCase())) return [{ type: "mention", value: bare }, { type: "text", value: part.slice(bare.length) }];
    return [{ type: "text", value: part }];
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

/** Members of a group under their department, the biggest department first; people without one last. SIM-CLIENTS R137:
 *  a client's people come first, under their company (they have no department here). */
export function byDepartment(members) {
  const groups = new Map(), companies = new Set();
  for (const m of members) { const k = m.company || m.team || "No department"; if (m.company) companies.add(k); groups.set(k, [...(groups.get(k) ?? []), m]); }
  return [...groups.entries()].sort((a, b) => companies.has(b[0]) - companies.has(a[0]) || (a[0] === "No department") - (b[0] === "No department") || b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([department, people]) => ({ department, people: people.sort((x, y) => x.name.localeCompare(y.name)) }));
}

/** "2.4 MB" */
export function fileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

const ANSWERING = new Set(["queued", "leased", "dispatching"]);
/** CHAT-V3 rule, shared by Chats and the top-bar chat (BUGFIX #26): the AI employees working on an answer to the latest
 *  messages, by their whole name ("Project Coordinator", not "Project Coordinator (AI)"). Paused ones and ones out of
 *  quota are not working, so they are left out. */
export function aiThinking(messages) {
  const names = (messages ?? []).slice(-20)
    .filter((m) => m?.agentAsk && ANSWERING.has(m.agentAsk.state) && m.agentAsk.reason !== "paused" && m.agentAsk.runtimeState !== "out_of_quota")
    .map((m) => String(m.agentAsk.agent ?? "").replace(/\s*\(AI\)\s*$/, "")).filter(Boolean);
  return [...new Set(names)];
}
/** "Accounts Assistant is working on an answer" / "A and B are working on an answer"; "" when nobody is. */
export function thinkingLine(names) {
  if (!names?.length) return "";
  return `${names.join(" and ")} ${names.length === 1 ? "is" : "are"} working on an answer`;
}
