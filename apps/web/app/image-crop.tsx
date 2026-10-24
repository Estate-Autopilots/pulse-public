"use client";
// PEOPLE-CONTACTS (owner, 11 Oct 2026): one photo and logo picker for people, contacts and the organisation's logo.
// "WhatsApp-level": pinch and drag, wheel and double-tap zoom, turn by 90° or straighten by degrees, a circle or square
// mask, a sharp high-DPI result, and motion that settles instead of jumping. The phone's camera and gallery come from
// the browser's own file picker (the Pulse phone shell offers Camera next to Photos for image fields, Android's
// ShellChromeClient; iOS shows Take Photo / Photo Library). JPEG orientation (EXIF) is honoured even where the
// browser would not. The saved image goes to the caller (the person or contact photo store, the organisation brand).
// Maths and its tests: lib/image-crop.mjs.
import { Camera, Check, Circle, ImagePlus, Minus, Plus, RectangleHorizontal, RotateCcw, RotateCw, Square, Trash2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { clampView, exifOrientation, minScale, orient, outputSize, spring, withOrientation, zoomAt, type View } from "./lib/image-crop.mjs";
import css from "./image-crop.module.css";

export type CropShape = "circle" | "square" | "wide";
export type CropResult = { dataUrl: string; blob: Blob; mime: string; width: number; height: number; bytes: number };
type Source = { canvas: HTMLCanvasElement; w: number; h: number };
const ASPECT: Record<CropShape, number> = { circle: 1, square: 1, wide: 4 };
/** The frame: as big as the stage allows with room around it; wide logos are 4:1. */
const frameFor = (stage: { w: number; h: number }, shape: CropShape) => {
  const aspect = ASPECT[shape], side = Math.max(120, Math.min(stage.w - 40, (stage.h - 40) * aspect, aspect > 1 ? 640 : 420));
  return { w: side, h: side / aspect };
};
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------------------------------------ reading the file
let probe: Promise<boolean> | null = null;
/** Whether this browser turns JPEGs by their EXIF orientation when decoding (all current ones do; old WebViews not):
 *  a 2 × 1 JPEG marked "turn clockwise" decodes 1 px wide when it does. */
function browserTurns(): Promise<boolean> {
  probe ??= (async () => {
    try {
      const c = document.createElement("canvas"); c.width = 2; c.height = 1;
      const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", 0.9));
      if (!blob) return true;
      const marked = withOrientation(new Uint8Array(await blob.arrayBuffer()), 6);
      const bitmap = await createImageBitmap(new Blob([marked as BlobPart], { type: "image/jpeg" }));
      const turned = bitmap.width === 1; bitmap.close(); return turned;
    } catch { return true; }
  })();
  return probe;
}
/** The picture upright, at most `long` px on its long side (iOS refuses canvases over ~16 megapixels). */
async function readImage(file: Blob, long = 4096): Promise<Source> {
  const bytes = await file.arrayBuffer();
  const orientation = file.type === "image/jpeg" || /\.jpe?g$/i.test((file as File).name ?? "") ? exifOrientation(bytes) : 1;
  const bitmap = await createImageBitmap(file);
  const fix = orientation !== 1 && !(await browserTurns());
  const upright = fix ? orient(orientation, bitmap.width, bitmap.height) : { width: bitmap.width, height: bitmap.height, matrix: [1, 0, 0, 1, 0, 0] as const };
  let ratio = Math.min(1, long / Math.max(upright.width, upright.height));
  // Big photos shrink in halves: one jump from 8000 px to 2000 px drops detail (moiré); halving keeps it.
  let src: CanvasImageSource = bitmap, sw = bitmap.width, sh = bitmap.height;
  while (ratio < 0.5) {
    const half = document.createElement("canvas"); half.width = Math.max(1, Math.round(sw / 2)); half.height = Math.max(1, Math.round(sh / 2));
    const hx = half.getContext("2d")!; hx.imageSmoothingQuality = "high"; hx.drawImage(src, 0, 0, half.width, half.height);
    src = half; sw = half.width; sh = half.height; ratio *= 2;
  }
  const t = fix ? orient(orientation, sw, sh) : { width: sw, height: sh, matrix: [1, 0, 0, 1, 0, 0] as const };
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(t.width * ratio)); canvas.height = Math.max(1, Math.round(t.height * ratio));
  const g = canvas.getContext("2d")!; g.imageSmoothingQuality = "high";
  g.scale(ratio, ratio); const [a, b, c, d, e, f] = t.matrix; g.transform(a, b, c, d, e, f); g.drawImage(src, 0, 0);
  bitmap.close();
  return { canvas, w: canvas.width, h: canvas.height };
}

/** Draw the framed part of the picture into an image of `out` px, sampling down by halves when it shrinks a lot. */
function render(source: Source, view: View, frame: { w: number; h: number }, out: { width: number; height: number }) {
  const k = out.width / frame.w;                                      // output pixels per frame pixel
  const shrink = 1 / (view.scale * k);                                // picture pixels per output pixel
  let steps = 0; while (shrink / 2 ** steps > 2 && steps < 2) steps++;
  const big = document.createElement("canvas"); big.width = out.width * 2 ** steps; big.height = out.height * 2 ** steps;
  const g = big.getContext("2d")!; g.imageSmoothingQuality = "high";
  g.translate(big.width / 2, big.height / 2); g.scale(k * 2 ** steps, k * 2 ** steps);
  g.translate(view.x, view.y); g.rotate((view.angle * Math.PI) / 180); g.scale(view.scale, view.scale);
  g.drawImage(source.canvas, -source.w / 2, -source.h / 2);
  let cur = big;
  for (let i = 0; i < steps; i++) {
    const half = document.createElement("canvas"); half.width = cur.width / 2; half.height = cur.height / 2;
    const h = half.getContext("2d")!; h.imageSmoothingQuality = "high"; h.drawImage(cur, 0, 0, half.width, half.height); cur = half;
  }
  return cur;
}
const toBlob = (c: HTMLCanvasElement, mime: string, q: number) => new Promise<Blob | null>((ok) => c.toBlob(ok, mime, q));
const asDataUrl = (b: Blob) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(r.error); r.readAsDataURL(b); });
/** WebP where the browser can write it (smaller), else JPEG (photos) or PNG (logos keep transparency); quality steps
 *  down, then the size, until the file fits. */
async function encode(canvas: HTMLCanvasElement, maxBytes: number, alpha: boolean): Promise<CropResult> {
  let c = canvas;
  for (let round = 0; round < 4; round++) {
    for (const q of [0.92, 0.86, 0.8, 0.72]) {
      let blob = await toBlob(c, "image/webp", q);
      if (!blob || blob.type !== "image/webp") blob = await toBlob(c, alpha ? "image/png" : "image/jpeg", q);
      if (blob && blob.size <= maxBytes) return { dataUrl: await asDataUrl(blob), blob, mime: blob.type, width: c.width, height: c.height, bytes: blob.size };
      if (blob?.type === "image/png") break;                           // PNG ignores quality: go smaller instead
    }
    const smaller = document.createElement("canvas"); smaller.width = Math.round(c.width * 0.8); smaller.height = Math.round(c.height * 0.8);
    const s = smaller.getContext("2d")!; s.imageSmoothingQuality = "high"; s.drawImage(c, 0, 0, smaller.width, smaller.height); c = smaller;
  }
  throw new Error("This picture is too detailed to save. Try a smaller one.");
}

// ------------------------------------------------------------------------------------------------------ the cropper
type CropperProps = {
  file: Blob; title: string; shapes: CropShape[]; maxBytes: number; long?: number; alpha?: boolean; doneLabel?: string;
  onCancel: () => void; onDone: (result: CropResult) => Promise<void> | void;
};
/** Full-screen on a phone, a calm sheet on a computer. Nothing is saved until "Use photo". */
export function ImageCropper({ file, title, shapes, maxBytes, long = 1024, alpha = false, doneLabel = "Use photo", onCancel, onDone }: CropperProps) {
  const [shape, setShape] = useState<CropShape>(shapes[0]);
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1, angle: 0 });
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [active, setActive] = useState(false);                        // a finger or the mouse is on the picture
  const stageRef = useRef<HTMLDivElement>(null), canvasHost = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: View; mid: { x: number; y: number }; dist: number } | null>(null);
  const anim = useRef(0), latest = useRef(view);
  const titleId = useId();
  /** Every change goes through here, so gestures always start from what is on the screen. */
  const apply = useCallback((v: View) => { latest.current = v; setView(v); }, []);

  const aspect = ASPECT[shape];
  const frame = frameFor(stage, shape);
  const image = source ? { w: source.w, h: source.h } : { w: 1, h: 1 };

  useEffect(() => {
    let live = true;
    readImage(file).then((s) => { if (live) setSource(s); }).catch(() => { if (live) setError("Pulse can’t read this picture. Use a JPEG, PNG, WebP or HEIC photo."); });
    return () => { live = false; };
  }, [file]);
  useLayoutEffect(() => {
    const el = stageRef.current; if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure(); const ro = new ResizeObserver(measure); ro.observe(el); return () => ro.disconnect();
  }, []);
  // The picture on screen is a lighter copy (at most 1600 px; phones keep big layers slow) of the same upright pixels
  // the saved image is drawn from, stretched to the full picture's size so the maths need not know about it.
  useEffect(() => {
    const host = canvasHost.current; if (!host || !source) return;
    const k = Math.min(1, 1600 / Math.max(source.w, source.h)), shown = document.createElement("canvas");
    shown.width = Math.max(1, Math.round(source.w * k)); shown.height = Math.max(1, Math.round(source.h * k));
    const g = shown.getContext("2d")!; g.imageSmoothingQuality = "high"; g.drawImage(source.canvas, 0, 0, shown.width, shown.height);
    shown.className = css.picture; shown.setAttribute("aria-hidden", "true"); shown.dataset.cropPicture = "";
    host.replaceChildren(shown);
  }, [source]);

  /** Glide to `to` with a soft spring (no overshoot); immediate when motion is reduced. */
  const settle = useCallback((to: View) => {
    cancelAnimationFrame(anim.current);
    if (reduced()) { apply(to); return; }
    const from = latest.current; const keys = ["x", "y", "scale", "angle"] as const;
    const state = Object.fromEntries(keys.map((k) => [k, { value: from[k], velocity: 0 }])) as Record<(typeof keys)[number], { value: number; velocity: number }>;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now; let done = true;
      for (const k of keys) {
        const target = to[k], scale = k === "scale" ? 1 / Math.max(to.scale, 0.01) : 1;
        state[k] = spring(state[k].value, target, state[k].velocity, dt, 320);
        if (Math.abs(state[k].value - target) * scale > 0.05 || Math.abs(state[k].velocity) * scale > 0.05) done = false;
      }
      apply(done ? to : { x: state.x.value, y: state.y.value, scale: state.scale.value, angle: state.angle.value });
      if (!done) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }, [apply]);
  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  // First fit: start a touch closer, then settle to fill the frame (a small arrival, not a jump).
  const fitted = useRef("");
  useEffect(() => {
    if (!source || !stage.w) return;
    const box = frameFor(stage, shape), pic = { w: source.w, h: source.h };
    const key = `${shape}:${source.w}x${source.h}`; if (fitted.current === key) { apply(clampView(latest.current, box, pic)); return; }
    const first = !fitted.current; fitted.current = key;
    const fit = { x: 0, y: 0, angle: latest.current.angle, scale: minScale(box, pic, latest.current.angle) };
    if (first) { apply({ ...fit, scale: fit.scale * 1.08 }); requestAnimationFrame(() => settle(fit)); } else settle(clampView({ ...latest.current, scale: Math.max(latest.current.scale, fit.scale) }, box, pic));
  }, [source, stage, shape, settle, apply]);

  /** While a finger is down, going past an edge meets resistance (like a rubber band) instead of a wall. */
  const rubber = (v: View) => {
    const c = clampView(v, frame, image, 10);
    const r = (a: number, b: number) => b + (a - b) * 0.35;
    return { ...v, x: r(v.x, c.x), y: r(v.y, c.y), scale: v.scale < c.scale ? r(v.scale, c.scale) : Math.min(v.scale, c.scale * 1.15) };
  };
  const local = (e: { clientX: number; clientY: number }) => { const r = stageRef.current!.getBoundingClientRect(); return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }; };
  const startGesture = () => {
    const pts = [...pointers.current.values()];
    const mid = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
    gesture.current = { view: latest.current, mid, dist: pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0 };
  };
  function down(e: ReactPointerEvent<HTMLDivElement>) {
    if (!source || busy) return;
    cancelAnimationFrame(anim.current);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e)); startGesture(); setActive(true);
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, local(e));
    const g = gesture.current, pts = [...pointers.current.values()];
    if (pts.length > 1) {
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const zoomed = zoomAt(g.view, dist / Math.max(g.dist, 1), g.mid);
      apply(rubber({ ...zoomed, x: zoomed.x + mid.x - g.mid.x, y: zoomed.y + mid.y - g.mid.y }));
    } else apply(rubber({ ...g.view, x: g.view.x + pts[0].x - g.mid.x, y: g.view.y + pts[0].y - g.mid.y }));
  }
  function up(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size) { startGesture(); return; }
    gesture.current = null; setActive(false); settle(clampView(latest.current, frame, image));
  }
  // Wheel and trackpad pinch zoom around the pointer; settles once the wheel stops.
  const wheelEnd = useRef(0);
  useEffect(() => {
    const el = stageRef.current; if (!el || !source) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); cancelAnimationFrame(anim.current);
      const at = local(e), factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022));
      apply(rubber(zoomAt(latest.current, factor, at)));
      window.clearTimeout(wheelEnd.current); wheelEnd.current = window.setTimeout(() => settle(clampView(latest.current, frame, image)), 140);
    };
    el.addEventListener("wheel", onWheel, { passive: false }); return () => el.removeEventListener("wheel", onWheel);
  });
  const least = minScale(frame, image, view.angle);
  const zoomTo = (scale: number, at = { x: 0, y: 0 }) => settle(clampView(zoomAt(latest.current, scale / latest.current.scale, at), frame, image));
  const turn = (deg: number) => { const v = latest.current; settle(clampView({ ...v, angle: v.angle + deg, scale: Math.max(v.scale, minScale(frame, image, v.angle + deg)) }, frame, image)); };
  const straighten = (deg: number) => {
    const v = latest.current, quarter = Math.round(v.angle / 90) * 90, angle = quarter + deg;
    cancelAnimationFrame(anim.current); apply(clampView({ ...v, angle, scale: Math.max(v.scale, minScale(frame, image, angle)) }, frame, image));
  };
  const fine = view.angle - Math.round(view.angle / 90) * 90;
  function key(e: ReactKeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 40 : 10, v = latest.current;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => settle(clampView({ ...v, x: v.x - step }, frame, image)), ArrowRight: () => settle(clampView({ ...v, x: v.x + step }, frame, image)),
      ArrowUp: () => settle(clampView({ ...v, y: v.y - step }, frame, image)), ArrowDown: () => settle(clampView({ ...v, y: v.y + step }, frame, image)),
      "+": () => zoomTo(v.scale * 1.2), "=": () => zoomTo(v.scale * 1.2), "-": () => zoomTo(v.scale / 1.2), r: () => turn(90), R: () => turn(-90),
    };
    if (moves[e.key]) { e.preventDefault(); moves[e.key](); }
  }
  async function save() {
    if (!source) return;
    setBusy(true); setError("");
    try {
      const v = clampView(latest.current, frame, image);
      const result = await encode(render(source, v, frame, outputSize(frame, v, aspect, long)), maxBytes, alpha);
      await onDone(result);
    } catch (e) { setError(e instanceof Error ? e.message : "The picture was not saved"); setBusy(false); }
  }
  // Escape closes; focus stays inside; the page behind does not scroll.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
      if (e.key === "Tab") {
        const all = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),[tabindex='0']") ?? [])];
        if (e.shiftKey && document.activeElement === all[0]) { e.preventDefault(); all.at(-1)?.focus(); } else if (!e.shiftKey && document.activeElement === all.at(-1)) { e.preventDefault(); all[0]?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = overflow; before?.focus?.(); };
  }, [onCancel]);

  const shapeIcon = { circle: Circle, square: Square, wide: RectangleHorizontal } as const;
  const shapeLabel = { circle: "Circle", square: "Square", wide: "Wide" } as const;
  const style = { "--frame-w": `${frame.w}px`, "--frame-h": `${frame.h}px` } as CSSProperties;
  const transform = `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) rotate(${view.angle}deg) scale(${view.scale})`;
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div ref={dialog} className={css.sheet} role="dialog" aria-modal="true" aria-labelledby={titleId} data-busy={busy ? "" : undefined}>
        <header className={css.head}>
          <button type="button" className={css.iconBtn} onClick={onCancel} aria-label="Cancel" disabled={busy}><X size={18} aria-hidden="true" /></button>
          <h2 id={titleId}>{title}</h2>
          <button type="button" className={css.done} onClick={() => void save()} disabled={!source || busy} data-autofocus="">{busy ? <span className={css.spinner} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{busy ? "Saving…" : doneLabel}</button>
        </header>
        <div ref={stageRef} className={css.stage} style={style} data-active={active ? "" : undefined} data-shape={shape} data-ready={source ? "" : undefined} data-alpha={alpha ? "" : undefined}
          tabIndex={0} role="application" aria-roledescription="photo cropper" aria-label="Drag to move, pinch or scroll to zoom. Arrow keys move, plus and minus zoom, R turns."
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}
          onDoubleClick={(e) => { const v = latest.current; zoomTo(v.scale > least * 1.6 ? least : least * 2.5, local(e)); }}>
          <div ref={canvasHost} className={css.pictureHost} style={{ transform, width: image.w, height: image.h }} />
          <div className={css.frame} aria-hidden="true"><i /><i /><i /><i /></div>
          {!source && !error ? <div className={css.loading} role="status"><span className={css.spinner} aria-hidden="true" />Opening the photo…</div> : null}
          {error ? <p className={css.error} role="alert">{error}</p> : null}
        </div>
        <div className={css.controls}>
          <label className={css.slider}><span className={css.srOnly}>Zoom</span>
            <button type="button" className={css.iconBtn} aria-label="Zoom out" disabled={!source || busy} onClick={() => zoomTo(view.scale / 1.25)}><Minus size={16} aria-hidden="true" /></button>
            <input type="range" min={0} max={1000} step={1} disabled={!source || busy} aria-label="Zoom"
              value={Math.round((Math.log(view.scale / least) / Math.log(8)) * 1000) || 0}
              onChange={(e) => { cancelAnimationFrame(anim.current); apply(clampView({ ...latest.current, scale: least * 8 ** (Number(e.target.value) / 1000) }, frame, image)); }} />
            <button type="button" className={css.iconBtn} aria-label="Zoom in" disabled={!source || busy} onClick={() => zoomTo(view.scale * 1.25)}><Plus size={16} aria-hidden="true" /></button>
          </label>
          <label className={css.slider} data-straighten=""><span className={css.dial}>{fine > 0 ? "+" : ""}{fine.toFixed(1)}°</span>
            <input type="range" min={-45} max={45} step={0.1} value={fine} disabled={!source || busy} aria-label="Straighten" onChange={(e) => straighten(Number(e.target.value))} onDoubleClick={() => straighten(0)} />
          </label>
          <div className={css.row}>
            <button type="button" className={css.tool} disabled={!source || busy} onClick={() => turn(-90)}><RotateCcw size={16} aria-hidden="true" /><span>Turn left</span></button>
            <button type="button" className={css.tool} disabled={!source || busy} onClick={() => turn(90)}><RotateCw size={16} aria-hidden="true" /><span>Turn right</span></button>
            <button type="button" className={css.tool} disabled={!source || busy} onClick={() => settle({ x: 0, y: 0, angle: 0, scale: minScale(frame, image, 0) })}><Undo2 size={16} aria-hidden="true" /><span>Reset</span></button>
            {shapes.length > 1 ? <span className={css.shapes} role="radiogroup" aria-label="Shape">{shapes.map((s) => { const Icon = shapeIcon[s]; return (
              <button key={s} type="button" role="radio" aria-checked={shape === s} className={css.tool} disabled={busy} onClick={() => setShape(s)}><Icon size={16} aria-hidden="true" /><span>{shapeLabel[s]}</span></button>); })}</span> : null}
          </div>
        </div>
      </div>
    </div>, document.body);
}

// ------------------------------------------------------------------------------------------------------- the picker
type PickerProps = {
  /** What the picture is of, for labels: "your photo", "Asha's photo", "the logo". */
  label: string; has: boolean; shapes?: CropShape[]; maxBytes?: number; long?: number; alpha?: boolean;
  save: (result: CropResult) => Promise<void>; remove?: () => Promise<void>;
  /** How the trigger looks: the round camera badge on an avatar, or a button. */
  variant?: "badge" | "button"; children?: ReactNode; disabled?: boolean; onError?: (message: string) => void;
};
/** A trigger that offers Take a photo (phones), Choose a photo and Remove, then opens the cropper. Desktop: a picture
 *  dropped on the trigger opens it too. */
export function ImagePicker({ label, has, shapes = ["circle"], maxBytes = 380_000, long, alpha, save, remove, variant = "badge", children, disabled, onError }: PickerProps) {
  const [menu, setMenu] = useState(false), [file, setFile] = useState<Blob | null>(null), [busy, setBusy] = useState(false), [drag, setDrag] = useState(false);
  const camera = useRef<HTMLInputElement>(null), gallery = useRef<HTMLInputElement>(null), box = useRef<HTMLSpanElement>(null);
  // A phone offers "Take a photo"; read when the menu opens (nothing on the first render depends on it).
  const [touch] = useState(() => typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false));
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => { if (!box.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc); };
  }, [menu]);
  const pick = (f?: File | null) => { setMenu(false); if (f && (f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name))) setFile(f); else if (f) onError?.("Choose a photo: JPEG, PNG, WebP or HEIC."); };
  const open = () => { if (!has && !touch && !remove) { gallery.current?.click(); return; } setMenu((m) => !m); };
  const trigger = variant === "badge"
    ? <button type="button" className={css.badge} aria-label={has ? `Change ${label}` : `Add ${label}`} title={has ? `Change ${label}` : `Add ${label}`} aria-haspopup="menu" aria-expanded={menu} disabled={disabled || busy} onClick={open}><Camera size={14} aria-hidden="true" /></button>
    : <button type="button" className={css.button} aria-haspopup="menu" aria-expanded={menu} disabled={disabled || busy} onClick={open}>{children ?? <><ImagePlus size={14} aria-hidden="true" />{has ? "Change" : "Add"}</>}</button>;
  return <span ref={box} className={css.picker} data-variant={variant} data-drag={drag ? "" : undefined}
    onDragOver={(e) => { if ([...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)}
    onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}>
    {/* Two inputs: `capture` asks a phone for its camera; the other opens Photos and Files (and, in the Pulse app, Camera too). */}
    <input ref={camera} type="file" accept="image/*" capture="user" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
    <input ref={gallery} type="file" accept="image/*" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
    {trigger}
    {menu ? <span className={css.menu} role="menu" aria-label={label}>
      {touch ? <button type="button" role="menuitem" onClick={() => camera.current?.click()}><Camera size={15} aria-hidden="true" />Take a photo</button> : null}
      <button type="button" role="menuitem" onClick={() => gallery.current?.click()}><ImagePlus size={15} aria-hidden="true" />{touch ? "Choose from gallery" : has ? "Upload a new photo" : "Upload a photo"}</button>
      {has && remove ? <button type="button" role="menuitem" data-danger="" onClick={async () => { setMenu(false); setBusy(true); try { await remove(); } catch (e) { onError?.(e instanceof Error ? e.message : "Not removed"); } finally { setBusy(false); } }}><Trash2 size={15} aria-hidden="true" />Remove</button> : null}
    </span> : null}
    {file ? <ImageCropper file={file} title={has ? `Change ${label}` : `Add ${label}`} shapes={shapes} maxBytes={maxBytes} long={long} alpha={alpha}
      onCancel={() => setFile(null)} onDone={async (r) => { await save(r); setFile(null); }} /> : null}
  </span>;
}
