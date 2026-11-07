"use client";

// COMP-A: a pay letter's live preview. The browser fills the company's template and draws the PDF with the same code,
// fonts, design, logo and signature the API files when the decision is made (@pulse/invoice-doc's letter writer), then
// shows it with ERP's PDF.js pages: what HR reads here is what the person will receive.
import { useEffect, useRef, useState } from "react";
import { buildLetterModel, FONT_URLS, letterContent, renderLetterPdf, type Asset, type Fonts, type LetterData } from "@pulse/invoice-doc/browser";
import { PdfPages } from "../../erp/preview";
import erp from "../../erp/erp.module.css";

type Head = { design: unknown; company: { name: string; lines: string[] }; letters: Record<string, { title?: string; body?: string }>; logo: string | null; signature: string | null };
let head: Promise<Head | null> | null = null;
let fonts: Promise<Fonts> | null = null;
const loadFonts = () => (fonts ??= Promise.all([FONT_URLS.regular, FONT_URLS.semibold].map((u) => fetch(u).then((r) => r.arrayBuffer())))
  .then(([regular, semibold]) => ({ regular: new Uint8Array(regular), semibold: new Uint8Array(semibold) })));
const image = (url: string | null): Promise<Asset | null> => (url ? fetch(url).then(async (r) => {
  if (!r.ok) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  return bytes[0] === 0x89 ? { bytes, mime: "image/png" } : bytes[0] === 0xff ? { bytes, mime: "image/jpeg" } : null;
}).catch(() => null) : Promise.resolve(null));
const loadHead = () => (head ??= fetch("/api/v0/comp/letterhead").then((r) => (r.ok ? r.json() : null)).catch(() => null));

/** The letter for `kind` and `data` (from the API's preview), drawn 250 ms after the last change. */
export function LetterPreview({ kind, data, name, role, draft = true }: { kind: string; data: LetterData | null; name: string; role?: string | null; draft?: boolean }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [state, setState] = useState({ busy: true, pages: 0, error: "" });
  const key = JSON.stringify([kind, data, name, role, draft]);
  const last = useRef(key);
  useEffect(() => {
    last.current = key;
    if (!data) return;
    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, busy: true }));
      try {
        const [h, f] = await Promise.all([loadHead(), loadFonts()]);
        const [logo, signature] = await Promise.all([image(h?.logo ?? null), image(h?.signature ?? null)]);
        const company = h?.company ?? { name: "", lines: [] };
        const content = letterContent(kind, { ...data, company: company.name }, h?.letters ?? {});
        const today = new Date().toISOString().slice(0, 10);
        const r = await renderLetterPdf(buildLetterModel(h?.design ?? {}, { ...content, kind, date: today, reference: "Preview", to: { name, lines: [role ?? ""].filter(Boolean) }, company, accepted: null, draft },
          { logo, signature }), { fonts: f });
        if (last.current !== key) return;
        setBytes(r.bytes); setState({ busy: false, pages: r.pages, error: "" });
      } catch (e) { setState({ busy: false, pages: 0, error: e instanceof Error ? e.message : "The letter cannot be drawn yet" }); }
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <section className={erp.preview} aria-label="Letter preview" data-busy={state.busy ? "" : undefined}>
    <div className={erp.previewHead}><span>The letter</span><span className={erp.previewMeta} aria-live="polite">{!data ? "Fill in the change to see it" : state.error ? "Not drawn" : state.busy ? "Drawing…" : `${state.pages} ${state.pages === 1 ? "page" : "pages"} · as it will be sent`}</span></div>
    {state.error ? <p className={erp.previewNote} role="alert">{state.error}</p> : null}
    <PdfPages bytes={bytes} label="Letter preview" />
  </section>;
}
