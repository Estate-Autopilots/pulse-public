// CONTRACTS-PRO (owner, 15 Nov 2026: "sign by typing a name in a signature font"): a typed name drawn as handwriting, from
// the Hershey "Script 1-stroke" strokes (signature-script-data.js). One stroked path for the whole name, used by the signing
// sheet's preview (SVG) and the PDF (pdf-lib drawSvgPath), so the typed signature looks the same everywhere and needs no font file.
import { SCRIPT_GLYPHS } from './signature-script-data.js';

const ADVANCE = 1.68, SPACE = 12, HEIGHT = 34, BASELINE = 22;

/**
 * The name as one handwriting path: { d, width, height, baseline } in glyph units (y down), or null when the name has a
 * character the face does not have (accents, other scripts): then the caller shows the name in plain type.
 * @param {string} name
 */
export function scriptSignature(name) {
  const text = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!text) return null;
  let x = 0, d = '';
  for (const ch of text) {
    if (ch === ' ') { x += SPACE; continue; }
    const code = ch.codePointAt(0) ?? 0;
    const g = code >= 33 && code <= 126 ? SCRIPT_GLYPHS[code - 33] : null;
    if (!g) return null;
    d += ` ${g[1].replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, a, b) => `${round(Number(a) + x)},${b}`)}`;
    x += g[0] * ADVANCE;
  }
  return { d: d.trim(), width: round(x + 4), height: HEIGHT, baseline: BASELINE };
}
const round = (n) => Math.round(n * 100) / 100;

/** The typed signature as an SVG document (stroke only), e.g. for a preview. */
export function scriptSignatureSvg(name, { color = '#1e1b2e', stroke = 1.6 } = {}) {
  const s = scriptSignature(name);
  if (!s) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${s.width + 4} ${s.height + 4}"><path d="${s.d}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
