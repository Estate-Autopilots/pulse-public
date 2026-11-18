"use client";
// DOCS-MCP (owner, 8 Nov 2026: "folders work like Drive, each project gets its own folder, docs get tags and categories";
// "bring in a Drive folder or a zip of md files and keep the folder tree"). The parts the Docs page and a doc's page share:
// tag chips, a doc's folder / tags / category under its title, who a folder is for, and Import (a file, a zip or a whole
// folder from the computer, sent in batches; the folder tree is kept and a doc of the same name is updated, not copied).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { ChevronDown, FileText, FolderOpen, FolderUp, Import, Lock, Plus, Tag, Users, X } from "lucide-react";
import { post } from "../orgs/client";
import css from "./docs.module.css";
import oc from "./organize.module.css";

export type FolderLite = { id: string; name: string; parentId: string | null; access?: "company" | "people" };

/** Tags as chips; with `href`, each opens the docs with that tag. */
export function TagChips({ tags, href, current, className }: { tags: string[]; href?: (t: string) => string; current?: string | null; className?: string }) {
  if (!tags.length) return null;
  return <ul className={`${oc.tags} ${className ?? ""}`} aria-label="Tags">{tags.map((t) => <li key={t}>
    {href ? <Link className={oc.tag} href={href(t)} aria-current={current === t ? "page" : undefined}>{t}</Link> : <span className={oc.tag}>{t}</span>}</li>)}</ul>;
}

/** Folders in tree order with their depth (for pickers). */
export function folderOptions(folders: FolderLite[]): { id: string; label: string; depth: number }[] {
  const out: { id: string; label: string; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    if (depth > 12) return;
    for (const f of folders.filter((x) => x.parentId === parent).sort((a, b) => a.name.localeCompare(b.name))) { out.push({ id: f.id, label: f.name, depth }); walk(f.id, depth + 1); }
  };
  walk(null, 0);
  return out;
}

/** Docs / Company / Offer: the way back up from a doc or a folder. */
export function Crumbs({ folders, folderId, children }: { folders: FolderLite[]; folderId: string | null; children?: ReactNode }) {
  const path: FolderLite[] = [];
  for (let id = folderId, hops = 0; id && hops < 14; hops++) { const f = folders.find((x) => x.id === id); if (!f) break; path.unshift(f); id = f.parentId; }
  return <nav className={oc.crumbs} aria-label="Where this is">
    <Link href="/docs">Docs</Link>
    {path.map((f, i) => <span key={f.id} style={{ display: "contents" }}><span aria-hidden="true">/</span>
      {i === path.length - 1 && !children ? <b>{f.name}{f.access === "people" ? <Lock size={13} className={oc.folderLock} aria-label="Private folder" /> : null}</b>
        : <Link href={`/docs?folder=${f.id}`}>{f.name}</Link>}</span>)}
    {children}
  </nav>;
}

type Labelled = { id: string; folderId: string | null; tags: string[]; category: string | null; canEdit: boolean };
/** Under a doc's title: its folder (move it), its tags (+ Add tag) and its category. Each change saves at once. */
export function DocLabels({ doc, folders, suggestions, categories, onSaved, onError }: { doc: Labelled; folders: FolderLite[]; suggestions: string[]; categories: string[];
  onSaved: (d: Partial<Labelled>) => void; onError: (message: string) => void }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false), [draft, setDraft] = useState(""), [busy, setBusy] = useState(false);
  const save = async (part: Partial<{ tags: string[]; category: string | null; folderId: string | null }>) => {
    setBusy(true);
    try {
      const r = await post<{ doc: Labelled }>(`docs/${doc.id}`, part);
      onSaved({ tags: r.doc.tags, category: r.doc.category, folderId: r.doc.folderId });
      if ("folderId" in part) router.refresh();
    } catch (e) { onError(e instanceof Error ? e.message : "Not saved. Try again."); } finally { setBusy(false); }
  };
  const add = () => {
    const t = draft.trim().toLowerCase().replace(/^#+/, "");
    setDraft(""); setAdding(false);
    if (t && !doc.tags.includes(t)) void save({ tags: [...doc.tags, t] });
  };
  const opts = folderOptions(folders);
  const cats = [...new Set([...(doc.category ? [doc.category] : []), ...categories])];
  return <div className={oc.labels}>
    <span className={oc.labelGroup}><FolderOpen size={15} aria-hidden="true" />
      {doc.canEdit ? <select aria-label="Folder" value={doc.folderId ?? ""} disabled={busy} onChange={(e) => void save({ folderId: e.target.value || null })}>
        <option value="">No folder</option>
        {opts.map((o) => <option key={o.id} value={o.id}>{"  ".repeat(o.depth)}{o.label}</option>)}
      </select> : <span>{folders.find((f) => f.id === doc.folderId)?.name ?? "No folder"}</span>}</span>
    <span className={oc.labelGroup}><Tag size={15} aria-hidden="true" />
      <ul className={oc.tags} aria-label="Tags">{doc.tags.map((t) => <li key={t} className={oc.tag}>{t}
        {doc.canEdit ? <button type="button" aria-label={`Remove tag ${t}`} disabled={busy} onClick={() => void save({ tags: doc.tags.filter((x) => x !== t) })}><X size={12} aria-hidden="true" /></button> : null}</li>)}</ul>
      {doc.canEdit ? adding ? <>
        <input autoFocus value={draft} maxLength={40} placeholder="Tag name" aria-label="New tag" list="doc-tag-suggestions" onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } if (e.key === "Escape") { setAdding(false); setDraft(""); } }} onBlur={() => { if (draft.trim()) add(); else setAdding(false); }} />
        <datalist id="doc-tag-suggestions">{suggestions.filter((s) => !doc.tags.includes(s)).slice(0, 40).map((s) => <option key={s} value={s} />)}</datalist>
      </> : <button type="button" className={oc.addTag} onClick={() => setAdding(true)} disabled={busy || doc.tags.length >= 20}><Plus size={13} aria-hidden="true" />Add tag</button>
        : doc.tags.length ? null : <span>No tags</span>}</span>
    <span className={oc.labelGroup}>
      {doc.canEdit ? <select aria-label="Category" value={doc.category ?? ""} disabled={busy} onChange={(e) => void save({ category: e.target.value || null })}>
        <option value="">No category</option>
        {cats.map((k) => <option key={k} value={k}>{k}</option>)}
      </select> : doc.category ? <span>{doc.category}</span> : null}</span>
  </div>;
}

type Person = { personId: string; name: string };
type FolderFull = FolderLite & { canShare: boolean; people: Person[] };
/** Who a folder is for: the whole company, or only chosen people (everything inside is hidden from everyone else). */
export function FolderAccess({ folder, me, onClose }: { folder: FolderFull; me: string; onClose: () => void }) {
  const router = useRouter();
  const [access, setAccess] = useState<"company" | "people">(folder.access ?? "company");
  const [people, setPeople] = useState<Person[]>(folder.people.length ? folder.people : []);
  const [q, setQ] = useState(""), [found, setFound] = useState<Person[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const search = (v: string) => {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    if (!v.trim()) { setFound([]); return; }
    timer.current = setTimeout(() => {
      void fetch(`/api/v0/docs/mentions?kinds=person,agent&q=${encodeURIComponent(v.trim())}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : { items: [] })
        .then((d: { items: { id: string; label: string }[] }) => setFound(d.items.map((x) => ({ personId: x.id, name: x.label })).filter((x) => !people.some((p) => p.personId === x.personId))))
        .catch(() => setFound([]));
    }, 250);
  };
  const save = async () => {
    setBusy(true); setError(null);
    try { await post(`docs/folders/${folder.id}`, { access, people: access === "people" ? people.map((p) => p.personId) : [] }); router.refresh(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : "Not saved. Try again."); } finally { setBusy(false); }
  };
  return <section className={css.panel} aria-label={`Who can see ${folder.name}`}>
    <h2>Who can see “{folder.name}”<button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={onClose} aria-label="Close"><X size={15} aria-hidden="true" /></button></h2>
    <label className={css.radio}><input type="radio" name="folder-access" checked={access === "company"} onChange={() => setAccess("company")} />
      <span><b>Everyone in the company</b><br /><span className={css.hint}>Each doc inside still keeps its own sharing.</span></span></label>
    <label className={css.radio}><input type="radio" name="folder-access" checked={access === "people"} onChange={() => setAccess("people")} />
      <span><b>Only the people below</b><br /><span className={css.hint}>Everything inside is hidden from everyone else, admins too, and from their AI.</span></span></label>
    {access === "people" ? <>
      <ul className={oc.people}>{people.map((p) => <li key={p.personId}>{p.name}{p.personId === me ? " (you)" : ""}
        {p.personId !== me ? <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} aria-label={`Remove ${p.name}`} onClick={() => setPeople((x) => x.filter((y) => y.personId !== p.personId))}><X size={14} aria-hidden="true" /></button> : null}</li>)}</ul>
      <label className={css.field}>Add a person<input value={q} onChange={(e) => search(e.target.value)} placeholder="Type a name" /></label>
      {found.length ? <ul className={oc.found}>{found.slice(0, 6).map((p) => <li key={p.personId}><button type="button" onClick={() => { setPeople((x) => [...x, p]); setQ(""); setFound([]); }}>{p.name}</button></li>)}</ul> : null}
    </> : null}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={css.toolbarRow}><button type="button" className={`${css.btn} ${css.primary}`} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
      <button type="button" className={`${css.btn} ${css.quiet}`} onClick={onClose}>Cancel</button></div>
  </section>;
}

// ------------------------------------------------------------------------------------------------ import
type Item = { path: string; data: string };
type Result = { created: number; updated: number; folders: number; skipped: { path: string; why: string }[] };
const DOC_EXT = /\.(md|markdown|txt|html?|docx)$/i;
const MAX_FILE = 5 * 1048576, MAX_FILES = 2000;
const b64 = (buf: ArrayBuffer) => { const bytes = new Uint8Array(buf); let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

/** Import: one file (.md, .html, .docx) opens as a doc; a zip or a folder keeps its folders. */
export function ImportMenu({ folderId, folderName, onSingle }: { folderId: string | null; folderName: string | null; onSingle: (f: File) => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState<{ items: Item[]; skipped: { path: string; why: string }[]; from: string } | null>(null);
  const [access, setAccess] = useState<"company" | "private">("company"), [replace, setReplace] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null), [result, setResult] = useState<Result | null>(null), [error, setError] = useState<string | null>(null);
  const single = useRef<HTMLInputElement>(null), zipper = useRef<HTMLInputElement>(null);
  const prepare = async (files: { path: string; size: number; read: () => Promise<string> }[], from: string) => {
    setError(null); setResult(null);
    const items: Item[] = [], skipped: { path: string; why: string }[] = [];
    for (const f of files.slice(0, MAX_FILES)) {
      const name = f.path.split("/").pop() ?? "";
      if (name.startsWith(".") || f.path.includes("__MACOSX/")) continue;
      if (!DOC_EXT.test(name)) { skipped.push({ path: f.path, why: "not a .md, .txt, .html or .docx file" }); continue; }
      if (f.size > MAX_FILE) { skipped.push({ path: f.path, why: "bigger than 5 MB" }); continue; }
      items.push({ path: f.path, data: await f.read() });
    }
    if (files.length > MAX_FILES) skipped.push({ path: `${files.length - MAX_FILES} more files`, why: `only ${MAX_FILES} files at a time` });
    if (!items.length) { setError("There are no .md, .txt, .html or .docx files in it."); return; }
    setReady({ items, skipped, from });
  };
  const fromZip = async (file: File) => {
    try {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files).filter((e) => !e.dir);
      await prepare(entries.map((e) => ({ path: e.name, size: (e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
        read: async () => { const buf = await e.async("arraybuffer"); if (buf.byteLength > MAX_FILE) throw new Error(`${e.name} is bigger than 5 MB`); return b64(buf); } })), file.name);
    } catch (e) { setError(e instanceof Error && e.message ? `That zip could not be opened: ${e.message}` : "That zip could not be opened."); }
  };
  const fromFolder = async (list: FileList) => {
    const files = Array.from(list);
    await prepare(files.map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, size: f.size, read: async () => b64(await f.arrayBuffer()) })),
      (files[0] as File & { webkitRelativePath?: string })?.webkitRelativePath?.split("/")[0] || "your folder");
  };
  const run = async () => {
    if (!ready) return;
    const batches: Item[][] = []; let cur: Item[] = [], size = 0;
    for (const it of ready.items) {
      if (cur.length >= 25 || (cur.length && size + it.data.length > 8_000_000)) { batches.push(cur); cur = []; size = 0; }
      cur.push(it); size += it.data.length;
    }
    if (cur.length) batches.push(cur);
    const total: Result = { created: 0, updated: 0, folders: 0, skipped: [...ready.skipped] };
    setProgress({ done: 0, total: ready.items.length }); setError(null);
    try {
      for (const batch of batches) {
        const r = await post<Result>("docs/import-tree", { folderId, items: batch, replace, access });
        total.created += r.created; total.updated += r.updated; total.folders += r.folders; total.skipped.push(...r.skipped);
        setProgress((p) => p && { ...p, done: p.done + batch.length });
      }
      setResult(total); setReady(null); router.refresh();
    } catch (e) { setError(`${e instanceof Error ? e.message : "The import stopped."} ${total.created + total.updated ? `${total.created + total.updated} docs were already brought in; import again to finish (nothing is copied twice).` : ""}`); setResult(total); }
    finally { setProgress(null); }
  };
  const where = folderName ? `“${folderName}”` : "Docs";
  return <>
    <div className={css.menu}>
      <button type="button" className={css.btn} onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!!progress}><Import size={16} aria-hidden="true" />{progress ? "Importing…" : "Import"}<ChevronDown size={14} aria-hidden="true" /></button>
      {open ? <div className={css.menuList} role="menu">
        <button type="button" role="menuitem" className={`${css.btn} ${css.quiet}`} onClick={() => { setOpen(false); single.current?.click(); }}><FileText size={16} aria-hidden="true" />One file (.md, .docx, .html)</button>
        <button type="button" role="menuitem" className={`${css.btn} ${css.quiet}`} onClick={() => { setOpen(false); zipper.current?.click(); }}><FolderUp size={16} aria-hidden="true" />A zip of a folder</button>
        <label role="menuitem" className={`${css.btn} ${css.quiet}`} style={{ justifyContent: "flex-start" }}><FolderOpen size={16} aria-hidden="true" />A folder from this computer
          <input type="file" multiple hidden ref={(el) => { el?.setAttribute("webkitdirectory", ""); }} onChange={(e) => { setOpen(false); const f = e.target.files; if (f?.length) void fromFolder(f); e.target.value = ""; }} /></label>
      </div> : null}
      <input ref={single} type="file" accept=".md,.markdown,.txt,.html,.htm,.docx" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onSingle(f); }} />
      <input ref={zipper} type="file" accept=".zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void fromZip(f); }} />
    </div>
    {ready || progress || result || error ? <div className={oc.progress} role="status" style={{ flexBasis: "100%" }}>
      {ready && !progress ? <>
        <b>Bring {ready.items.length} {ready.items.length === 1 ? "file" : "files"} from {ready.from} into {where}?</b>
        <span className={css.hint}>Its folders come too. Word, Markdown and web pages become docs you can edit.</span>
        <label className={css.radio}><input type="radio" name="import-access" checked={access === "company"} onChange={() => setAccess("company")} /><span><Users size={14} aria-hidden="true" /> Everyone who can open {where} can read and edit them</span></label>
        <label className={css.radio}><input type="radio" name="import-access" checked={access === "private"} onChange={() => setAccess("private")} /><span><Lock size={14} aria-hidden="true" /> Only me for now</span></label>
        <label className={css.radio}><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /><span>If a doc with the same name is already in that folder, update it (its old words stay in History)</span></label>
        <div className={css.toolbarRow}><button type="button" className={`${css.btn} ${css.primary}`} onClick={() => void run()}>Import {ready.items.length}</button>
          <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setReady(null)}>Cancel</button></div>
      </> : null}
      {progress ? <><span>Bringing in {progress.done} of {progress.total}…</span><div className={oc.bar}><span style={{ width: `${Math.round(100 * progress.done / Math.max(progress.total, 1))}%` }} /></div></> : null}
      {result && !progress ? <>
        <b>Done: {result.created} new {result.created === 1 ? "doc" : "docs"}{result.updated ? `, ${result.updated} updated` : ""}{result.folders ? `, ${result.folders} new ${result.folders === 1 ? "folder" : "folders"}` : ""}.</b>
        {result.skipped.length ? <details><summary>{result.skipped.length} left out</summary><ul className={oc.skipped}>{result.skipped.slice(0, 50).map((s) => <li key={s.path}>{s.path}: {s.why}</li>)}</ul></details> : null}
        <div className={css.toolbarRow}><button type="button" className={`${css.btn} ${css.small}`} onClick={() => setResult(null)}>OK</button></div>
      </> : null}
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </div> : null}
  </>;
}
