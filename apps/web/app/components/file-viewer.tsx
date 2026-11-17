"use client";
// DOCS-WORKBENCH (owner, 6 Nov 2026: "if HTML is sent on chat, that HTML or any application viewer should be there …
// PDF reader, PPTX or any kind of file should be opened in side view"): one side panel that opens any file Pulse holds,
// in chats, docs and tasks. What runs where:
//   * HTML is never run on the app's origin. It is shown in an iframe with `sandbox` and no flags (no scripts, no
//     forms, no navigation), sanitised by DOMPurify first. "Allow scripts" is an explicit choice per file: the same
//     iframe then gets only `allow-scripts` (never allow-same-origin), so it runs in its own opaque origin with no
//     cookies, storage or Pulse session, and a CSP that refuses every network call, form and frame.
//   * PDFs are drawn by PDF.js; pictures, video and sound by the browser from a local copy of the bytes.
//   * Markdown is rendered and sanitised; code and text are highlighted (highlight.js escapes every character).
//   * Word (.docx) is drawn by docx-preview into the same sealed iframe; spreadsheets (.xlsx, .csv) as tables
//     (read-excel-file); slides (.pptx) as each slide's words (JSZip). Anything else, or too big, offers Download.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { Download, ExternalLink, FileWarning, ShieldAlert, X } from "lucide-react";
import css from "./file-viewer.module.css";

export type ViewFile = { url: string; name: string; mime?: string | null; size?: number | null };
type Kind = "pdf" | "image" | "video" | "audio" | "html" | "markdown" | "code" | "csv" | "docx" | "xlsx" | "pptx" | "other";
/** Larger files are offered as a download only (the viewer keeps the bytes in memory). */
export const PREVIEW_LIMIT = 30 * 1024 * 1024;

const CODE_EXT: Record<string, string> = { js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", jsx: "javascript", json: "json", py: "python",
  rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cs: "csharp", php: "php", sh: "bash", bash: "bash", ps1: "powershell",
  sql: "sql", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", xml: "xml", css: "css", scss: "scss", txt: "plaintext", log: "plaintext", env: "plaintext", dockerfile: "dockerfile" };

export function kindOf(name: string, mime?: string | null): Kind {
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "");
  const m = (mime ?? "").toLowerCase();
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp"].includes(ext)) return "image";
  if (m.startsWith("video/") || ["mp4", "webm", "mov", "m4v", "ogv"].includes(ext)) return "video";
  if (m.startsWith("audio/") || ["mp3", "m4a", "wav", "ogg", "oga", "aac", "opus"].includes(ext)) return "audio";
  if (m === "text/html" || ["html", "htm"].includes(ext)) return "html";
  if (m === "text/markdown" || ["md", "markdown"].includes(ext)) return "markdown";
  if (m === "text/csv" || ext === "csv") return "csv";
  if (ext === "docx" || m.includes("wordprocessingml")) return "docx";
  if (ext === "xlsx" || m.includes("spreadsheetml")) return "xlsx";
  if (ext === "pptx" || m.includes("presentationml")) return "pptx";
  if (ext in CODE_EXT || m.startsWith("text/") || m === "application/json" || m === "application/xml") return "code";
  return "other";
}

/** A sealed page for the iframe: a CSP that allows no network calls, forms or frames (and scripts only when asked). */
function sealed(html: string, scripts: boolean) {
  const csp = `default-src 'none'; img-src data: blob: https:; media-src data: blob: https:; style-src 'unsafe-inline' https:; font-src data: https:; connect-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'${scripts ? "; script-src 'unsafe-inline' https:" : ""}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base target="_blank"></head><body>${html}</body></html>`;
}

async function purify(html: string, whole = false) {
  const DOMPurify = (await import("dompurify")).default;
  return DOMPurify.sanitize(html, { WHOLE_DOCUMENT: whole, FORBID_TAGS: ["form", "input", "button", "textarea", "select", "iframe", "frame", "object", "embed", "base", "meta", "link"],
    FORBID_ATTR: ["srcdoc", "formaction", "action", "ping"], ALLOW_DATA_ATTR: false });
}

type Loaded = { state: "loading" } | { state: "error"; message: string } | { state: "big" } | { state: "ready"; bytes: ArrayBuffer; type: string };

/** The side panel. Escape or the close button closes it; on a phone it fills the screen. */
export function FileSidePanel({ file, onClose }: { file: ViewFile; onClose: () => void }) {
  const [fetched, setLoaded] = useState<Loaded>({ state: "loading" });
  const kind = kindOf(file.name, file.mime);
  const blocked: Loaded | null = kind === "other" ? { state: "error", message: "" } : file.size && file.size > PREVIEW_LIMIT ? { state: "big" } : null;
  const loaded = blocked ?? fetched;
  useEffect(() => {
    let gone = false;
    if (kind === "other" || (file.size && file.size > PREVIEW_LIMIT)) return;
    fetch(file.url, { cache: "no-store", credentials: "same-origin" }).then(async (r) => {
      if (!r.ok) throw new Error(r.status === 404 || r.status === 403 ? "This file is not one you can open." : "The file could not be loaded. Try again.");
      const len = Number(r.headers.get("content-length") ?? 0);
      if (len > PREVIEW_LIMIT) { if (!gone) setLoaded({ state: "big" }); return; }
      const bytes = await r.arrayBuffer();
      if (!gone) setLoaded(bytes.byteLength > PREVIEW_LIMIT ? { state: "big" } : { state: "ready", bytes, type: (file.mime || r.headers.get("content-type") || "").split(";")[0] });
    }).catch((e) => { if (!gone) setLoaded({ state: "error", message: e instanceof Error ? e.message : "The file could not be loaded." }); });
    return () => { gone = true; };
  }, [file.url, file.size, file.mime, kind]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const download = `${file.url}${file.url.includes("?") ? "&" : "?"}download=1`;
  const safeTab = ["pdf", "image", "video", "audio"].includes(kind);
  if (typeof document === "undefined") return null;
  return createPortal(<aside className={css.panel} role="dialog" aria-modal="false" aria-label={`Viewing ${file.name}`}>
    <header className={css.head}>
      <strong title={file.name}>{file.name}</strong>
      <span className={css.actions}>
        {safeTab ? <a className={css.icon} href={file.url} target="_blank" rel="noopener noreferrer" title="Open in a new tab" aria-label="Open in a new tab"><ExternalLink size={16} aria-hidden="true" /></a> : null}
        <a className={css.icon} href={download} download={file.name} title="Download" aria-label="Download"><Download size={16} aria-hidden="true" /></a>
        <button type="button" className={css.icon} onClick={onClose} title="Close" aria-label="Close"><X size={18} aria-hidden="true" /></button>
      </span>
    </header>
    <div className={css.body}>
      {loaded.state === "loading" ? <p className={css.note} aria-live="polite">Opening {file.name}…</p>
        : loaded.state === "big" ? <Fallback file={file} download={download} why="This file is too big to show here (30 MB at most)." />
        : loaded.state === "error" ? <Fallback file={file} download={download} why={loaded.message || "Pulse cannot show this kind of file here yet."} />
        : <Render kind={kind} file={file} bytes={loaded.bytes} type={loaded.type} download={download} />}
    </div>
  </aside>, document.body);
}

function Fallback({ file, download, why }: { file: ViewFile; download: string; why: string }) {
  return <div className={css.fallback}><FileWarning size={28} aria-hidden="true" /><p>{why}</p>
    <a className={css.btn} href={download} download={file.name}><Download size={16} aria-hidden="true" />Download {file.name}</a></div>;
}

function Render({ kind, file, bytes, type, download }: { kind: Kind; file: ViewFile; bytes: ArrayBuffer; type: string; download: string }) {
  if (kind === "image" || kind === "video" || kind === "audio") return <MediaView kind={kind} bytes={bytes} type={type || (kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg")} name={file.name} />;
  if (kind === "pdf") return <PdfView bytes={bytes} name={file.name} />;
  if (kind === "html") return <HtmlView text={new TextDecoder().decode(bytes)} />;
  if (kind === "markdown") return <MarkdownView text={new TextDecoder().decode(bytes)} />;
  if (kind === "code") return <CodeView text={new TextDecoder().decode(bytes)} name={file.name} />;
  if (kind === "csv") return <CsvView text={new TextDecoder().decode(bytes)} />;
  if (kind === "docx") return <DocxView bytes={bytes} file={file} download={download} />;
  if (kind === "xlsx") return <XlsxView bytes={bytes} file={file} download={download} />;
  if (kind === "pptx") return <PptxView bytes={bytes} file={file} download={download} />;
  return <Fallback file={file} download={download} why="Pulse cannot show this kind of file here yet." />;
}

function MediaView({ kind, bytes, type, name }: { kind: "image" | "video" | "audio"; bytes: ArrayBuffer; type: string; name: string }) {
  // Only picture, sound and video types become a local address: never HTML or anything that could run.
  const safe = /^(image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm|x-m4a|aac))$/.test(type) ? type : kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg";
  const src = useMemo(() => URL.createObjectURL(new Blob([bytes], { type: safe })), [bytes, safe]);
  useEffect(() => () => URL.revokeObjectURL(src), [src]);
  // eslint-disable-next-line @next/next/no-img-element
  if (kind === "image") return <img className={css.media} src={src} alt={name} />;
  if (kind === "video") return <video className={css.media} src={src} controls playsInline />;
  return <audio className={css.audio} src={src} controls />;
}

type PdfDoc = { numPages: number; getPage: (n: number) => Promise<{ getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: Record<string, unknown>) => { promise: Promise<void> } }>; destroy?: () => Promise<void> };
function PdfView({ bytes, name }: { bytes: ArrayBuffer; name: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [pages, setPages] = useState(0);
  useEffect(() => {
    let gone = false; let doc: PdfDoc | null = null;
    (async () => {
      const m = await import("pdfjs-dist/legacy/build/pdf.mjs");
      m.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
      doc = await m.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise as unknown as PdfDoc;
      if (gone || !box.current) return;
      const n = Math.min(doc.numPages, 300);
      setPages(doc.numPages);
      const width = Math.max(240, box.current.clientWidth - 8);
      for (let i = 1; i <= n && !gone; i++) {
        const page = await doc.getPage(i);
        const v1 = page.getViewport({ scale: 1 }); const scale = width / v1.width; const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const vp = page.getViewport({ scale: scale * dpr });
        const canvas = document.createElement("canvas"); canvas.width = vp.width; canvas.height = vp.height;
        canvas.style.width = `${width}px`; canvas.setAttribute("aria-label", `${name}, page ${i}`); canvas.className = css.page;
        box.current?.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, canvas }).promise;
      }
    })().catch((e) => { if (!gone) setError(e instanceof Error ? e.message : "This PDF could not be drawn"); });
    return () => { gone = true; void doc?.destroy?.().catch(() => undefined); if (box.current) box.current.innerHTML = ""; }; // eslint-disable-line react-hooks/exhaustive-deps
  }, [bytes, name]);
  return <>{error ? <p className={css.note} role="alert">{error}</p> : null}{pages > 300 ? <p className={css.note}>Showing the first 300 of {pages} pages. Download it for the rest.</p> : null}
    <div ref={box} className={css.pdf} /></>;
}

function HtmlView({ text }: { text: string }) {
  const [scripts, setScripts] = useState(false);
  const [safeDoc, setDoc] = useState<string | null>(null);
  const runDoc = useMemo(() => scripts ? sealed(text, true) : null, [text, scripts]);
  useEffect(() => {
    let gone = false;
    void purify(text, true).then((clean) => { if (!gone) setDoc(sealed(String(clean).replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, ""), false)); });
    return () => { gone = true; };
  }, [text]);
  const doc = runDoc ?? safeDoc;
  return <div className={css.htmlWrap}>
    <div className={css.bar}>
      <ShieldAlert size={16} aria-hidden="true" />
      {scripts ? <span>Scripts are running in a sealed sandbox: no Pulse session, no network, no forms.</span> : <span>Shown safely: scripts and forms are off.</span>}
      <button type="button" className={css.btn} onClick={() => setScripts((s) => !s)}>{scripts ? "Turn scripts off" : "Allow scripts"}</button>
    </div>
    {doc !== null ? <iframe key={scripts ? "run" : "safe"} className={css.frame} title="HTML preview" srcDoc={doc} sandbox={scripts ? "allow-scripts" : ""} referrerPolicy="no-referrer" /> : null}
  </div>;
}

function MarkdownView({ text }: { text: string }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let gone = false;
    void import("marked").then(async ({ marked }) => { const clean = await purify(marked.parse(text, { async: false, gfm: true }) as string); if (!gone) setHtml(String(clean)); });
    return () => { gone = true; };
  }, [text]);
  return <article className={css.prose} dangerouslySetInnerHTML={{ __html: html }} />;
}

function CodeView({ text, name }: { text: string; name: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const shown = text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  useEffect(() => {
    let gone = false;
    void import("highlight.js/lib/common").then(({ default: hljs }) => {
      const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "");
      const lang = CODE_EXT[ext];
      // highlight.js escapes every character of the file; only its own <span class> marks are added.
      const out = lang && lang !== "plaintext" && hljs.getLanguage(lang) ? hljs.highlight(shown, { language: lang, ignoreIllegals: true }).value
        : shown.length < 200_000 && !lang ? hljs.highlightAuto(shown).value : shown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      if (!gone) setHtml(out);
    });
    return () => { gone = true; };
  }, [shown, name]);
  return <>{text.length > shown.length ? <p className={css.note}>Showing the first 2 MB. Download it for the rest.</p> : null}
    <pre className={css.code}><code dangerouslySetInnerHTML={{ __html: html ?? "" }} /></pre></>;
}

function Table({ rows }: { rows: unknown[][] }) {
  const shown = rows.slice(0, 1000);
  const width = Math.min(60, Math.max(0, ...shown.map((r) => r.length)));
  const cell = (v: unknown) => v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  return <>{rows.length > shown.length ? <p className={css.note}>Showing the first 1,000 of {new Intl.NumberFormat("en-IN").format(rows.length)} rows.</p> : null}
    <div className={css.tableWrap}><table className={css.table}><tbody>{shown.map((r, i) => <tr key={i}>{Array.from({ length: width }, (_, j) => i === 0 ? <th key={j}>{cell(r[j])}</th> : <td key={j}>{cell(r[j])}</td>)}</tr>)}</tbody></table></div></>;
}

function CsvView({ text }: { text: string }) {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", quoted = false;
  for (let i = 0; i < text.length && rows.length <= 1001; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch; continue; }
    if (ch === '"') quoted = true; else if (ch === ",") { row.push(cur); cur = ""; } else if (ch === "\n") { row.push(cur.replace(/\r$/, "")); rows.push(row); row = []; cur = ""; } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return <Table rows={rows} />;
}

function DocxView({ bytes, file, download }: { bytes: ArrayBuffer; file: ViewFile; download: string }) {
  const [doc, setDoc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let gone = false;
    (async () => {
      const { renderAsync } = await import("docx-preview");
      const body = document.createElement("div"), styles = document.createElement("div");
      await renderAsync(new Blob([bytes]), body, styles, { inWrapper: true, ignoreLastRenderedPageBreak: true, useBase64URL: true, renderHeaders: true, renderFooters: true, experimental: false });
      const clean = await purify(`${styles.innerHTML}${body.innerHTML}`);
      if (!gone) setDoc(sealed(String(clean), false));
    })().catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; };
  }, [bytes]);
  if (failed) return <Fallback file={file} download={download} why="This Word file could not be drawn here." />;
  return doc === null ? <p className={css.note}>Drawing the document…</p> : <iframe className={css.frame} title={file.name} srcDoc={doc} sandbox="" referrerPolicy="no-referrer" />;
}

type Sheet = { name: string; rows: unknown[][] };
function XlsxView({ bytes, file, download }: { bytes: ArrayBuffer; file: ViewFile; download: string }) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [at, setAt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let gone = false;
    (async () => {
      const read = (await import("read-excel-file/browser")).default as unknown as (input: Blob) => Promise<{ sheet?: string; name?: string; data?: unknown[][] }[]>;
      const all = await read(new Blob([bytes]));
      if (!gone) setSheets(all.map((s, i) => ({ name: String(s.sheet ?? s.name ?? `Sheet ${i + 1}`), rows: Array.isArray(s.data) ? s.data : [] })));
    })().catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; };
  }, [bytes]);
  if (failed) return <Fallback file={file} download={download} why="This spreadsheet could not be read here." />;
  if (!sheets) return <p className={css.note}>Reading the sheets…</p>;
  return <>{sheets.length > 1 ? <div className={css.tabs} role="tablist">{sheets.map((s, i) => <button key={i} type="button" role="tab" aria-selected={i === at} onClick={() => setAt(i)}>{s.name}</button>)}</div> : null}
    <Table rows={sheets[at]?.rows ?? []} /></>;
}

function PptxView({ bytes, file, download }: { bytes: ArrayBuffer; file: ViewFile; download: string }) {
  const [slides, setSlides] = useState<string[][] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let gone = false;
    (async () => {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(bytes);
      const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0])).slice(0, 300);
      const out: string[][] = [];
      for (const n of names) {
        const xml = new DOMParser().parseFromString(await zip.files[n].async("text"), "application/xml");
        const paras = Array.from(xml.getElementsByTagName("a:p")).map((p) => Array.from(p.getElementsByTagName("a:t")).map((t) => t.textContent ?? "").join("")).filter((s) => s.trim());
        out.push(paras);
      }
      if (!gone) setSlides(out);
    })().catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; };
  }, [bytes]);
  if (failed) return <Fallback file={file} download={download} why="These slides could not be read here." />;
  if (!slides) return <p className={css.note}>Reading the slides…</p>;
  return <>
    <p className={css.note}>Each slide&apos;s words are shown here. Download the file to see its design.</p>
    {slides.map((s, i) => <section key={i} className={css.slide} aria-label={`Slide ${i + 1}`}><span className={css.slideNo}>Slide {i + 1}</span>
      {s.length ? s.map((p, j) => j === 0 ? <h3 key={j}>{p}</h3> : <p key={j}>{p}</p>) : <p className={css.note}>No words on this slide.</p>}</section>)}
  </>;
}

/** Open a file in the side panel from anywhere (a chat's file chip, a list), with no state of the caller's: the panel
 *  mounts itself and unmounts on close. Answers false for a file it cannot show, so the caller keeps its own link. */
let host: { root: Root; el: HTMLDivElement } | null = null;
export function openFileViewer(file: ViewFile): boolean {
  if (typeof document === "undefined" || kindOf(file.name, file.mime) === "other") return false;
  if (!host) { const el = document.createElement("div"); el.setAttribute("data-file-viewer", ""); document.body.appendChild(el); host = { root: createRoot(el), el }; }
  const close = () => host?.root.render(null);
  host.root.render(<FileSidePanel key={file.url} file={file} onClose={close} />);
  return true;
}
export const canView = (name: string, mime?: string | null) => kindOf(name, mime) !== "other";

/** A link-like button that opens a file in the side panel (its own state, so it drops in anywhere a file is listed). */
export function FileOpen({ file, className, children, title }: { file: ViewFile; className?: string; children: ReactNode; title?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={className ?? css.linkButton} title={title ?? `Open ${file.name}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}>{children}</button>
    {open ? <FileSidePanel file={file} onClose={() => setOpen(false)} /> : null}
  </>;
}
