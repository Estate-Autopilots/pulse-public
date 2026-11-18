/* AC design system: themes (owner workbench, 21 Oct 2026). One accent colour, a roundness and a density become the CSS
   every component reads (--theme-* colour in tokens.css, --ds-* scales in scale.css), in light and dark. An app writes
   themeCss(theme) into a <style> once; the editor reads a colour from a logo with colourFromImage(). */
export type Theme = { accent?: string | null; roundness?: number | null; density?: number | null };

const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The CSS for a theme; empty when nothing differs from the default. */
export function themeCss(theme: Theme | null | undefined): string {
  if (!theme) return "";
  const parts: string[] = [];
  const a = theme.accent && HEX.test(theme.accent) ? theme.accent : null;
  if (a) {
    parts.push(`:root,:root[data-theme="light"]{--theme-action:${a};--theme-action-hover:color-mix(in oklab,${a} 84%,black);--theme-focus:color-mix(in oklab,${a} 70%,white);`
      + `--theme-canvas:color-mix(in oklab,${a} 3%,#f6f6fa);--theme-surface-subtle:color-mix(in oklab,${a} 5%,#efeff6)}`);
    parts.push(`:root[data-theme="dark"]{--theme-action:color-mix(in oklab,${a} 55%,white);--theme-action-hover:color-mix(in oklab,${a} 42%,white);--theme-focus:color-mix(in oklab,${a} 45%,white)}`);
  }
  const scales: string[] = [];
  if (typeof theme.roundness === "number") scales.push(`--ds-roundness:${clamp(theme.roundness, 0.25, 1.75)}`);
  if (typeof theme.density === "number") scales.push(`--ds-density:${clamp(theme.density, 0.85, 1.2)}`);
  if (scales.length) parts.push(`:root{${scales.join(";")}}`);
  return parts.join("");
}

/** Readable text on a colour: black or white, by relative luminance. */
export function textOn(hex: string): "#000000" | "#ffffff" {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#000000" : "#ffffff";
}

/** The brand colour of a logo (browser only): the most common saturated, mid-light colour, so a white background,
 *  black text and anti-aliased edges never win. Null when the image has no such colour. */
export async function colourFromImage(src: string): Promise<string | null> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = src;
  await img.decode();
  const size = 64, canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, alpha] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (alpha < 200) continue;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), light = (max + min) / 510, sat = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
    if (sat < 0.35 || light < 0.15 || light > 0.85) continue;
    const key = `${r >> 5}-${g >> 5}-${b >> 5}`;
    const s = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    s.n++; s.r += r; s.g += g; s.b += b; buckets.set(key, s);
  }
  const best = [...buckets.values()].sort((x, y) => y.n - x.n)[0];
  if (!best) return null;
  const hex = (v: number) => Math.round(v / best.n).toString(16).padStart(2, "0");
  return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
}
