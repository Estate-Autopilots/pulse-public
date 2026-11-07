"use client";
// DOCS-WORKBENCH: a doc's page. The words save themselves as they are typed (a second after the last key; a change
// someone else saved meanwhile is never overwritten: the page asks to reload). Beside the words: Share (only you, the
// company, chosen people), Comments, History (each editing session, restore any) and Export (Markdown, PDF).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, Download, History, MessageSquare, Printer, Share2, X } from "lucide-react";
import { post } from "../orgs/client";
import { FileSidePanel, type ViewFile } from "../components/file-viewer";
import { ChipContext, DocEditor, KindIcon, mentionsIn, type DocEditorHandle, type MentionKind, type Resolved } from "./editor";
import { ACCESS_WORDS, toBase64, when, type DocFile } from "./workbench";
import css from "./docs.module.css";

export type Doc = { id: string; title: string; html: string; folderId: string | null; access: "private" | "company" | "people"; companyEdits: boolean; createdBy: string; owner: string | null;
  updatedAt: string; updatedBy: string | null; version: number; archived: boolean; canEdit: boolean; canShare: boolean };
type Share = { personId: string; name: string; side: string; canEdit: boolean };
type Comment = { id: string; body: string; quote: string | null; who: string; createdAt: string; resolvedAt: string | null; mine: boolean };
type Version = { id: string; version: number; title: string; reason: string; savedAt: string; startedAt: string; savedBy: string | null };
export type DocDetail = { doc: Doc; shares: Share[]; comments: Comment[]; files: DocFile[] };
type Panel = null | "share" | "comments" | "history";
const fail = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

export function DocView({ initial }: { initial: DocDetail }) {
  const router = useRouter();
  const [doc, setDoc] = useState(initial.doc);
  const [title, setTitle] = useState(initial.doc.title);
  const [panel, setPanel] = useState<Panel>(null);
  const [state, setState] = useState<{ tone?: "bad"; text: string }>({ text: initial.doc.canEdit ? "Saved" : "You can read this doc" });
  const [conflict, setConflict] = useState<string | null>(null);
  const [chips, setChips] = useState<Map<string, Resolved>>(new Map());
  const [viewing, setViewing] = useState<ViewFile | null>(null);
  const editorRef = useRef<DocEditorHandle>(null);
  const version = useRef(initial.doc.version);
  const pending = useRef<{ html?: string; title?: string }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (saving.current || conflict) return;
    const body = pending.current; pending.current = {};
    if (body.html === undefined && body.title === undefined) return;
    saving.current = true; setState({ text: "Saving…" });
    try {
      const r = await post<{ version: number; updatedAt: string }>(`docs/${doc.id}`, { ...body, baseVersion: version.current });
      version.current = r.version; setState({ text: `Saved ${when(r.updatedAt)}` });
    } catch (e) {
      const message = fail(e);
      if (/changed this doc meanwhile/.test(message)) setConflict(message);
      else { pending.current = { ...body, ...pending.current }; setState({ tone: "bad", text: `Not saved: ${message}` }); }
    } finally {
      saving.current = false;
      if (pending.current.html !== undefined || pending.current.title !== undefined) timer.current = setTimeout(() => void flush(), 1000);
    }
  }, [doc.id, conflict]);
  const queue = useCallback((part: { html?: string; title?: string }) => {
    pending.current = { ...pending.current, ...part };
    setState({ text: "Editing…" });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 1000);
  }, [flush]);
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => { if (pending.current.html !== undefined || pending.current.title !== undefined) { void flush(); e.preventDefault(); } };
    window.addEventListener("beforeunload", leave);
    return () => { window.removeEventListener("beforeunload", leave); void flush(); };
  }, [flush]);

  // Live chips: each mention's name and state now, looked up when the doc opens and when a new one is added.
  const known = useRef(new Set<string>());
  const refreshChips = useCallback(async () => {
    const items = mentionsIn(editorRef.current?.editor ?? null).filter((m) => !known.current.has(`${m.kind}:${m.id}`));
    if (!items.length) return;
    items.forEach((m) => known.current.add(`${m.kind}:${m.id}`));
    try {
      const r = await post<{ items: Resolved[] }>("docs/resolve", { items });
      setChips((old) => { const next = new Map(old); for (const x of r.items) next.set(`${x.kind}:${x.id}`, x); return next; });
    } catch { /* chips keep their saved names */ }
  }, []);
  useEffect(() => { const t = setTimeout(() => void refreshChips(), 300); return () => clearTimeout(t); }, [refreshChips]);
  const chipApi = useMemo(() => ({ get: (kind: string, id: string) => chips.get(`${kind}:${id}`),
    openFile: (r: Resolved) => setViewing({ url: r.href, name: r.label, mime: r.mime ?? r.sub }) }), [chips]);

  const uploadImage = useCallback(async (f: File) => {
    if (f.size > 10 * 1048576) { setState({ tone: "bad", text: "Pictures are 10 MB at most" }); return null; }
    try { const r = await post<{ file: { url: string } }>("docs/files", { docId: doc.id, name: f.name, mime: f.type, data: toBase64(await f.arrayBuffer()) }); return r.file.url; }
    catch (e) { setState({ tone: "bad", text: fail(e) }); return null; }
  }, [doc.id]);

  async function exportMarkdown() {
    await flush();
    try {
      const r = await fetch(`/api/v0/docs/${doc.id}?format=markdown`, { cache: "no-store" });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error ?? "Export failed");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([`# ${title}\n\n${data.markdown}`], { type: "text/markdown" }));
      a.download = `${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "doc"}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { setState({ tone: "bad", text: fail(e) }); }
  }
  async function exportPdf() {
    await flush();
    const DOMPurify = (await import("dompurify")).default;
    const html = DOMPurify.sanitize(editorRef.current?.editor?.getHTML() ?? doc.html, { FORBID_TAGS: ["style", "form", "input", "iframe"] });
    const w = window.open("", "_blank", "width=900,height=1000");
    if (!w) { setState({ tone: "bad", text: "Allow pop-ups for Pulse to save a PDF" }); return; }
    const safeTitle = title.replace(/[<>&"]/g, "");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:760px;margin:32px auto;color:#111}
      img{max-width:100%}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:6px 8px;text-align:left}pre{background:#f4f4f4;padding:10px;border-radius:6px;white-space:pre-wrap}
      div[data-type=callout]{border:1px solid #bbb;border-radius:8px;padding:8px 12px;background:#f7f7f7}ul[data-type=taskList]{list-style:none;padding-left:4px}
      span[data-type=mention]{background:#eee;border-radius:999px;padding:0 6px}</style></head><body><h1>${safeTitle}</h1>${html}</body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  }
  async function archive(on: boolean) {
    try { const r = await post<{ doc: Doc }>(`docs/${doc.id}/archive`, { archived: on }); setDoc((d) => ({ ...d, ...r.doc, html: d.html })); router.refresh(); } catch (e) { setState({ tone: "bad", text: fail(e) }); }
  }

  const toggle = (p: Panel) => setPanel((x) => x === p ? null : p);
  return <div className={css.wrap}>
    <div className={css.docTop}>
      <Link href={doc.folderId ? `/docs?folder=${doc.folderId}` : "/docs"} className={`${css.btn} ${css.quiet} ${css.small}`}>← Docs</Link>
      <span className={css.status} data-tone={state.tone} aria-live="polite">{state.text}</span>
      <span className={css.toolbarRow}>
        <button type="button" className={`${css.btn} ${css.small}`} onClick={() => toggle("share")} aria-pressed={panel === "share"}><Share2 size={15} aria-hidden="true" />{ACCESS_WORDS[doc.access]}</button>
        <button type="button" className={`${css.btn} ${css.small}`} onClick={() => toggle("comments")} aria-pressed={panel === "comments"}><MessageSquare size={15} aria-hidden="true" />Comments</button>
        <button type="button" className={`${css.btn} ${css.small}`} onClick={() => toggle("history")} aria-pressed={panel === "history"}><History size={15} aria-hidden="true" />History</button>
        <button type="button" className={`${css.btn} ${css.small}`} onClick={() => void exportMarkdown()}><Download size={15} aria-hidden="true" />Markdown</button>
        <button type="button" className={`${css.btn} ${css.small}`} onClick={() => void exportPdf()}><Printer size={15} aria-hidden="true" />PDF</button>
        {doc.canShare ? <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={() => void archive(!doc.archived)}>
          {doc.archived ? <><ArchiveRestore size={15} aria-hidden="true" />Restore</> : <><Archive size={15} aria-hidden="true" />Archive</>}</button> : null}
      </span>
    </div>
    {conflict ? <div className={css.banner} role="alert">{conflict}<button type="button" className={`${css.btn} ${css.small}`} onClick={() => window.location.reload()}>Reload</button></div> : null}
    {doc.archived ? <div className={css.banner}>This doc is archived. {doc.canShare ? "Restore it to change it." : ""}</div> : null}
    <div className={css.docGrid} data-panel={panel ? "1" : undefined}>
      <div className={css.paper}>
        <input className={css.titleInput} value={title} readOnly={!doc.canEdit} aria-label="Title" maxLength={200}
          onChange={(e) => { setTitle(e.target.value); if (e.target.value.trim()) queue({ title: e.target.value }); }} />
        <p className={css.hint}>{doc.owner ? `By ${doc.owner}` : ""}{doc.updatedBy ? ` · last changed by ${doc.updatedBy}, ${when(doc.updatedAt)}` : ""}</p>
        <ChipContext.Provider value={chipApi}>
          <DocEditor ref={editorRef} html={initial.doc.html} editable={doc.canEdit && !conflict} onUpload={uploadImage}
            onChange={(html) => { queue({ html }); void refreshChips(); }} />
        </ChipContext.Provider>
        {initial.files.length ? <div className={css.backlinks}><p className={css.sideHead}>Files in this doc</p>
          {initial.files.map((f) => <button key={f.id} type="button" className={`${css.btn} ${css.small} ${css.quiet}`} style={{ justifyContent: "flex-start" }}
            onClick={() => setViewing({ url: f.url, name: f.name, mime: f.mime, size: f.size })}><KindIcon kind="file" />{f.name}</button>)}</div> : null}
      </div>
      {panel === "share" ? <SharePanel doc={doc} initial={initial.shares} onClose={() => setPanel(null)} onDoc={(d) => setDoc((x) => ({ ...x, ...d, html: x.html }))} /> : null}
      {panel === "comments" ? <CommentsPanel docId={doc.id} initial={initial.comments} canEdit={doc.canEdit} onClose={() => setPanel(null)} quote={() => {
        const ed = editorRef.current?.editor; if (!ed) return ""; const { from, to } = ed.state.selection; return ed.state.doc.textBetween(from, to, " ").slice(0, 500);
      }} /> : null}
      {panel === "history" ? <HistoryPanel docId={doc.id} canEdit={doc.canEdit} onClose={() => setPanel(null)} onRestored={() => window.location.reload()} beforeRestore={flush} /> : null}
    </div>
    {viewing ? <FileSidePanel key={viewing.url} file={viewing} onClose={() => setViewing(null)} /> : null}
  </div>;
}

function PanelHead({ title, onClose }: { title: string; onClose: () => void }) {
  return <h2>{title}<button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={onClose} aria-label="Close"><X size={16} aria-hidden="true" /></button></h2>;
}

function SharePanel({ doc, initial, onClose, onDoc }: { doc: Doc; initial: Share[]; onClose: () => void; onDoc: (d: Partial<Doc>) => void }) {
  const [access, setAccess] = useState(doc.access);
  const [companyEdits, setCompanyEdits] = useState(doc.companyEdits);
  const [people, setPeople] = useState(initial);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ kind: MentionKind; id: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!q.trim()) return;
    const t = setTimeout(() => { void fetch(`/api/v0/docs/mentions?q=${encodeURIComponent(q)}&kinds=person,agent`, { cache: "no-store" }).then((r) => r.ok ? r.json() : { items: [] }).then((d) => setHits(d.items ?? [])); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  async function save() {
    setBusy(true); setError(null);
    try {
      const r = await post<{ doc: Doc; shares: Share[] }>(`docs/${doc.id}/share`, { access, companyEdits, people: people.map((p) => ({ personId: p.personId, canEdit: p.canEdit })) });
      onDoc(r.doc); setPeople(r.shares); onClose();
    } catch (e) { setError(fail(e)); } finally { setBusy(false); }
  }
  if (!doc.canShare) return <aside className={css.panel}><PanelHead title="Who can see it" onClose={onClose} />
    <p className={css.hint}>{ACCESS_WORDS[doc.access]}{doc.access === "company" ? (doc.companyEdits ? ", and everyone may edit." : "; only its owner edits.") : ""}</p>
    {doc.access === "people" ? <ul className={css.list}>{initial.map((p) => <li key={p.personId}>{p.name}<span className={css.count}>{p.canEdit ? "Edits" : "Reads"}</span></li>)}</ul> : null}
    <p className={css.hint}>{doc.owner ?? "The owner"} decides who it is shared with.</p></aside>;
  return <aside className={css.panel}>
    <PanelHead title="Share" onClose={onClose} />
    {(["private", "company", "people"] as const).map((a) => <label key={a} className={css.radio}><input type="radio" name="access" checked={access === a} onChange={() => setAccess(a)} />
      <span><strong>{ACCESS_WORDS[a]}</strong><br /><span className={css.hint}>{a === "private" ? "Only you see it." : a === "company" ? "Every staff member and AI employee finds and reads it." : "Only the people you add below."}</span></span></label>)}
    {access === "company" ? <label className={css.radio}><input type="checkbox" checked={companyEdits} onChange={(e) => setCompanyEdits(e.target.checked)} />Everyone may edit it (otherwise only you)</label> : null}
    {access === "people" ? <>
      <label className={css.field}>Add a person or AI employee<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a name" /></label>
      {(q.trim() ? hits : []).filter((h) => !people.some((p) => p.personId === h.id)).slice(0, 6).map((h) => <button key={h.id} type="button" className={`${css.btn} ${css.small} ${css.quiet}`} style={{ justifyContent: "flex-start" }}
        onClick={() => { setPeople((p) => [...p, { personId: h.id, name: h.label, side: h.kind === "agent" ? "agent" : "staff", canEdit: false }]); setQ(""); }}><KindIcon kind={h.kind} />{h.label}</button>)}
      {people.length ? <ul className={css.list}>{people.map((p) => <li key={p.personId}><span style={{ flex: 1 }}>{p.name}</span>
        <select value={p.canEdit ? "edit" : "read"} aria-label={`What ${p.name} may do`} onChange={(e) => setPeople((all) => all.map((x) => x.personId === p.personId ? { ...x, canEdit: e.target.value === "edit" } : x))}>
          <option value="read">Reads</option><option value="edit">Edits</option></select>
        <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} aria-label={`Remove ${p.name}`} onClick={() => setPeople((all) => all.filter((x) => x.personId !== p.personId))}><X size={14} aria-hidden="true" /></button></li>)}</ul>
        : <p className={css.hint}>Nobody added yet.</p>}
    </> : null}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <button type="button" className={`${css.btn} ${css.primary}`} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save sharing"}</button>
  </aside>;
}

function CommentsPanel({ docId, initial, canEdit, onClose, quote }: { docId: string; initial: Comment[]; canEdit: boolean; onClose: () => void; quote: () => string }) {
  const [comments, setComments] = useState(initial);
  const [text, setText] = useState("");
  const [quoted, setQuoted] = useState(() => quote());
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  async function act(path: string, body: unknown = {}) {
    setError(null);
    try { const r = await post<{ comments: Comment[] }>(path, body); setComments(r.comments); return true; } catch (e) { setError(fail(e)); return false; }
  }
  const open = comments.filter((c) => !c.resolvedAt), resolved = comments.filter((c) => c.resolvedAt);
  return <aside className={css.panel}>
    <PanelHead title={`Comments${open.length ? ` (${open.length})` : ""}`} onClose={onClose} />
    {(showResolved ? comments : open).map((c) => <div key={c.id} className={css.comment} data-resolved={c.resolvedAt ? "1" : undefined}>
      {c.quote ? <q>{c.quote}</q> : null}
      <span>{c.body}</span>
      <span className={css.who}>{c.who}, {when(c.createdAt)}{c.resolvedAt ? " · resolved" : ""}</span>
      <span className={css.toolbarRow}>
        {canEdit ? <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={() => void act(`docs/${docId}/comments/${c.id}/${c.resolvedAt ? "reopen" : "resolve"}`)}>{c.resolvedAt ? "Reopen" : "Resolve"}</button> : null}
        {c.mine ? <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={() => void act(`docs/${docId}/comments/${c.id}/remove`)}>Take back</button> : null}
      </span>
    </div>)}
    {!open.length && !showResolved ? <p className={css.hint}>No open comments.</p> : null}
    {resolved.length ? <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={() => setShowResolved((s) => !s)}>{showResolved ? "Hide resolved" : `Show ${resolved.length} resolved`}</button> : null}
    <form onSubmit={async (e) => { e.preventDefault(); if (await act(`docs/${docId}/comments`, { body: text, quote: quoted || undefined })) { setText(""); setQuoted(""); } }} className={css.field}>
      {quoted ? <span className={css.hint}>About: “{quoted}” <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={() => setQuoted("")}>Clear</button></span>
        : <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={() => setQuoted(quote())}>Quote the selected words</button>}
      <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} placeholder="Write a comment" aria-label="Comment" />
      <button type="submit" className={`${css.btn} ${css.primary}`} disabled={!text.trim()}>Comment</button>
    </form>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
  </aside>;
}

function HistoryPanel({ docId, canEdit, onClose, onRestored, beforeRestore }: { docId: string; canEdit: boolean; onClose: () => void; onRestored: () => void; beforeRestore: () => Promise<void> }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [open, setOpen] = useState<{ id: string; html: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void fetch(`/api/v0/docs/${docId}/versions`, { cache: "no-store" }).then((r) => r.json()).then((d) => setVersions(d.versions ?? [])).catch(() => setError("History is unavailable")); }, [docId]);
  async function look(id: string) {
    try {
      const r = await fetch(`/api/v0/docs/${docId}/versions/${id}`, { cache: "no-store" }); const d = await r.json();
      const DOMPurify = (await import("dompurify")).default;
      setOpen({ id, html: String(DOMPurify.sanitize(String(d.version?.html ?? ""), { FORBID_TAGS: ["style", "form", "input", "iframe"] })) });
    } catch { setError("That version could not be opened"); }
  }
  async function restore(id: string) {
    if (!window.confirm("Restore this version? The doc takes its words; what is there now stays in the history.")) return;
    await beforeRestore();
    try { await post(`docs/${docId}/versions/${id}/restore`); onRestored(); } catch (e) { setError(fail(e)); }
  }
  const why: Record<string, string> = { edit: "Edited", create: "Started", restore: "Restored", import: "Imported" };
  return <aside className={css.panel}>
    <PanelHead title="History" onClose={onClose} />
    {!versions ? <p className={css.hint}>Loading…</p> : versions.map((v) => <div key={v.id} className={css.comment}>
      <span><strong>{why[v.reason] ?? "Saved"}</strong> by {v.savedBy ?? "someone"}</span>
      <span className={css.who}>{when(v.savedAt)}{v.startedAt !== v.savedAt ? ` (from ${when(v.startedAt)})` : ""}</span>
      <span className={css.toolbarRow}>
        <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={() => void look(v.id)}>{open?.id === v.id ? "Shown below" : "Look"}</button>
        {canEdit ? <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={() => void restore(v.id)}>Restore</button> : null}
      </span>
      {open?.id === v.id ? <div className={`${css.preview} ${css.prose}`} dangerouslySetInnerHTML={{ __html: open.html }} /> : null}
    </div>)}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
  </aside>;
}
