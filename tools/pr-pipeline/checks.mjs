// PR-PIPELINE: the visual checks of a creative. measure() runs inside the page (it must stay self-contained: Playwright
// serialises it); the colour maths and summarise() are pure and tested with node --test (tests/checks.test.mjs).

export const parseColor = (c) => {
  const m = String(c).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
};
export const luminance = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
export const over = (t, b) => { const a = t[3]; return [t[0] * a + b[0] * (1 - a), t[1] * a + b[1] * (1 - a), t[2] * a + b[2] * (1 - a), 1]; };
export const contrast = (a, b) => { const l1 = luminance(a), l2 = luminance(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

/** In the page: every text run with its colour, the colour behind it, its size and its box. */
export function measure({ W, H }) {
  const parse = (c) => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const over = (t, b) => { const a = t[3]; return [t[0] * a + b[0] * (1 - a), t[1] * a + b[1] * (1 - a), t[2] * a + b[2] * (1 - a), 1]; };
  const bgOf = (el) => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } } let col = [255, 255, 255, 1]; for (let i = layers.length - 1; i >= 0; i--) col = over(layers[i], col); return col; };
  const runs = new Map();
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement; if (!el || el.closest('[data-deco],script,style,title,svg')) continue;
    const r = document.createRange(); r.selectNodeContents(n); const rects = [...r.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
    if (!rects.length) continue;
    const box = rects.reduce((a, x) => ({ l: Math.min(a.l, x.left), t: Math.min(a.t, x.top), r: Math.max(a.r, x.right), b: Math.max(a.b, x.bottom) }), { l: 1e9, t: 1e9, r: -1e9, b: -1e9 });
    const prev = runs.get(el);
    if (prev) { prev.text += ' ' + n.nodeValue.trim(); prev.box = { l: Math.min(prev.box.l, box.l), t: Math.min(prev.box.t, box.t), r: Math.max(prev.box.r, box.r), b: Math.max(prev.box.b, box.b) }; }
    else runs.set(el, { text: n.nodeValue.trim(), box });
  }
  const out = [];
  for (const [el, run] of runs) {
    const cs = getComputedStyle(el);
    out.push({ text: run.text.slice(0, 80), color: parse(cs.color), bg: bgOf(el), fontPx: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10) || 400,
      box: [run.box.l, run.box.t, run.box.r, run.box.b] });
  }
  const overflow = [];
  document.querySelectorAll('[data-fit]').forEach((el) => { if (el.scrollWidth > el.clientWidth + 1) overflow.push(`too wide: "${el.textContent.trim().slice(0, 30)}"`); });
  const main = document.querySelector('.main'); if (main && main.scrollHeight > main.clientHeight + 2) overflow.push(`taller than its area by ${main.scrollHeight - main.clientHeight}px`);
  return { runs: out, overflow, W, H };
}

/** The three visual checks from the measurements. */
export function summarise(m, { W, H, min = 4.5 }) {
  const mx = W * 0.04, my = H * 0.04, scale = 360 / W;
  const low = [], outside = [];
  let worst = Infinity, smallest = Infinity;
  for (const r of m.runs) {
    if (!r.color || !r.bg) continue;
    const fg = r.color[3] < 1 ? over(r.color, r.bg) : r.color;
    const c = contrast(fg, r.bg);
    worst = Math.min(worst, c);
    if (c < min) low.push({ text: r.text.slice(0, 40), ratio: +c.toFixed(2) });
    smallest = Math.min(smallest, r.fontPx * scale);
    const [l, t, rr, b] = r.box;
    if (l < mx - 0.5 || t < my - 0.5 || rr > W - mx + 0.5 || b > H - my + 0.5) outside.push(r.text.slice(0, 40));
  }
  return {
    contrast: { ok: low.length === 0, min, worst: Number.isFinite(worst) ? +worst.toFixed(2) : null, low: low.slice(0, 8) },
    legible360: { ok: !(smallest < 9), smallestPx: Number.isFinite(smallest) ? +smallest.toFixed(1) : null },
    cropSafe: { ok: outside.length === 0 && m.overflow.length === 0, outside: outside.slice(0, 8), overflow: m.overflow.slice(0, 4) },
  };
}
