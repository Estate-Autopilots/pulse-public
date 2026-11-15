"use client";
// CONTRACTS-2 (owner, 8 Nov 2026): the signing sheet, the same on the client's link and inside Vitals OS (the chosen
// concept: a bottom sheet with two tabs, "Type your name" and "Draw", a preview, "I agree", and one big "Sign now").
// The full name is always typed (it is the name on the audit page); a drawing is optional and stays small (PNG, ≤ 600px).
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Camera, X } from "lucide-react";
import { pngBytesOf, pngDataUrl, pngWithVector, scriptSignature } from "@pulse/invoice-doc/browser";
import { cleanSignature, signatureSvg, tracePaths } from "../lib/signature-clean.mjs";
import css from "./sign.module.css";

export type Signature = { name: string; kind: "typed" | "drawn" | "uploaded"; image: string | null; agree: boolean };

/** POLISH-1115: the PNG kept with its vector written inside it (the PDF draws the vector, crisp and on the line); a
 *  vector that would make the picture too big to keep is left out, and the PNG prints as it is. */
const round1 = (d: string) => d.replace(/-?\d+\.\d+/g, (n) => String(Math.round(Number(n) * 10) / 10));
function withVector(png: string, vector: { box: number[]; d: string[]; stroke?: number } | null) {
  const bytes = pngBytesOf(png);
  if (!bytes || !vector) return png;
  const out = pngDataUrl(pngWithVector(bytes, { v: 1, ...vector, d: vector.d.map(round1) }));
  return out.length < 190_000 ? out : png;
}

/** CONTRACTS-PRO: a photo of a signature, cleaned on this device: the vector preview (SVG) and the PNG kept (drawn from it at 2×). */
type Cleaned = { photo: string; svg: string; png: string };
async function cleanPhoto(file: File, darker: number): Promise<Cleaned | null> {
  const photo = URL.createObjectURL(file);
  const img = await new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("That file is not a photo we can read. Try a JPG or PNG.")); i.src = photo; });
  const k = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const g = c.getContext("2d", { willReadFrequently: true }); if (!g) return null;
  g.drawImage(img, 0, 0, c.width, c.height);
  const m = cleanSignature(g.getImageData(0, 0, c.width, c.height), { darker });
  if (!m.found) return null;
  const paths = tracePaths(m.mask, m.width, m.height);
  const svg = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(signatureSvg(paths, m.width, m.height, m.ink))}`;
  // The kept picture: the vector drawn at up to 600 × 200, on a clear background.
  const s = Math.min(600 / m.width, 200 / m.height, 3);
  const out = document.createElement("canvas"); out.width = Math.max(1, Math.round(m.width * s)); out.height = Math.max(1, Math.round(m.height * s));
  const o = out.getContext("2d"); if (!o) return null;
  o.scale(s, s); o.fillStyle = `rgb(${m.ink.join(",")})`;
  for (const d of paths) o.fill(new Path2D(d), "evenodd");
  return { photo, svg, png: withVector(out.toDataURL("image/png"), { box: [0, 0, m.width, m.height], d: paths }) };
}

/** CONTRACTS-PRO: a typed name written as handwriting (the same Hershey script strokes the PDF draws); a name the face
 *  cannot write (accents, other scripts) is shown in a cursive type instead. */
export function TypedSignature({ name, className }: { name: string; className?: string }) {
  const s = scriptSignature(name);
  if (!s) return <span className={`${css.script} ${className ?? ""}`}>{name}</span>;
  return <svg className={`${css.typed} ${className ?? ""}`} viewBox={`-2 -2 ${s.width + 4} ${s.height + 4}`} role="img" aria-label={`Signature: ${name}`}>
    <path d={s.d} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

/** A drawn signature as it was kept (a small data: PNG). */
export function SignatureImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- a drawn signature is a small data: PNG; there is nothing to optimise
  return <img src={src} alt={alt} className={className} />;
}

export function SignSheet({ signer, what, onSign, onClose }: { signer: string; what: string; onSign: (s: Signature) => Promise<void>; onClose: () => void }) {
  const [tab, setTab] = useState<"typed" | "drawn" | "uploaded">("drawn");
  const [file, setFile] = useState<File | null>(null);
  const [darker, setDarker] = useState(0);
  const [cleaned, setCleaned] = useState<Cleaned | null | "none">(null);
  const [cleaning, setCleaning] = useState(false);
  const [name, setName] = useState(signer);
  const [agree, setAgree] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const prev = useRef<{ x: number; y: number } | null>(null);
  // POLISH-1115: the strokes as SVG paths too (the same mid-point curves the pad draws), so the PDF prints them as lines.
  const strokes = useRef<string[]>([]);
  const bounds = useRef<[number, number, number, number] | null>(null);
  const grow = (...ps: { x: number; y: number }[]) => { for (const p of ps) { const b = bounds.current; bounds.current = b ? [Math.min(b[0], p.x), Math.min(b[1], p.y), Math.max(b[2], p.x), Math.max(b[3], p.y)] : [p.x, p.y, p.x, p.y]; } };
  const f1 = (n: number) => Math.round(n * 10) / 10;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || tab !== "drawn") return;
    const r = c.getBoundingClientRect(), ratio = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(r.width * ratio); c.height = Math.round(r.height * ratio);
    const g = c.getContext("2d");
    if (g) { g.scale(ratio, ratio); g.lineWidth = 2.4; g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = "#1e1b2e"; }
    strokes.current = []; bounds.current = null;
    setDrawn(false);
  }, [tab]);

  const point = (e: ReactPointerEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function down(e: ReactPointerEvent<HTMLCanvasElement>) { e.currentTarget.setPointerCapture(e.pointerId); last.current = point(e); prev.current = last.current; strokes.current.push(`M${f1(last.current.x)} ${f1(last.current.y)}`); }
  function move(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!last.current) return;
    const g = e.currentTarget.getContext("2d"), p = point(e);
    if (!g) return;
    // Smooth strokes: a curve through the mid-points (as signature pads draw), not a chain of straight segments.
    const a = prev.current ?? last.current, b = last.current, m0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, m1 = { x: (b.x + p.x) / 2, y: (b.y + p.y) / 2 };
    g.beginPath(); g.moveTo(m0.x, m0.y); g.quadraticCurveTo(b.x, b.y, m1.x, m1.y); g.stroke();
    const k = strokes.current.length - 1; if (k >= 0) strokes.current[k] += ` Q${f1(b.x)} ${f1(b.y)} ${f1(m1.x)} ${f1(m1.y)}`;
    grow(m0, b, m1);
    prev.current = b; last.current = p; setDrawn(true);
  }
  const up = () => { last.current = null; prev.current = null; };
  function clear() { const c = canvas.current, g = c?.getContext("2d"); if (c && g) { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height); g.restore(); } strokes.current = []; bounds.current = null; setDrawn(false); }
  /** The drawing as a small PNG (at most 600 × 200), so it is kept and printed without weighing much. */
  function image() {
    const c = canvas.current; if (!c) return null;
    const w = Math.min(600, c.width), h = Math.round((c.height / c.width) * w);
    const out = document.createElement("canvas"); out.width = w; out.height = h;
    out.getContext("2d")?.drawImage(c, 0, 0, w, h);
    const lines = strokes.current.filter((d) => d.includes("Q")), b = bounds.current;
    return withVector(out.toDataURL("image/png"), lines.length && b ? { box: [b[0], b[1], Math.max(1, b[2] - b[0]), Math.max(1, b[3] - b[1])], d: lines, stroke: 2.4 } : null);
  }

  async function redo(f: File, d: number) {
    setCleaning(true); setError(null);
    try { setCleaned((await cleanPhoto(f, d)) ?? "none"); } catch (e) { setError(e instanceof Error ? e.message : "That photo could not be read."); setCleaned(null); } finally { setCleaning(false); }
  }
  async function sign() {
    if (name.trim().length < 2) { setError("Type your full name."); return; }
    if (tab === "drawn" && !drawn) { setError("Draw your signature in the box, or choose Type your name."); return; }
    if (tab === "uploaded" && (!cleaned || cleaned === "none")) { setError("Choose a photo of your signature first."); return; }
    if (!agree) { setError('Tick "I agree" first.'); return; }
    setBusy(true); setError(null);
    try { await onSign({ name: name.trim(), kind: tab, image: tab === "drawn" ? image() : tab === "uploaded" && cleaned && cleaned !== "none" ? cleaned.png : null, agree }); }
    catch (e) { setError(e instanceof Error ? e.message : "Your signature was not saved. Try again."); setBusy(false); }
  }

  return <div className={css.backdrop} onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div className={css.sheet} role="dialog" aria-modal="true" aria-labelledby="sign-title">
      <div className={css.grab} aria-hidden="true" />
      <button type="button" className={css.close} onClick={onClose} disabled={busy} aria-label="Close"><X size={20} aria-hidden="true" /></button>
      <h2 id="sign-title">Sign your agreement</h2>
      <p className={css.muted}>Your name is added to {what}.</p>
      <div className={css.tabs} role="tablist" aria-label="How to sign">
        <button type="button" role="tab" aria-selected={tab === "drawn"} onClick={() => setTab("drawn")}>Draw</button>
        <button type="button" role="tab" aria-selected={tab === "typed"} onClick={() => setTab("typed")}>Type</button>
        <button type="button" role="tab" aria-selected={tab === "uploaded"} onClick={() => setTab("uploaded")}>Photo</button>
      </div>
      <label className={css.label}>Your full name
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={160} enterKeyHint="done" />
      </label>
      {tab === "uploaded" ? <div className={css.padWrap}>
        <span className={css.previewLabel}>A photo of your signature on paper</span>
        <label className={css.upload}><Camera size={18} aria-hidden="true" />{file ? "Choose another photo" : "Choose or take a photo"}
          <input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setDarker(0); if (f) void redo(f, 0); }} /></label>
        {cleaning ? <p className={css.muted} aria-live="polite">Cleaning your photo…</p> : null}
        {cleaned === "none" ? <p className={css.error} role="alert">We could not find a signature in that photo. Try a closer photo on plain paper, in good light.</p> : null}
        {cleaned && cleaned !== "none" ? <>
          <div className={css.cleanPair}>
            <span className={css.previewLabel}>Your photo</span>
            {/* eslint-disable-next-line @next/next/no-img-element -- a local photo the person just chose */}
            <img src={cleaned.photo} alt="Your photo" className={css.cleanBefore} />
            <span className={css.previewLabel}>On the agreement</span>
            {/* eslint-disable-next-line @next/next/no-img-element -- the cleaned vector, drawn on this device */}
            <img src={cleaned.svg} alt="Your signature, cleaned" className={css.cleanAfter} />
          </div>
          <p className={css.muted}>We removed the paper and kept only the ink. This is what goes on the agreement.</p>
          <div className={css.inkRow} role="group" aria-label="Ink">
            <button type="button" className={css.linkBtn} disabled={darker <= -2 || cleaning} onClick={() => { const d = darker - 1; setDarker(d); if (file) void redo(file, d); }}>Lighter ink</button>
            <button type="button" className={css.linkBtn} disabled={darker >= 2 || cleaning} onClick={() => { const d = darker + 1; setDarker(d); if (file) void redo(file, d); }}>Darker ink</button>
          </div>
        </> : null}
      </div> : tab === "typed" ? <div className={css.preview} aria-label="Your signature">
        <span className={css.previewLabel}>Your signature</span>
        {name.trim() ? <TypedSignature name={name.trim()} /> : <span className={css.script}>Your name</span>}
      </div> : <div className={css.padWrap}>
        <span className={css.previewLabel}>Draw with your finger or mouse</span>
        <canvas ref={canvas} className={css.pad} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} aria-label="Signature box" />
        {drawn ? <button type="button" className={css.linkBtn} onClick={clear}>Clear</button> : null}
      </div>}
      <div className={css.signFoot}>
      <label className={css.agree}><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I agree to this agreement</label>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      <button type="button" className={css.big} onClick={sign} disabled={busy}>{busy ? "Signing…" : "Sign now"}</button>
      </div>
      <p className={css.tiny}>We save your name, the time, and your device, so both sides have a record.</p>
    </div>
  </div>;
}
