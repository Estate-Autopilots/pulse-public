// DOCS-DRIVE (owner, 8 Nov 2026: "make the UX like how we handle Drive … much nicer for folders, folders under folders,
// documents and so on"): the Docs page's rules that need no screen, kept here so they are tested (docs-drive.test.mjs):
// what type a doc is (its icon and colour), sorting the list, Shift/Ctrl selection, which folder may be dropped where,
// how many things a folder holds, matching words to highlight, and what a file dropped from the computer becomes.

/** @typedef {{ id: string; name: string; parentId: string | null }} FolderLike */
/** @typedef {"doc" | "meeting" | "sop" | "offer" | "contract" | "policy" | "plan" | "brief"} DocType */

/** Each doc type: its words and colour (icons are chosen in the page). The type is the doc's category. */
export const DOC_TYPES = /** @type {const} */ ({
  doc: { label: "Doc", colour: "#2f6fe4" },
  meeting: { label: "Meeting notes", colour: "#d98a00" },
  sop: { label: "SOP", colour: "#1f9254" },
  offer: { label: "Offer", colour: "#d6407a" },
  contract: { label: "Contract", colour: "#6b4cf0" },
  policy: { label: "Policy", colour: "#0f8a8a" },
  plan: { label: "Plan", colour: "#5a6b85" },
  brief: { label: "Brief", colour: "#a35a1c" },
});

/** @param {string | null | undefined} category @returns {DocType} */
export function docType(category) {
  const c = String(category ?? "").trim().toLowerCase();
  if (!c) return "doc";
  if (c.startsWith("meeting")) return "meeting";
  if (c === "sop" || c.startsWith("process") || c.startsWith("how to")) return "sop";
  if (c.startsWith("offer") || c.startsWith("proposal") || c.startsWith("quote")) return "offer";
  if (c.startsWith("contract") || c === "legal" || c.startsWith("agreement")) return "contract";
  if (c.startsWith("polic")) return "policy";
  if (c.startsWith("plan")) return "plan";
  if (c.startsWith("brief")) return "brief";
  return "doc";
}

/** @typedef {{ key: string; kind: "folder" | "doc" | "file"; name: string; owner?: string | null; updatedAt?: string | null; activityAt?: string | null; access?: string | null; tags?: string[] }} Row */

const ACCESS_ORDER = { private: 0, people: 1, company: 2 };
/** A time as a sortable string (ISO times from Postgres and from JSON differ in form; this compares them as times). @param {string | null | undefined} iso */
const stamp = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isNaN(t) ? "" : String(t).padStart(15, "0"); };
/** The list view's sort: folders always first; then by the column, ties by name. DOCS-ACTIVITY: "activity" (the
 *  default, newest first) is each doc's latest activity and each folder's latest anywhere under it.
 *  @param {Row[]} rows @param {"name" | "owner" | "updated" | "activity" | "access" | "tags"} key @param {"asc" | "desc"} dir @returns {Row[]} */
export function sortRows(rows, key, dir) {
  const sign = dir === "desc" ? -1 : 1;
  const byName = (/** @type {Row} */ a, /** @type {Row} */ b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  /** @param {Row} r */
  const value = (r) => key === "owner" ? (r.owner ?? "") : key === "updated" ? (r.updatedAt ?? "") : key === "activity" ? stamp(r.activityAt ?? r.updatedAt) : key === "access" ? String(ACCESS_ORDER[/** @type {keyof typeof ACCESS_ORDER} */ (r.access ?? "company")] ?? 3)
    : key === "tags" ? (r.tags ?? []).join(" ") : r.name;
  return [...rows].sort((a, b) => {
    if ((a.kind === "folder") !== (b.kind === "folder")) return a.kind === "folder" ? -1 : 1;
    if (key === "name") return sign * byName(a, b);
    const va = value(a), vb = value(b);
    if (va === vb) return byName(a, b);
    // Empty values sink to the end whichever way the column is sorted.
    if (!va) return 1;
    if (!vb) return -1;
    return sign * va.localeCompare(vb, undefined, { numeric: true, sensitivity: "base" });
  });
}

/** Click, Ctrl/Cmd-click and Shift-click, as in a file manager.
 *  @param {string[]} order the keys as shown @param {Set<string>} selected @param {string | null} anchor @param {string} key
 *  @param {{ shift?: boolean; toggle?: boolean }} mods @returns {{ selected: Set<string>; anchor: string }} */
export function selectWith(order, selected, anchor, key, mods) {
  if (mods.shift && anchor && order.includes(anchor)) {
    const a = order.indexOf(anchor), b = order.indexOf(key);
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    const next = new Set(mods.toggle ? selected : []);
    for (const k of range) next.add(k);
    return { selected: next, anchor };
  }
  if (mods.toggle) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    return { selected: next, anchor: key };
  }
  return { selected: new Set([key]), anchor: key };
}

/** Folders inside a folder, at any depth. @param {FolderLike[]} folders @param {string} id @returns {Set<string>} */
export function descendants(folders, id) {
  const out = new Set(), queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    for (const f of folders) if (f.parentId === cur && !out.has(f.id)) { out.add(f.id); queue.push(f.id); }
  }
  return /** @type {Set<string>} */ (out);
}

/** May these folders be dropped into target (null: the top)? Not into themselves, their own folders, or where they are.
 *  @param {FolderLike[]} folders @param {string[]} moving @param {string | null} target */
export function canDropFolders(folders, moving, target) {
  for (const id of moving) {
    if (target === id) return false;
    if (target && descendants(folders, id).has(target)) return false;
  }
  return !moving.length || moving.some((id) => (folders.find((f) => f.id === id)?.parentId ?? null) !== target);
}

/** The way up from a folder: [top, …, folder]. @param {FolderLike[]} folders @param {string | null} id @returns {FolderLike[]} */
export function pathTo(folders, id) {
  const out = [];
  for (let cur = id, hops = 0; cur && hops < 14; hops++) {
    const f = folders.find((x) => x.id === cur);
    if (!f) break;
    out.unshift(f);
    cur = f.parentId;
  }
  return out;
}

/** "4 docs · 2 folders" (or "Empty"). @param {{ docs: number; folders: number; files: number }} n */
export function countWords(n) {
  const part = (/** @type {number} */ k, /** @type {string} */ one, /** @type {string} */ many) => k ? `${k} ${k === 1 ? one : many}` : "";
  return [part(n.docs, "doc", "docs"), part(n.folders, "folder", "folders"), part(n.files, "file", "files")].filter(Boolean).join(" · ") || "Empty";
}

/** Split text into parts that match the searched words (for a highlight). Words shorter than 2 letters are ignored.
 *  @param {string} text @param {string} query @returns {{ text: string; hit: boolean }[]} */
export function highlight(text, query) {
  const words = [...new Set(String(query ?? "").toLowerCase().split(/[\s,]+/).map((w) => w.replace(/^#/, "")).filter((w) => w.length >= 2))];
  if (!words.length || !text) return [{ text, hit: false }];
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(re).filter((p) => p !== "").map((p) => ({ text: p, hit: words.includes(p.toLowerCase()) }));
}

/** The server marks matches in a search snippet with « and »; split it into parts. @param {string} snippet */
export function snippetParts(snippet) {
  const out = [];
  const re = /«([^«»]*)»/g;
  let at = 0;
  for (const m of String(snippet ?? "").matchAll(re)) {
    if ((m.index ?? 0) > at) out.push({ text: snippet.slice(at, m.index), hit: false });
    out.push({ text: m[1], hit: true });
    at = (m.index ?? 0) + m[0].length;
  }
  if (at < String(snippet ?? "").length) out.push({ text: snippet.slice(at), hit: false });
  return out.filter((p) => p.text);
}

/** What a file dropped from the computer becomes: a doc (Word, Markdown, web page, text), a zip of docs, or a kept file.
 *  @param {string} name @returns {"doc" | "zip" | "file" | "blocked"} */
export function dropKind(name) {
  const n = String(name ?? "").toLowerCase();
  if (/\.(exe|bat|cmd|msi|sh|ps1|js|mjs|jar|scr|com|vbs)$/.test(n)) return "blocked";
  if (/\.(md|markdown|txt|html?|docx)$/.test(n)) return "doc";
  if (n.endsWith(".zip")) return "zip";
  return "file";
}

/** Arrow keys over a grid of `columns` (1 for the list). @param {number} index @param {string} key @param {number} columns @param {number} count */
export function nextIndex(index, key, columns, count) {
  if (!count) return -1;
  const cols = Math.max(1, columns);
  const i = index < 0 ? 0 : index;
  const to = key === "ArrowRight" ? i + 1 : key === "ArrowLeft" ? i - 1 : key === "ArrowDown" ? i + cols : key === "ArrowUp" ? i - cols
    : key === "Home" ? 0 : key === "End" ? count - 1 : i;
  if (index < 0) return 0;
  return Math.min(count - 1, Math.max(0, to));
}

/** Who can see a doc, in words, given its own sharing and whether its folder is private.
 *  @param {"private" | "company" | "people"} access @param {number} people @param {string | null} privateFolder */
export function whoWords(access, people, privateFolder) {
  if (access === "private") return "Only you";
  if (access === "people") return people === 1 ? "1 person" : `${people} people`;
  return privateFolder ? `People in ${privateFolder}` : "Everyone";
}
