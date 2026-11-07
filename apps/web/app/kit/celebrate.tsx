"use client";
// UX-POLISH-2 (owner, 6 Nov 2026): confetti, only on a real milestone (a month's books fully closed), once per milestone
// per browser, about a second and a half, then gone. A small canvas of its own (no library); nothing under
// prefers-reduced-motion. The idea follows canvas-confetti (ISC) and Magic UI's confetti (MIT); no code taken.
import { useEffect } from "react";

const COLORS = ["--theme-action", "--theme-success", "--theme-warning", "--theme-info", "--theme-brand-2"];

export function Celebrate({ when, id }: { when: boolean; /** One milestone (e.g. "close-2026-10"): it celebrates once. */ id: string }) {
  useEffect(() => {
    if (!when || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const key = `pulse-celebrated:${id}`;
    try { if (localStorage.getItem(key)) return; localStorage.setItem(key, "1"); } catch { /* private mode: celebrate anyway */ }
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    Object.assign(canvas.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh", pointerEvents: "none", zIndex: "9999" });
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d"); if (!ctx) { canvas.remove(); return; }
    const dpr = Math.min(2, devicePixelRatio || 1); canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const colors = COLORS.map((c) => css.getPropertyValue(c).trim() || "#7a68e6");
    const bits = Array.from({ length: 110 }, (_, i) => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 120, y: innerHeight * 0.35,
      vx: (Math.random() - 0.5) * 11, vy: -Math.random() * 11 - 4, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
      w: 6 + Math.random() * 5, h: 3 + Math.random() * 4, c: colors[i % colors.length],
    }));
    const t0 = performance.now(); let frame = 0;
    const draw = (now: number) => {
      const t = (now - t0) / 1600; ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const b of bits) {
        b.vy += 0.32; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.r += b.vr;
        ctx.save(); ctx.globalAlpha = Math.max(0, 1 - t * t); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
      }
      if (t < 1) frame = requestAnimationFrame(draw); else canvas.remove();
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); canvas.remove(); };
  }, [when, id]);
  return null;
}
