"use client";

// ERP-INVOICE: the live preview. The browser builds the same model and the same PDF the API exports and files when a
// document is issued (@pulse/invoice-doc, same fonts, same code), then draws that PDF with PDF.js. What you see is the
// export itself, not an HTML imitation of it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { buildModel, FONT_URLS, renderPdf, type Asset, type DocumentInput, type Fonts } from "@pulse/invoice-doc/browser";
import css from "./erp.module.css";
import docs from "./documents/documents.module.css";

let fonts: Promise<Fonts> | null = null;
const loadFonts = () => (fonts ??= Promise.all([FONT_URLS.regular, FONT_URLS.semibold].map((u) => fetch(u).then((r) => r.arrayBuffer())))
  .then(([regular, semibold]) => ({ regular: new Uint8Array(regular), semibold: new Uint8Array(semibold) })));
const assets = new Map<string, Promise<Asset | null>>();
/** A template image by its ERP id ("org-logo" is the organisation's PNG logo). The type is read from its first bytes. */
export function loadAsset(id: string | null | undefined): Promise<Asset | null> {
  if (!id) return Promise.resolve(null);
  if (!assets.has(id)) assets.set(id, fetch(`/api/v0/erp/assets/${id}`).then(async (r) => {
    if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    const mime = bytes[0] === 0x89 && bytes[1] === 0x50 ? "image/png" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : null;
    return mime ? { bytes, mime } : null;
  }).catch(() => null));
  return assets.get(id)!;
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Promise<PdfJs> | null = null;
let worker: InstanceType<PdfJs["PDFWorker"]> | null = null;
const loadPdfjs = () => (pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((m) => { m.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString(); return m; }));

/** Renders `doc` with `design` to PDF bytes in the browser (the bytes the API would export for the same inputs). */
export async function previewPdf(design: unknown, doc: DocumentInput, logoId?: string | null, signatureId?: string | null) {
  const [f, logo, signature] = await Promise.all([loadFonts(), loadAsset(logoId), loadAsset(signatureId)]);
  return renderPdf(buildModel(design, doc, { logo, signature }), { fonts: f });
}

/** The pages of a PDF, drawn to fit the column. `bytes` changes → the pages are drawn again, the old ones stay until then. */
export function PdfPages({ bytes, label }: { bytes: Uint8Array | null; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!bytes || !box.current) return;
    let gone = false; let task: { destroy: () => Promise<void> } | null = null;
    (async () => {
      try {
        const m = await loadPdfjs();
        worker ??= new m.PDFWorker();
        const loading = m.getDocument({ data: bytes.slice(), worker }); task = loading;
        const doc = await loading.promise;
        const width = Math.max(280, box.current?.clientWidth ?? 600);
        const canvases: HTMLCanvasElement[] = [];
        for (let n = 1; n <= doc.numPages && !gone; n++) {
          const page = await doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          // At least 2x: small print stays legible on ordinary screens (the canvas is shown at the column width).
          const ratio = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
          const viewport = page.getViewport({ scale: (width / base.width) * ratio });
          const c = document.createElement("canvas");
          c.width = Math.round(viewport.width); c.height = Math.round(viewport.height);
          c.style.width = `${width}px`; c.style.height = `${Math.round(viewport.height / ratio)}px`;
          c.className = css.pdfPage; c.setAttribute("role", "img"); c.setAttribute("aria-label", `${label}, page ${n} of ${doc.numPages}`); c.dataset.pdfPage = String(n);
          await page.render({ canvas: c, canvasContext: c.getContext("2d")!, viewport }).promise;
          canvases.push(c);
        }
        if (gone || !box.current) return;
        box.current.replaceChildren(...canvases);
        box.current.dataset.pages = String(doc.numPages);
        box.current.dataset.drawn = "1";
        setError("");
      } catch (e) { if (!gone) setError(e instanceof Error ? e.message : "The preview could not be drawn"); }
    })();
    return () => { gone = true; void task?.destroy().catch(() => undefined); };
  }, [bytes, label]);
  return <div className={css.pdfWrap}>
    {error ? <p className={css.previewNote} role="alert">{error}</p> : null}
    <div ref={box} className={css.pdfPages} aria-live="polite" />
  </div>;
}

/** A live preview: re-renders 250 ms after the last change; shows the page count and whether it is up to date.
 *  Billing redesign (18 Oct): `note` says what it is ("Customer's copy · updates as you type"), `actions` sit in its head
 *  (Open PDF), and `bare` drops the card around it (inside the phone sheet). */
export function LivePreview({ design, doc, logoId, signatureId, label = "Preview", onBytes, note, actions, bare }: { design: unknown; doc: DocumentInput | null; logoId?: string | null; signatureId?: string | null; label?: string; onBytes?: (b: Uint8Array) => void; note?: ReactNode; actions?: ReactNode; bare?: boolean }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [state, setState] = useState<{ busy: boolean; pages: number; error: string }>({ busy: true, pages: 0, error: "" });
  const key = JSON.stringify([design, doc, logoId, signatureId]);
  const keep = useRef(onBytes);
  useEffect(() => { keep.current = onBytes; }, [onBytes]);
  useEffect(() => {
    if (!doc) return;
    let gone = false;
    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, busy: true }));
      try {
        const r = await previewPdf(design, doc, logoId, signatureId);
        if (gone) return;
        setBytes(r.bytes); keep.current?.(r.bytes);
        setState({ busy: false, pages: r.pages, error: "" });
      } catch (e) { if (!gone) setState({ busy: false, pages: 0, error: e instanceof Error ? e.message : "This document cannot be drawn yet" }); }
    }, 250);
    return () => { gone = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const meta = state.error ? "Not drawn" : state.busy ? "Drawing…" : `${state.pages} page${state.pages === 1 ? "" : "s"} · exactly as exported`;
  return <section className={bare ? docs.previewBare : css.preview} aria-label={label} data-busy={state.busy ? "" : undefined}>
    <div className={css.previewHead}>
      <span className={docs.previewTitle}>{label}{note ? <small>{note}</small> : null}</span>
      <span className={docs.previewTools}><span className={css.previewMeta} aria-live="polite">{meta}</span>{actions}</span>
    </div>
    {state.error ? <p className={css.previewNote} role="alert">{state.error}</p> : null}
    <PdfPages bytes={bytes} label={label} />
  </section>;
}
