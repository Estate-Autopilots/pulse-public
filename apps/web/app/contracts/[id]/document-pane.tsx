"use client";
// CONTRACTS-PRO (owner, 15 Nov 2026): "the contract page shows the document first". The agreement is drawn by the API
// as a typeset legal document (letterhead, parties, numbered clauses, schedules, signature blocks, page numbers) and
// shown here with Billing's PDF.js pages: the very bytes "Download PDF" gives, so the screen and the PDF never differ.
import { useEffect, useRef, useState } from "react";
import { PdfPages, type PdfOutline } from "../../erp/preview";
import pro from "./pro.module.css";

/** Where a part of the document is: its bookmark's title ("3. Fees and payment", "Schedule 1: …", "Parties"). */
export type Jump = { to: string; n: number } | null;
/** The bookmark for a part: the exact title, else the clause number ("3." / "Schedule 1"). */
export function findPart(o: PdfOutline, to: string) {
  const num = /^(\d+\.|Schedule \d+)/.exec(to)?.[1];
  return o.find((x) => x.title === to) ?? (num ? o.find((x) => x.title.startsWith(num)) : undefined);
}

/** The agreement's PDF, drawn page by page to the column's width. `stamp` changes → it is fetched again. `jump` scrolls to a part. */
export function DocumentPane({ id, stamp, title, jump = null }: { id: string; stamp: string; title: string; jump?: Jump }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [outline, setOutline] = useState<PdfOutline>([]);
  const pane = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!jump) return;
    const part = findPart(outline, jump.to);
    const el = part ? pane.current?.querySelector<HTMLElement>(`[data-pdf-page="${part.page}"]`) : null;
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); el.dataset.flash = String(jump.n); }
  }, [jump, outline]);
  const [state, setState] = useState<{ busy: boolean; error: string; pages: number }>({ busy: true, error: "", pages: 0 });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let gone = false;
    fetch(`/api/v0/contracts/${id}/pdf?inline=1&v=${encodeURIComponent(stamp)}`, { credentials: "same-origin" })
      .then(async (r) => { if (!r.ok) throw new Error("The document could not be drawn. Try again."); return new Uint8Array(await r.arrayBuffer()); })
      .then((b) => { if (!gone) { setBytes(b); setState({ busy: false, error: "", pages: countPages(b) }); } })
      .catch((e: unknown) => { if (!gone) setState({ busy: false, error: e instanceof Error ? e.message : "The document could not be drawn.", pages: 0 }); });
    return () => { gone = true; };
  }, [id, stamp, retry]);
  return <section ref={pane} className={pro.paper} aria-label={`${title}: the document`} data-busy={state.busy ? "" : undefined}>
    <p className={pro.paperHint}>Pinch to zoom, or use PDF to download it.</p>
    {state.busy && !bytes ? <div className={pro.paperSkeleton} aria-hidden="true"><span /><span /><span /><span /><span /></div> : null}
    {state.error ? <div className={pro.paperError} role="alert"><p>{state.error}</p><button type="button" onClick={() => { setState({ busy: true, error: "", pages: 0 }); setRetry((n) => n + 1); }}>Try again</button></div> : null}
    <PdfPages bytes={bytes} label={title} onOutline={setOutline} />
  </section>;
}
/** Pages in a PDF, read from its page objects (only for the label; PDF.js draws them). */
function countPages(b: Uint8Array) {
  const s = new TextDecoder("latin1").decode(b.subarray(0, Math.min(b.length, 2_000_000)));
  return (s.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/** A live preview of words not saved yet: the API draws them 600 ms after the last change. */
export function LivePaper({ id, title, body }: { id: string; title: string; body: string }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [note, setNote] = useState("Drawing…");
  useEffect(() => {
    let gone = false;
    const t = setTimeout(() => {
      setNote("Drawing…");
      fetch(`/api/v0/contracts/${id}/preview`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, body }) })
        .then(async (r) => { if (!r.ok) throw new Error("Not drawn yet"); return new Uint8Array(await r.arrayBuffer()); })
        .then((b) => { if (!gone) { setBytes(b); setNote("Exactly as the PDF"); } })
        .catch(() => { if (!gone) setNote("Not drawn yet: keep typing"); });
    }, 600);
    return () => { gone = true; clearTimeout(t); };
  }, [id, title, body]);
  return <section className={pro.livePaper} aria-label="Preview">
    <p className={pro.liveNote} aria-live="polite">{note}</p>
    {!bytes ? <div className={pro.paperSkeleton} aria-hidden="true"><span /><span /><span /><span /><span /></div> : null}
    <PdfPages bytes={bytes} label="Preview" />
  </section>;
}
