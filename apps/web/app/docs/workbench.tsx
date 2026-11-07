"use client";
// DOCS-WORKBENCH: the Docs page. Folders on the left (a picker on a phone), the docs and files of the folder chosen (or
// what a search finds) in the middle; new doc (blank or a template), import (.md, .html, .docx), upload a file, new
// folder. Files open in the side viewer.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Archive, ChevronDown, FileText, Folder, FolderPlus, Globe, Import, Lock, Plus, Upload, User, Users } from "lucide-react";
import { post } from "../orgs/client";
import { FileOpen } from "../components/file-viewer";
import css from "./docs.module.css";

export type DocSummary = { id: string; title: string; folderId: string | null; access: "private" | "company" | "people"; owner: string | null; updatedAt: string; updatedBy: string | null; snippet: string | null; archived: boolean };
export type Folder = { id: string; name: string; parentId: string | null; canEdit: boolean; docs: number };
export type DocFile = { id: string; name: string; mime: string; size: number; folderId: string | null; addedBy: string | null; addedAt: string; url: string };
export type DocsData = { docs: DocSummary[]; folders: Folder[]; files: DocFile[]; me: string; admin: boolean; templates: { key: string; label: string }[] };

const ACCESS_ICON = { private: Lock, company: Globe, people: Users } as const;
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

function FolderTree({ folders, parent, current, depth }: { folders: Folder[]; parent: string | null; current: string | null; depth: number }) {
  const kids = folders.filter((f) => f.parentId === parent);
  if (!kids.length || depth > 12) return null;
  return <>{kids.map((f) => <div key={f.id}>
    <Link href={`/docs?folder=${f.id}`} aria-current={current === f.id ? "page" : undefined} style={{ paddingLeft: 10 + depth * 14 }}>
      <Folder size={16} aria-hidden="true" />{f.name}<span className={css.count}>{f.docs || ""}</span></Link>
    <FolderTree folders={folders} parent={f.id} current={current} depth={depth + 1} />
  </div>)}</>;
}

export function Workbench({ data, folder, query, archived, mine }: { data: DocsData; folder: string | null; query: string; archived: boolean; mine: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState(query);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importer = useRef<HTMLInputElement>(null), uploader = useRef<HTMLInputElement>(null);
  const folderId = folder && folder !== "root" ? folder : null;
  const here = data.folders.find((f) => f.id === folderId);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : "That did not work. Try again.");

  async function create(template?: string) {
    setMenu(false); setBusy("new"); setError(null);
    try { const r = await post<{ doc: { id: string } }>("docs", { folderId, ...(template ? { template } : {}) }); router.push(`/docs/${r.doc.id}`); }
    catch (e) { fail(e); setBusy(null); }
  }
  async function newFolder() {
    const name = window.prompt(here ? `New folder inside “${here.name}”` : "New folder name");
    if (!name?.trim()) return;
    try { const r = await post<{ id: string }>("docs/folders", { name, parentId: folderId }); router.push(`/docs?folder=${r.id}`); router.refresh(); } catch (e) { fail(e); }
  }
  async function readFile(f: File, limit: number) {
    if (f.size > limit) throw new Error(`${f.name} is too big (${sizeWords(limit)} at most).`);
    return toBase64(await f.arrayBuffer());
  }
  async function doImport(f: File) {
    setBusy("import"); setError(null);
    try { const r = await post<{ doc: { id: string } }>("docs/import", { name: f.name, data: await readFile(f, 5 * 1048576), folderId }); router.push(`/docs/${r.doc.id}`); }
    catch (e) { fail(e); setBusy(null); }
  }
  async function upload(files: FileList) {
    setBusy("upload"); setError(null);
    try { for (const f of Array.from(files)) await post("docs/files", { name: f.name, mime: f.type || "application/octet-stream", data: await readFile(f, 10 * 1048576), folderId }); router.refresh(); }
    catch (e) { fail(e); } finally { setBusy(null); }
  }
  function search(e: FormEvent) {
    e.preventDefault();
    router.push(q.trim() ? `/docs?q=${encodeURIComponent(q.trim())}` : folderId ? `/docs?folder=${folderId}` : "/docs");
  }
  async function renameFolder() {
    if (!here) return;
    const name = window.prompt("Rename folder", here.name);
    if (!name?.trim()) return;
    try { await post(`docs/folders/${here.id}`, { name }); router.refresh(); } catch (e) { fail(e); }
  }
  async function archiveFolder() {
    if (!here || !window.confirm(`Archive the folder “${here.name}”? Its docs stay and are listed under All docs.`)) return;
    try { await post(`docs/folders/${here.id}`, { archived: true }); router.push("/docs"); router.refresh(); } catch (e) { fail(e); }
  }

  const title = query ? `Found for “${query}”` : archived ? "Archived docs" : mine ? "Your docs" : here ? here.name : folder === "root" ? "Not in a folder" : "All docs";
  return <div className={css.wrap}>
    <div className={css.toolbarRow}>
      <form onSubmit={search} style={{ display: "contents" }} role="search">
        <input className={css.search} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search every doc's words" aria-label="Search docs" />
      </form>
      <div className={css.menu}>
        <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => setMenu((m) => !m)} aria-expanded={menu} disabled={busy === "new"}>
          <Plus size={16} aria-hidden="true" />{busy === "new" ? "Opening…" : "New doc"}<ChevronDown size={14} aria-hidden="true" /></button>
        {menu ? <div className={css.menuList} role="menu">
          <button type="button" role="menuitem" className={`${css.btn} ${css.quiet}`} onClick={() => void create()}><FileText size={16} aria-hidden="true" />Blank doc</button>
          {data.templates.map((t) => <button key={t.key} type="button" role="menuitem" className={`${css.btn} ${css.quiet}`} onClick={() => void create(t.key)}><FileText size={16} aria-hidden="true" />{t.label}</button>)}
        </div> : null}
      </div>
      <button type="button" className={css.btn} onClick={() => importer.current?.click()} disabled={busy === "import"}><Import size={16} aria-hidden="true" />{busy === "import" ? "Importing…" : "Import"}</button>
      <input ref={importer} type="file" accept=".md,.markdown,.txt,.html,.htm,.docx" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void doImport(f); }} />
      <button type="button" className={css.btn} onClick={() => uploader.current?.click()} disabled={busy === "upload"}><Upload size={16} aria-hidden="true" />{busy === "upload" ? "Uploading…" : "Upload file"}</button>
      <input ref={uploader} type="file" multiple hidden onChange={(e) => { const f = e.target.files; if (f?.length) void upload(f); e.target.value = ""; }} />
      <button type="button" className={css.btn} onClick={() => void newFolder()}><FolderPlus size={16} aria-hidden="true" />New folder</button>
    </div>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={css.split}>
      <nav className={css.side} aria-label="Folders">
        <Link href="/docs" aria-current={!folder && !query && !archived && !mine ? "page" : undefined}><FileText size={16} aria-hidden="true" />All docs</Link>
        <Link href="/docs?mine=1" aria-current={mine ? "page" : undefined}><User size={16} aria-hidden="true" />Your docs</Link>
        <Link href="/docs?folder=root" aria-current={folder === "root" ? "page" : undefined}><FileText size={16} aria-hidden="true" />Not in a folder</Link>
        <Link href="/docs?archived=1" aria-current={archived ? "page" : undefined}><Archive size={16} aria-hidden="true" />Archived</Link>
        {data.folders.length ? <p className={css.sideHead}>Folders</p> : null}
        <FolderTree folders={data.folders} parent={null} current={folderId} depth={0} />
      </nav>
      <section aria-label={title} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <div className={css.sectionHead}><h2>{title}</h2>
          {here?.canEdit ? <span className={css.toolbarRow}><button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={() => void renameFolder()}>Rename</button>
            <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={() => void archiveFolder()}>Archive folder</button></span> : null}</div>
        {data.docs.length ? <ul className={css.list}>{data.docs.map((d) => { const I = ACCESS_ICON[d.access]; return <li key={d.id}>
          <FileText size={18} aria-hidden="true" />
          <div className={css.itemText}>
            <Link href={`/docs/${d.id}`}>{d.title}</Link>
            {d.snippet ? <span className={css.snippet}>{d.snippet.replace(/[«»]/g, "")}</span> : null}
            <span>{d.updatedBy ? `${d.updatedBy}, ` : ""}{when(d.updatedAt)}{d.owner ? ` · by ${d.owner}` : ""}</span>
          </div>
          <span title={ACCESS_WORDS[d.access]} aria-label={ACCESS_WORDS[d.access]}><I size={16} aria-hidden="true" /></span>
        </li>; })}</ul>
          : <p className={css.empty}>{query ? "No doc has those words. Try fewer or different words." : archived ? "Nothing archived." : "No docs here yet. Start one with New doc, or import a Markdown, HTML or Word file."}</p>}
        {data.files.length ? <>
          <div className={css.sectionHead}><h2>Files</h2><span className={css.hint}>{data.files.length}</span></div>
          <ul className={css.list}>{data.files.map((f) => <li key={f.id}>
            <Upload size={18} aria-hidden="true" />
            <div className={css.itemText}>
              <FileOpen file={{ url: f.url, name: f.name, mime: f.mime, size: f.size }}>{f.name}</FileOpen>
              <span>{sizeWords(f.size)}{f.addedBy ? ` · ${f.addedBy}` : ""} · {when(f.addedAt)}</span>
            </div>
          </li>)}</ul>
        </> : null}
      </section>
    </div>
  </div>;
}
