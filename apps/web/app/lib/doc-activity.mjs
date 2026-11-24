// DOCS-ACTIVITY (owner, 17 Nov 2026: "there is no last editor and no trail. Last activity should be visible"): the words
// for a doc's or folder's activity, kept here so they are tested (doc-activity.test.mjs). The API sends what happened
// (services/api/src/doc-activity.ts); this says it in plain words: "Ravi commented", "Asha moved it to Clients",
// "Made by an automation (weekly report tool)". "You" when it was the reader.

/** @typedef {{ id: string; name: string; agent?: boolean; photoAt?: string | null }} Who */
/** @typedef {"ai" | "api" | "script" | null} Via */
/** @typedef {{ at: string; kind: string; by: Who | null; via?: Via; viaLabel?: string | null; times?: number; doc?: { id: string; title: string } | null;
 *   folder?: { id: string; name: string } | null; words?: string | null; from?: string | null; to?: string | null; person?: string | null; role?: string | null;
 *   note?: string | null; readPct?: number | null }} Item */

/** What someone did, as a short verb phrase (cards, folder tiles, the list). */
export const VERBS = /** @type {const} */ ({
  created: "made it", imported: "imported it", edited: "edited", restored: "restored an older version", enriched: "made it richer",
  commented: "commented", resolved: "resolved a comment", moved: "moved it", shared: "shared it", unshared: "stopped sharing it",
  access: "changed who can see it", archived: "archived it", unarchived: "brought it back", renamed: "renamed it", added: "added a file", viewed: "read it",
});

/** The person's name as the reader sees it: "You" for themselves, the first name otherwise ("Someone" when unknown).
 *  @param {Who | null | undefined} who @param {string | null | undefined} me */
export function whoWord(who, me) {
  if (!who) return "Someone";
  if (me && who.id === me) return "You";
  return who.name.replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(/\s+/)[0] || who.name;
}

/** An AI employee's name as the lines say it: its whole name, with "(AI)" unless the name already says so.
 *  @param {Who} who */
export const agentName = (who) => /\bAI\b/.test(who.name) ? who.name : `${who.name} (AI)`;
/** Who did it, as the lines say it. @param {Who | null | undefined} who @param {string | null | undefined} me */
const nameOf = (who, me) => who?.agent ? agentName(who) : whoWord(who, me);

/** How much of a doc someone read, in plain words ("read most of it"). @param {number | null | undefined} pct */
export function readWords(pct) {
  const n = typeof pct === "number" ? pct : 0;
  return n >= 90 ? "read all of it" : n >= 60 ? "read most of it" : n >= 35 ? "read about half" : n > 0 ? "read a little of it" : "opened it";
}

/** How a change was made, in a few words; null when a person did it in the app.
 *  @param {Via | undefined} via @param {string | null | undefined} label */
export function viaWords(via, label) {
  if (via === "ai") return "AI";
  if (via === "api") return label ? `via ${label}` : "via an API key";
  if (via === "script") return label ? `by automation (${label})` : "by automation";
  return null;
}

/** Made by AI or an automation (an AI employee, or one of the server's tools): the doc wears an AI marker.
 *  @param {{ madeVia?: Via; activity?: { via?: Via } | null } | null | undefined} d */
export const madeByAi = (d) => d?.madeVia === "ai" || d?.madeVia === "script";

/** A doc card's or list row's line: "Ravi commented", "You edited", "Ops Helper (AI) made it".
 *  An AI employee keeps its whole name (it says "(AI)").
 *  @param {Item | null | undefined} a @param {string | null | undefined} me */
export function activityLine(a, me) {
  if (!a) return "";
  const name = nameOf(a.by, me);
  const verb = /** @type {Record<string, string>} */ (VERBS)[a.kind] ?? "changed it";
  // Made or changed by one of the server's tools for this person: say so, as the card's "Made by AI" chip does.
  const how = a.via === "script" && ["created", "imported", "edited", "enriched", "restored"].includes(a.kind) ? " with automation" : "";
  return `${name} ${verb}${how}`;
}

/** A folder tile's line: who did what to which doc inside ("Meera edited “Launch brief”").
 *  @param {Item | null | undefined} a @param {string | null | undefined} me */
export function folderLine(a, me) {
  if (!a) return "";
  const name = nameOf(a.by, me);
  const title = a.doc?.title ? `“${a.doc.title}”` : null;
  if (a.kind === "created" && !a.doc) return `${name} made this folder`;
  if (a.kind === "renamed" && !a.doc) return `${name} renamed this folder`;
  if (a.kind === "moved" && !a.doc) return `${name} moved this folder`;
  if (a.kind === "added") return title ? `${name} added ${title}` : `${name} added a file`;
  if (!title) return `${name} ${/** @type {Record<string, string>} */ (VERBS)[a.kind] ?? "changed it"}`;
  const verb = /** @type {Record<string, string>} */ ({ created: "made", imported: "imported", edited: "edited", restored: "restored", enriched: "improved",
    commented: "commented on", resolved: "resolved a comment on", moved: "moved", shared: "shared", unshared: "stopped sharing", access: "changed who can see",
    archived: "archived", unarchived: "brought back" })[a.kind] ?? "changed";
  return `${name} ${verb} ${title}`;
}

const ACCESS_TO = /** @type {Record<string, string>} */ ({ private: "made it private", company: "opened it to everyone in the company", people: "shared it with chosen people" });

/** One line of a trail, as a sentence without the time: "Asha moved it from My Docs to HR and policies".
 *  `inFolder`: the folder's trail, which names the doc each line is about.
 *  @param {Item} a @param {string | null | undefined} me @param {{ inFolder?: boolean }} [opts] */
export function trailWords(a, me, opts = {}) {
  const name = nameOf(a.by, me);
  const it = opts.inFolder && a.doc?.title ? `“${a.doc.title}”` : "it";
  const times = a.times && a.times > 1 ? ` (${a.times} times)` : "";
  switch (a.kind) {
    case "created": return opts.inFolder && !a.doc ? `${name} made the folder${a.folder?.name ? ` “${a.folder.name}”` : ""}` : `${name} made ${it}`;
    case "imported": return `${name} imported ${it}`;
    case "edited": return `${name} edited ${it}${times}`;
    case "restored": return `${name} restored an older version${opts.inFolder && a.doc ? ` of ${it}` : ""}`;
    case "enriched": return `${name} made ${it} richer`;
    case "commented": return `${name} commented${opts.inFolder && a.doc ? ` on ${it}` : ""}${a.words ? `: “${a.words}”` : ""}`;
    case "resolved": return `${name} resolved a comment${a.words ? `: “${a.words}”` : ""}`;
    case "moved": return a.doc || !opts.inFolder ? `${name} moved ${it}${a.from ? ` from ${a.from}` : ""}${a.to ? ` to ${a.to}` : ""}` : `${name} moved the folder${a.folder?.name ? ` “${a.folder.name}”` : ""}${a.to ? ` to ${a.to}` : ""}`;
    case "renamed": return `${name} renamed the folder${a.from ? ` from “${a.from}”` : ""}${a.to ? ` to “${a.to}”` : ""}`;
    case "shared": return `${name} shared ${it} with ${a.person ?? "someone"}${a.role ? ` (${a.role})` : ""}`;
    case "unshared": return `${name} stopped sharing ${it} with ${a.person ?? "someone"}`;
    case "access": return `${name} ${ACCESS_TO[String(a.to)] ?? "changed who can see it"}${opts.inFolder && a.doc ? ` (${it})` : ""}`;
    case "archived": return `${name} archived ${it}`;
    case "unarchived": return `${name} brought ${it} back from the archive`;
    case "added": return `${name} added ${a.doc?.title ? `“${a.doc.title}”` : "a file"}`;
    case "viewed": return `${name} ${readWords(a.readPct)}${times}`;
    default: return `${name} changed ${it}`;
  }
}

/** The trail's icon group, so each kind looks the same everywhere. @param {string} kind */
export function trailTone(kind) {
  if (kind === "commented" || kind === "resolved") return "comment";
  if (kind === "moved" || kind === "renamed") return "move";
  if (kind === "shared" || kind === "unshared" || kind === "access") return "share";
  if (kind === "viewed") return "view";
  if (kind === "archived" || kind === "unarchived") return "archive";
  if (kind === "created" || kind === "imported" || kind === "added") return "made";
  return "edit";
}
