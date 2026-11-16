"use client";
// DOCS-WORKBENCH: a doc's page. The words save themselves as they are typed (a second after the last key; a change
// someone else saved meanwhile is never overwritten: the page asks to reload). Beside the words: Share (only you, the
// company, chosen people), Comments, History (each editing session, restore any) and Export (Markdown, PDF).
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, BarChart3, ChevronDown, Download, Eye, FileText, History, Link2, ListChecks, MessageSquare, Printer, Send, Share2, Sparkles, Tag, Users, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../orgs/client";
import { blockChanges } from "../lib/doc-rich.mjs";
import { markdownWithPictures, printableHtml, PRINT_CSS, readingHtml } from "./rich/export";
import { FileSidePanel, type ViewFile } from "../components/file-viewer";
import { ChipContext, DocEditor, KindIcon, mentionsIn, type DocEditorHandle, type MentionKind, type Resolved } from "./editor";
import { ACCESS_WORDS, toBase64, type DocFile } from "./workbench";
import { readMinutes, whenText } from "../lib/doc-read.mjs";
import { Avatar } from "../avatar";
import { useOrgZone } from "../org-code";
import { lookRicher, RicherDialog, upgradeWords, type RicherDone, type RicherLook } from "./richer";
import { BlockHost, type Answer } from "./blocks";
import { useReadTracking } from "./read-tracker";
import { AskBanner, LinksPanel, ReadsPanel, SendPanel, TrackingChip, type Interactive } from "./interactive-panels";
import { Crumbs, DocLabels, type FolderLite } from "./organize";
import { useConfirm } from "../kit/dialogs";
import css from "./docs.module.css";

export type Doc = { id: string; title: string; html: string; folderId: string | null; access: "private" | "company" | "people"; companyEdits: boolean; createdBy: string; owner: string | null;
  updatedAt: string; updatedBy: string | null; version: number; archived: boolean; canEdit: boolean; canShare: boolean; tags: string[]; category: string | null };
// DOCS-DRIVE (1893): a chosen person views, comments or edits.
type Share = { personId: string; name: string; side: string; canEdit: boolean; canComment?: boolean };
const roleOf = (p: Share) => p.canEdit ? "edit" : p.canComment === false ? "view" : "comment";
const ROLE_LABEL = { view: "Views", comment: "Comments", edit: "Edits" } as const;
type Comment = { id: string; body: string; quote: string | null; who: string; createdAt: string; resolvedAt: string | null; mine: boolean };
type Version = { id: string; version: number; title: string; reason: string; savedAt: string; startedAt: string; savedBy: string | null };
// DOCS-MCP: the folders (for the picker and the way back), and the tags and categories already in use.
export type DocDetail = { doc: Doc; shares: Share[]; comments: Comment[]; files: DocFile[]; folders: FolderLite[]; tags: string[]; categories: string[] };
type Panel = null | "share" | "comments" | "history" | "send" | "reads" | "links";
const fail = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
// DOCS-POLISH: times in the company's zone, written the same on the server and in the browser (the "last changed" line
// used the server's zone and locale, then the browser's: React's hydration mismatch, DOCS-RICH's report).
function useWhen() { const zone = useOrgZone(); return useCallback((iso: string) => whenText(iso, zone), [zone]); }
const plainText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");
type Heading = { pos: number; level: number; text: string };
/** The doc's headings (and folded toggles' titles), for "On this page". */
function headingsOf(ed: { state: { doc: { descendants: (f: (n: { type: { name: string }; attrs: Record<string, unknown>; textContent: string }, pos: number) => boolean | void) => void } } } | null): Heading[] {
  const out: Heading[] = [];
  ed?.state.doc.descendants((n, pos) => {
    if (n.type.name === "heading" && Number(n.attrs.level) <= 3 && n.textContent.trim()) out.push({ pos, level: Number(n.attrs.level), text: n.textContent.trim() });
    else if (n.type.name === "toggleSummary" && n.textContent.trim()) out.push({ pos, level: 2, text: n.textContent.trim() });
    return n.type.name !== "table" && n.type.name !== "pulseBlock";
  });
  return out;
}
// The empty doc's four starts (Codex concept 4): the same templates as Docs → New.
const STARTS = [{ key: "plan", label: "Plan", hint: "Goals, steps and who does what", icon: ListChecks }, { key: "report", label: "Report", hint: "Key numbers, what happened, next steps", icon: FileText },
  { key: "meeting", label: "Meeting notes", hint: "Agenda, decisions and actions", icon: Users }, { key: "analysis", label: "Analysis with charts", hint: "A question, big numbers and a chart", icon: BarChart3 }] as const;

export function DocView({ initial, open, company }: { initial: DocDetail; open?: Panel; company?: string }) {
  const router = useRouter();
  const at = useWhen();
  const [doc, setDoc] = useState(initial.doc);
  const [title, setTitle] = useState(initial.doc.title);
  const [panel, setPanel] = useState<Panel>(open ?? null);
  // DOCS-INTERACTIVE: requests (sent to me, sent by me), block answers, linked work and reading receipts.
  const [ix, setIx] = useState<Interactive | null>(null);
  const loadIx = useCallback(() => fetch(`/api/v0/docs/${initial.doc.id}/interactive`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null)
    .then((d: Interactive | null) => { if (d) setIx(d); }).catch(() => undefined), [initial.doc.id]);
  useEffect(() => { void loadIx(); }, [loadIx]);
  const paperRef = useRef<HTMLDivElement>(null);
  const rootOf = useCallback(() => paperRef.current, []);
  useReadTracking(initial.doc.id, rootOf, ix?.tracking === true, initial.doc.version);
  const blockHost = useMemo(() => ({ docId: initial.doc.id, answers: ix?.answers ?? [], canAnswer: !initial.doc.archived,
    onAnswers: (answers: Answer[]) => { setIx((x) => x ? { ...x, answers } : x); void loadIx(); } }), [initial.doc.id, initial.doc.archived, ix?.answers, loadIx]);
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
      version.current = r.version; setState({ text: `Saved ${at(r.updatedAt)}` }); setDoc((d) => ({ ...d, updatedAt: r.updatedAt }));
    } catch (e) {
      const message = fail(e);
      if (/changed this doc meanwhile/.test(message)) setConflict(message);
      else { pending.current = { ...body, ...pending.current }; setState({ tone: "bad", text: `Not saved: ${message}` }); }
    } finally {
      saving.current = false;
      if (pending.current.html !== undefined || pending.current.title !== undefined) timer.current = setTimeout(() => void flush(), 1000);
    }
  }, [doc.id, conflict, at]);
  const queue = useCallback((part: { html?: string; title?: string }) => {
    pending.current = { ...pending.current, ...part };
    setState({ text: "Editing…" });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 1000);
  }, [flush]);
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => { if (pending.current.html !== undefined || pending.current.title !== undefined) { void flush(); e.preventDefault(); } };
    // TASK-MERGE (Pip): a doc open in the chat's side panel is a frame; closing its tab removes the frame without
    // "beforeunload", and an ordinary request dies with it. The last words typed (under the 1 s wait) are sent with
    // keepalive, which outlives the page, when the page goes away; when it is only hidden they are saved at once.
    const away = () => {
      const body = pending.current; if (body.html === undefined && body.title === undefined) return;
      const json = JSON.stringify({ ...body, baseVersion: version.current });
      if (json.length > 60000) { void flush(); return; } // keepalive bodies are 64 KB at most
      pending.current = {}; if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      void fetch(`/api/v0/docs/${doc.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: json, keepalive: true })
        .then((r) => r.ok ? r.json() as Promise<{ version?: number }> : null).then((d) => { if (d?.version) version.current = d.version; }).catch(() => {});
    };
    const hidden = () => { if (document.visibilityState === "hidden") void flush(); };
    window.addEventListener("beforeunload", leave); window.addEventListener("pagehide", away); document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("beforeunload", leave); window.removeEventListener("pagehide", away); document.removeEventListener("visibilitychange", hidden); void flush(); };
  }, [flush, doc.id]);

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

  // DOCS-POLISH: read time, "On this page", the empty doc's templates and "Make this doc richer".
  const [minutes, setMinutes] = useState(() => readMinutes(plainText(initial.doc.html)));
  const [outline, setOutline] = useState<Heading[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [empty, setEmpty] = useState(() => !plainText(initial.doc.html).trim() && !/<(img|table|div data-type="pulse-block")/.test(initial.doc.html));
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const readMore = useCallback(() => {
    const ed = editorRef.current?.editor ?? null;
    setOutline(headingsOf(ed));
    // Still empty while "/" (from the "+") is being typed on the only line: the templates stay where they are.
    if (ed) { setMinutes(readMinutes(ed.state.doc.textContent)); setEmpty(ed.isEmpty || (ed.state.doc.childCount === 1 && /^\/[\p{L} ]*$/u.test(ed.state.doc.textContent))); }
  }, []);
  useEffect(() => { const t = setTimeout(readMore, 400); return () => clearTimeout(t); }, [readMore]);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readSoon = useCallback(() => { if (readTimer.current) clearTimeout(readTimer.current); readTimer.current = setTimeout(readMore, 600); }, [readMore]);
  useEffect(() => {
    if (outline.length < 3) return;
    let frame = 0;
    const spot = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      const ed = editorRef.current?.editor; if (!ed) return;
      let on: number | null = null;
      for (const h of outline) { const el = ed.view.nodeDOM(h.pos) as HTMLElement | null; if (el?.getBoundingClientRect && el.getBoundingClientRect().top < 140) on = h.pos; }
      setActive(on ?? outline[0].pos);
    }); };
    spot(); document.addEventListener("scroll", spot, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("scroll", spot, true); };
  }, [outline]);
  const goTo = (pos: number) => {
    const el = editorRef.current?.editor?.view.nodeDOM(pos) as HTMLElement | null;
    el?.scrollIntoView?.({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    setOutlineOpen(false);
  };
  const [richer, setRicher] = useState<RicherLook | null>(null);
  const [richerOpen, setRicherOpen] = useState(false);
  const dismissKey = `pulse:docs-richer-off:${initial.doc.id}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!initial.doc.canEdit || initial.doc.archived) return;
    let live = true;
    void lookRicher(initial.doc.id).then((l) => { if (live) { setRicher(l); try { setDismissed(localStorage.getItem(dismissKey)); } catch { /* private mode */ } } });
    return () => { live = false; };
  }, [initial.doc.id, initial.doc.canEdit, initial.doc.archived, dismissKey]);
  const offer = richer?.suggestions.filter((x) => x.on) ?? [];
  const offerKey = offer.map((x) => x.id).sort().join(",");
  const showOffer = doc.canEdit && !doc.archived && offer.length > 0 && dismissed !== offerKey;
  const applied = useCallback((done: RicherDone) => {
    const ed = editorRef.current?.editor;
    ed?.commands.setContent(done.html, { emitUpdate: false });
    version.current = done.version; pending.current = {};
    setRicher((x) => x ? { ...x, suggestions: [] } : x); readMore(); void refreshChips();
    setState({ text: "Saved" });
    const undo = done.undo;
    notify({ id: "docs-richer", tone: "success", title: "Your doc is richer", message: `Added ${upgradeWords(done.applied)}. Undo here or in History.`, timeout: 9000,
      ...(undo ? { action: { label: "Undo", run: () => { void post(`docs/${doc.id}/versions/${undo}/restore`).then(() => window.location.reload()).catch((e: unknown) => setState({ tone: "bad", text: fail(e) })); } } } : {}) });
  }, [doc.id, readMore, refreshChips]);
  async function startWith(key: string) {
    try {
      const res = await fetch(`/api/v0/docs/templates/${key}`, { cache: "no-store" }); const t = await res.json();
      if (!res.ok) throw new Error(t?.error ?? "That template is unavailable");
      const html = String(t.html ?? "").replace(/^\s*<h1>[\s\S]*?<\/h1>/, "");
      editorRef.current?.editor?.chain().setContent(html).focus("start").run();
      if (!title.trim() || /^untitled$/i.test(title.trim())) { setTitle(t.title); queue({ title: t.title }); }
      readMore();
    } catch (e) { setState({ tone: "bad", text: fail(e) }); }
  }

  async function exportMarkdown() {
    await flush();
    try {
      const r = await fetch(`/api/v0/docs/${doc.id}?format=markdown`, { cache: "no-store" });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error ?? "Export failed");
      const a = document.createElement("a");
      // DOCS-RICH: each chart and diagram goes with a picture of itself (and a diagram with its Mermaid code)
      const md = paperRef.current ? markdownWithPictures(String(data.markdown ?? ""), paperRef.current) : data.markdown;
      a.href = URL.createObjectURL(new Blob([`# ${title}\n\n${md}`], { type: "text/markdown" }));
      a.download = `${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "doc"}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { setState({ tone: "bad", text: fail(e) }); }
  }
  async function exportPdf() {
    await flush();
    const DOMPurify = (await import("dompurify")).default;
    // DOCS-RICH: blocks print as they look (charts and diagrams as SVG, big numbers, tables), toggles open, columns side by side.
    const body = editorRef.current?.editor?.getHTML() ?? doc.html;
    // DOCS-POLISH: a diagram's words sit in the SVG's foreignObject (Mermaid's labels): kept, as DOMPurify allows them only when asked.
    const html = DOMPurify.sanitize(readingHtml((paperRef.current ? printableHtml(body, paperRef.current) : body).replace(/<details\b/g, "<details open"), title),
      { FORBID_TAGS: ["style", "form", "input", "iframe", "script"], ADD_TAGS: ["foreignObject"], HTML_INTEGRATION_POINTS: { foreignobject: true, "annotation-xml": true } });
    const w = window.open("", "_blank", "width=900,height=1000");
    if (!w) { setState({ tone: "bad", text: "Allow pop-ups for Pulse to save a PDF" }); return; }
    const safe = (x: string) => x.replace(/[<>&"]/g, "");
    const safeTitle = safe(title);
    // DOCS-POLISH: the PDF opens with the same cover as the page (kind, title, who, when, company, read time).
    const meta = [doc.owner ? safe(doc.owner) : "", `Updated ${at(doc.updatedAt)}`, company ? safe(company) : "", `${minutes} min read`].filter(Boolean).join(" · ");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title><style>${PRINT_CSS}</style></head><body>`
      + `<header class="cover">${doc.category ? `<span class="chip">${safe(doc.category)}</span>` : ""}<h1>${safeTitle}</h1><p>${meta}</p></header>${html}</body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  }
  async function archive(on: boolean) {
    try { const r = await post<{ doc: Doc }>(`docs/${doc.id}/archive`, { archived: on }); setDoc((d) => ({ ...d, ...r.doc, html: d.html })); router.refresh(); } catch (e) { setState({ tone: "bad", text: fail(e) }); }
  }

  const toggle = (p: Panel) => setPanel((x) => x === p ? null : p);
  // The first heading that only repeats the title is hidden from readers (editor.tsx TitleRepeat), so not listed either.
  const same = (a: string) => a.replace(/\s+/g, " ").trim().toLowerCase();
  const toc = outline.filter((h) => !(h.pos === 0 && same(h.text) === same(title)));
  return <div className={css.wrap}>
    <div className={css.docTop}>
      <Crumbs folders={initial.folders} folderId={doc.folderId} />
      <span className={css.status} data-tone={state.tone} aria-live="polite">{state.text}</span>
      <span className={css.toolbarRow}>
        {doc.canShare || doc.canEdit ? <button type="button" className={`${css.btn} ${css.small} ${css.violet}`} onClick={() => toggle("send")} aria-pressed={panel === "send"}><Send size={15} aria-hidden="true" />Send for approval</button> : null}
        {ix && (ix.reads.length || ix.requests.some((r) => r.fromId === ix.me)) ? <button type="button" className={`${css.btn} ${css.small}`} onClick={() => toggle("reads")} aria-pressed={panel === "reads"}>
          <Eye size={15} aria-hidden="true" />Reads{ix.reads.length ? <span className={css.badge}>{ix.reads.length}</span> : null}</button> : null}
        {doc.canEdit && !doc.archived ? <button type="button" className={`${css.btn} ${css.small} ${css.richerBtn}`} onClick={() => setRicherOpen(true)}><Sparkles size={15} aria-hidden="true" />Make richer</button> : null}
        <button type="button" className={`${css.btn} ${css.small}`} onClick={() => toggle("links")} aria-pressed={panel === "links"}><Link2 size={15} aria-hidden="true" />Linked work{ix?.links.length ? <span className={css.badge}>{ix.links.length}</span> : null}</button>
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
    {ix?.forMe ? <AskBanner request={ix.forMe} onAnswered={() => void loadIx()} /> : null}
    <div className={css.docGrid} data-panel={panel ? "1" : undefined} data-rail={!panel && toc.length >= 3 ? "1" : undefined}>
      <div className={css.paper} ref={paperRef}>
        {/* DOCS-POLISH (Codex concept 1): a cover with the doc's kind, its title and one line of who, when, where and how long. */}
        <header className={css.cover}>
          {doc.category ? <span className={css.coverChip}>{doc.category}</span> : null}
          {/* A long title wraps (a one-line field cut it off on a phone); Enter goes on to the words. */}
          <textarea className={css.titleInput} value={title} readOnly={!doc.canEdit} aria-label="Title" maxLength={200} data-doc-title="" rows={1}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); editorRef.current?.editor?.commands.focus("start"); } }}
            onChange={(e) => { const v = e.target.value.replace(/[\r\n]+/g, " "); setTitle(v); if (v.trim()) queue({ title: v }); }} />
          <p className={css.byline}>
            {doc.owner ? <span className={css.who}><Avatar name={doc.owner} id={doc.createdBy} size={28} className={css.ownerFace} /><strong>{doc.owner}</strong></span> : null}
            <span className={css.meta}>
              <span>{doc.updatedBy && doc.updatedBy !== doc.owner ? `Changed by ${doc.updatedBy}, ` : "Updated "}<time dateTime={doc.updatedAt}>{at(doc.updatedAt)}</time></span>
              {company ? <span>{company}</span> : null}
              <span>{minutes} min read</span>
            </span>
            {ix?.tracking ? <TrackingChip from={ix.forMe?.from ?? null} /> : null}
          </p>
        </header>
        {/* On a phone the folder, tags and type fold behind one button, beside "On this page", so the words start sooner. */}
        <div className={css.underCover} data-open={labelsOpen ? "1" : undefined}>
          <div className={css.underRow}>
            <button type="button" className={`${css.pill} ${css.labelsToggle}`} aria-expanded={labelsOpen} onClick={() => setLabelsOpen((o) => !o)}><Tag size={15} aria-hidden="true" />Folder and tags<ChevronDown size={15} aria-hidden="true" /></button>
            {toc.length >= 3 ? <button type="button" className={`${css.pill} ${css.outlinePill}`} aria-expanded={outlineOpen} onClick={() => setOutlineOpen((o) => !o)}>On this page<ChevronDown size={15} aria-hidden="true" /></button> : null}
          </div>
          {outlineOpen && toc.length >= 3 ? <div className={css.outlineDrop}><Outline items={toc} active={active} onGo={goTo} /></div> : null}
          <div className={css.labelsBody}>
            <DocLabels doc={doc} folders={initial.folders} suggestions={initial.tags} categories={initial.categories}
              onSaved={(d) => setDoc((x) => ({ ...x, ...d }))} onError={(text) => setState({ tone: "bad", text: `Not saved: ${text}` })} />
          </div>
        </div>
        {showOffer ? <div className={css.offer} role="status">
          <Sparkles size={18} aria-hidden="true" className={css.richerSpark} />
          <span><strong>This doc can look better.</strong><span className={css.offerMore}> We found {upgradeWords(offer)} in what it already says.</span></span>
          <button type="button" className={`${css.btn} ${css.small} ${css.primary}`} onClick={() => setRicherOpen(true)}>{offer.length === 1 ? "See the upgrade" : `See the ${offer.length} upgrades`}</button>
          <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} aria-label="Not now" onClick={() => { setDismissed(offerKey); try { localStorage.setItem(dismissKey, offerKey); } catch { /* private mode */ } }}><X size={15} aria-hidden="true" /></button>
        </div> : null}
        {doc.canEdit && empty && !doc.archived ? <section className={css.starts} aria-label="Start with a template">
          <p className={css.startsHead}>Start with a template</p>
          <div className={css.startGrid}>{STARTS.map((t) => { const I = t.icon; return <button key={t.key} type="button" className={css.start} onClick={() => void startWith(t.key)}>
            <span className={css.startIcon}><I size={20} aria-hidden="true" /></span><strong>{t.label}</strong><small>{t.hint}</small></button>; })}</div>
          <p className={css.hint}>Or start writing below. Type / for charts, big numbers, diagrams and more.</p>
        </section> : null}
        <ChipContext.Provider value={chipApi}>
          <BlockHost.Provider value={blockHost}>
            <DocEditor ref={editorRef} html={initial.doc.html} editable={doc.canEdit && !conflict} onUpload={uploadImage} title={title}
              onChange={(html) => { queue({ html }); void refreshChips(); readSoon(); }} />
          </BlockHost.Provider>
        </ChipContext.Provider>
        {initial.files.length ? <div className={css.backlinks}><p className={css.sideHead}>Files in this doc</p>
          {initial.files.map((f) => <button key={f.id} type="button" className={`${css.btn} ${css.small} ${css.quiet}`} style={{ justifyContent: "flex-start" }}
            onClick={() => setViewing({ url: f.url, name: f.name, mime: f.mime, size: f.size })}><KindIcon kind="file" />{f.name}</button>)}</div> : null}
      </div>
      {!panel && toc.length >= 3 ? <nav className={css.outlineRail} aria-label="On this page"><p className={css.railHead}>On this page</p><Outline items={toc} active={active} onGo={goTo} /></nav> : null}
      {panel === "share" ? <SharePanel doc={doc} initial={initial.shares} onClose={() => setPanel(null)} onDoc={(d) => setDoc((x) => ({ ...x, ...d, html: x.html }))} /> : null}
      {panel === "comments" ? <CommentsPanel docId={doc.id} initial={initial.comments} canEdit={doc.canEdit} onClose={() => setPanel(null)} quote={() => {
        const ed = editorRef.current?.editor; if (!ed) return ""; const { from, to } = ed.state.selection; return ed.state.doc.textBetween(from, to, " ").slice(0, 500);
      }} /> : null}
      {panel === "send" ? <SendPanel docId={doc.id} ix={ix} onClose={() => setPanel(null)} onChanged={() => void loadIx()} beforeSend={flush} /> : null}
      {panel === "reads" ? <ReadsPanel ix={ix} onClose={() => setPanel(null)} onRefresh={() => void loadIx()} /> : null}
      {panel === "links" ? <LinksPanel docId={doc.id} links={ix?.links ?? []} canEdit={doc.canEdit} onClose={() => setPanel(null)} onLinks={(links) => setIx((x) => x ? { ...x, links } : x)} /> : null}
      {panel === "history" ? <HistoryPanel docId={doc.id} canEdit={doc.canEdit} onClose={() => setPanel(null)} onRestored={() => window.location.reload()} beforeRestore={flush}
        current={() => editorRef.current?.editor?.getHTML() ?? doc.html} /> : null}
    </div>
    {viewing ? <FileSidePanel key={viewing.url} file={viewing} onClose={() => setViewing(null)} /> : null}
    {doc.canEdit ? <RicherDialog docId={doc.id} open={richerOpen} onClose={() => setRicherOpen(false)} beforeLook={flush} onApplied={applied} /> : null}
  </div>;
}

function Outline({ items, active, onGo }: { items: Heading[]; active: number | null; onGo: (pos: number) => void }) {
  const top = Math.min(...items.map((h) => h.level));
  return <ol className={css.outline}>{items.map((h) => <li key={h.pos} data-depth={Math.min(2, h.level - top)}>
    <button type="button" aria-current={active === h.pos ? "location" : undefined} onClick={() => onGo(h.pos)}>{h.text}</button></li>)}</ol>;
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
      const r = await post<{ doc: Doc; shares: Share[] }>(`docs/${doc.id}/share`, { access, companyEdits, people: people.map((p) => ({ personId: p.personId, role: roleOf(p) })) });
      onDoc(r.doc); setPeople(r.shares); onClose();
    } catch (e) { setError(fail(e)); } finally { setBusy(false); }
  }
  if (!doc.canShare) return <aside className={css.panel}><PanelHead title="Who can see it" onClose={onClose} />
    <p className={css.hint}>{ACCESS_WORDS[doc.access]}{doc.access === "company" ? (doc.companyEdits ? ", and everyone may edit." : "; only its owner edits.") : ""}</p>
    {doc.access === "people" ? <ul className={css.list}>{initial.map((p) => <li key={p.personId}>{p.name}<span className={css.count}>{ROLE_LABEL[roleOf(p)]}</span></li>)}</ul> : null}
    <p className={css.hint}>{doc.owner ?? "The owner"} decides who it is shared with.</p></aside>;
  return <aside className={css.panel}>
    <PanelHead title="Share" onClose={onClose} />
    {(["private", "company", "people"] as const).map((a) => <label key={a} className={css.radio}><input type="radio" name="access" checked={access === a} onChange={() => setAccess(a)} />
      <span><strong>{ACCESS_WORDS[a]}</strong><br /><span className={css.hint}>{a === "private" ? "Only you see it." : a === "company" ? "Every staff member and AI employee finds and reads it." : "Only the people you add below."}</span></span></label>)}
    {access === "company" ? <label className={css.radio}><input type="checkbox" checked={companyEdits} onChange={(e) => setCompanyEdits(e.target.checked)} />Everyone may edit it (otherwise only you)</label> : null}
    {access === "people" ? <>
      <label className={css.field}>Add a person or AI employee<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a name" /></label>
      {(q.trim() ? hits : []).filter((h) => !people.some((p) => p.personId === h.id)).slice(0, 6).map((h) => <button key={h.id} type="button" className={`${css.btn} ${css.small} ${css.quiet}`} style={{ justifyContent: "flex-start" }}
        onClick={() => { setPeople((p) => [...p, { personId: h.id, name: h.label, side: h.kind === "agent" ? "agent" : "staff", canEdit: false, canComment: true }]); setQ(""); }}><KindIcon kind={h.kind} />{h.label}</button>)}
      {people.length ? <ul className={css.list}>{people.map((p) => <li key={p.personId}><span style={{ flex: 1 }}>{p.name}</span>
        <select value={roleOf(p)} aria-label={`What ${p.name} may do`} onChange={(e) => setPeople((all) => all.map((x) => x.personId === p.personId ? { ...x, canEdit: e.target.value === "edit", canComment: e.target.value !== "view" } : x))}>
          <option value="view">Can view</option><option value="comment">Can comment</option><option value="edit">Can edit</option></select>
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
  const when = useWhen();
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

function HistoryPanel({ docId, canEdit, onClose, onRestored, beforeRestore, current }: { docId: string; canEdit: boolean; onClose: () => void; onRestored: () => void; beforeRestore: () => Promise<void>; current: () => string }) {
  const confirm = useConfirm();
  const when = useWhen();
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [open, setOpen] = useState<{ id: string; html: string; changes: { kind: string; text: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void fetch(`/api/v0/docs/${docId}/versions`, { cache: "no-store" }).then((r) => r.json()).then((d) => setVersions(d.versions ?? [])).catch(() => setError("History is unavailable")); }, [docId]);
  async function look(id: string) {
    try {
      const r = await fetch(`/api/v0/docs/${docId}/versions/${id}`, { cache: "no-store" }); const d = await r.json();
      const DOMPurify = (await import("dompurify")).default;
      // DOCS-RICH: what changed since that version, block by block (a chart's type, series and rows; a diagram; a page) and in words.
      setOpen({ id, html: String(DOMPurify.sanitize(String(d.version?.html ?? ""), { FORBID_TAGS: ["style", "form", "input", "iframe"] })), changes: blockChanges(String(d.version?.html ?? ""), current()) });
    } catch { setError("That version could not be opened"); }
  }
  async function restore(id: string) {
    if (!(await confirm({ title: "Restore this version?", body: "The doc goes back to these words. What it says now is kept in History, so you can get it back.", confirmLabel: "Restore version" }))) return;
    await beforeRestore();
    try { await post(`docs/${docId}/versions/${id}/restore`); onRestored(); } catch (e) { setError(fail(e)); }
  }
  const why: Record<string, string> = { edit: "Edited", create: "Started", restore: "Restored", import: "Imported", enrich: "Made richer" };
  return <aside className={css.panel}>
    <PanelHead title="History" onClose={onClose} />
    {!versions ? <p className={css.hint}>Loading…</p> : versions.map((v) => <div key={v.id} className={css.comment}>
      <span><strong>{why[v.reason] ?? "Saved"}</strong> by {v.savedBy ?? "someone"}</span>
      <span className={css.who}>{when(v.savedAt)}{v.startedAt !== v.savedAt ? ` (from ${when(v.startedAt)})` : ""}</span>
      <span className={css.toolbarRow}>
        <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={() => void look(v.id)}>{open?.id === v.id ? "Shown below" : "Look"}</button>
        {canEdit ? <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={() => void restore(v.id)}>Restore</button> : null}
      </span>
      {open?.id === v.id ? <>
        <div className={css.hint}><strong>Changed since this version</strong>{open.changes.length ? <ul style={{ margin: "4px 0 8px", paddingLeft: 18 }}>{open.changes.map((c, i) => <li key={i} data-change={c.kind}>{c.text}</li>)}</ul> : <p style={{ margin: "4px 0 8px" }}>Nothing: it is the same as now.</p>}</div>
        <div className={`${css.preview} ${css.prose}`} dangerouslySetInnerHTML={{ __html: open.html }} /></> : null}
    </div>)}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
  </aside>;
}
