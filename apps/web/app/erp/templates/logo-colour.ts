// BILLING-SETUP: the colours of a company's logo, worked out in the browser, so a template's colour can be offered from
// the logo. The image is drawn small on a canvas; transparent, near-white and grey pixels are left out; similar colours
// are pooled and the strongest few come back, darkened where needed so white text stays legible on a band.

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;

function hsl(r: number, g: number, b: number) {
  const R = r / 255, G = g / 255, B = b / 255, max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2;
  const s = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  return { s, l };
}

/** Darkens a colour until its lightness is at most `limit` (a band of a light yellow is unreadable with white text). */
function printable(r: number, g: number, b: number, limit = 0.46) {
  const { l } = hsl(r, g, b);
  if (l <= limit) return hex(r, g, b);
  const k = limit / l;
  return hex(r * k, g * k, b * k);
}

const cache = new Map<string, Promise<string[]>>();

/** Up to `count` accent colours from the image at `src` (a same-origin URL); [] when there is none or it has no colour. */
export function logoColours(src: string | null, count = 3): Promise<string[]> {
  if (!src || typeof document === "undefined") return Promise.resolve([]);
  if (!cache.has(src)) cache.set(src, new Promise<string[]>((done) => {
    const img = new Image();
    img.decoding = "async";
    img.onerror = () => done([]);
    img.onload = () => {
      try {
        const size = 64, canvas = document.createElement("canvas");
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return done([]);
        const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
        ctx.drawImage(img, 0, 0, Math.max(1, img.naturalWidth * scale), Math.max(1, img.naturalHeight * scale));
        const px = ctx.getImageData(0, 0, size, size).data;
        const pools = new Map<number, { n: number; r: number; g: number; b: number; weight: number }>();
        for (let i = 0; i < px.length; i += 4) {
          const [r, g, b, a] = [px[i], px[i + 1], px[i + 2], px[i + 3]];
          if (a < 200) continue;
          const { s, l } = hsl(r, g, b);
          if (l > 0.93 || (s < 0.16 && l > 0.25)) continue;                  // paper and greys
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const p = pools.get(key) ?? { n: 0, r: 0, g: 0, b: 0, weight: 0 };
          p.n++; p.r += r; p.g += g; p.b += b; p.weight += 0.35 + s;          // a coloured pixel counts more than a dark one
          pools.set(key, p);
        }
        const ranked = [...pools.values()].sort((x, y) => y.weight - x.weight).map((p) => [p.r / p.n, p.g / p.n, p.b / p.n] as const);
        const picked: (readonly [number, number, number])[] = [];
        for (const c of ranked) {
          if (picked.length >= count) break;
          if (picked.every((q) => Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]) > 60)) picked.push(c);
        }
        done(picked.map(([r, g, b]) => printable(r, g, b)));
      } catch { done([]); }
    };
    img.src = src;
  }));
  return cache.get(src)!;
}
