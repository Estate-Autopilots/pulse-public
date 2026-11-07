"use client";
// PR-STUDIO: a draft's brand image, drawn in the browser from the company's own brand (its accent colour, its mark from
// Settings → Organisation, the app's font) in the house style of the brand assets: a deep gradient, rings, a dot grid
// and the pulse line. Three templates: a headline, a list, a big number. Copy image puts a PNG on the clipboard;
// Download saves it. The same drawing runs in headless Chromium on the server for batch renders (docs/spec/PR-STUDIO.md).
import { useEffect, useRef, useState } from "react";
import { Copy, Download } from "lucide-react";
import { ratioSize, wrapLines } from "../lib/pr-studio.mjs";
import css from "./pr.module.css";

export type ImageSpec = { template: "headline" | "list" | "number"; ratio: "1:1" | "4:5" | "9:16" | "16:9"; kicker: string; title: string; lines: string[]; big: string | null };
export type BrandLook = { company: string; accent: string; font: string; mark: HTMLImageElement | null };

type RGB = [number, number, number];
const parse = (c: string): RGB | null => {
  const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(c);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = /^#([0-9a-f]{6})$/i.exec(c.trim());
  return h ? [parseInt(h[1].slice(0, 2), 16), parseInt(h[1].slice(2, 4), 16), parseInt(h[1].slice(4), 16)] : null;
};
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] * (1 - t) + b[i] * t)) as RGB;
const rgba = (c: RGB, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** The look of the company: its accent (the theme's action colour), the app's font and its mark, when it has one. */
export function useBrandLook(company: string): BrandLook | null {
  const [look, setLook] = useState<BrandLook | null>(null);
  useEffect(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--theme-action)";
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const font = getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";
    const done = (mark: HTMLImageElement | null) => setLook({ company, accent: parse(accent) ? accent : "rgb(107,76,240)", font, mark });
    const img = new Image();
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = "/api/v0/brand/mark";
  }, [company]);
  return look;
}

/** Draws one image onto a canvas sized for its shape. */
export function drawImage(canvas: HTMLCanvasElement, spec: ImageSpec, look: BrandLook, day: string) {
  const { width: W, height: H } = ratioSize(spec.ratio);
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext("2d");
  if (!g) return;
  const accent = parse(look.accent) ?? [107, 76, 240];
  const ink: RGB = [255, 255, 255], night: RGB = mix(accent, [8, 4, 24], 0.82), deep: RGB = mix(accent, [14, 8, 40], 0.62);
  const wide = W > H, pad = Math.round(Math.min(W, H) * 0.085), font = look.font;
  // Background: a deep gradient in the brand's colour, a glow top right, a glow bottom left.
  const bg = g.createLinearGradient(0, 0, W * 0.4, H);
  bg.addColorStop(0, rgba(deep)); bg.addColorStop(0.5, rgba(mix(deep, accent, 0.18))); bg.addColorStop(1, rgba(night));
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const glow = (x: number, y: number, r: number, c: RGB, a: number) => { const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, rgba(c, a)); rg.addColorStop(1, rgba(c, 0)); g.fillStyle = rg; g.fillRect(0, 0, W, H); };
  glow(W * 0.9, -H * 0.05, Math.max(W, H) * 0.6, mix(accent, ink, 0.35), 0.5);
  glow(-W * 0.1, H * 1.05, Math.max(W, H) * 0.55, accent, 0.45);
  // A dot grid fading from the top left, and rings around the top right.
  for (let y = 14; y < H * 0.55; y += 28) for (let x = 14; x < W * 0.6; x += 28) {
    const a = 0.16 * Math.max(0, 1 - Math.hypot(x / W, y / H) * 1.6);
    if (a > 0.01) { g.fillStyle = rgba(mix(accent, ink, 0.7), a); g.beginPath(); g.arc(x, y, 1.4, 0, Math.PI * 2); g.fill(); }
  }
  g.lineWidth = 1.4;
  [[140, 0.16], [230, 0.12], [330, 0.09], [440, 0.07], [560, 0.05]].forEach(([r, a]) => { g.strokeStyle = rgba(mix(accent, ink, 0.75), a); g.beginPath(); g.arc(W * 0.92, H * 0.1, r, 0, Math.PI * 2); g.stroke(); });
  // The pulse line across the lower part.
  const y0 = H * (spec.template === "number" ? 0.74 : 0.86), x = W * 0.3, s = Math.min(W, H) / 1080;
  const pts: [number, number][] = [[-20, y0], [x, y0], [x + 70 * s, y0 + 92 * s], [x + 144 * s, y0 - 57 * s], [x + 184 * s, y0], [W + 20, y0]];
  const line = g.createLinearGradient(0, 0, W, 0);
  line.addColorStop(0, rgba(accent, 0)); line.addColorStop(0.45, rgba(mix(accent, ink, 0.45), 0.5)); line.addColorStop(0.62, "rgba(255,141,138,0.5)"); line.addColorStop(1, rgba(accent, 0));
  g.strokeStyle = line; g.lineWidth = 4; g.lineJoin = "round"; g.lineCap = "round";
  g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.stroke();

  const text = (t: string, px: number, py: number, size: number, weight: number, color: string, spacing = 0) => {
    g.font = `${weight} ${size}px ${font}`; g.fillStyle = color; g.textBaseline = "alphabetic";
    if ("letterSpacing" in g) (g as unknown as { letterSpacing: string }).letterSpacing = `${spacing}px`;
    g.fillText(t, px, py);
    if ("letterSpacing" in g) (g as unknown as { letterSpacing: string }).letterSpacing = "0px";
  };
  const measure = (size: number, weight: number) => (t: string) => { g.font = `${weight} ${size}px ${font}`; return g.measureText(t).width; };
  const usable = (wide ? W * 0.62 : W) - pad * 2;
  let y = pad + Math.round(Math.min(W, H) * 0.06);
  // Kicker: a pill in the accent.
  const kick = spec.kicker.toUpperCase(), ks = Math.round(Math.min(W, H) * 0.024);
  g.font = `700 ${ks}px ${font}`;
  const kw = g.measureText(kick).width + kick.length * ks * 0.16 + ks * 2;
  g.fillStyle = rgba(mix(accent, ink, 0.12), 0.9); g.beginPath(); g.roundRect(pad, y - ks * 1.5, kw, ks * 2.3, ks * 1.15); g.fill();
  text(kick, pad + ks, y, ks, 700, "#fff", ks * 0.16);
  y += ks * 2.6;

  if (spec.template === "number") {
    const big = spec.big ?? "0", bs = Math.round(Math.min(W, H) * (big.length > 3 ? 0.26 : 0.34));
    y += bs * 0.95;
    const grad = g.createLinearGradient(pad, y - bs, pad + bs * big.length * 0.6, y);
    grad.addColorStop(0, "#ffffff"); grad.addColorStop(1, rgba(mix(accent, ink, 0.55)));
    g.font = `800 ${bs}px ${font}`; g.fillStyle = grad; g.fillText(big, pad - bs * 0.04, y);
    y += Math.round(bs * 0.32);
    const ts = Math.round(Math.min(W, H) * 0.06);
    for (const l of wrapLines(measure(ts, 700), spec.title, usable, 2)) { text(l, pad, y, ts, 700, "#fff"); y += ts * 1.15; }
  } else {
    let ts = Math.round(Math.min(W, H) * (spec.template === "list" ? 0.062 : 0.078));
    let tl = wrapLines(measure(ts, 800), spec.title, usable, 4);
    if (tl.length > 3) { ts = Math.round(ts * 0.86); tl = wrapLines(measure(ts, 800), spec.title, usable, 4); }
    y += ts * 0.6;
    for (const l of tl) { text(l, pad, y, ts, 800, "#fff"); y += ts * 1.12; }
    y += ts * 0.5;
    const ls = Math.round(Math.min(W, H) * (spec.template === "list" ? 0.036 : 0.032));
    const max = spec.template === "list" ? 5 : 3;
    for (const item of spec.lines.slice(0, max)) {
      if (y > H * 0.8) break;
      const r = ls * 0.62;
      g.fillStyle = rgba(mix(accent, ink, 0.25), 0.95); g.beginPath(); g.arc(pad + r, y - ls * 0.36, r, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "#fff"; g.lineWidth = Math.max(2, ls * 0.11); g.beginPath();
      g.moveTo(pad + r * 0.55, y - ls * 0.36); g.lineTo(pad + r * 0.9, y - ls * 0.36 + r * 0.38); g.lineTo(pad + r * 1.5, y - ls * 0.36 - r * 0.38); g.stroke();
      const wl = wrapLines(measure(ls, 600), item, usable - r * 3, 2);
      wl.forEach((l, i) => text(l, pad + r * 3, y + i * ls * 1.2, ls, 600, "rgba(240,236,255,0.92)"));
      y += ls * 1.2 * wl.length + ls * 0.75;
    }
  }
  // Footer: the mark and the company's name, and the day.
  const fs = Math.round(Math.min(W, H) * 0.03), fy = H - pad;
  let fx = pad;
  if (look.mark) { const m = fs * 1.9; try { g.drawImage(look.mark, fx, fy - m * 0.8, m, m); fx += m + fs * 0.6; } catch { /* a mark that cannot be drawn is left out */ } }
  text(look.company, fx, fy, fs, 700, "#fff");
  g.font = `500 ${Math.round(fs * 0.85)}px ${font}`;
  const dw = g.measureText(day).width;
  text(day, W - pad - dw, fy, Math.round(fs * 0.85), 500, "rgba(232,226,255,0.72)");
}

export function PrImage({ spec, look, day, name }: { spec: ImageSpec; look: BrandLook | null; day: string; name: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (ref.current && look) drawImage(ref.current, spec, look, day); }, [spec, look, day]);
  const blob = () => new Promise<Blob | null>((ok) => ref.current ? ref.current.toBlob(ok, "image/png") : ok(null));
  async function copy() {
    try {
      const b = await blob();
      if (!b || typeof ClipboardItem === "undefined") throw new Error("no clipboard");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]);
      setNote("Image copied");
    } catch { setNote("This browser cannot copy images: use Download"); }
  }
  async function download() {
    const b = await blob();
    if (!b) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b); a.download = `${name}.png`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  return <figure className={css.image} data-ratio={spec.ratio}>
    <canvas ref={ref} aria-label={`${spec.kicker}: ${spec.title}`} role="img" />
    <figcaption>
      <button type="button" className={css.btn} onClick={copy}><Copy size={14} aria-hidden="true" />Copy image</button>
      <button type="button" className={css.btn} onClick={download}><Download size={14} aria-hidden="true" />Download</button>
      {note ? <span className={css.note} role="status">{note}</span> : null}
    </figcaption>
  </figure>;
}
