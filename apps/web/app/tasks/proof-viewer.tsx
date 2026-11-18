"use client";
// TASKS-P0: proof opens inside Pulse. PDFs are drawn by PDF.js (page thumbnails, zoom), images inline; anything else
// offers Download. The drawer lives in the address (?proof=<id>), so Back closes it and a link opens it directly.
// Access is the API's: the bytes come from the same /api/v0/tasks/proof/<id> route as "Open in a new tab".
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Download, ExternalLink, FileLock2, FileText, Image as ImageIcon, Link2, Lock, Minus, Paperclip, Plus, X } from "lucide-react";
import { protectedFor } from "./chips";
import css from "./focus.module.css";

export type ProofItem = { id: string; kind: "link" | "file" | "document"; label: string; url: string | null; readable?: boolean; concerns?: string | null; addedBy?: string | null; addedAt?: string;
  /** POLISH-1: where the bytes come from when not a task's proof (e.g. a person's protected documents); titled "Document". */
  src?: string };
type Loaded = { state: "loading"; progress?: number } | { state: "pdf"; bytes: Uint8Array } | { state: "image"; src: string } | { state: "other"; type: string } | { state: "error"; message: string };

export const proofHref = (id: string) => `/api/v0/tasks/proof/${id}`;
const hrefOf = (proof: ProofItem) => proof.src ?? proofHref(proof.id);
// POLISH-1: the last few files opened on this page stay in memory (never stored), so opening one again is instant.
const recent = new Map<string, { type: string; bytes: Uint8Array<ArrayBuffer> }>();
function remember(href: string, file: { type: string; bytes: Uint8Array<ArrayBuffer> }) { recent.delete(href); recent.set(href, file); while (recent.size > 3) recent.delete(recent.keys().next().value!); }

// Whether this page pushed the drawer's address (then closing goes Back), or it was opened from a link (then the
// address just drops ?proof).
let pushed = false;
function setProofParam(id: string | null) {
  pushed = !!id;
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("proof", id); else url.searchParams.delete("proof");
  window.history[id ? "pushState" : "replaceState"](null, "", url);
  window.dispatchEvent(new Event("pulse:proof"));
}
/** The proof id in the address, kept in step with Back and Forward (none while rendering on the server). */
function subscribe(changed: () => void) {
  window.addEventListener("popstate", changed); window.addEventListener("pulse:proof", changed);
  return () => { window.removeEventListener("popstate", changed); window.removeEventListener("pulse:proof", changed); };
}
const useProofParam = () => useSyncExternalStore(subscribe, () => new URL(window.location.href).searchParams.get("proof"), () => null);

/** A proof row's title: links open their page; files and documents open the viewer. */
export function ProofOpen({ proof, className, children }: { proof: ProofItem; className?: string; children?: ReactNode }) {
  if (proof.kind === "link") return <a className={className} href={proof.url!} target="_blank" rel="noreferrer">{children ?? proof.label}</a>;
  return <a className={className} href={`?proof=${proof.id}`} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); setProofParam(proof.id); }}
    aria-haspopup="dialog">{children ?? proof.label}</a>;
}
export function ProofIcon({ proof, size = 16 }: { proof: ProofItem; size?: number }) {
  return proof.kind === "document" ? <FileLock2 size={size} aria-hidden="true" /> : proof.kind === "file" ? <Paperclip size={size} aria-hidden="true" /> : <Link2 size={size} aria-hidden="true" />;
}

/** Mount once per page with the task's proof; it opens when the address names one of them. */
export function ProofViewer({ proofs }: { proofs: ProofItem[] }) {
  const id = useProofParam();
  const proof = proofs.find((p) => p.id === id && p.kind !== "link") ?? null;
  const close = useCallback(() => { if (pushed) { pushed = false; window.history.back(); } else setProofParam(null); }, []);
  if (!proof) return null;
  return createPortal(<ViewerDrawer key={proof.id} proof={proof} onClose={close} />, document.body);
}

function ViewerDrawer({ proof, onClose }: { proof: ProofItem; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>(proof.kind === "document" && proof.readable === false ? { state: "error", message: "locked" } : { state: "loading" });
  const [zoom, setZoom] = useState(1);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (proof.kind === "document" && proof.readable === false) return;
    let gone = false; let objectUrl: string | null = null;
    (async () => {
      try {
        const href = hrefOf(proof); let file = recent.get(href);
        if (!file) {
          const r = await fetch(href, { cache: "no-store" });
          if (!r.ok) { const body = await r.json().catch(() => null); throw new Error(body?.error ?? "This file could not be opened"); }
          // Read as it arrives, so a large file on a phone shows how far it has come.
          const total = Number(r.headers.get("content-length")) || 0, reader = r.body?.getReader(), parts: Uint8Array[] = []; let got = 0;
          if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; if (total && !gone) setLoaded({ state: "loading", progress: Math.min(1, got / total) }); }
          const bytes = reader ? new Uint8Array(got) : new Uint8Array(await r.arrayBuffer()); if (reader) { let at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; } }
          file = { type: (r.headers.get("content-type") ?? "").split(";")[0], bytes }; remember(href, file);
        }
        const { type, bytes } = file;
        if (gone) return;
        if (type === "application/pdf" || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) setLoaded({ state: "pdf", bytes });
        else if (/^image\/(png|jpeg|gif|webp)$/.test(type)) { objectUrl = URL.createObjectURL(new Blob([bytes], { type })); setLoaded({ state: "image", src: objectUrl }); }
        else setLoaded({ state: "other", type });
      } catch (e) { if (!gone) setLoaded({ state: "error", message: e instanceof Error ? e.message : "This file could not be opened" }); }
    })();
    return () => { gone = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [proof]);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } else if ((e.key === "+" || e.key === "=") && !e.metaKey && !e.ctrlKey) setZoom((z) => Math.min(3, z + 0.25)); else if (e.key === "-" && !e.metaKey && !e.ctrlKey) setZoom((z) => Math.max(0.5, z - 0.25)); };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); before?.focus?.(); };
  }, [onClose]);
  const guard = protectedFor(proof);
  const zoomable = loaded.state === "pdf" || loaded.state === "image";
  return <div className={css.viewerBackdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={panel} className={css.viewer} role="dialog" aria-modal="true" aria-label={`${proof.src ? "Document" : "Proof"}: ${proof.label}`} tabIndex={-1}>
      <header className={css.viewerHead}>
        <span className={css.viewerIcon}>{loaded.state === "image" ? <ImageIcon size={18} aria-hidden="true" /> : proof.kind === "document" ? <FileLock2 size={18} aria-hidden="true" /> : <FileText size={18} aria-hidden="true" />}</span>
        <div className={css.viewerTitle}><h2 title={proof.label}>{proof.label}</h2>
          <p>{guard ? <span className={css.guard}><Lock size={12} aria-hidden="true" />{guard}</span> : null}{proof.addedBy ? <span>Added by {proof.addedBy}</span> : null}</p></div>
        <div className={css.viewerTools}>
          {zoomable ? <span className={css.zoom} role="group" aria-label="Zoom">
            <button type="button" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} aria-label="Zoom out" disabled={zoom <= 0.5}><Minus size={14} /></button>
            <output aria-live="polite">{Math.round(zoom * 100)}%</output>
            <button type="button" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} aria-label="Zoom in" disabled={zoom >= 3}><Plus size={14} /></button></span> : null}
          {loaded.state !== "error" || loaded.message !== "locked" ? <>
            <a className={css.viewerBtn} href={hrefOf(proof)} download={proof.label}><Download size={14} aria-hidden="true" /><span>Download</span></a>
            <a className={css.viewerBtn} href={hrefOf(proof)} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" /><span>Open in a new tab</span></a></> : null}
          <button type="button" className={css.viewerClose} onClick={onClose} aria-label={proof.src ? "Close" : "Close the proof"}><X size={18} /></button>
        </div>
      </header>
      <div className={css.viewerBody}>
        {loaded.state === "loading" ? <p className={css.viewerNote} aria-live="polite">Opening {proof.label}…{loaded.progress ? ` ${Math.round(loaded.progress * 100)}%` : ""}</p>
          : loaded.state === "pdf" ? <PdfPages bytes={loaded.bytes} zoom={zoom} label={proof.label} />
          : loaded.state === "image" ? <div className={css.imageWrap}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a private blob of the proof, not a public asset */}
            <img src={loaded.src} alt={proof.label} style={{ width: `${zoom * 100}%` }} /></div>
          : loaded.state === "other" ? <div className={css.viewerNote}><b>This kind of file opens in its own app.</b><span>Download it to open it.</span><a className={css.viewerBtn} href={hrefOf(proof)} download={proof.label}><Download size={14} aria-hidden="true" />Download</a></div>
          : loaded.message === "locked" ? <div className={css.viewerNote}><Lock size={22} aria-hidden="true" /><b>You can’t open this document.</b><span>Only HR, the founders and the person it concerns can see it.</span></div>
          : <div className={css.viewerNote} role="alert"><b>{loaded.message}</b><span>Try again, or download it.</span></div>}
      </div>
    </div>
  </div>;
}

type PdfDoc = { numPages: number; getPage: (n: number) => Promise<PdfPage> };
type PdfPage = { getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: Record<string, unknown>) => { promise: Promise<void>; cancel: () => void } };
// PDF.js's legacy build: the same viewer with polyfills, so phones and older browsers draw PDFs too (the modern build
// needs Map.prototype.getOrInsertComputed, which many browsers do not have yet).
let pdfjs: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;
let worker: InstanceType<Awaited<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>["PDFWorker"]> | null = null;
// POLISH-1: later pages start drawing once page 1 is on screen, so the first view is never queued behind them.
const firstDrawn = new WeakMap<object, { promise: Promise<void>; done: () => void }>();
function firstOf(doc: object) {
  let entry = firstDrawn.get(doc);
  if (!entry) { let done = () => {}; const promise = new Promise<void>((r) => { done = r; }); entry = { promise, done }; firstDrawn.set(doc, entry); }
  return entry;
}
function loadPdfjs() {
  pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((m) => { m.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString(); return m; });
  return pdfjs;
}

/** Every page, drawn when it scrolls near view; thumbnails beside them on wide screens. */
function PdfPages({ bytes, zoom, label }: { bytes: Uint8Array; zoom: number; label: string }) {
  const [doc, setDoc] = useState<PdfDoc | null>(null), [error, setError] = useState(""), [sizes, setSizes] = useState<{ w: number; h: number }[]>([]), [current, setCurrent] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The loading task owns the worker and the document: destroying it on close frees both.
    let gone = false; let opened: PdfDoc | null = null; let task: { destroy: () => Promise<void> } | null = null;
    loadPdfjs().then(async (m) => {
      // POLISH-1: one worker for every file opened on this page (starting a worker for each cost about half a second).
      worker ??= new m.PDFWorker();
      const loading = m.getDocument({ data: bytes.slice(), worker }); task = loading;
      opened = await loading.promise as unknown as PdfDoc;
      // POLISH-1: page 1 is drawn as soon as it is known; the other pages take its size until their own is read
      // (a long scan used to show nothing until every page had been measured).
      const first = (await opened.getPage(1)).getViewport({ scale: 1 });
      const all = Array.from({ length: opened.numPages }, () => ({ w: first.width, h: first.height }));
      if (gone) return;
      setSizes(all); setDoc(opened);
      for (let n = 2; n <= opened.numPages && !gone; n++) {
        const v = (await opened.getPage(n)).getViewport({ scale: 1 });
        if (v.width !== first.width || v.height !== first.height) { all[n - 1] = { w: v.width, h: v.height }; if (!gone) setSizes([...all]); }
      }
    }).catch((e) => { if (!gone) setError(e instanceof Error ? e.message : "This PDF could not be drawn"); });
    return () => { gone = true; void task?.destroy().catch(() => undefined); };
  }, [bytes]);
  const go = useCallback((n: number) => { scroller.current?.querySelector<HTMLElement>(`[data-page="${n}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }); }, []);
  if (error) return <p className={css.viewerNote} role="alert">{error}</p>;
  if (!doc) return <p className={css.viewerNote} aria-live="polite">Drawing {label}…</p>;
  return <div className={css.pdf}>
    <nav className={css.thumbs} aria-label="Pages">{sizes.map((s, i) => <button key={i} type="button" className={css.thumb} aria-current={current === i + 1 ? "page" : undefined} onClick={() => go(i + 1)} aria-label={`Page ${i + 1}`}>
      <PdfCanvas doc={doc} n={i + 1} width={96} size={s} root={null} /><span>{i + 1}</span></button>)}</nav>
    <div className={css.pages} ref={scroller} onScroll={(e) => { const top = e.currentTarget.scrollTop + 40; let n = 1; for (const el of e.currentTarget.querySelectorAll<HTMLElement>("[data-page]")) if (el.offsetTop <= top) n = Number(el.dataset.page); setCurrent(n); }}>
      <p className={css.pageCount} aria-live="polite">Page {current} of {doc.numPages}</p>
      {sizes.map((s, i) => <div key={i} className={css.page} data-page={i + 1}><PdfCanvas doc={doc} n={i + 1} width={Math.round(Math.min(860, s.w * 1.25) * zoom)} size={s} root={scroller} label={`${label}, page ${i + 1}`} /></div>)}
    </div>
  </div>;
}

function PdfCanvas({ doc, n, width, size, root, label }: { doc: PdfDoc; n: number; width: number; size: { w: number; h: number }; root: RefObject<HTMLDivElement | null> | null; label?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(n <= 2);
  const height = Math.round(width * size.h / size.w);
  useEffect(() => {
    const el = canvas.current; if (!el || near) return;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) setNear(true); }, { root: root?.current ?? null, rootMargin: "600px 0px" });
    io.observe(el); return () => io.disconnect();
  }, [near, root]);
  useEffect(() => {
    const el = canvas.current; if (!el || !near) return;
    let task: { promise: Promise<void>; cancel: () => void } | null = null; let gone = false;
    // A hidden canvas (the page thumbnails on a phone) is not drawn at all.
    if (!el.offsetParent) return;
    (async () => {
      if (n > 1) await Promise.race([firstOf(doc).promise, new Promise((r) => setTimeout(r, 1500))]);
      const page = await doc.getPage(n); if (gone) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      // POLISH-1: page 1 appears at 1x first (a quarter of the pixels on a phone), then sharp at the screen's density.
      for (const r of n === 1 && ratio > 1 ? [1, ratio] : [ratio]) {
        if (gone) return;
        const viewport = page.getViewport({ scale: (width / size.w) * r });
        // Drawn off screen and then copied in, so the 1x picture stays until the sharp one is ready.
        const target = document.createElement("canvas");
        target.width = Math.round(viewport.width); target.height = Math.round(viewport.height);
        task = page.render({ canvas: target, canvasContext: target.getContext("2d"), viewport });
        await task.promise.catch(() => undefined);
        if (gone) return;
        el.width = target.width; el.height = target.height; el.getContext("2d")?.drawImage(target, 0, 0);
        el.dataset.drawn = "1";
        if (n === 1) firstOf(doc).done();
      }
    })();
    return () => { gone = true; task?.cancel(); };
  }, [doc, n, width, size.w, near]);
  return <canvas ref={canvas} style={{ width, height }} data-pdf-page={n} aria-label={label} role={label ? "img" : undefined} />;
}
