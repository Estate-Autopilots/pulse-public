// CONTRACTS-PRO (owner, 15 Nov 2026): sign by uploading a photo of a signature on paper. The photo is cleaned here, in
// the browser, and nothing but the result leaves the device:
//   1. grey levels, then each pixel against the paper around it (a wide blur), so shadows and uneven light fall away;
//   2. ink is what is clearly darker than its own paper (Otsu's threshold on that contrast, nudged by "Lighter/Darker");
//   3. specks are removed (small blobs) and so are ruled lines (long, very flat blobs);
//   4. the ink is cropped with a margin and traced into closed outlines (our own edge tracer), simplified and smoothed
//      into curves: a crisp vector signature (SVG) at any size.
// The signature kept with the agreement is that vector drawn at 2× into a small PNG (transparent background).
// Pure functions over { data, width, height } (ImageData's shape) so they run in node tests too.

/** @typedef {{ data: Uint8ClampedArray | Uint8Array; width: number; height: number }} Img */

/** Grey level 0–255 per pixel. @param {Img} img */
export function greyOf(img) {
  const { data, width, height } = img, g = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3] / 255;
    g[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) * a + 255 * (1 - a); // transparent reads as paper
  }
  return g;
}

/** A box blur of radius r (an integral image): the paper's own brightness around each pixel. */
function blur(g, w, h, r) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(w, x + r + 1), y1 = Math.min(h, y + r + 1);
    out[y * w + x] = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
  }
  return out;
}

/** Otsu's threshold of values in 0..1 (256 bins). */
function otsu(v) {
  const hist = new Float64Array(256);
  for (const x of v) hist[Math.max(0, Math.min(255, Math.round(x * 255)))]++;
  const total = v.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, at = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; at = i; }
  }
  return at / 255;
}

/**
 * The ink of a photo as a mask, cleaned and cropped.
 * @param {Img} img @param {{ darker?: number }} [o] darker: −2..2 moves the threshold (lighter pens, darker paper)
 * @returns {{ mask: Uint8Array; width: number; height: number; ink: [number, number, number]; found: boolean }}
 */
export function cleanSignature(img, o = {}) {
  const { width: w, height: h } = img;
  const g = greyOf(img);
  const paper = blur(g, w, h, Math.max(8, Math.round(Math.min(w, h) / 12)));
  const contrast = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) contrast[i] = Math.max(0, Math.min(1, g[i] / Math.max(1, paper[i])));
  // Ink is clearly darker than the paper around it; Otsu finds the split, never looser than 0.9 nor tighter than 0.45.
  const t = Math.max(0.45, Math.min(0.9, Math.min(otsu(contrast), 0.86) + (Number(o.darker) || 0) * 0.04));
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = contrast[i] < t ? 1 : 0;
  // Blobs: drop specks and ruled lines.
  const { labels, blobs } = label(mask, w, h);
  const minArea = Math.max(6, Math.round(w * h * 0.00004));
  const keep = new Uint8Array(blobs.length + 1);
  for (const b of blobs) {
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
    const ruled = bw > w * 0.45 && bh <= Math.max(4, h * 0.012) * 2 && b.area / (bw * bh) > 0.5;
    keep[b.id] = b.area >= minArea && !ruled ? 1 : 0;
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1, r = 0, gg = 0, bb = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!keep[labels[i]] || !mask[i]) { mask[i] = 0; continue; }
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    r += img.data[i * 4]; gg += img.data[i * 4 + 1]; bb += img.data[i * 4 + 2]; n++;
  }
  if (x1 < 0) return { mask: new Uint8Array(0), width: 0, height: 0, ink: [30, 27, 46], found: false };
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04) + 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = mask[(y + y0) * w + x + x0];
  // The pen's own colour, darkened a little so it prints crisply (blue ink stays blue).
  const ink = /** @type {[number, number, number]} */ ([r / n, gg / n, bb / n].map((c) => Math.round(c * 0.6)));
  return { mask: out, width: cw, height: ch, ink, found: true };
}

/** Connected blobs (8-neighbours) of a mask: a label per pixel and each blob's box and area. */
function label(mask, w, h) {
  const labels = new Int32Array(w * h), blobs = [], stack = [];
  let id = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s]) continue;
    id++; const b = { id, area: 0, x0: w, y0: h, x1: 0, y1: 0 };
    labels[s] = id; stack.push(s);
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      b.area++; if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (mask[j] && !labels[j]) { labels[j] = id; stack.push(j); }
      }
    }
    blobs.push(b);
  }
  return { labels, blobs };
}

/**
 * The outlines of a mask as closed loops of corner points (outer loops clockwise on screen, holes the other way).
 * Each ink pixel adds the sides it shares with paper as directed edges; the edges are joined into loops.
 * @param {Uint8Array} mask @param {number} w @param {number} h @returns {number[][][]} loops of [x, y]
 */
export function traceLoops(mask, w, h) {
  const W = w + 1, next = new Map();
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
  const add = (a, b) => { const l = next.get(a); if (l) l.push(b); else next.set(a, [b]); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    if (!at(x, y - 1)) add(y * W + x, y * W + x + 1);
    if (!at(x + 1, y)) add(y * W + x + 1, (y + 1) * W + x + 1);
    if (!at(x, y + 1)) add((y + 1) * W + x + 1, (y + 1) * W + x);
    if (!at(x - 1, y)) add((y + 1) * W + x, y * W + x);
  }
  const loops = [];
  for (const [start, ends] of next) {
    while (ends.length) {
      const loop = [];
      let from = start, to = ends.pop();
      loop.push([from % W, Math.floor(from / W)]);
      for (let guard = 0; to !== start && guard < 4 * w * h + 8; guard++) {
        loop.push([to % W, Math.floor(to / W)]);
        const options = next.get(to);
        if (!options?.length) break;
        // At a corner two loops touch (diagonal pixels): turn right, so each loop stays on its own pixels.
        let pick = 0;
        if (options.length > 1) {
          const dx = (to % W) - (from % W), dy = Math.floor(to / W) - Math.floor(from / W);
          pick = options.findIndex((o) => { const ex = (o % W) - (to % W), ey = Math.floor(o / W) - Math.floor(to / W); return dx * ey - dy * ex > 0; });
          if (pick < 0) pick = 0;
        }
        from = to; to = options.splice(pick, 1)[0];
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

/** Ramer–Douglas–Peucker on a closed loop. */
function simplify(pts, eps) {
  if (pts.length < 8) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b], L = Math.hypot(bx - ax, by - ay) || 1;
    let far = -1, best = eps;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L; if (d > best) { best = d; far = i; } }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * A mask as smooth SVG path data: each loop simplified, then drawn as quadratic curves through the mid-points of its
 * sides (pixel stairs become curves). Fill with fill-rule="evenodd" so holes (the eye of an "e") stay open.
 * @param {Uint8Array} mask @param {number} w @param {number} h @returns {string[]}
 */
export function tracePaths(mask, w, h) {
  const r = (n) => Math.round(n * 10) / 10;
  return traceLoops(mask, w, h).map((loop) => {
    const p = simplify(loop, 0.9);
    if (p.length < 3) return '';
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const m0 = mid(p[p.length - 1], p[0]);
    let d = `M${r(m0[0])} ${r(m0[1])}`;
    for (let i = 0; i < p.length; i++) { const m = mid(p[i], p[(i + 1) % p.length]); d += `Q${r(p[i][0])} ${r(p[i][1])} ${r(m[0])} ${r(m[1])}`; }
    return `${d}Z`;
  }).filter(Boolean);
}

/** The cleaned signature as an SVG document (for the preview and as the vector kept on the device). */
export function signatureSvg(paths, w, h, ink = [30, 27, 46]) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path fill="rgb(${ink.join(',')})" fill-rule="evenodd" d="${paths.join('')}"/></svg>`;
}
