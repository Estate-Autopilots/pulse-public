// UX-DELIGHT (6 Nov 2026): the app's small moments of motion, in one place. Written here (no dependency, about 2 KB),
// after studying canvas-confetti (ISC), react-rewards (MIT) and motion (MIT): see docs/design/MOTION.md for what each
// taught and why none is installed. Every effect is a no-op when the person asks for reduced motion, on the server, and
// when the browser lacks the API; none of them blocks input or holds focus.

/** True when the person has asked their system for less motion (or we cannot tell: no window). */
export function reducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

type Origin = Element | { x: number; y: number } | null | undefined;
type Piece = { x: number; y: number; vx: number; vy: number; size: number; spin: number; turn: number; color: string; shape: 0 | 1 | 2 };

function point(origin: Origin): { x: number; y: number } {
  if (origin && "getBoundingClientRect" in origin) {
    const r = origin.getBoundingClientRect();
    if (r.width || r.height) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  } else if (origin && "x" in origin) return origin;
  return { x: window.innerWidth / 2, y: window.innerHeight * 0.4 };
}

function palette(): string[] {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return [v("--theme-success", "#328267"), v("--theme-action", "#5b45d6"), v("--theme-warning", "#b7791f"), "#f2b705", "#e86a92", "#3fa7d6"];
}

/**
 * A short burst of confetti from a point (a tick, a button) or, with `big`, a wider shower for the last task of the
 * day or a project. Drawn on one fixed canvas that removes itself; pointer events pass through it.
 */
export function burst(origin?: Origin, opts: { big?: boolean } = {}): void {
  if (reducedMotion() || typeof document === "undefined") return;
  const canvas = document.createElement("canvas"); const ctx = canvas.getContext("2d"); if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = window.innerWidth, h = window.innerHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, { position: "fixed", inset: "0", width: `${w}px`, height: `${h}px`, pointerEvents: "none", zIndex: "2147483000" });
  document.body.appendChild(canvas); ctx.scale(dpr, dpr);
  const colors = palette(), big = !!opts.big, from = point(origin);
  const pieces: Piece[] = [];
  const add = (x: number, y: number, n: number, spread: number, speed: number, angle: number) => {
    for (let i = 0; i < n; i++) {
      const a = angle + (Math.random() - 0.5) * spread, s = speed * (0.55 + Math.random() * 0.6);
      pieces.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, size: 4 + Math.random() * 4, spin: Math.random() * Math.PI, turn: (Math.random() - 0.5) * 0.3,
        color: colors[i % colors.length], shape: (i % 3) as 0 | 1 | 2 });
    }
  };
  if (big) { add(w * 0.15, h * 0.95, 70, 0.9, 17, -Math.PI / 2.6); add(w * 0.85, h * 0.95, 70, 0.9, 17, -Math.PI + Math.PI / 2.6); add(from.x, from.y, 30, Math.PI * 2, 8, 0); }
  else add(from.x, from.y, 26, Math.PI * 2, 6.5, -Math.PI / 2);
  const life = big ? 2200 : 1000; const start = performance.now();
  const frame = (now: number) => {
    const t = now - start; ctx.clearRect(0, 0, w, h);
    const fade = Math.max(0, 1 - Math.max(0, t - life * 0.55) / (life * 0.45));
    for (const p of pieces) {
      p.vx *= 0.975; p.vy = p.vy * 0.975 + (big ? 0.32 : 0.22); p.x += p.vx; p.y += p.vy; p.spin += p.turn;
      ctx.save(); ctx.globalAlpha = fade; ctx.fillStyle = p.color; ctx.translate(p.x, p.y); ctx.rotate(p.spin);
      if (p.shape === 0) ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      else if (p.shape === 1) { ctx.beginPath(); ctx.arc(0, 0, p.size / 2.6, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(0, -p.size / 2); ctx.lineTo(p.size / 2, p.size / 2); ctx.lineTo(-p.size / 2, p.size / 2); ctx.closePath(); ctx.fill(); }
      ctx.restore();
    }
    if (t < life) requestAnimationFrame(frame); else canvas.remove();
  };
  requestAnimationFrame(frame);
}

/**
 * The error pattern: the field or card shakes once and glows red for a moment, so the eye finds what to fix. The
 * words of the error stay the caller's (a toast or the field's own message). With reduced motion it only glows.
 */
export function shake(el: Element | null | undefined): void {
  if (!el || typeof (el as HTMLElement).animate !== "function") return;
  const glow = "0 0 0 3px color-mix(in srgb, var(--theme-danger) 35%, transparent)";
  const keys: Keyframe[] = reducedMotion()
    ? [{ boxShadow: glow }, { boxShadow: glow, offset: 0.7 }, { boxShadow: "none" }]
    : [{ transform: "translateX(0)", boxShadow: glow }, { transform: "translateX(-6px)" }, { transform: "translateX(5px)" }, { transform: "translateX(-4px)" },
      { transform: "translateX(3px)" }, { transform: "translateX(0)", boxShadow: glow, offset: 0.6 }, { transform: "translateX(0)", boxShadow: "none" }];
  try { (el as HTMLElement).animate(keys, { duration: 900, easing: "ease-out" }); } catch { /* old browser: the message still shows */ }
}

/** Shake the first invalid field in a form (or the form itself) and move focus there. */
export function shakeInvalid(form: HTMLFormElement | null | undefined): void {
  if (!form) return;
  const bad = form.querySelector<HTMLElement>(":invalid:not(fieldset):not(form), [aria-invalid=\"true\"]");
  shake(bad ?? form); bad?.focus?.();
}
