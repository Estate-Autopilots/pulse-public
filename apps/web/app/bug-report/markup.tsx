"use client";

// BUG-REPORT (owner, 27 Oct 2026; copied from Sales X-Ray): mark up the picture before it goes. Draw to point at what
// is wrong, blur to hide what the team should not see (a name, a number). A step inside the reporter, never a second
// panel: Cancel returns to the report unchanged, "Use this picture" keeps the marked copy. Everything happens on the device.
import { Brush, EyeOff, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import { haptic } from "../lib/native-shell";
import { styles as ui } from "../ui";
import styles from "./bug-report.module.css";

type Tool = "draw" | "blur";
const HISTORY = 12;

function tokenColour(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/** Pixelate one rectangle of the canvas so nothing in it can be read. */
export function pixelate(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  block = 14,
) {
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
  shrink.drawImage(
    context.canvas,
    left,
    top,
    w,
    h,
    0,
    0,
    small.width,
    small.height,
  );
  const smoothing = context.imageSmoothingEnabled;
  context.imageSmoothingEnabled = false;
  context.drawImage(small, 0, 0, small.width, small.height, left, top, w, h);
  context.imageSmoothingEnabled = smoothing;
}

export function MarkupEditor({
  source,
  onDone,
  onCancel,
}: {
  source: Blob;
  onDone: (marked: Blob) => void;
  onCancel: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("draw");
  const [ready, setReady] = useState(false);
  const [steps, setSteps] = useState(0);
  const history = useRef<ImageData[]>([]);
  const stroke = useRef<{ x: number; y: number; base?: ImageData } | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    const url = URL.createObjectURL(source);
    const image = new Image();
    image.onload = () => {
      const target = canvas.current;
      const context = target?.getContext("2d");
      if (!alive || !target || !context) return;
      target.width = image.naturalWidth;
      target.height = image.naturalHeight;
      context.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      setReady(true);
    };
    image.src = url;
    return () => {
      alive = false;
      URL.revokeObjectURL(url);
    };
  }, [source]);

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const target = event.currentTarget;
    const box = target.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * target.width,
      y: ((event.clientY - box.top) / box.height) * target.height,
    };
  };

  const remember = (context: CanvasRenderingContext2D) => {
    history.current = [
      ...history.current,
      context.getImageData(0, 0, context.canvas.width, context.canvas.height),
    ].slice(-HISTORY);
    setSteps(history.current.length);
  };

  const finish = () => {
    const target = canvas.current;
    if (!target) return;
    target.toBlob(
      (webp) => {
        if (webp && webp.type === "image/webp") return onDone(webp);
        target.toBlob((jpeg) => jpeg && onDone(jpeg), "image/jpeg", 0.88);
      },
      "image/webp",
      0.85,
    );
  };

  return (
    <div className={styles.markup}>
      <div className={styles.markupTools} role="toolbar" aria-label="Mark up">
        <button
          type="button"
          className={styles.chip}
          aria-pressed={tool === "draw"}
          onClick={() => setTool("draw")}
        >
          <Brush size={15} aria-hidden="true" />
          Draw
        </button>
        <button
          type="button"
          className={styles.chip}
          aria-pressed={tool === "blur"}
          onClick={() => setTool("blur")}
        >
          <EyeOff size={15} aria-hidden="true" />
          Blur
        </button>
        <button
          type="button"
          className={styles.chip}
          disabled={steps === 0}
          onClick={() => {
            const context = canvas.current?.getContext("2d");
            const last = history.current.pop();
            if (context && last) context.putImageData(last, 0, 0);
            setSteps(history.current.length);
          }}
        >
          <Undo2 size={15} aria-hidden="true" />
          Undo
        </button>
      </div>
      <p className={styles.markupHint}>
        {tool === "draw"
          ? "Draw around what is wrong."
          : "Drag over anything private to blur it."}
      </p>
      <div className={styles.markupFrame} data-no-pull="">
        <canvas
          ref={canvas}
          className={styles.markupCanvas}
          aria-label="The picture of the screen"
          data-ready={ready || undefined}
          onPointerDown={(event) => {
            const context = canvas.current?.getContext("2d");
            if (!context || !ready) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            remember(context);
            const at = point(event);
            stroke.current = {
              ...at,
              base:
                tool === "blur"
                  ? context.getImageData(
                      0,
                      0,
                      context.canvas.width,
                      context.canvas.height,
                    )
                  : undefined,
            };
            if (tool === "draw") {
              context.strokeStyle = tokenColour("--theme-danger", "#e5484d");
              context.lineWidth = Math.max(4, context.canvas.width / 120);
              context.lineCap = "round";
              context.lineJoin = "round";
              context.beginPath();
              context.moveTo(at.x, at.y);
            }
          }}
          onPointerMove={(event) => {
            const context = canvas.current?.getContext("2d");
            const start = stroke.current;
            if (!context || !start) return;
            const at = point(event);
            if (tool === "draw") {
              context.lineTo(at.x, at.y);
              context.stroke();
            } else if (start.base) {
              // Show the rectangle as it will be blurred.
              context.putImageData(start.base, 0, 0);
              pixelate(
                context,
                start.x,
                start.y,
                at.x - start.x,
                at.y - start.y,
              );
            }
          }}
          onPointerUp={() => {
            if (stroke.current) haptic("light");
            stroke.current = null;
          }}
          onPointerCancel={() => {
            stroke.current = null;
          }}
        />
      </div>
      <div className={styles.markupActions}>
        <button type="button" className={ui.btn} onClick={onCancel}>Cancel</button>
        <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} disabled={!ready} onClick={finish}>
          Use this picture
        </button>
      </div>
    </div>
  );
}
