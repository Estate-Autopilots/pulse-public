"use client";
// DOCS-RICH (owner, 9 Nov 2026: "Each time you make an HTML analysis, we should be able to upload that HTML and render it
// right there in the doc, and it should become editable"): a web page in a doc. Two ways in (Codex concept "rich-html"):
//  - Keep as interactive page: the page is the doc's file, shown in <iframe sandbox="allow-scripts"> from
//    /api/v0/docs/frames/:id, whose own policy (lib/doc-rich.mjs FRAME_CSP) gives it an opaque origin, no network but a
//    few public CDNs, no forms, pop-ups or top navigation. It cannot read Pulse's cookies, the doc or the API. It tells us
//    its height by postMessage, which is all we take from it (only from that frame, only a number).
//  - Turn into doc blocks: the API reads its headings, words, tables, numbers and charts into the doc's own blocks.
// "Edit code" changes the page (kept as a new file; the doc's history keeps the old one).
import { useEffect, useRef, useState, type DragEvent } from "react";
import { Code2, Expand, FileCode2, Layers, UploadCloud, X } from "lucide-react";
import { post } from "../../orgs/client";
import { FRAME_GROWS_PER_SECOND, FRAME_SANDBOX, frameHeight, framePath } from "../../lib/doc-rich.mjs";
import r from "./rich.module.css";

export type PageBlock = { kind: "html"; id: string; title?: string; fileId?: string; height?: number };
export type Found = { headings: number; paragraphs: number; lists: number; tables: number; charts: number; numbers: number; images: number; skipped: { charts: number; drawings: number; controls: number } };
const MAX_PAGE = 4 * 1024 * 1024;
const toBase64 = (s: string) => { const bytes = new TextEncoder().encode(s); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const fail = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
export const foundWords = (f: Found) => {
  const n = (k: number, one: string, many: string) => k ? `${k} ${k === 1 ? one : many}` : null;
  const got = [n(f.headings, "heading", "headings"), n(f.tables, "table", "tables"), n(f.charts, "chart", "charts"), n(f.numbers, "row of big numbers", "rows of big numbers"), n(f.paragraphs, "paragraph", "paragraphs")].filter(Boolean);
  const left = [n(f.skipped.charts, "chart drawn by code", "charts drawn by code"), n(f.skipped.drawings, "drawing", "drawings"), n(f.skipped.controls, "button or field", "buttons and fields")].filter(Boolean);
  return `${got.length ? `Found: ${got.join(", ")}.` : "Found no words or tables to copy."}${left.length ? ` Not copied: ${left.join(", ")} (they work in the interactive page).` : ""}`;
};

/** Keeps a page as a file of this doc; answers its id. */
export async function savePage(docId: string, name: string, html: string): Promise<string> {
  if (new Blob([html]).size > MAX_PAGE) throw new Error("A web page in a doc is 4 MB at most");
  const r2 = await post<{ file: { id: string } }>("docs/files", { docId, name: /\.html?$/i.test(name) ? name : `${name || "page"}.html`, mime: "text/html", data: toBase64(html) });
  return r2.file.id;
}
export const convertPage = (body: { html?: string; fileId?: string }) => post<{ title: string; html: string; found: Found }>("docs/convert-html", body);

/** The sealed frame, as tall as its page (up to 8000 px; a page that keeps growing stops). A page that sends its frame to
 *  another address (a second load) is put back, and the reader is told; after three tries it stays stopped. */
export function PageFrame({ fileId, title, full }: { fileId: string; title: string; full?: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);
  const loads = useRef(0);
  const [resets, setResets] = useState(0);
  const onLoad = () => { loads.current += 1; if (loads.current > 1) { loads.current = 0; setResets((n) => n + 1); } };
  useEffect(() => {
    let grows = 0, since = Date.now(), last = 0;
    const on = (e: MessageEvent) => {
      if (!ref.current || e.source !== ref.current.contentWindow) return; // only this frame; its origin is opaque ("null")
      const h = frameHeight(e.data); if (h === null) return;
      if (Date.now() - since > 1000) { since = Date.now(); grows = 0; }
      if (h > last && ++grows > FRAME_GROWS_PER_SECOND) return;
      last = h; setHeight(h);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [fileId]);
  if (resets > 3) return <p className={r.pageMissing} role="alert">This page kept trying to open another website, so it was stopped. Turn it into doc blocks, or edit its code.</p>;
  return <>
    {resets ? <p className={r.hint} role="status">This page tried to open another website. It was put back.</p> : null}
    <iframe key={resets} ref={ref} className={r.frame} src={framePath(fileId)} sandbox={FRAME_SANDBOX} referrerPolicy="no-referrer" allow="" loading="lazy" onLoad={onLoad}
      title={`Web page: ${title}`} style={full ? { height: "100%" } : { height }} />
  </>;
}

/** The block: the page, then what it is and what you can do with it. */
export function PageView({ block, canEdit, docId, onReplace, onConvert }: { block: PageBlock; canEdit: boolean; docId: string | null;
  onReplace: (fileId: string) => void; onConvert: (html: string) => void }) {
  const [full, setFull] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState(false);
  const fullRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (full) fullRef.current?.showModal(); else fullRef.current?.close(); }, [full]);
  if (!block.fileId) return <div className={r.pageMissing}>This web page is not saved yet. Remove the block and add the page again.</div>;
  const title = block.title || "Web page";
  async function editCode() {
    setBusy(true); setError(null);
    try { const res = await fetch(`${framePath(block.fileId!)}?source=1`, { cache: "no-store" }); if (!res.ok) throw new Error("The page could not be opened"); setCode(await res.text()); }
    catch (e) { setError(fail(e)); } finally { setBusy(false); }
  }
  async function saveCode() {
    if (!docId || code === null) return;
    setBusy(true); setError(null);
    try { onReplace(await savePage(docId, title, code)); setCode(null); } catch (e) { setError(fail(e)); } finally { setBusy(false); }
  }
  async function convert() {
    setBusy(true); setError(null);
    try { const out = await convertPage({ fileId: block.fileId }); if (!out.html.trim()) throw new Error("There were no words or tables to copy"); onConvert(out.html); }
    catch (e) { setError(fail(e)); } finally { setBusy(false); }
  }
  return <div className={r.page}>
    {code === null ? <PageFrame fileId={block.fileId} title={title} /> : <label className={r.field}>The page’s code (HTML). Saving keeps the old one in the doc’s history.
      <textarea className={r.code} rows={18} value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} /></label>}
    <div className={r.pageBar}>
      <span className={r.pageLabel}><FileCode2 size={15} aria-hidden="true" />{title} · sealed box
        <button type="button" className={r.infoBtn} aria-expanded={info} aria-label="What is a sealed box?" onClick={() => setInfo((x) => !x)}>i</button></span>
      {code !== null ? <>
        <button type="button" className={r.btn} onClick={() => setCode(null)} disabled={busy}>Cancel</button>
        <button type="button" className={`${r.btn} ${r.primary}`} onClick={() => void saveCode()} disabled={busy}>{busy ? "Saving…" : "Save the page"}</button>
      </> : <>
        {canEdit ? <button type="button" className={r.btn} onClick={() => void editCode()} disabled={busy}><Code2 size={15} aria-hidden="true" />Edit code</button> : null}
        {canEdit ? <button type="button" className={r.btn} onClick={() => void convert()} disabled={busy}><Layers size={15} aria-hidden="true" />{busy ? "Working…" : "Turn into doc blocks"}</button> : null}
        <button type="button" className={r.btn} onClick={() => setFull(true)}><Expand size={15} aria-hidden="true" />Full screen</button>
      </>}
    </div>
    {info ? <p className={r.hint}>The page runs in a sealed box: its buttons and charts work, but it cannot see your account, this doc or anything else in Vitals, and it cannot send anything anywhere.</p> : null}
    {error ? <p className={r.error} role="alert">{error}</p> : null}
    <dialog ref={fullRef} className={r.fullDialog} onClose={() => setFull(false)} aria-label={title}>
      <div className={r.fullBar}><strong>{title}</strong><button type="button" className={r.btn} onClick={() => setFull(false)}><X size={16} aria-hidden="true" />Close</button></div>
      {full ? <PageFrame fileId={block.fileId} title={title} full /> : null}
    </dialog>
  </div>;
}

/** Insert → Web page: drop or paste a page, see what it holds, keep it interactive or turn it into blocks. */
export function AddPageDialog({ open, docId, onClose, onKeep, onConvert }: { open: boolean; docId: string | null; onClose: () => void;
  onKeep: (b: { title: string; fileId: string }) => void; onConvert: (html: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState<{ name: string; html: string } | null>(null);
  const [pasting, setPasting] = useState(false);
  const [mode, setMode] = useState<"keep" | "convert">("keep");
  const [found, setFound] = useState<{ title: string; html: string; found: Found } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  useEffect(() => { if (open) { ref.current?.showModal(); } else ref.current?.close(); }, [open]);
  const close = () => { setPage(null); setFound(null); setError(null); setMode("keep"); setPasting(false); onClose(); };
  useEffect(() => {
    if (!page?.html.trim()) return;
    let live = true;
    const t = setTimeout(() => { void convertPage({ html: page.html }).then((f) => { if (live) setFound(f); }).catch(() => { if (live) setFound(null); }); }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [page]);
  async function pick(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (!/\.html?$/i.test(f.name) && f.type !== "text/html") { setError("Choose a web page: a file ending in .html"); return; }
    if (f.size > MAX_PAGE) { setError("A web page in a doc is 4 MB at most"); return; }
    setPage({ name: f.name, html: await f.text() }); setPasting(false);
  }
  async function add() {
    if (!page || !docId) return;
    setBusy(true); setError(null);
    try {
      if (mode === "keep") onKeep({ title: (found?.title || page.name.replace(/\.html?$/i, "")).slice(0, 120), fileId: await savePage(docId, page.name, page.html) });
      else { const out = shownFound ?? await convertPage({ html: page.html }); if (!out.html.trim()) throw new Error("There were no words or tables to copy. Keep it as an interactive page instead."); onConvert(out.html); }
      close();
    } catch (e) { setError(fail(e)); } finally { setBusy(false); }
  }
  const shownFound = page?.html.trim() ? found : null;
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); void pick(e.dataTransfer.files?.[0]); };
  return <dialog ref={ref} className={r.dialog} onClose={close} aria-labelledby="add-page-title">
    <div className={r.dialogHead}><h2 id="add-page-title">Add a web page</h2>
      <button type="button" className={r.iconBtn} aria-label="Close" onClick={close}><X size={18} aria-hidden="true" /></button></div>
    {!pasting ? <label className={r.drop} data-over={over ? "1" : undefined} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
      <UploadCloud size={28} aria-hidden="true" /><span>Drop an .html file here, or <u>choose one</u></span>
      <input type="file" accept=".html,.htm,text/html" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
    </label> : <label className={r.field}>Paste the page’s code
      <textarea className={r.code} rows={8} autoFocus value={page?.html ?? ""} spellCheck={false} placeholder="<!doctype html>…"
        onChange={(e) => setPage({ name: "Pasted page.html", html: e.target.value })} /></label>}
    <button type="button" className={r.linkBtn} onClick={() => { setPasting((x) => !x); setPage(null); }}>{pasting ? "Choose a file instead" : "Or paste the code"}</button>
    {page && !pasting ? <p className={r.fileRow}><FileCode2 size={16} aria-hidden="true" />{page.name} ({Math.max(1, Math.round(new Blob([page.html]).size / 1024))} KB)</p> : null}
    <div className={r.choices} role="radiogroup" aria-label="How to add it">
      <label className={r.choice} data-on={mode === "keep" ? "1" : undefined}><input type="radio" name="page-mode" checked={mode === "keep"} onChange={() => setMode("keep")} />
        <span><strong>Keep as interactive page</strong><small>It runs in a sealed box inside the doc; its buttons and charts still work.</small></span></label>
      <label className={r.choice} data-on={mode === "convert" ? "1" : undefined}><input type="radio" name="page-mode" checked={mode === "convert"} onChange={() => setMode("convert")} />
        <span><strong>Turn into doc blocks</strong><small>We copy its headings, text, tables and charts into the doc so you can edit them.</small></span></label>
    </div>
    {shownFound ? <p className={r.hint}>{foundWords(shownFound.found)}</p> : null}
    {error ? <p className={r.error} role="alert">{error}</p> : null}
    <div className={r.dialogFoot}>
      <button type="button" className={r.btn} onClick={close}>Cancel</button>
      <button type="button" className={`${r.btn} ${r.primary}`} disabled={!page?.html.trim() || busy || !docId} onClick={() => void add()}>{busy ? "Adding…" : "Add to doc"}</button>
    </div>
  </dialog>;
}
