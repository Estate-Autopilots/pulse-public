"use client";
// DOCS-WORKBENCH: the Docs page. DOCS-MCP (8 Nov 2026): tags, cards, private folders and Import of a zip or folder.
// DOCS-DRIVE (owner, 8 Nov 2026: "make the UX like how we handle Drive … far better than Google Docs, and much nicer for
// folders, folders under folders, documents and so on"; Codex concepts A/B/C in reports/docs-drive/concepts):
//   * left: My Docs, Shared with me, Recent, Starred, Archived, then the folder tree (open and close, drag onto a folder
//     to move, right-click or ⋯ for its menu); a drawer on a phone;
//   * top: breadcrumbs (each one a drop target), search with filters, a grid or list view, the Details panel;
//   * the things: folder tiles with what they hold, doc cards with their type's icon and colour, files; or a list with
//     sortable columns (name, owner, last edited, who can see, tags);
//   * speed: New folder and rename in place (no browser prompt), Shift/Ctrl to pick many and a bar to move, tag, share or
//     archive them, drag docs onto folders, drop files and whole folders from the computer, Undo on every change, and
//     keys (arrows, Enter opens, Space picks, Del archives, F2 renames, ⌘K searches).
// DOCS-ACTIVITY (owner, 17 Nov 2026: "there is no last editor and no trail … whatever activity happened in a folder,
// that folder should pop up at the top"): Recent is the first view (/docs); every card, tile and row says who did what
// last (with their photo, an AI marker for AI and automation) and when; folders and docs are newest activity first
// everywhere (a folder takes the newest activity under it); Details shows the trail (lib/doc-activity.mjs words).
// The rules that need no screen are in lib/docs-drive.mjs (tested); the API is services/api/src/doc-drive.ts.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ChevronDown, ExternalLink, FileUp, FolderInput, FolderOpen, FolderPlus, FolderTree, FolderUp, Globe, Info, LayoutGrid, Link2, List, Lock, MoreHorizontal,
  Pencil, Plus, Search, Share2, Star, Tag, Upload, Users, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../orgs/client";
import { openFileViewer } from "../components/file-viewer";
import { canDropFolders, countWords, dropKind, highlight, pathTo, selectWith, snippetParts, sortRows, whoWords } from "../lib/docs-drive.mjs";
import { activityLine, folderLine, madeByAi, viaWords, whoWord } from "../lib/doc-activity.mjs";
import { AiBadge, Avatar, Tooltip } from "../kit";
import { DocsInbox, ReceiptsSetting } from "./inbox";
import { FolderAccess } from "./organize";
import { DetailsPanel, ago, type Picked } from "./drive/details";
import { Confirm, Dialog, FolderGlyph, MoveDialog, ShareDialog, TagDialog, TypeChip, TypeIcon, typeOf, type Role } from "./drive/parts";
import { NameField, Side, type DropProps, type Place } from "./drive/tree";
import css from "./drive/drive.module.css";

export type Who = { id: string; name: string; agent?: boolean; photoAt?: string | null };
export type Via = "ai" | "api" | "script" | null;
/** DOCS-ACTIVITY: what happened last, by whom (services/api/src/doc-activity.ts). */
export type ActivityItem = { at: string; kind: string; by: Who | null; via?: Via; viaLabel?: string | null; doc?: { id: string; title: string } | null; folder?: { id: string; name: string } | null };
export type DocSummary = { id: string; title: string; folderId: string | null; access: "private" | "company" | "people"; owner: string | null; updatedAt: string; updatedBy: string | null; snippet: string | null; archived: boolean;
  tags: string[]; category: string | null; preview: string; createdBy?: string;
  activity?: ActivityItem | null; editedBy?: Who | null; editedAt?: string | null; editVia?: Via; editViaLabel?: string | null; madeVia?: Via; madeViaLabel?: string | null; openedAt?: string | null };
export type Folder = { id: string; name: string; parentId: string | null; canEdit: boolean; docs: number; files?: number; createdBy?: string; access: "company" | "people"; canShare: boolean; people: { personId: string; name: string }[];
  activity?: ActivityItem | null };
export type DocFile = { id: string; name: string; mime: string; size: number; folderId: string | null; addedBy: string | null; addedAt: string; url: string };
export type DocsData = { docs: DocSummary[]; folders: Folder[]; files: DocFile[]; me: string; admin: boolean; templates: { key: string; label: string }[];
  tags: { tag: string; docs: number }[]; categories: { category: string; docs: number }[];
  starred?: { docs: string[]; folders: string[] }; owners?: { id: string; name: string }[]; archivedFolders?: { id: string; name: string; parentId: string | null; canEdit: boolean }[] };
export type Filters = { type: string | null; owner: string | null; from: string | null; to: string | null };

export const ACCESS_WORDS = { private: "Only you", company: "Everyone in the company", people: "Chosen people" } as const;
export const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
};
export const sizeWords = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
export function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// CONTRACTS-2 builds contracts on the doc shell; New ▾ → Contract opens its "New agreement" builder (FEATURE-AUDIT, 9 Nov
// 2026: it opened the Agreements list, one extra click). The builder says who may make agreements to anyone else.
const CONTRACT_NEW = "/contracts/new";
type Kind = "doc" | "folder" | "file";
type Key = `${Kind}:${string}`;
const keyOf = (kind: Kind, id: string) => `${kind}:${id}` as Key;
const parse = (k: Key) => { const i = k.indexOf(":"); return { kind: k.slice(0, i) as Kind, id: k.slice(i + 1) }; };
type MoveResult = { moved: { kind: Kind; id: string }[]; failed: { name: string; why: string }[]; to: { id: string | null; name: string; private: boolean }; needsConfirm: null | { message: string } };
type BulkResult = { done: { kind: Kind; id: string }[]; failed: { name: string; why: string }[] };
type Entry = { path: string; size: number; type: string; read: () => Promise<ArrayBuffer> };
type DialogState = null | { kind: "move" | "tag" | "share"; keys: Key[] } | { kind: "confirm"; title: string; body: string; yes: string; run: () => void } | { kind: "access"; folderId: string };
type Sort = { key: "name" | "owner" | "updated" | "activity" | "access" | "tags"; dir: "asc" | "desc" };
const EDIT_KINDS = new Set(["edited", "created", "imported", "restored", "enriched"]);

const ACCESS_ICON = { private: Lock, company: Globe, people: Users } as const;
const say = (tone: "success" | "error" | "info", title: string, message?: string, action?: { label: string; run: () => void }) =>
  notify({ id: tone === "error" ? "docs-drive-error" : "docs-drive", tone, title, ...(message ? { message } : {}), ...(action ? { action } : {}), timeout: action ? 9000 : tone === "error" ? 7000 : 3500 });
const why = (e: unknown) => e instanceof Error && e.message ? e.message : "That did not work. Try again.";
// Typing: a text box, not a checkbox (Esc after ticking an item's checkbox must still let go of the choice).
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName)
  || (t instanceof HTMLInputElement && !/^(checkbox|radio|button|submit|reset)$/.test(t.type)));

// The person's view (grid or list) and whether Details is open, kept in this browser; read as an external store, so the
// first paint matches the server's and nothing is set from an effect.
const PREF_EVENT = "pulse:docs-pref";
const subscribePrefs = (on: () => void) => { window.addEventListener(PREF_EVENT, on); window.addEventListener("storage", on); return () => { window.removeEventListener(PREF_EVENT, on); window.removeEventListener("storage", on); }; };
function usePref(key: string, fallback: string): [string, (v: string) => void] {
  const v = useSyncExternalStore(subscribePrefs, () => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }, () => fallback);
  return [v, (x: string) => { try { localStorage.setItem(key, x); } catch { /* private mode */ } window.dispatchEvent(new Event(PREF_EVENT)); }];
}
const subscribeWide = (on: () => void) => { const m = window.matchMedia("(min-width: 900px)"); m.addEventListener("change", on); return () => m.removeEventListener("change", on); };
const NO_KEYS: ReadonlySet<string> = new Set();

/** A card's preview line: the doc's opening words without its own title repeated in front. */
const previewOf = (d: { title: string; preview: string }) => {
  const t = d.preview.replace(/^#?\s*/, "").trim(), a = d.title.toLowerCase(), b = t.toLowerCase();
  let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++;
  // The body usually opens with the doc's own heading: drop it when it repeats the title (at a word's end).
  const cut = n >= Math.min(8, a.length) && (n === b.length || /\s/.test(b[n]) || /\s/.test(a[n - 1] ?? "")) ? n : 0;
  return t.slice(cut).replace(/^[\s:.·-]+/, "").slice(0, 200);
};
/** "5 min ago": read from the clock, so the server's and the browser's can differ by a minute (no hydration error for it). */
const Ago = ({ iso }: { iso: string }) => <time dateTime={iso} suppressHydrationWarning>{ago(iso)}</time>;
function Marked({ text, query }: { text: string; query: string }) {
  return <>{highlight(text, query).map((p, i) => p.hit ? <mark key={i} className={css.hit}>{p.text}</mark> : <span key={i}>{p.text}</span>)}</>;
}
function Snippet({ text }: { text: string }) {
  return <>{snippetParts(text).map((p, i) => p.hit ? <mark key={i} className={css.hit}>{p.text}</mark> : <span key={i}>{p.text}</span>)}</>;
}

/** Walk what was dropped from the computer: files, and folders with everything inside (paths keep the tree). */
async function droppedEntries(dt: DataTransfer): Promise<Entry[]> {
  const out: Entry[] = [];
  type FsEntry = { isFile: boolean; isDirectory: boolean; name: string; fullPath: string; file?: (ok: (f: File) => void, bad: (e: unknown) => void) => void;
    createReader?: () => { readEntries: (ok: (list: FsEntry[]) => void, bad: (e: unknown) => void) => void } };
  const fromFile = (f: File, path: string): Entry => ({ path, size: f.size, type: f.type, read: () => f.arrayBuffer() });
  const walk = async (e: FsEntry): Promise<void> => {
    if (out.length > 2000) return;
    if (e.isFile && e.file) { const f = await new Promise<File>((ok, bad) => e.file!(ok, bad)); out.push(fromFile(f, e.fullPath.replace(/^\/+/, ""))); return; }
    if (e.isDirectory && e.createReader) {
      const reader = e.createReader();
      for (;;) {
        const batch = await new Promise<FsEntry[]>((ok, bad) => reader.readEntries(ok, bad));
        if (!batch.length) break;
        for (const x of batch) await walk(x);
      }
    }
  };
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === "file");
  const entries = items.map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() ?? null);
  if (entries.length && entries.every(Boolean)) { for (const e of entries) await walk(e!); return out; }
  return Array.from(dt.files).map((f) => fromFile(f, f.name));
}

export function Workbench({ data, receipts, folder, query, archived, mine, tag, view, filters }: { data: DocsData; receipts?: { docReads: boolean; canChange: boolean } | null; folder: string | null; query: string; archived: boolean; mine: boolean; tag?: string | null;
  view?: "shared" | "recent" | "starred" | null; filters?: Filters }) {
  const router = useRouter();
  const f: Filters = filters ?? { type: null, owner: null, from: null, to: null };
  const folderId = folder && folder !== "root" ? folder : null;
  const here = data.folders.find((x) => x.id === folderId) ?? null;
  const searching = !!query || !!tag || !!f.type || !!f.owner || !!f.from || !!f.to;
  const place: Place = archived ? "archived" : view === "shared" ? "shared" : view === "recent" ? "recent" : view === "starred" ? "starred" : !folderId && !searching && !mine ? "home" : null;
  const starred = { docs: new Set(data.starred?.docs ?? []), folders: new Set(data.starred?.folders ?? []) };

  // ---------------------------------------------------------------- what is shown
  // Things just moved or archived leave the view at once; the next data from the server replaces the list.
  const [goneState, setGoneState] = useState<{ data: DocsData; keys: Set<string> }>({ data, keys: new Set() });
  const gone = goneState.data === data ? goneState.keys : NO_KEYS;
  const subfolders = (() => {
    if (searching) return [];
    if (archived) return (data.archivedFolders ?? []).map((x) => ({ ...x, access: "company" as const, docs: 0, files: 0, canShare: false, people: [] }));
    if (view === "starred") return data.folders.filter((x) => starred.folders.has(x.id));
    if (view === "shared") return data.folders.filter((x) => x.access === "people" && x.createdBy !== data.me && x.people.some((p) => p.personId === data.me) && !data.folders.some((y) => y.id === x.parentId && y.access === "people"));
    // Recent: the folders where something happened last (any depth), newest first (the API's order).
    if (view === "recent") return data.folders.filter((x) => x.activity).slice(0, 6);
    if (mine) return [];
    return data.folders.filter((x) => x.parentId === folderId);
  })();
  const childCount = (id: string) => data.folders.filter((x) => x.parentId === id).length;
  const folders = subfolders.filter((x) => !gone.has(keyOf("folder", x.id)));
  const docs = data.docs.filter((d) => !gone.has(keyOf("doc", d.id)));
  const files = data.files.filter((x) => !gone.has(keyOf("file", x.id)));

  // ---------------------------------------------------------------- layout, selection, menus
  const [layoutPref, setLayout] = usePref("pulse.docs.layout", "grid");
  const layout: "grid" | "list" = layoutPref === "list" ? "list" : "grid";
  // Details stays open between visits on a computer; on a phone it is a sheet opened each time.
  const wideScreen = useSyncExternalStore(subscribeWide, () => window.matchMedia("(min-width: 900px)").matches, () => true);
  const [detailsPref, setDetailsPref] = usePref("pulse.docs.details", "0");
  const [phoneDetails, setPhoneDetails] = useState(false);
  const details = wideScreen ? detailsPref === "1" : phoneDetails;
  const setDetails = (on: boolean) => { if (wideScreen) setDetailsPref(on ? "1" : "0"); else setPhoneDetails(on); };
  const [sort, setSort] = useState<Sort>({ key: "activity", dir: "desc" });
  const [sel, setSel] = useState<Set<Key>>(new Set());
  // On a phone the checkboxes wait behind "Select" (as in the phone's own Files app); a tap on a card still opens it.
  const [selecting, setSelecting] = useState(false);
  const [anchor, setAnchor] = useState<Key | null>(null);
  const [focusKey, setFocusKey] = useState<Key | null>(null);
  const [menu, setMenu] = useState<null | { key: Key; x: number; y: number; from?: "tree" }>(null);
  const [newMenu, setNewMenu] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [renaming, setRenamingState] = useState<null | { key: Key; where: "tree" | "main" }>(null);
  const setRenaming = (k: Key | null, where: "tree" | "main" = "main") => setRenamingState(k ? { key: k, where } : null);
  const [creating, setCreating] = useState<null | { parent: string | null; where: "tree" | "main" }>(null);
  const [drawer, setDrawer] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set(pathTo(data.folders, folderId).map((x) => x.id)));
  const [busy, setBusy] = useState<string | null>(null);
  const [upload, setUpload] = useState<null | { done: number; total: number; label: string }>(null);
  const [q, setQ] = useState(query);
  const searchRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const uploader = useRef<HTMLInputElement>(null), importer = useRef<HTMLInputElement>(null), folderPicker = useRef<HTMLInputElement>(null);
  // Another folder or search: start fresh (nothing picked, no menu), and open the tree down to where you are.
  const loc = `${folder}|${query}|${archived}|${view}|${tag}|${mine}`;
  const [seenLoc, setSeenLoc] = useState(loc);
  if (seenLoc !== loc) {
    setSeenLoc(loc); setSel(new Set()); setSelecting(false); setAnchor(null); setMenu(null); setRenamingState(null); setCreating(null); setQ(query);
    setOpen((o) => { const n = new Set(o); for (const p of pathTo(data.folders, folderId)) if (p.id !== folderId) n.add(p.id); return n; });
  }

  const rows = (() => {
    const all = [
      ...folders.map((x) => ({ key: keyOf("folder", x.id), kind: "folder" as const, name: x.name, owner: null, updatedAt: null, activityAt: "activity" in x ? x.activity?.at ?? null : null, access: x.access === "people" ? "people" : "company", tags: [] })),
      ...docs.map((d) => ({ key: keyOf("doc", d.id), kind: "doc" as const, name: d.title, owner: d.owner, updatedAt: d.updatedAt, activityAt: d.activity?.at ?? d.updatedAt, access: d.access, tags: d.tags })),
      ...files.map((x) => ({ key: keyOf("file", x.id), kind: "file" as const, name: x.name, owner: x.addedBy, updatedAt: x.addedAt, activityAt: x.addedAt, access: null, tags: [] })),
    ];
    // The server's order stands for a word search (best match first) and Recent (your own openings count there).
    return layout === "list" && !((query || view === "recent") && sort.key === "activity" && sort.dir === "desc") ? sortRows(all, sort.key, sort.dir) : all;
  })();
  const order = rows.map((r) => r.key as Key);

  const nameOf = (k: Key) => { const { kind, id } = parse(k); return kind === "doc" ? data.docs.find((d) => d.id === id)?.title : kind === "folder" ? data.folders.find((x) => x.id === id)?.name ?? data.archivedFolders?.find((x) => x.id === id)?.name : data.files.find((x) => x.id === id)?.name; };
  const parentOf = (k: Key): string | null => { const { kind, id } = parse(k); return kind === "doc" ? data.docs.find((d) => d.id === id)?.folderId ?? null : kind === "folder" ? data.folders.find((x) => x.id === id)?.parentId ?? null : data.files.find((x) => x.id === id)?.folderId ?? null; };
  const editable = (k: Key) => { const { kind, id } = parse(k); return kind === "folder" ? !!data.folders.find((x) => x.id === id)?.canEdit : kind === "doc"; };
  const things = (keys: Key[]) => keys.length === 1 ? `“${nameOf(keys[0]) ?? "it"}”` : `${keys.length} things`;
  const hide = (keys: Key[]) => setGoneState((g) => ({ data, keys: new Set([...(g.data === data ? g.keys : []), ...keys]) }));
  const refresh = () => router.refresh();

  // ---------------------------------------------------------------- actions (each says what happened, with Undo)
  async function move(keys: Key[], to: string | null, allowWider = false, quiet = false): Promise<void> {
    if (!keys.length) return;
    const from = new Map(keys.map((k) => [k, parentOf(k)]));
    try {
      const r = await post<MoveResult>("docs/move", { items: keys.map(parse), to, allowWider });
      if (r.needsConfirm) {
        setDialog({ kind: "confirm", title: "Let more people see it?", body: r.needsConfirm.message, yes: "Move it", run: () => { setDialog(null); void move(keys, to, true, quiet); } });
        return;
      }
      const moved = r.moved.map((m) => keyOf(m.kind, m.id)).filter((k) => from.get(k) !== to);
      if (to !== folderId || searching || view || archived) hide(moved.filter(() => !searching && !view));
      setSel(new Set());
      if (!quiet && moved.length) {
        say("success", `Moved ${things(moved)} to ${r.to.name}`, r.to.private ? `Only the people who can open ${r.to.name} see ${moved.length === 1 ? "it" : "them"} now.` : undefined,
          { label: "Undo", run: () => void undo(moved, from) });
      }
      if (r.failed.length) say("error", `${r.failed.length} could not move`, `${r.failed[0].name}: ${r.failed[0].why}`);
      if (to) setOpen((o) => new Set([...o, to]));
      refresh();
    } catch (e) { say("error", "Not moved", why(e)); }
  }
  async function undo(keys: Key[], from: Map<Key, string | null>) {
    const groups = new Map<string, Key[]>();
    for (const k of keys) { const g = from.get(k) ?? ""; groups.set(g, [...(groups.get(g) ?? []), k]); }
    try {
      for (const [to, ks] of groups) await post<MoveResult>("docs/move", { items: ks.map(parse), to: to || null, allowWider: true });
      say("info", "Moved back"); refresh();
    } catch (e) { say("error", "Could not move it back", why(e)); }
  }
  async function bulk(keys: Key[], action: "archive" | "restore" | "addTags" | "removeTags" | "share", extra: Record<string, unknown> = {}, quiet = false): Promise<BulkResult | null> {
    try {
      const r = await post<BulkResult>("docs/bulk", { items: keys.map(parse), action, ...extra });
      if (r.failed.length) say("error", `${r.failed.length} ${r.failed.length === 1 ? "was" : "were"} not changed`, `${r.failed[0].name}: ${r.failed[0].why}`);
      if (!quiet) refresh();
      return r;
    } catch (e) { say("error", "Not changed", why(e)); return null; }
  }
  async function archive(keys: Key[]) {
    const r = await bulk(keys, archived ? "restore" : "archive");
    if (!r?.done.length) return;
    const done = r.done.map((d) => keyOf(d.kind, d.id));
    hide(done); setSel(new Set());
    if (archived) say("success", `Restored ${things(done)}`, "It is back where it was.");
    else say("success", `Archived ${things(done)}`, "Find it under Archived.", { label: "Undo", run: () => void bulk(done, "restore").then(() => say("info", "Brought back")) });
  }
  async function addTag(keys: Key[], t: string) {
    const docsOnly = keys.filter((k) => k.startsWith("doc:"));
    const r = await bulk(docsOnly, "addTags", { tags: [t] });
    if (r?.done.length) say("success", `Tagged ${things(r.done.map((d) => keyOf(d.kind, d.id)))} “${t}”`, undefined, { label: "Undo", run: () => void bulk(r.done.map((d) => keyOf(d.kind, d.id)), "removeTags", { tags: [t] }) });
  }
  async function share(keys: Key[], s: { access: "private" | "company" | "people"; people: { personId: string; role: Role }[] }) {
    const docsOnly = keys.filter((k) => k.startsWith("doc:"));
    const r = await bulk(docsOnly, "share", s.access === "people" ? { access: "people", people: s.people } : { access: s.access });
    if (r?.done.length) say("success", `Shared ${things(r.done.map((d) => keyOf(d.kind, d.id)))}`, s.access === "private" ? "Only you see it now." : s.access === "company" ? (here ? `Everyone who can open ${here.name} sees it.` : "Everyone in the company sees it.") : `${s.people.length} ${s.people.length === 1 ? "person" : "people"} added.`);
  }
  async function star(kind: "doc" | "folder", id: string, on: boolean) {
    try { await post("docs/star", { kind, id, on }); say("success", on ? "Starred" : "Star taken off", on ? "Find it under Starred." : undefined); refresh(); } catch (e) { say("error", "Not starred", why(e)); }
  }
  async function rename(k: Key, name: string | null) {
    setRenaming(null);
    if (!name) return;
    const { kind, id } = parse(k);
    const old = nameOf(k);
    try {
      if (kind === "folder") await post(`docs/folders/${id}`, { name });
      else if (kind === "doc") await post(`docs/${id}`, { title: name });
      say("success", "Renamed", `“${old}” is now “${name}”.`, { label: "Undo", run: () => void (kind === "folder" ? post(`docs/folders/${id}`, { name: old }) : post(`docs/${id}`, { title: old })).then(refresh) });
      refresh();
    } catch (e) { say("error", "Not renamed", why(e)); }
  }
  async function createFolder(name: string | null) {
    const at = creating;
    setCreating(null);
    if (!name || !at) return;
    try {
      const r = await post<{ id: string }>("docs/folders", { name, parentId: at.parent });
      if (at.parent) setOpen((o) => new Set([...o, at.parent!]));
      say("success", `Made the folder “${name}”`, undefined, { label: "Open it", run: () => router.push(`/docs?folder=${r.id}`) });
      refresh();
    } catch (e) { say("error", "Folder not made", why(e)); }
  }
  async function newDoc(template?: string) {
    setNewMenu(false); setBusy("new");
    // A doc made inside a folder is seen by whoever can open the folder (Drive's rule); in My Docs it is yours alone.
    try { const r = await post<{ doc: { id: string } }>("docs", { folderId, ...(folderId ? { access: "company" } : {}), ...(template ? { template } : {}) }); router.push(`/docs/${r.doc.id}`); }
    catch (e) { say("error", "Doc not made", why(e)); setBusy(null); }
  }
  const startFolder = () => {
    setNewMenu(false);
    if (searching || view || archived || mine) { router.push("/docs?folder=root"); return; }
    setCreating({ parent: folderId, where: "main" });
  };

  // ---------------------------------------------------------------- bring in files and folders from the computer
  async function bringIn(list: Entry[], root: string | null = folderId) {
    if (!list.length) return;
    const into = root === folderId ? here : data.folders.find((x) => x.id === root) ?? null;
    const skipped: string[] = [];
    const expanded: Entry[] = [];
    for (const e of list) {
      const k = dropKind(e.path);
      if (k === "blocked") { skipped.push(`${e.path}: programs cannot be kept in Docs`); continue; }
      if (k !== "zip") { expanded.push(e); continue; }
      try {
        const JSZip = (await import("jszip")).default;
        const zip = await JSZip.loadAsync(await e.read());
        for (const z of Object.values(zip.files)) if (!z.dir && !z.name.includes("__MACOSX/") && !z.name.split("/").pop()?.startsWith(".")) {
          expanded.push({ path: z.name, size: (z as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0, type: "", read: () => z.async("arraybuffer") });
        }
      } catch { skipped.push(`${e.path}: the zip could not be opened`); }
    }
    const docsIn = expanded.filter((e) => dropKind(e.path) === "doc"), filesIn = expanded.filter((e) => dropKind(e.path) === "file");
    const total = docsIn.length + filesIn.length;
    if (!total) { say("error", "Nothing was added", skipped[0] ?? "Drop Word, Markdown, PDF, picture or zip files."); return; }
    setUpload({ done: 0, total, label: `Adding ${total} ${total === 1 ? "thing" : "things"}${into ? ` to ${into.name}` : ""}…` });
    let made = 0, added = 0, newFolders = 0;
    // Folders first, so docs and files land in the same tree they came from.
    const ids = new Map<string, string | null>([["", root]]);
    let known = data.folders.map((x) => ({ id: x.id, name: x.name, parentId: x.parentId }));
    const folderFor = async (path: string): Promise<string | null> => {
      const parts = path.split("/").slice(0, -1).filter(Boolean).slice(0, 8);
      let key = "", parent = root;
      for (const p of parts) {
        key += `/${p.toLowerCase()}`;
        if (ids.has(key)) { parent = ids.get(key)!; continue; }
        const found = known.find((x) => x.parentId === parent && x.name.toLowerCase() === p.toLowerCase());
        if (found) { parent = found.id; ids.set(key, parent); continue; }
        const r = await post<{ id: string; folders: { id: string; name: string; parentId: string | null }[] }>("docs/folders", { name: p.slice(0, 120), parentId: parent });
        known = r.folders; parent = r.id; ids.set(key, parent); newFolders++;
      }
      return parent;
    };
    try {
      for (const e of [...docsIn, ...filesIn]) await folderFor(e.path);
      // Docs: in batches through the tree import (a doc of the same name in that folder is updated, not copied).
      const access = root ? "company" : "private";
      for (let i = 0; i < docsIn.length; i += 20) {
        const batch = [];
        for (const e of docsIn.slice(i, i + 20)) {
          if (e.size > 5 * 1048576) { skipped.push(`${e.path}: bigger than 5 MB`); continue; }
          batch.push({ path: e.path, data: toBase64(await e.read()) });
        }
        if (batch.length) {
          const r = await post<{ created: number; updated: number; skipped: { path: string; why: string }[] }>("docs/import-tree", { folderId: root, items: batch, replace: true, access });
          made += r.created + r.updated; skipped.push(...r.skipped.map((s) => `${s.path}: ${s.why}`));
        }
        setUpload((u) => u && { ...u, done: Math.min(u.total, i + 20) });
      }
      for (const [n, e] of filesIn.entries()) {
        if (e.size > 10 * 1048576) skipped.push(`${e.path}: bigger than 10 MB`);
        else {
          const name = e.path.split("/").pop() ?? e.path;
          await post("docs/files", { name, mime: e.type || "application/octet-stream", data: toBase64(await e.read()), folderId: await folderFor(e.path) });
          added++;
        }
        setUpload((u) => u && { ...u, done: docsIn.length + n + 1 });
      }
      const parts = [made ? `${made} ${made === 1 ? "doc" : "docs"}` : "", added ? `${added} ${added === 1 ? "file" : "files"}` : "", newFolders ? `${newFolders} ${newFolders === 1 ? "folder" : "folders"}` : ""].filter(Boolean);
      say(skipped.length ? "info" : "success", parts.length ? `Added ${parts.join(", ")}` : "Nothing was added", skipped.length ? `${skipped.length} left out. ${skipped[0]}` : undefined);
    } catch (e) { say("error", "Adding stopped", `${why(e)} What was already added stays; drop the rest again (nothing is copied twice).`); }
    finally { setUpload(null); refresh(); }
  }
  const fromInput = (list: FileList | null) => list ? Array.from(list).map((x) => ({ path: (x as File & { webkitRelativePath?: string }).webkitRelativePath || x.name, size: x.size, type: x.type, read: () => x.arrayBuffer() })) : [];

  // ---------------------------------------------------------------- dragging (inside the page and from the computer)
  const dragKeys = useRef<Key[]>([]);
  const [dragging, setDragging] = useState<Set<Key>>(new Set());
  const [dropOn, setDropOn] = useState<string | null | undefined>(undefined);
  const [fileOver, setFileOver] = useState(false);
  const isFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files") && !dragKeys.current.length;
  const startDrag = (k: Key, e: DragEvent) => {
    const keys = sel.has(k) ? [...sel] : [k];
    dragKeys.current = keys; setDragging(new Set(keys));
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", keys.map((x) => nameOf(x)).join(", "));
  };
  const endDrag = () => { dragKeys.current = []; setDragging(new Set()); setDropOn(undefined); };
  const allowed = (target: string | null) => {
    const keys = dragKeys.current;
    if (!keys.length) return true; // files from the computer
    const fs = keys.filter((k) => k.startsWith("folder:")).map((k) => parse(k).id);
    if (!canDropFolders(data.folders, fs, target)) return false;
    return keys.some((k) => parentOf(k) !== target);
  };
  const dropInto = (target: string | null, e: DragEvent) => {
    setDropOn(undefined); setFileOver(false);
    const keys = dragKeys.current;
    endDrag();
    if (keys.length) { void move(keys, target); return; }
    // Files from the computer dropped on a folder (a tile, the tree, a breadcrumb) go into that folder.
    if (Array.from(e.dataTransfer.types).includes("Files") && !archived) void droppedEntries(e.dataTransfer).then((list) => bringIn(list, target));
  };
  const drop: DropProps = { target: dropOn, over: setDropOn, drop: dropInto, allowed, start: (k, e) => startDrag(k as Key, e) };

  // ---------------------------------------------------------------- keys
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      // ⌘K / Ctrl+K searches docs here; pressed again inside the search, the app-wide search opens as usual.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && document.activeElement !== searchRef.current) {
        e.preventDefault(); e.stopPropagation(); searchRef.current?.focus(); searchRef.current?.select(); return;
      }
      if (e.key === "/" && !typing(e.target)) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // Esc lets go of everything picked, wherever the focus is (not while typing, and not when Esc is closing a menu or a dialog).
  const picking = sel.size > 0;
  useEffect(() => {
    if (!picking) return;
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || typing(e.target) || document.querySelector("dialog[open], [role='menu']")) return;
      setSel(new Set());
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [picking]);
  useEffect(() => {
    if (!menu && !newMenu) return;
    const close = (e: Event) => { if (!(e.target instanceof Element && e.target.closest("[data-menu]"))) { setMenu(null); setNewMenu(false); } };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { setMenu(null); setNewMenu(false); } };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc); };
  }, [menu, newMenu]);
  const focusItem = (k: Key | undefined) => { if (!k) return; setFocusKey(k); areaRef.current?.querySelector<HTMLElement>(`[data-key="${k}"]`)?.focus(); };
  const openItem = (k: Key, newTab = false) => {
    const { kind, id } = parse(k);
    if (kind === "folder") { if (!archived) router.push(`/docs?folder=${id}`); return; }
    if (kind === "doc") { if (newTab) window.open(`/docs/${id}`, "_blank", "noopener"); else router.push(`/docs/${id}`); return; }
    const file = data.files.find((x) => x.id === id);
    if (file) openFileViewer({ url: file.url, name: file.name, mime: file.mime, size: file.size });
  };
  const pick = (k: Key, mods: { shift?: boolean; toggle?: boolean }) => {
    const r = selectWith(order, sel, anchor, k, mods);
    setSel(r.selected as Set<Key>); setAnchor(r.anchor as Key); setFocusKey(k);
    // The bar rises from the bottom: keep the item just picked in sight above it (items carry a scroll margin for it).
    // (scrollIntoView does not move this shell's page, so the window is scrolled by just what the bar would cover.)
    if (r.selected.has(k)) requestAnimationFrame(() => {
      const box = areaRef.current?.querySelector<HTMLElement>(`[data-key="${k}"]`)?.getBoundingClientRect();
      const room = innerHeight - (innerWidth < 900 ? 170 : 96);
      if (box && box.bottom > room) window.scrollBy({ top: Math.min(box.bottom - room, box.top - 80), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    });
  };
  function areaKeys(e: KeyboardEvent) {
    if (typing(e.target) || renaming || creating) return;
    const cur = focusKey && order.includes(focusKey) ? focusKey : null;
    const els = Array.from(areaRef.current?.querySelectorAll<HTMLElement>("[data-key]") ?? []);
    if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const i = cur ? els.findIndex((x) => x.dataset.key === cur) : -1;
      let next: HTMLElement | undefined;
      if (i < 0) next = els[0];
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") next = els[i + (e.key === "ArrowRight" ? 1 : -1)];
      else if (e.key === "Home" || e.key === "End") next = e.key === "Home" ? els[0] : els[els.length - 1];
      else {
        // Up and down go to the nearest item in the row above or below (folders and cards have different columns).
        const r = els[i].getBoundingClientRect(), cx = r.left + r.width / 2;
        const cands = els.filter((x) => { const b = x.getBoundingClientRect(); return e.key === "ArrowDown" ? b.top > r.top + 4 : b.top < r.top - 4; });
        const rowTop = e.key === "ArrowDown" ? Math.min(...cands.map((x) => x.getBoundingClientRect().top)) : Math.max(...cands.map((x) => x.getBoundingClientRect().top));
        next = cands.filter((x) => Math.abs(x.getBoundingClientRect().top - rowTop) < 4).sort((a, b) => Math.abs(a.getBoundingClientRect().left + a.getBoundingClientRect().width / 2 - cx) - Math.abs(b.getBoundingClientRect().left + b.getBoundingClientRect().width / 2 - cx))[0];
      }
      const k = next?.dataset.key as Key | undefined;
      if (k) { focusItem(k); if (e.shiftKey) pick(k, { shift: true }); }
      return;
    }
    if (e.key === "Escape") { setSel(new Set()); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSel(new Set(order)); return; }
    if (!cur) return;
    if (e.key === "Enter") { e.preventDefault(); openItem(cur, e.metaKey || e.ctrlKey); }
    else if (e.key === " ") { e.preventDefault(); pick(cur, { toggle: true }); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); void archive(sel.size ? [...sel] : [cur]); }
    else if (e.key === "F2" && editable(cur)) { e.preventDefault(); setRenaming(cur); }
    else if (e.key === "i" && !e.metaKey && !e.ctrlKey) setDetails(!details);
    else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); const r = (e.target as HTMLElement).getBoundingClientRect(); setMenu({ key: cur, x: r.left + 20, y: r.top + 20 }); }
  }
  // FIX-DOCS-WORK (owner walkthrough, 10 Nov 2026: "a single click doesn't open a doc; double-click shows a weird double
  // ring; something stays selected I never selected"): one click on a card, tile or row opens it, on every screen; only
  // its checkbox picks it (Shift or Ctrl/⌘ click still pick, as in a file manager). Double-click does nothing extra: rename
  // is in the ⋯ menu and F2, so a name never turns into an edit box by surprise.
  const itemMouse = (k: Key) => ({
    onClick: (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("button, input, label")) return;
      if (e.shiftKey || e.metaKey || e.ctrlKey) { e.preventDefault(); pick(k, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey }); return; }
      if (t.closest("a")) return; // the name is a real link: it opens by itself (and middle-click opens a new tab)
      openItem(k);
    },
    // Right-click opens the menu for this thing (or for everything picked, when it is one of them); it picks nothing, so
    // nothing stays chosen after the menu closes.
    onContextMenu: (e: MouseEvent) => { e.preventDefault(); setFocusKey(k); setMenu({ key: k, x: e.clientX, y: e.clientY }); },
    onFocus: () => setFocusKey(k),
    draggable: !archived && !renaming,
    onDragStart: (e: DragEvent) => startDrag(k, e),
    onDragEnd: endDrag,
  });
  // A name link: a plain click opens (the browser follows it); Shift or Ctrl/⌘ click picks instead, like the rest of the card.
  const linkClick = (e: MouseEvent) => { if (e.shiftKey || e.metaKey || e.ctrlKey) e.preventDefault(); };

  // ---------------------------------------------------------------- the details panel follows the focused or only chosen thing
  const pickedKey = sel.size === 1 ? [...sel][0] : focusKey && order.includes(focusKey) ? focusKey : null;
  const picked: Picked | null = (() => {
    if (!pickedKey) return null;
    const { kind, id } = parse(pickedKey);
    if (kind === "doc") { const d = data.docs.find((x) => x.id === id); return d ? { kind, id, title: d.title } : null; }
    if (kind === "folder") { const x = data.folders.find((y) => y.id === id); return x ? { kind, id, name: x.name, access: x.access, docs: x.docs, files: x.files ?? 0, folders: childCount(id), people: x.people, canShare: x.canShare } : null; }
    const x = data.files.find((y) => y.id === id); return x ? { kind, id, name: x.name, mime: x.mime, size: x.size, url: x.url, addedBy: x.addedBy, addedAt: x.addedAt } : null;
  })();

  // ---------------------------------------------------------------- search and filters
  const params = (over: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const base: Record<string, string | null> = { q: query || null, tag: tag ?? null, category: f.type, owner: f.owner, from: f.from, to: f.to, folder: searching ? folder : null };
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/docs?${s}` : "/docs";
  };
  const submitSearch = (e: React.FormEvent) => { e.preventDefault(); router.push(q.trim() ? params({ q: q.trim(), folder: folderId ?? (searching ? folder : null) }) : folderId ? `/docs?folder=${folderId}` : "/docs"); };

  // ---------------------------------------------------------------- words
  const crumbs = pathTo(data.folders, folderId) as Folder[];
  const title = query ? `Results for “${query}”` : tag ? `Tagged “${tag}”` : searching ? "Search results" : archived ? "Archived" : view === "shared" ? "Shared with me" : view === "recent" ? "Recent"
    : view === "starred" ? "Starred" : mine ? "Made by you" : here ? here.name : "My Docs";
  const privateAbove = [...crumbs].reverse().find((x) => x.access === "people")?.name ?? null;
  const total = rows.length;
  const selDocs = [...sel].filter((k) => k.startsWith("doc:")).length;

  const menuFor = (k: Key) => {
    const { kind, id } = parse(k);
    const many = sel.size > 1 && sel.has(k);
    const keys = many ? [...sel] : [k];
    const isStar = kind === "doc" ? starred.docs.has(id) : kind === "folder" ? starred.folders.has(id) : false;
    const fo = kind === "folder" ? data.folders.find((x) => x.id === id) : null;
    const item = (icon: ReactNode, label: string, run: () => void, danger = false) => <button type="button" role="menuitem" className={danger ? css.danger : undefined} onClick={() => { setMenu(null); run(); }}>{icon}{label}</button>;
    return <div className={css.menu} data-menu="" data-at="point" role="menu" aria-label={`Actions for ${things(keys)}`}
      style={{ left: Math.min(menu?.x ?? 0, (typeof window !== "undefined" ? window.innerWidth : 1200) - 250), top: Math.min(menu?.y ?? 0, (typeof window !== "undefined" ? window.innerHeight : 800) - 380) }}>
      {many ? <p className={css.menuNote}>{keys.length} chosen</p> : <>
        {item(kind === "folder" ? <FolderOpen size={16} aria-hidden="true" /> : <ExternalLink size={16} aria-hidden="true" />, "Open", () => openItem(k))}
        {kind === "doc" ? item(<ExternalLink size={16} aria-hidden="true" />, "Open in a new tab", () => openItem(k, true)) : null}
        {editable(k) && !archived ? item(<Pencil size={16} aria-hidden="true" />, "Rename", () => setRenaming(k, menu?.from === "tree" || !order.includes(k) ? "tree" : "main")) : null}
      </>}
      {!archived ? item(<FolderInput size={16} aria-hidden="true" />, "Move to…", () => setDialog({ kind: "move", keys })) : null}
      {!many && kind !== "file" && !archived ? item(<Star size={16} aria-hidden="true" />, isStar ? "Take the star off" : "Star it", () => void star(kind, id, !isStar)) : null}
      {kind === "doc" && !archived ? item(<Tag size={16} aria-hidden="true" />, "Add a tag", () => setDialog({ kind: "tag", keys })) : null}
      {kind === "doc" && !archived ? item(<Share2 size={16} aria-hidden="true" />, "Share", () => setDialog({ kind: "share", keys })) : null}
      {fo?.canShare && !many ? item(<Users size={16} aria-hidden="true" />, "Who can see", () => setDialog({ kind: "access", folderId: id })) : null}
      {!many && kind !== "file" && !archived ? item(<Link2 size={16} aria-hidden="true" />, "Copy link", () => void navigator.clipboard.writeText(`${window.location.origin}${kind === "doc" ? `/docs/${id}` : `/docs?folder=${id}`}`)
        .then(() => say("success", "Link copied", "It opens for people who can already see it. Share it first to let others in."), () => say("error", "Could not copy the link"))) : null}
      {kind === "folder" && !many && !archived && fo?.canEdit !== false ? item(<FolderPlus size={16} aria-hidden="true" />, "New folder inside", () => { setOpen((o) => new Set([...o, id])); setCreating({ parent: id, where: "tree" }); }) : null}
      {!many ? item(<Info size={16} aria-hidden="true" />, "Details", () => { setFocusKey(k); if (sel.size === 1 && !sel.has(k)) setSel(new Set()); setDetails(true); }) : null}
      <hr />
      {item(archived ? <ArchiveRestore size={16} aria-hidden="true" /> : <Archive size={16} aria-hidden="true" />, archived ? "Restore" : "Archive", () => void archive(keys), !archived)}
    </div>;
  };
  const treeMenu = (id: string, x: number, y: number) => { setMenu({ key: keyOf("folder", id), x, y, from: "tree" }); };

  // ---------------------------------------------------------------- pieces
  // DOCS-ACTIVITY: who did what last, with their photo (an AI employee's own marker), and when. In Recent, your own
  // opening of a doc is what put it there, so it says so when it is newer than anything else.
  const face = (who: Who | null | undefined, size = 18) => who ? <Avatar ai={!!who.agent} name={who.name} id={who.id} photoAt={who.photoAt ?? null} size={size} /> : null;
  const aiMark = (via: Via | undefined, label: string | null | undefined) => via === "ai" || via === "script"
    ? <Tooltip content={via === "ai" ? "Made by an AI employee" : `Made by automation${label ? ` (${label})` : ""}`}><span className={css.aiMark}><AiBadge /></span></Tooltip> : null;
  const lastOf = (d: DocSummary): { line: string; at: string; who: Who | null; via: Via | undefined; viaLabel: string | null | undefined } => {
    const a = d.activity;
    if (view === "recent" && d.openedAt && (!a || Date.parse(d.openedAt) > Date.parse(a.at))) return { line: "You opened it", at: d.openedAt, who: null, via: null, viaLabel: null };
    return a ? { line: activityLine(a, data.me), at: a.at, who: a.by, via: a.via, viaLabel: a.viaLabel } : { line: `${d.updatedBy ?? d.owner ?? "Someone"} edited`, at: d.updatedAt, who: null, via: null, viaLabel: null };
  };
  const activityTitle = (line: string, at: string, via: Via | undefined, label: string | null | undefined) => `${line}, ${when(at)}${viaWords(via ?? null, label) ? ` (${viaWords(via ?? null, label)})` : ""}`;
  const itemState = (k: Key) => ({ "data-selected": sel.has(k) ? "1" : undefined, "data-key": k, tabIndex: (focusKey ?? order[0]) === k ? 0 : -1, "data-dragging": dragging.has(k) ? "1" : undefined });
  const folderDrop = (id: string) => ({
    "data-drop": dropOn === id ? "1" : undefined,
    onDragOver: (e: DragEvent) => {
      if (isFiles(e) ? archived : dragging.has(keyOf("folder", id)) || !allowed(id)) return;
      e.preventDefault(); e.stopPropagation(); setDropOn(id); setFileOver(false);
    },
    onDragLeave: () => setDropOn(undefined),
    onDrop: (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); dropInto(id, e); },
  });
  // The checkbox and ⋯ sit together in the item's own corner (never on top of its icon); the checkbox has a 32px target.
  const check = (k: Key, label: string) => <label className={css.check} title="Select" onClick={(e) => e.stopPropagation()}>
    <input type="checkbox" checked={sel.has(k)} aria-label={`Choose ${label}`} tabIndex={-1} onChange={() => pick(k, { toggle: true })} /></label>;
  const moreBtn = (k: Key, label: string) => <button type="button" className={`${css.btn} ${css.icon} ${css.quiet} ${css.small} ${css.itemMore}`} aria-label={`More for ${label}`} tabIndex={-1}
    onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setFocusKey(k); setMenu({ key: k, x: r.left - 200, y: r.bottom + 4 }); }}><MoreHorizontal size={16} aria-hidden="true" /></button>;
  const corner = (k: Key, label: string) => <span className={css.corner}>{check(k, label)}{moreBtn(k, label)}</span>;
  const folderTile = (x: Folder | (typeof subfolders)[number]) => {
    const k = keyOf("folder", x.id);
    const n = { docs: x.docs, folders: childCount(x.id), files: x.files ?? 0 };
    return <li key={x.id} className={`${css.item} ${css.folderTile}`} {...itemState(k)} {...itemMouse(k)} {...folderDrop(x.id)} aria-label={`Folder ${x.name}, ${countWords(n)}`}>
      <FolderGlyph size={30} />
      <span className={css.tileText}>
        {renaming?.where === "main" && renaming.key === k ? <NameField value={x.name} label="Folder name" onDone={(v) => void rename(k, v)} onCancel={() => setRenaming(null)} />
          : archived ? <span className={css.tileName}>{x.name}</span> : <Link href={`/docs?folder=${x.id}`} className={css.tileName} onClick={linkClick} draggable={false}>{x.name}</Link>}
        <span className={css.tileSub}>{view === "recent" && x.parentId ? <>in {pathTo(data.folders, x.parentId).map((p) => p.name).join(" / ")} · </> : null}{countWords(n)}{x.access === "people" ? <> · <Lock size={11} aria-label="Private folder" /> private</> : null}{starred.folders.has(x.id) ? <> · <Star size={11} className={css.starOn} fill="currentColor" aria-label="Starred" /></> : null}</span>
        {"activity" in x && x.activity ? <span className={css.tileAct} title={activityTitle(folderLine(x.activity, data.me), x.activity.at, x.activity.via, x.activity.viaLabel)}>
          {face(x.activity.by, 16)}<span className={css.footText}>{folderLine(x.activity, data.me)}</span><span className={css.footWhen}>· <Ago iso={x.activity.at} /></span></span> : null}
      </span>
      {corner(k, x.name)}
    </li>;
  };
  const newFolderTile = creating?.where === "main" ? <li className={`${css.item} ${css.folderTile}`} aria-label="New folder"><FolderGlyph size={30} />
    <span className={css.tileText}><NameField fresh value="Untitled folder" label="New folder name" onDone={(v) => void createFolder(v)} onCancel={() => setCreating(null)} /><span className={css.tileSub}>Enter to keep · Esc to cancel</span></span></li> : null;
  const docCard = (d: DocSummary) => {
    const k = keyOf("doc", d.id), t = typeOf(d.category), A = ACCESS_ICON[d.access];
    return <li key={d.id} className={`${css.item} ${css.card}`} {...itemState(k)} {...itemMouse(k)} aria-label={`${d.title}, ${typeOf(d.category)}`}>
      <div className={css.cardTop}><TypeIcon type={t} />{t !== "doc" ? <TypeChip type={t} /> : null}{madeByAi(d) ? aiMark(d.madeVia, d.madeViaLabel) : null}{starred.docs.has(d.id) ? <Star size={14} className={css.starOn} fill="currentColor" aria-label="Starred" /> : null}</div>
      {corner(k, d.title)}
      <h3 className={css.cardTitle}>{renaming?.where === "main" && renaming.key === k ? <NameField value={d.title} label="Doc name" onDone={(v) => void rename(k, v)} onCancel={() => setRenaming(null)} />
        : <Link href={`/docs/${d.id}`} onClick={linkClick} draggable={false}><Marked text={d.title} query={query} /></Link>}</h3>
      {d.snippet ? <p className={css.cardText}><Snippet text={d.snippet} /></p> : previewOf(d) ? <p className={css.cardText}>{previewOf(d)}</p> : null}
      {d.tags.length ? <ul className={css.tags}>{d.tags.slice(0, 4).map((x) => <li key={x} className={css.tag}><Marked text={x} query={query || tag || ""} /></li>)}</ul> : null}
      {(() => { const l = lastOf(d), edit = d.editedBy && d.activity && !EDIT_KINDS.has(d.activity.kind) && l.line !== "You opened it" ? d.editedBy : null;
        return <>{edit || l.line === "You opened it" ? <p className={css.cardEdit}>{face(d.editedBy ?? d.activity?.by, 14)}<span className={css.footText}>Last edit: {d.editedBy ? whoWord(d.editedBy, data.me) : d.updatedBy ?? "someone"}</span>
          <span className={css.footWhen}>· <Ago iso={d.editedAt ?? d.updatedAt} /></span></p> : null}
          <div className={css.cardFoot}><span title={activityTitle(l.line, l.at, l.via, l.viaLabel)}>{face(l.who)}<span className={css.footText}>{l.line}</span><span className={css.footWhen}>· <Ago iso={l.at} /></span></span>
            <span className={css.footAccess}><A size={13} aria-hidden="true" />{whoWords(d.access, 0, d.access === "company" ? privateAbove : null).replace(/^0 people$/, "Chosen people")}</span></div></>; })()}
    </li>;
  };
  const fileCard = (x: DocFile) => {
    const k = keyOf("file", x.id);
    return <li key={x.id} className={`${css.item} ${css.folderTile} ${css.fileTile}`} {...itemState(k)} {...itemMouse(k)} aria-label={`File ${x.name}`}>
      <span className={css.typeIcon} style={{ ["--t" as string]: "#5a6b85" }} aria-hidden="true"><FileUp size={16} /></span>
      <span className={css.tileText}><span className={css.tileName}><Marked text={x.name} query={query} /></span><span className={css.tileSub}><Ago iso={x.addedAt} /> · {sizeWords(x.size)}</span></span>
      {corner(k, x.name)}
    </li>;
  };
  const sortHead = (key: Sort["key"], label: string, wide = false) => <th scope="col" className={wide ? css.wide : undefined} aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
    <button type="button" onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : s.key === key ? "asc" : key === "updated" || key === "activity" ? "desc" : "asc" }))}>
      {label}{sort.key === key ? sort.dir === "asc" ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" /> : null}</button></th>;
  const anyTags = docs.some((d) => d.tags.length > 0);
  const listView = <table className={css.table} aria-label={title}>
    <thead><tr><th scope="col" className={css.boxCell}><label className={css.rowCheck}><input type="checkbox" aria-label="Choose all" checked={sel.size > 0 && sel.size === order.length} onChange={(e) => setSel(e.target.checked ? new Set(order) : new Set())} /></label></th>
      {sortHead("name", "Name")}{sortHead("activity", "Last activity")}{sortHead("owner", "Owner", true)}{sortHead("access", "Who can see", true)}{anyTags ? sortHead("tags", "Tags", true) : null}</tr></thead>
    <tbody>
      {creating?.where === "main" ? <tr className={css.item}><td /><td colSpan={anyTags ? 5 : 4}><span className={css.nameCell}><FolderGlyph size={20} /><NameField fresh value="Untitled folder" label="New folder name" onDone={(v) => void createFolder(v)} onCancel={() => setCreating(null)} /></span></td></tr> : null}
      {rows.map((r) => {
        const k = r.key as Key, { kind, id } = parse(k);
        const d = kind === "doc" ? docs.find((x) => x.id === id) : undefined, fo = kind === "folder" ? folders.find((x) => x.id === id) : undefined, fi = kind === "file" ? files.find((x) => x.id === id) : undefined;
        const A = d ? ACCESS_ICON[d.access] : fo?.access === "people" ? Lock : Globe;
        return <tr key={k} className={css.item} aria-selected={sel.has(k)} {...itemState(k)} {...itemMouse(k)} {...(fo ? folderDrop(fo.id) : {})}>
          <td className={css.boxCell} onClick={(e) => e.stopPropagation()}><label className={css.rowCheck}><input type="checkbox" checked={sel.has(k)} aria-label={`Choose ${r.name}`} tabIndex={-1} onChange={() => pick(k, { toggle: true })} /></label></td>
          <td><span className={css.nameCell}>{fo ? <span className={css.typeIcon} style={{ ["--t" as string]: "#c99a1e" }} aria-hidden="true"><FolderGlyph size={16} /></span> : d ? <TypeIcon type={typeOf(d.category)} size={15} /> : <span className={css.typeIcon} style={{ ["--t" as string]: "#5a6b85" }} aria-hidden="true"><FileUp size={15} /></span>}
            {renaming?.where === "main" && renaming.key === k ? <NameField value={r.name} label="Name" onDone={(v) => void rename(k, v)} onCancel={() => setRenaming(null)} />
              : fi || (fo && archived) ? <span className={css.rowName}><Marked text={r.name} query={query} /></span>
                : <Link href={fo ? `/docs?folder=${id}` : `/docs/${id}`} onClick={linkClick} draggable={false}><Marked text={r.name} query={query} /></Link>}
            {(d && starred.docs.has(id)) || (fo && starred.folders.has(id)) ? <Star size={13} className={css.starOn} fill="currentColor" aria-label="Starred" /> : null}</span>
            {d?.snippet ? <span className={css.tileSub}><Snippet text={d.snippet} /></span> : null}</td>
          <td className={css.actCell}>{d ? (() => { const l = lastOf(d); return <span className={css.rowAct} title={activityTitle(l.line, l.at, l.via, l.viaLabel)}>{face(l.who)}<span className={css.footText}>{l.line}</span><span className={css.footWhen}><Ago iso={l.at} /></span></span>; })()
            : fo && "activity" in fo && fo.activity ? <span className={css.rowAct} title={activityTitle(folderLine(fo.activity, data.me), fo.activity.at, fo.activity.via, fo.activity.viaLabel)}>{face(fo.activity.by)}<span className={css.footText}>{folderLine(fo.activity, data.me)}</span><span className={css.footWhen}><Ago iso={fo.activity.at} /></span></span>
            : fi ? <span className={css.rowAct}><span className={css.footText}>{fi.addedBy ? `${fi.addedBy} added it` : "Added"}</span><span className={css.footWhen}><Ago iso={fi.addedAt} /></span></span> : "—"}</td>
          <td className={`${css.wide} ${css.muted}`}>{d?.owner ?? fi?.addedBy ?? (fo ? data.owners?.find((o) => "createdBy" in fo && o.id === fo.createdBy)?.name ?? "—" : "—")}</td>
          <td className={css.wide}>{fi ? (() => { const pf = data.folders.find((x) => x.id === fi.folderId); return pf?.access === "people" ? <span className={css.who}><Lock size={12} aria-hidden="true" />{pf.name}&apos;s people</span> : <span className={css.who}><Globe size={12} aria-hidden="true" />Everyone</span>; })() : null}{d || fo ? <span className={css.who}><A size={12} aria-hidden="true" />{d ? whoWords(d.access, 0, d.access === "company" ? privateAbove : null).replace(/^0 people$/, "Chosen people") : fo?.access === "people" ? "Private" : "Everyone"}</span> : null}</td>
          {anyTags ? <td className={css.wide}>{d?.tags.length ? <ul className={css.tags}>{d.tags.slice(0, 3).map((t) => <li key={t} className={css.tag}>{t}</li>)}</ul> : null}</td> : null}
        </tr>;
      })}
    </tbody>
  </table>;

  const empty = (() => {
    const art = (icon: ReactNode) => <span className={css.emptyArt}>{icon}</span>;
    if (searching) return <div className={css.empty}>{art(<Search size={30} aria-hidden="true" />)}<h2>Nothing matches{query ? ` “${query}”` : " these filters"}</h2>
      <p>Try fewer or different words, or clear the filters.</p><Link className={`${css.btn} ${css.primary}`} href={query ? `/docs?q=${encodeURIComponent(query)}` : "/docs"}>Clear the filters</Link></div>;
    if (archived) return <div className={css.empty}>{art(<Archive size={30} aria-hidden="true" />)}<h2>Nothing archived</h2><p>Archived docs and folders wait here. Nothing is ever deleted.</p><Link className={css.btn} href="/docs?folder=root">Back to My Docs</Link></div>;
    if (view === "shared") return <div className={css.empty}>{art(<Users size={30} aria-hidden="true" />)}<h2>Nothing shared with you yet</h2><p>When someone shares a doc or a private folder with you, it shows here.</p><Link className={css.btn} href="/docs?folder=root">Go to My Docs</Link></div>;
    if (view === "recent") return <div className={css.empty}>{art(<FileUp size={30} aria-hidden="true" />)}<h2>Nothing here yet</h2><p>Docs you and your team make, change, comment on or open show here, newest first.</p>
      <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => void newDoc()} disabled={busy === "new"}><Plus size={16} aria-hidden="true" />{busy === "new" ? "Opening…" : "New doc"}</button></div>;
    if (view === "starred") return <div className={css.empty}>{art(<Star size={30} aria-hidden="true" />)}<h2>No stars yet</h2><p>Right-click a doc or folder and press Star it. It then waits here.</p><Link className={css.btn} href="/docs?folder=root">Go to My Docs</Link></div>;
    return <div className={css.empty}>{art(<FolderOpen size={30} aria-hidden="true" />)}<h2>{here ? `“${here.name}” is empty` : "Your docs live here"}</h2>
      <p>{here ? "Make the first doc, or drop files and folders from your computer onto this page." : "Make a doc or a folder, or drop files and whole folders from your computer onto this page."}</p>
      <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => void newDoc()} disabled={busy === "new"}><Plus size={16} aria-hidden="true" />{busy === "new" ? "Opening…" : "New doc"}</button></div>;
  })();

  const newItem = (icon: ReactNode, label: string, run: () => void) => <button type="button" role="menuitem" onClick={() => { setNewMenu(false); run(); }}>{icon}{label}</button>;
  const tpl = (key: string) => data.templates.some((t) => t.key === key) ? key : undefined;
  const others = data.templates.filter((t) => !["meeting", "sop", "client_offer"].includes(t.key));

  return <div className={css.shell} data-details={details ? "1" : undefined}>
    <Side folders={data.folders.map((x) => ({ ...x, files: x.files ?? 0 }))} current={folderId} place={place} open={open}
      toggle={(id, on) => setOpen((o) => { const n = new Set(o); if (on ?? !n.has(id)) n.add(id); else n.delete(id); return n; })}
      drop={drop} renaming={renaming?.where === "tree" ? parse(renaming.key).id : null} onRename={(id, name) => name === "" ? setRenaming(keyOf("folder", id), "tree") : void rename(keyOf("folder", id), name)}
      creatingIn={creating?.where === "tree" ? creating.parent : undefined} onCreate={(name) => void createFolder(name)} onMenu={treeMenu} drawer={drawer} onDrawer={setDrawer}
      extra={<><button type="button" className={css.place} onClick={() => { setDrawer(false); setCreating({ parent: null, where: "tree" }); }}><FolderPlus size={17} aria-hidden="true" />New folder</button>
        {receipts ? <ReceiptsSetting initial={receipts} /> : null}</>} />

    {/* LAND-CAPTAIN-12 (hosted CI page matrix): the shell already has the page's one <main>; a second one inside it is
        invalid and broke every check that finds the page by its main. A labelled section, so Docs is still a landmark. */}
    <section className={css.main} aria-label="Docs"
      onDragOver={(e) => { if (isFiles(e) && !archived) { e.preventDefault(); setFileOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setFileOver(false); }}
      onDrop={(e) => { if (isFiles(e) && !archived) { e.preventDefault(); setFileOver(false); void droppedEntries(e.dataTransfer).then(bringIn); } }}>
      <div className={css.top}>
        <button type="button" className={`${css.btn} ${css.icon} ${css.drawerBtn}`} onClick={() => setDrawer(true)} aria-label="Open folders" title="Folders"><FolderTree size={18} aria-hidden="true" /><span className={css.phoneWord}>Folders</span></button>
        <form role="search" className={css.searchBox} onSubmit={submitSearch}>
          <Search size={16} aria-hidden="true" />
          <input ref={searchRef} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search docs" />
          <span className={css.kbd} aria-hidden="true">⌘K</span>
        </form>
        <div className={css.menuWrap} data-menu="">
          <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => setNewMenu((m) => !m)} aria-expanded={newMenu} aria-haspopup="menu" disabled={busy === "new" || !!upload}>
            <Plus size={17} aria-hidden="true" />{busy === "new" ? "Opening…" : <><span className={css.wideOnly}>New</span><span className={css.phoneWord2}>New doc</span></>}<ChevronDown size={14} aria-hidden="true" /></button>
          {newMenu ? <div className={css.menu} role="menu" aria-label="New">
            {newItem(<TypeIcon type="doc" />, "Doc", () => void newDoc())}
            {newItem(<span className={css.typeIcon} style={{ ["--t" as string]: "#c99a1e" }} aria-hidden="true"><FolderPlus size={16} /></span>, "Folder", startFolder)}
            {newItem(<TypeIcon type="contract" />, "Contract", () => router.push(CONTRACT_NEW))}
            {tpl("meeting") ? newItem(<TypeIcon type="meeting" />, "Meeting notes", () => void newDoc("meeting")) : null}
            {tpl("sop") ? newItem(<TypeIcon type="sop" />, "SOP", () => void newDoc("sop")) : null}
            {tpl("client_offer") ? newItem(<TypeIcon type="offer" />, "Offer", () => void newDoc("client_offer")) : null}
            <hr />
            <button type="button" role="menuitem" onClick={() => { setNewMenu(false); uploader.current?.click(); }}><span className={css.typeIcon} style={{ ["--t" as string]: "#5a6b85" }} aria-hidden="true"><Upload size={16} /></span>Upload files (PDF, pictures…)</button>
            <button type="button" role="menuitem" onClick={() => { setNewMenu(false); importer.current?.click(); }}><span className={css.typeIcon} style={{ ["--t" as string]: "#5a6b85" }} aria-hidden="true"><FileUp size={16} /></span>Import Word, Markdown or a zip</button>
            <button type="button" role="menuitem" onClick={() => { setNewMenu(false); folderPicker.current?.click(); }}><span className={css.typeIcon} style={{ ["--t" as string]: "#5a6b85" }} aria-hidden="true"><FolderUp size={16} /></span>Import a whole folder</button>
            {others.length ? <><hr /><p className={css.menuNote}>More templates</p>{others.map((t) => <button key={t.key} type="button" role="menuitem" onClick={() => void newDoc(t.key)}><TypeIcon type={typeOf(t.label)} />{t.label}</button>)}</> : null}
            <p className={css.menuNote}>{folderId ? `New docs here are seen by everyone who can open “${here?.name ?? "this folder"}”.` : "New docs in My Docs are yours alone until you share them."}</p>
          </div> : null}
          <input ref={uploader} type="file" multiple hidden onChange={(e) => { const l = fromInput(e.target.files); e.target.value = ""; void bringIn(l); }} />
          <input ref={importer} type="file" multiple accept=".md,.markdown,.txt,.html,.htm,.docx,.zip" hidden onChange={(e) => { const l = fromInput(e.target.files); e.target.value = ""; void bringIn(l); }} />
          <input ref={(el) => { folderPicker.current = el; el?.setAttribute("webkitdirectory", ""); }} type="file" multiple hidden onChange={(e) => { const l = fromInput(e.target.files); e.target.value = ""; void bringIn(l); }} />
        </div>
      </div>

      <div className={css.titleRow}>
        <nav className={css.crumbs} aria-label="Where you are">
          {crumbs.length || searching || place !== "home" ? <Link href="/docs?folder=root" data-up={crumbs.length <= 1 ? "1" : undefined} data-drop={dropOn === null ? "1" : undefined}
            onDragOver={(e) => { if (dragKeys.current.length && allowed(null)) { e.preventDefault(); setDropOn(null); } }} onDragLeave={() => setDropOn(undefined)}
            onDrop={(e) => { if (dragKeys.current.length) { e.preventDefault(); dropInto(null, e); } }}>My Docs</Link> : null}
          {crumbs.length > 2 ? <span className={css.crumbFold} data-wide={crumbs.length > 4 ? "1" : undefined}><span aria-hidden="true">/</span><Link href={`/docs?folder=${crumbs[crumbs.length - 3].id}`} className={css.crumbChip} aria-label={`Up to ${crumbs[crumbs.length - 3].name}`} title={crumbs.slice(0, -2).map((c) => c.name).join(" / ")}>…</Link></span> : null}
          {crumbs.slice(0, -1).map((c, i, up) => <span key={c.id} className={i < up.length - 1 ? css.crumbMid : css.crumbLast} data-up={i === up.length - 1 ? "1" : undefined} data-far={up.length > 3 && i < up.length - 2 ? "1" : undefined}><span aria-hidden="true">/</span>
            <Link href={`/docs?folder=${c.id}`} {...folderDrop(c.id)}>{c.name}</Link></span>)}
          {here ? <span className={css.crumbHere}><span aria-hidden="true">/</span><b aria-current="page">{here.name}</b></span> : null}
        </nav>
      </div>
      <div className={css.titleRow} data-picking={sel.size ? "1" : undefined}>
        <h1 className={css.title}>{here ? <FolderGlyph size={30} /> : null}<span className={css.titleText}>{title}</span><span className={css.selTitle} aria-live="polite">{sel.size} selected</span></h1>
        {here?.access === "people" ? <span className={css.titleHint}><Lock size={13} aria-hidden="true" />Only {here.people.map((p) => p.name).join(", ")}</span> : null}
        {here ? <button type="button" className={`${css.btn} ${css.icon} ${css.quiet}`} aria-label={`More for ${here.name}`} data-menu=""
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ key: keyOf("folder", here.id), x: r.left, y: r.bottom + 4 }); }}><MoreHorizontal size={18} aria-hidden="true" /></button> : null}
        <span className={css.spacer} />
        {total && !sel.size ? <button type="button" className={`${css.btn} ${css.phoneOnly}`} aria-pressed={selecting} onClick={() => { if (selecting || sel.size) { setSelecting(false); setSel(new Set()); } else setSelecting(true); }}>
          {selecting || sel.size ? "Done" : "Select"}</button> : null}
        <div className={`${css.seg} ${css.wideOnly}`} role="group" aria-label="View">
          <button type="button" aria-pressed={layout === "grid"} aria-label="Grid" onClick={() => setLayout("grid")}><LayoutGrid size={16} aria-hidden="true" /></button>
          <button type="button" aria-pressed={layout === "list"} aria-label="List" onClick={() => setLayout("list")}><List size={16} aria-hidden="true" /></button>
        </div>
        <button type="button" className={`${css.btn} ${css.wideOnly}`} aria-pressed={details} onClick={() => setDetails(!details)}><Info size={16} aria-hidden="true" />Details</button>
      </div>

      {/* While something is picked, on a computer this bar takes the title row's place (as in Drive: nothing moves, nothing is
          covered); on a phone it rests on the bottom bar and the title says how many are picked. */}
      {sel.size ? <div className={css.bulk} role="toolbar" aria-label={`${sel.size} chosen`}>
        <b className={css.wideOnly}><span className={css.barTitle}>{title}</span><span className={css.bulkCount}>{sel.size}</span>selected</b>
        {!archived ? <button type="button" onClick={() => setDialog({ kind: "move", keys: [...sel] })}><FolderInput size={16} aria-hidden="true" /><span>Move</span></button> : null}
        {!archived && selDocs ? <button type="button" onClick={() => setDialog({ kind: "tag", keys: [...sel] })}><Tag size={16} aria-hidden="true" /><span>Tag</span></button> : null}
        {!archived && selDocs ? <button type="button" onClick={() => setDialog({ kind: "share", keys: [...sel] })}><Share2 size={16} aria-hidden="true" /><span>Share</span></button> : null}
        <button type="button" onClick={() => void archive([...sel])}>{archived ? <ArchiveRestore size={16} aria-hidden="true" /> : <Archive size={16} aria-hidden="true" />}<span>{archived ? "Restore" : "Archive"}</span></button>
        <button type="button" className={css.bulkClear} onClick={() => { setSel(new Set()); setSelecting(false); }}><X size={16} aria-hidden="true" /><span>Unselect</span></button>
      </div> : null}
      {searching ? <div className={css.filters} aria-label="Filters">
        <label>Type<select value={f.type ?? ""} onChange={(e) => router.push(params({ category: e.target.value || null }))}>
          <option value="">Any</option>{data.categories.map((c) => <option key={c.category} value={c.category}>{c.category}</option>)}</select></label>
        <label>Owner<select value={f.owner ?? ""} onChange={(e) => router.push(params({ owner: e.target.value || null }))}>
          <option value="">Anyone</option>{(data.owners ?? []).map((o) => <option key={o.id} value={o.id}>{o.id === data.me ? `${o.name} (you)` : o.name}</option>)}</select></label>
        <label>Folder<select value={folderId ?? ""} onChange={(e) => router.push(params({ folder: e.target.value || null }))}>
          <option value="">Everywhere</option>{data.folders.slice().sort((a, b) => pathTo(data.folders, a.id).map((x) => x.name).join("/").localeCompare(pathTo(data.folders, b.id).map((x) => x.name).join("/")))
            .map((x) => <option key={x.id} value={x.id}>{pathTo(data.folders, x.id).map((p) => p.name).join(" / ")}</option>)}</select></label>
        <label>Tag<select value={tag ?? ""} onChange={(e) => router.push(params({ tag: e.target.value || null }))}>
          <option value="">Any</option>{data.tags.slice(0, 60).map((t) => <option key={t.tag} value={t.tag}>{t.tag}</option>)}</select></label>
        <label>Changed from<input type="date" value={f.from ?? ""} onChange={(e) => router.push(params({ from: e.target.value || null }))} /></label>
        <label>to<input type="date" value={f.to ?? ""} onChange={(e) => router.push(params({ to: e.target.value || null }))} /></label>
        <span className={css.spacer} /><span className={css.tileSub}>{total} found</span>
        <Link href="/docs" className={`${css.btn} ${css.small} ${css.quiet}`}><X size={14} aria-hidden="true" />Clear</Link>
      </div> : place === "home" && data.tags.length ? <div className={css.chips} aria-label="Find docs by tag"><Tag size={15} aria-hidden="true" />
        {data.tags.slice(0, 12).map((t) => <Link key={t.tag} className={css.chip} href={`/docs?tag=${encodeURIComponent(t.tag)}`}>{t.tag}</Link>)}</div> : null}

      {upload ? <div className={css.progress} role="status"><span>{upload.label} {upload.done} of {upload.total}</span><div className={css.bar}><span style={{ width: `${Math.round(100 * upload.done / Math.max(1, upload.total))}%` }} /></div></div> : null}
      {place === "home" || place === "recent" ? <DocsInbox /> : null}

      <div ref={areaRef} className={css.area} onKeyDown={areaKeys} data-picking={sel.size ? "1" : undefined} data-selecting={selecting ? "1" : undefined}
        onClick={(e) => { if (sel.size && !(e.target as Element).closest("[data-key], button, input, label, a")) setSel(new Set()); }} aria-label={`${title}: ${total} ${total === 1 ? "thing" : "things"}`} role="region">
        {!total && !creating ? empty : layout === "list" ? listView : <>
          {folders.length || newFolderTile ? <><h2 className={css.groupHead}>{view === "recent" ? "Folders with recent activity" : "Folders"}</h2><ul className={css.folders} aria-label="Folders">{newFolderTile}{folders.map(folderTile)}</ul></> : null}
          {docs.length ? <>{folders.length || newFolderTile ? <h2 className={css.groupHead}>Docs</h2> : null}<ul className={css.cards} aria-label="Docs">{docs.map(docCard)}
            {!searching && !archived && !view && !mine && total <= 2 ? <li className={css.addTile}><button type="button" onClick={() => void newDoc()} disabled={busy === "new"}><Plus size={18} aria-hidden="true" />New doc here</button></li> : null}</ul></> : null}
          {files.length ? <><h2 className={css.groupHead}>Files</h2><ul className={css.folders} aria-label="Files">{files.map(fileCard)}</ul></> : null}
        </>}
        {fileOver ? <div className={css.dropZone}>Drop to add to {here ? `“${here.name}”` : "My Docs"}<br />Word and Markdown become docs; folders keep their folders</div> : null}
      </div>
    </section>

    {details ? <DetailsPanel picked={picked} me={data.me} onClose={() => setDetails(false)} onStar={(k, id, on) => void star(k, id, on)}
      onFolderAccess={(id) => setDialog({ kind: "access", folderId: id })} /> : null}


    {menu ? menuFor(menu.key) : null}
    {dialog?.kind === "move" ? <MoveDialog folders={data.folders} count={dialog.keys.length} here={folderId} moving={dialog.keys.filter((k) => k.startsWith("folder:")).map((k) => parse(k).id)}
      onClose={() => setDialog(null)} onPick={(to) => { const keys = dialog.keys; setDialog(null); void move(keys, to); }} /> : null}
    {dialog?.kind === "tag" ? <TagDialog count={dialog.keys.filter((k) => k.startsWith("doc:")).length} suggestions={data.tags.map((t) => t.tag)} onClose={() => setDialog(null)}
      onPick={(t) => { const keys = dialog.keys; setDialog(null); void addTag(keys, t); }} /> : null}
    {dialog?.kind === "share" ? <ShareDialog count={dialog.keys.filter((k) => k.startsWith("doc:")).length} folderName={here?.name ?? null} onClose={() => setDialog(null)}
      onShare={(s) => { const keys = dialog.keys; setDialog(null); void share(keys, s); }} /> : null}
    {dialog?.kind === "confirm" ? <Confirm title={dialog.title} body={dialog.body} yes={dialog.yes} onYes={dialog.run} onNo={() => setDialog(null)} /> : null}
    {dialog?.kind === "access" ? (() => { const fo = data.folders.find((x) => x.id === dialog.folderId); return fo ? <Dialog label={`Who can see ${fo.name}`} onClose={() => setDialog(null)}>
      <FolderAccess folder={fo} me={data.me} onClose={() => setDialog(null)} /></Dialog> : null; })() : null}
  </div>;
}
