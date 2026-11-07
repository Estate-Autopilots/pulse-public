"use client";

// BUG-REPORT (owner, 27 Oct 2026; copied from Sales X-Ray): mark up the picture before it goes. A step inside the
// reporter, never a second panel: Cancel returns to the report unchanged, "Use this picture" keeps the marked copy.
// Everything happens on the device.
// STAFF-UX (owner, 28 Oct 2026: "a proper drawing editor in a large centred view"): the picture fills the reporter
// (the whole screen on a phone) and the marks are shapes, not paint, so each one undoes and redoes on its own:
//   pen, highlighter, arrow, line, rectangle, ellipse, text label, and blur (redact: the pixels under it are blocked out
//   from the original picture, whatever is drawn later); six colours, three widths, undo, redo, clear.
// Mouse, pen and touch are the same pointer events; a drag paints only the shape being drawn over a cached picture of
// everything before it, so it stays smooth on a phone. The marks are drawn into the picture that goes with the report.
import { ArrowUpRight, Brush, Circle, EyeOff, Highlighter, Minus, Redo2, Square, Trash2, Type, Undo2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

import { haptic } from "../lib/native-shell";
import { styles as ui } from "../ui";
import styles from "./bug-report.module.css";

export type Tool = "pen" | "highlighter" | "arrow" | "line" | "rect" | "ellipse" | "text" | "blur";
type Point = { x: number; y: number };
export type Mark =
  | { tool: "pen" | "highlighter"; colour: string; width: number; points: Point[] }
  | { tool: "arrow" | "line" | "rect" | "ellipse" | "blur"; colour: string; width: number; from: Point; to: Point }
  | { tool: "text"; colour: string; width: number; at: Point; text: string };

const TOOLS: { key: Tool; label: string; icon: typeof Brush }[] = [
  { key: "pen", label: "Pen", icon: Brush }, { key: "highlighter", label: "Highlighter", icon: Highlighter }, { key: "arrow", label: "Arrow", icon: ArrowUpRight },
  { key: "line", label: "Line", icon: Minus }, { key: "rect", label: "Rectangle", icon: Square }, { key: "ellipse", label: "Ellipse", icon: Circle },
  { key: "text", label: "Text", icon: Type }, { key: "blur", label: "Blur", icon: EyeOff },
];
/** Red, amber, green, blue, black, white: readable on light and dark screens. */
export const COLOURS = [{ name: "Red", value: "#e5484d" }, { name: "Amber", value: "#f5a524" }, { name: "Green", value: "#30a46c" }, { name: "Blue", value: "#3e63dd" },
  { name: "Black", value: "#111111" }, { name: "White", value: "#ffffff" }];
const WIDTHS = [{ name: "Thin", value: 1 }, { name: "Medium", value: 2 }, { name: "Thick", value: 4 }];
const HINT: Record<Tool, string> = {
  pen: "Draw around what is wrong.", highlighter: "Mark over text to highlight it.", arrow: "Drag from the label to what is wrong.", line: "Drag to draw a straight line.",
  rect: "Drag to box what is wrong.", ellipse: "Drag to circle what is wrong.", text: "Tap where the label goes, type it, then press Enter.", blur: "Drag over anything private to hide it.",
};

/** Pixelate one rectangle of the canvas so nothing in it can be read. */
export function pixelate(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, block = 14, source?: CanvasImageSource) {
  const left = Math.max(0, Math.round(Math.min(x, x + width)));
  const top = Math.max(0, Math.round(Math.min(y, y + height)));
  const w = Math.min(context.canvas.width - left, Math.round(Math.abs(width)));
  const h = Math.min(context.canvas.height - top, Math.round(Math.abs(height)));
  if (w < 2 || h < 2) return;
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.ceil(w / block));
  small.height = Math.max(1, Math.ceil(h / block));
  const shrink = small.getContext("2d");
  if (!shrink) return;
  shrink.drawImage(source ?? context.canvas, left, top, w, h, 0, 0, small.width, small.height);
  const smoothing = context.imageSmoothingEnabled;
  context.imageSmoothingEnabled = false;
  context.drawImage(small, 0, 0, small.width, small.height, left, top, w, h);
  context.imageSmoothingEnabled = smoothing;
}

/** The stroke width in picture pixels: the chosen width scaled to the picture, so marks look the same on any screen. */
const strokeOf = (canvas: HTMLCanvasElement, width: number) => Math.max(2, (canvas.width / 260) * width);
const fontOf = (canvas: HTMLCanvasElement, width: number) => Math.round(Math.max(16, (canvas.width / 30) * (0.7 + width * 0.2)));

/** Draws one mark (blur needs the untouched picture as its source). */
export function drawMark(context: CanvasRenderingContext2D, mark: Mark, original: CanvasImageSource) {
  const canvas = context.canvas, line = strokeOf(canvas, mark.width);
  context.save();
  context.lineCap = "round"; context.lineJoin = "round"; context.strokeStyle = mark.colour; context.fillStyle = mark.colour; context.lineWidth = line;
  if (mark.tool === "pen" || mark.tool === "highlighter") {
    if (mark.tool === "highlighter") { context.globalAlpha = 0.35; context.lineWidth = line * 4; context.lineCap = "butt"; }
    const [first, ...rest] = mark.points;
    if (first) {
      context.beginPath(); context.moveTo(first.x, first.y);
      if (!rest.length) context.lineTo(first.x + 0.1, first.y);
      // A smooth line through the midpoints, so a quick stroke on a phone is not a polygon.
      for (let i = 0; i < rest.length; i += 1) {
        const p = rest[i], next = rest[i + 1];
        if (next) context.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2); else context.lineTo(p.x, p.y);
      }
      context.stroke();
    }
  } else if (mark.tool === "text") {
    const size = fontOf(canvas, mark.width);
    context.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`; context.textBaseline = "top";
    const lines = mark.text.split("\n"), pad = size * 0.3;
    const wide = Math.max(...lines.map((l) => context.measureText(l).width));
    // A label: the words on a contrasting plate, readable over any part of the screen.
    context.globalAlpha = 0.85; context.fillStyle = mark.colour === "#ffffff" ? "#111111" : "#ffffff";
    context.beginPath(); context.roundRect?.(mark.at.x - pad, mark.at.y - pad, wide + pad * 2, lines.length * size * 1.2 + pad * 2, pad); context.fill();
    context.globalAlpha = 1; context.fillStyle = mark.colour;
    lines.forEach((l, i) => context.fillText(l, mark.at.x, mark.at.y + i * size * 1.2));
  } else if ("from" in mark) {
    const { from, to } = mark;
    if (mark.tool === "blur") pixelate(context, from.x, from.y, to.x - from.x, to.y - from.y, Math.max(10, canvas.width / 90), original);
    else if (mark.tool === "rect") context.strokeRect(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    else if (mark.tool === "ellipse") {
      context.beginPath();
      context.ellipse((from.x + to.x) / 2, (from.y + to.y) / 2, Math.abs(to.x - from.x) / 2, Math.abs(to.y - from.y) / 2, 0, 0, Math.PI * 2);
      context.stroke();
    } else {
      context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke();
      if (mark.tool === "arrow") {
        const angle = Math.atan2(to.y - from.y, to.x - from.x), head = line * 4;
        context.beginPath(); context.moveTo(to.x, to.y);
        context.lineTo(to.x - head * Math.cos(angle - Math.PI / 7), to.y - head * Math.sin(angle - Math.PI / 7));
        context.lineTo(to.x - head * Math.cos(angle + Math.PI / 7), to.y - head * Math.sin(angle + Math.PI / 7));
        context.closePath(); context.fill();
      }
    }
  }
  context.restore();
}

/** Every mark over the picture: blurs first (always from the original, so nothing drawn later shows through), then the rest in order. */
export function paint(context: CanvasRenderingContext2D, original: CanvasImageSource, marks: readonly Mark[]) {
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  context.drawImage(original, 0, 0);
  for (const m of marks) if (m.tool === "blur") drawMark(context, m, original);
  for (const m of marks) if (m.tool !== "blur") drawMark(context, m, original);
}

export function MarkupEditor({ source, onDone, onCancel }: { source: Blob; onDone: (marked: Blob) => void; onCancel: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const original = useRef<HTMLCanvasElement | null>(null);
  // The picture with every finished mark, so a drag repaints one shape over it.
  const settled = useRef<HTMLCanvasElement | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [colour, setColour] = useState(COLOURS[0].value);
  const [width, setWidth] = useState(2);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [undone, setUndone] = useState<Mark[]>([]);
  const [ready, setReady] = useState(false);
  const [label, setLabel] = useState<{ at: Point; left: number; top: number; text: string } | null>(null);
  const live = useRef<Mark | null>(null);
  const labelBox = useRef<HTMLTextAreaElement>(null);
  // The label field takes focus once it is on screen (a press on the picture would otherwise take it back).
  const labelOpen = !!label;
  useLayoutEffect(() => { if (labelOpen) labelBox.current?.focus({ preventScroll: true }); }, [labelOpen]);
  const frame = useRef(0);

  useEffect(() => {
    let alive = true;
    const url = URL.createObjectURL(source);
    const image = new Image();
    image.onload = () => {
      const target = canvas.current;
      if (!alive || !target) return;
      const copy = document.createElement("canvas");
      copy.width = target.width = image.naturalWidth;
      copy.height = target.height = image.naturalHeight;
      copy.getContext("2d")?.drawImage(image, 0, 0);
      original.current = copy;
      settled.current = document.createElement("canvas");
      settled.current.width = copy.width; settled.current.height = copy.height;
      URL.revokeObjectURL(url);
      setReady(true);
    };
    image.src = url;
    return () => { alive = false; URL.revokeObjectURL(url); };
  }, [source]);

  // The finished marks change: paint them once into the cache and onto the screen.
  useEffect(() => {
    const target = canvas.current, base = original.current, cache = settled.current;
    const context = target?.getContext("2d"), cached = cache?.getContext("2d");
    if (!ready || !target || !base || !cache || !context || !cached) return;
    paint(cached, base, marks);
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(cache, 0, 0);
  }, [marks, ready]);

  const drawLive = useCallback(() => {
    frame.current = 0;
    const target = canvas.current, base = original.current, cache = settled.current, mark = live.current;
    const context = target?.getContext("2d");
    if (!target || !base || !cache || !context) return;
    if (mark?.tool === "blur") { paint(context, base, [...marks, mark]); return; }
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(cache, 0, 0);
    if (mark) drawMark(context, mark, base);
  }, [marks]);
  const schedule = () => { if (!frame.current) frame.current = requestAnimationFrame(drawLive); };
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);

  const point = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const target = event.currentTarget, box = target.getBoundingClientRect();
    return { x: ((event.clientX - box.left) / box.width) * target.width, y: ((event.clientY - box.top) / box.height) * target.height };
  };
  const add = (mark: Mark) => { setMarks((m) => [...m, mark]); setUndone([]); haptic("light"); };
  /** The label being typed as a mark (null when there is none or it is empty). */
  const typedLabel = (): Mark | null => { const text = label?.text.trim(); return label && text ? { tool: "text", colour, width, at: label.at, text } : null; };
  const commitLabel = () => { const mark = typedLabel(); if (mark) add(mark); setLabel(null); };
  const undo = () => { if (!marks.length) return; setUndone([...undone, marks[marks.length - 1]]); setMarks(marks.slice(0, -1)); };
  const redo = () => { if (!undone.length) return; setMarks([...marks, undone[undone.length - 1]]); setUndone(undone.slice(0, -1)); };

  useEffect(() => {
    // Ctrl+Z / Ctrl+Shift+Z (⌘ on a Mac) while marking up; never while typing a label.
    const onKey = (event: KeyboardEvent) => {
      if (label || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
    };
    // Capture: keys typed in the reporter stop at its root (dialog.tsx).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const finish = () => {
    const target = canvas.current, base = original.current;
    const context = target?.getContext("2d");
    if (!target || !base || !context) return;
    const typing = typedLabel();
    paint(context, base, typing ? [...marks, typing] : marks);
    target.toBlob((webp) => {
      if (webp && webp.type === "image/webp") return onDone(webp);
      target.toBlob((jpeg) => jpeg && onDone(jpeg), "image/jpeg", 0.88);
    }, "image/webp", 0.85);
  };

  return (
    <div className={styles.markup}>
      <div className={styles.markupTools} role="toolbar" aria-label="Mark up">
        <div className={styles.toolGroup} role="radiogroup" aria-label="Tool">
          {TOOLS.map(({ key, label: name, icon: Icon }) => <button key={key} type="button" role="radio" aria-checked={tool === key} className={styles.tool} title={name} aria-label={name}
            onClick={() => { commitLabel(); setTool(key); }}><Icon size={17} aria-hidden="true" /></button>)}
        </div>
        <div className={styles.toolGroup} role="radiogroup" aria-label="Colour" data-off={tool === "blur" ? "" : undefined}>
          {COLOURS.map((c) => <button key={c.value} type="button" role="radio" aria-checked={colour === c.value} aria-label={c.name} title={c.name} className={styles.swatch}
            style={{ "--swatch": c.value } as CSSProperties} disabled={tool === "blur"} onClick={() => setColour(c.value)} />)}
        </div>
        <div className={styles.toolGroup} role="radiogroup" aria-label="Width" data-off={tool === "blur" ? "" : undefined}>
          {WIDTHS.map((w) => <button key={w.value} type="button" role="radio" aria-checked={width === w.value} aria-label={w.name} title={w.name} className={styles.tool}
            disabled={tool === "blur"} onClick={() => setWidth(w.value)}><span className={styles.widthDot} style={{ width: 3 + w.value * 3, height: 3 + w.value * 3 }} /></button>)}
        </div>
        <div className={styles.toolGroup} aria-label="History">
          <button type="button" className={styles.tool} aria-label="Undo" title="Undo" disabled={!marks.length} onClick={undo}><Undo2 size={17} aria-hidden="true" /></button>
          <button type="button" className={styles.tool} aria-label="Redo" title="Redo" disabled={!undone.length} onClick={redo}><Redo2 size={17} aria-hidden="true" /></button>
          <button type="button" className={styles.tool} aria-label="Clear all marks" title="Clear all marks" disabled={!marks.length} onClick={() => { setUndone([...marks].reverse()); setMarks([]); }}><Trash2 size={17} aria-hidden="true" /></button>
        </div>
      </div>
      <p className={styles.markupHint} aria-live="polite">{HINT[tool]}</p>
      <div className={styles.markupStage} data-no-pull="">
        <div className={styles.markupFrame}>
          <canvas ref={canvas} className={styles.markupCanvas} aria-label="The picture of the screen" data-ready={ready || undefined} data-tool={tool}
            onPointerDown={(event) => {
              if (!ready || (event.pointerType === "mouse" && event.button !== 0)) return;
              const at = point(event);
              if (tool === "text") {
                event.preventDefault();
                if (label) { commitLabel(); return; }
                const box = event.currentTarget.getBoundingClientRect();
                setLabel({ at, left: event.clientX - box.left, top: event.clientY - box.top, text: "" });
                return;
              }
              event.currentTarget.setPointerCapture(event.pointerId);
              live.current = tool === "pen" || tool === "highlighter" ? { tool, colour, width, points: [at] } : { tool, colour, width, from: at, to: at };
              schedule();
            }}
            onPointerMove={(event) => {
              const mark = live.current;
              if (!mark) return;
              // A pen or stylus sends several points per frame: take them all, so curves stay round.
              const events = typeof event.nativeEvent.getCoalescedEvents === "function" ? event.nativeEvent.getCoalescedEvents() : [];
              const target = event.currentTarget, box = target.getBoundingClientRect();
              const toPoint = (e: { clientX: number; clientY: number }) => ({ x: ((e.clientX - box.left) / box.width) * target.width, y: ((e.clientY - box.top) / box.height) * target.height });
              if ("points" in mark) mark.points.push(...(events.length ? events.map(toPoint) : [point(event)]));
              else if ("to" in mark) mark.to = point(event);
              schedule();
            }}
            onPointerUp={() => {
              const mark = live.current;
              live.current = null;
              if (!mark) return;
              const tiny = "from" in mark && Math.hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y) < 4;
              if (!tiny) add(mark); else schedule();
            }}
            onPointerCancel={() => { live.current = null; schedule(); }}
          />
          {label ? <textarea ref={labelBox} className={styles.labelInput} rows={1} value={label.text} aria-label="Label text" placeholder="Type a label"
            style={{ left: label.left, top: label.top, color: colour }}
            onChange={(e) => setLabel({ ...label, text: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitLabel(); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setLabel(null); } }}
            onBlur={commitLabel} /> : null}
        </div>
      </div>
      <div className={styles.markupActions}>
        <button type="button" className={ui.btn} onClick={onCancel}>Cancel</button>
        <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} disabled={!ready} onClick={finish}>Use this picture</button>
      </div>
    </div>
  );
}
