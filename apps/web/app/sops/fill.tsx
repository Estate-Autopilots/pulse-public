"use client";
// SOP-WORKFLOW part 3: filling a field form, made for a phone. A photo opens the camera (the Pulse app's camera, or the
// phone browser's): the picture is turned upright, made smaller and, when the form asks, stamped with the time and the
// place before it is sent; pictures from the gallery are refused by Pulse. A signature is drawn with a finger; the
// location comes from the phone. Sending finishes the workflow step, and the run moves on with the answers.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Camera, CheckCircle2, Eraser, LocateFixed, MapPin, Send, X } from "lucide-react";
import { styles } from "../ui";
import type { FillForm, FormField } from "./types";
import css from "./forms.module.css";

type Shot = { data: string; preview: string; mime: string; capturedAt: string; width: number; height: number; name: string; lat?: number; lng?: number; accuracy?: number };
type Where = { lat: number; lng: number; accuracy: number } | null;
const MAX_EDGE = 1600;

/** Upright, at most 1600 px on its long side, JPEG; with a stamp of when and where when the field asks for it. */
async function prepare(file: File, field: FormField, where: Where): Promise<Shot> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  const g = canvas.getContext("2d")!; g.drawImage(bitmap, 0, 0, w, h); bitmap.close();
  const taken = new Date(file.lastModified || Date.now());
  if (field.stamp !== false || field.geotag) {
    const lines = [taken.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })];
    if (field.geotag !== false && where) lines.push(`${where.lat.toFixed(5)}, ${where.lng.toFixed(5)} ±${Math.round(where.accuracy)} m`);
    const size = Math.max(14, Math.round(w / 48)); g.font = `600 ${size}px system-ui, sans-serif`;
    const pad = Math.round(size * 0.6), bar = lines.length * size * 1.35 + pad * 1.4;
    g.fillStyle = "rgba(0,0,0,0.55)"; g.fillRect(0, h - bar, w, bar);
    g.fillStyle = "#fff"; lines.forEach((t, i) => g.fillText(t, pad, h - bar + pad + size * (i + 0.95) * 1.3));
  }
  const blob = await new Promise<Blob>((ok, no) => canvas.toBlob((b) => b ? ok(b) : no(new Error("Could not read the photo")), "image/jpeg", 0.82));
  const data = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] ?? ""); r.readAsDataURL(blob); });
  return { data, preview: URL.createObjectURL(blob), mime: "image/jpeg", capturedAt: taken.toISOString(), width: w, height: h, name: `${field.key}.jpg`,
    ...(where && field.geotag !== false ? { lat: where.lat, lng: where.lng, accuracy: where.accuracy } : {}) };
}

function useWhere(wanted: boolean) {
  const [where, setWhere] = useState<Where>(null), [state, setState] = useState<"idle" | "asking" | "ok" | "denied">("idle");
  const ask = useCallback(() => {
    if (!("geolocation" in navigator)) { setState("denied"); return; }
    setState("asking");
    navigator.geolocation.getCurrentPosition((p) => { setWhere({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }); setState("ok"); },
      () => setState("denied"), { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
  }, []);
  // Asked once the form opens (a cancelled first mount simply asks again).
  useEffect(() => { if (!wanted) return; const t = window.setTimeout(ask, 0); return () => window.clearTimeout(t); }, [wanted, ask]);
  return { where, state, ask };
}

export function FormFill({ form, stepId, flowStepId, projectId, preview, done }: { form: FillForm; stepId?: string; /** FLOW-C: the process step it is filled for (sending it finishes that step). */ flowStepId?: string; projectId?: string | null; preview?: boolean; done?: { href: string; label: string } }) {
  const router = useRouter();
  const wantsPlace = form.fields.some((f) => f.type === "location" || (f.type === "photo" && f.geotag !== false));
  const { where, state, ask } = useWhere(wantsPlace && !preview);
  const [answers, setAnswers] = useState<Record<string, unknown>>({}), [shots, setShots] = useState<Record<string, Shot[]>>({}), [signs, setSigns] = useState<Record<string, Shot | null>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [sent, setSent] = useState<{ stepDone: boolean; runs: string[] } | null>(null);
  const set = (k: string, v: unknown) => setAnswers((a) => ({ ...a, [k]: v }));
  // A location field fills itself once the phone knows where it is (only while it is still empty).
  useEffect(() => { if (!where) return; const t = window.setTimeout(() => setAnswers((a) => { const out = { ...a }; for (const f of form.fields) if (f.type === "location" && !out[f.key]) out[f.key] = where; return out; }), 0); return () => window.clearTimeout(t); }, [where, form.fields]);

  async function send() {
    setBusy(true); setError("");
    try {
      const files = [...Object.entries(shots).flatMap(([field, list]) => list.map((s) => ({ field, ...s, source: "camera" }))),
        ...Object.entries(signs).filter(([, s]) => s).map(([field, s]) => ({ field, ...s!, source: "signature" }))].map(({ preview: _p, ...f }) => { void _p; return f; });
      const r = await fetch("/api/v0/forms/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ formId: form.id, stepId, flowStepId, projectId, answers, files, location: where, device: /PulseShell/.test(navigator.userAgent) ? "app" : "browser" }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Not sent");
      setSent({ stepDone: d.stepDone, runs: d.runs ?? [] }); window.dispatchEvent(new Event("pulse:data-changed")); router.refresh();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) { setError(e instanceof Error ? e.message : "Not sent"); } finally { setBusy(false); }
  }

  if (sent) return <div className={css.sent} role="status">
    <CheckCircle2 size={40} aria-hidden="true" /><h2>Sent</h2>
    <p>{sent.stepDone ? "The step is done and the run has moved on." : sent.runs.length ? `It started ${sent.runs.length === 1 ? "a workflow" : `${sent.runs.length} workflows`}.` : "Your answers are saved with the project."}</p>
    {done ? <Link className={`${styles.btn} ${styles.btnPrimary}`} href={done.href}>{done.label}</Link> : null}
    {sent.runs[0] ? <Link className={styles.btn} href={`/runs/${sent.runs[0]}`}>Open the run</Link> : null}
  </div>;

  return <form className={css.fill} onSubmit={(e) => { e.preventDefault(); if (!preview) void send(); }} aria-label={form.name}>
    {wantsPlace && !preview ? <p className={css.place} data-state={state}><MapPin size={14} aria-hidden="true" />
      {state === "ok" && where ? `Location found (±${Math.round(where.accuracy)} m)` : state === "asking" ? "Finding where you are…" : state === "denied" ? "Location is off: photos go without a place." : "Location not asked yet."}
      {state !== "ok" && state !== "asking" ? <button type="button" className={css.linkBtn} onClick={ask}>Try again</button> : null}</p> : null}
    {form.fields.map((f) => <fieldset key={f.key} className={css.q} data-type={f.type}>
      <legend>{f.label}{f.required ? <em aria-hidden="true">*</em> : <small> (optional)</small>}</legend>
      {f.help ? <p className={css.help}>{f.help}</p> : null}
      <Answer f={f} value={answers[f.key]} onChange={(v) => set(f.key, v)} shots={shots[f.key] ?? []} setShots={(list) => setShots((s) => ({ ...s, [f.key]: list }))}
        sign={signs[f.key] ?? null} setSign={(s) => setSigns((x) => ({ ...x, [f.key]: s }))} where={where} disabled={!!preview} />
    </fieldset>)}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={css.sendBar}><button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !!preview || !form.live}><Send size={15} aria-hidden="true" />{busy ? "Sending…" : preview ? "Send (preview)" : "Send"}</button>
      {!form.live && !preview ? <small>This form is not live yet.</small> : null}</div>
  </form>;
}

function Answer({ f, value, onChange, shots, setShots, sign, setSign, where, disabled }: { f: FormField; value: unknown; onChange: (v: unknown) => void; shots: Shot[]; setShots: (s: Shot[]) => void;
  sign: Shot | null; setSign: (s: Shot | null) => void; where: Where; disabled: boolean }) {
  const [reading, setReading] = useState(false), [problem, setProblem] = useState("");
  const input = useRef<HTMLInputElement>(null);
  switch (f.type) {
    case "photo": {
      const max = f.max ?? 4, min = f.min ?? (f.required ? 1 : 0);
      return <div className={css.photos}>
        {shots.map((s, i) => <figure key={i}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a photo just taken, shown from the phone */}
          <img src={s.preview} alt={`${f.label} ${i + 1}`} /><button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => setShots(shots.filter((_, j) => j !== i))}><X size={14} /></button></figure>)}
        {shots.length < max ? <button type="button" className={css.camera} disabled={disabled || reading} onClick={() => input.current?.click()}><Camera size={22} aria-hidden="true" /><span>{reading ? "Reading…" : shots.length ? "Another photo" : "Take a photo"}</span></button> : null}
        <input ref={input} type="file" accept="image/*" capture="environment" hidden aria-label={`${f.label}: camera`} onChange={async (e) => {
          const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; setReading(true); setProblem("");
          try { setShots([...shots, await prepare(file, f, where)]); } catch { setProblem("That photo could not be read. Take it again."); } finally { setReading(false); } }} />
        <small className={css.count}>{shots.length} of {min > 1 ? `at least ${min}` : max} · camera only{f.geotag !== false ? " · place stamped" : ""}</small>
        {problem ? <small className={css.errorSmall}>{problem}</small> : null}
      </div>;
    }
    case "signature": return <SignaturePad value={sign} onChange={setSign} label={f.label} disabled={disabled} />;
    case "number": return <span className={css.num}><input type="number" inputMode="decimal" step={f.decimals ? 1 / 10 ** f.decimals : 1} min={f.min ?? undefined} max={f.max ?? undefined} value={value === undefined ? "" : String(value)} disabled={disabled}
      aria-label={f.label} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />{f.unit ? <span>{f.unit}</span> : null}</span>;
    case "text": return <input value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} aria-label={f.label} disabled={disabled} maxLength={300} />;
    case "longtext": return <textarea rows={f.lines ? 5 : 3} value={Array.isArray(value) ? value.join("\n") : String(value ?? "")} onChange={(e) => onChange(f.lines ? e.target.value.split("\n") : e.target.value)} aria-label={f.label}
      disabled={disabled} placeholder={f.lines ? "One per line" : undefined} />;
    case "select": return <span className={css.choices} role="radiogroup" aria-label={f.label}>{f.options!.map((o) => <button key={o} type="button" role="radio" aria-checked={value === o} disabled={disabled} onClick={() => onChange(o)}>{o}</button>)}</span>;
    case "multi": case "checklist": { const list = Array.isArray(value) ? value as string[] : [];
      return <span className={css.ticks}>{f.options!.map((o) => <label key={o}><input type="checkbox" checked={list.includes(o)} disabled={disabled} onChange={(e) => onChange(e.target.checked ? [...list, o] : list.filter((x) => x !== o))} />{o}</label>)}</span>; }
    case "yesno": return <span className={css.choices} role="radiogroup" aria-label={f.label}>{[["Yes", true], ["No", false]].map(([l, v]) => <button key={String(l)} type="button" role="radio" aria-checked={value === v} disabled={disabled} onClick={() => onChange(v)}>{String(l)}</button>)}</span>;
    case "date": return <input type="date" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} aria-label={f.label} disabled={disabled} />;
    case "location": { const v = value as Where;
      return <span className={css.loc}>{v ? <><MapPin size={14} aria-hidden="true" /><span>{v.lat.toFixed(5)}, {v.lng.toFixed(5)} <small>±{Math.round(v.accuracy)} m</small></span>
        <a className={css.linkBtn} href={`https://maps.google.com/?q=${v.lat},${v.lng}`} target="_blank" rel="noreferrer">Map</a></> : <span className={css.help}>Not found yet</span>}
        <button type="button" className={styles.btn} disabled={disabled || !where} onClick={() => where && onChange(where)}><LocateFixed size={14} aria-hidden="true" />Use where I am</button></span>; }
  }
}

/** A signature drawn with a finger or a mouse, kept as a PNG. */
function SignaturePad({ value, onChange, label, disabled }: { value: Shot | null; onChange: (s: Shot | null) => void; label: string; disabled: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null); const drawing = useRef(false); const drawn = useRef(false);
  const point = (e: ReactPointerEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(); return [(e.clientX - r.left) * (e.currentTarget.width / r.width), (e.clientY - r.top) * (e.currentTarget.height / r.height)]; };
  const end = async () => {
    if (!drawing.current) return; drawing.current = false; const c = canvas.current!; if (!drawn.current) return;
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/png")); if (!blob) return;
    const data = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] ?? ""); r.readAsDataURL(blob); });
    onChange({ data, preview: "", mime: "image/png", capturedAt: new Date().toISOString(), width: c.width, height: c.height, name: "signature.png" });
  };
  return <div className={css.sign}>
    <canvas ref={canvas} width={720} height={260} aria-label={`${label}: sign here`} role="img" data-signed={value ? "" : undefined}
      onPointerDown={(e) => { if (disabled) return; e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true; const g = e.currentTarget.getContext("2d")!; const [x, y] = point(e); g.lineWidth = 4; g.lineCap = "round"; g.strokeStyle = "#1d1b2c"; g.beginPath(); g.moveTo(x, y); }}
      onPointerMove={(e) => { if (!drawing.current) return; const g = e.currentTarget.getContext("2d")!; const [x, y] = point(e); g.lineTo(x, y); g.stroke(); drawn.current = true; }}
      onPointerUp={() => void end()} onPointerCancel={() => void end()} />
    <span className={css.signFoot}><small>{value ? "Signed" : "Sign in the box"}</small><button type="button" className={css.linkBtn} disabled={disabled} onClick={() => { const c = canvas.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); drawn.current = false; onChange(null); }}><Eraser size={13} aria-hidden="true" />Clear</button></span>
  </div>;
}

