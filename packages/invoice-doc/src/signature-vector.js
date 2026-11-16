// POLISH-1115 (owner, 14 Nov 2026): "clean the upload into a crisp SVG and place it pixel-correct on the signed PDF".
// A signature is kept as a small PNG (screens, older readers, the copy pushed to the other company), and its vector rides
// inside that same PNG as a standard tEXt chunk ("pulse-signature"), so no table changes and nothing can separate the
// two. The PDF draws the vector (crisp at any zoom, ink only, sitting on the signing line); a PNG without one, or with
// one that fails the checks below, prints as the picture it is.
//
// The vector: { v: 1, box: [x, y, w, h], d: string[], stroke?: number }. `box` is the ink's bounds in the path's own
// units; `d` are SVG path strings of the moves the PDF can draw (M L Q C Z, numbers); `stroke` is a pen width for a
// drawn signature (its strokes are lines), absent for a traced photo (its outlines are filled, even-odd).

const KEY = 'pulse-signature';
const PATH_RE = /^[MLHVQCSTZmlhvqcstz0-9.,\s-]+$/;
const MAX_PATH = 120000;

let table = null;
function crc32(bytes) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const isPng = (b) => b && b.length > 33 && SIG.every((x, i) => b[i] === x);
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const latin1 = (s) => Uint8Array.from(Array.from(s, (ch) => ch.charCodeAt(0) & 0xff));

/** A vector checked and tidied, or null. @param {any} v */
export function tidyVector(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.box) || v.box.length !== 4 || !Array.isArray(v.d)) return null;
  const box = v.box.map(Number);
  if (box.some((n) => !Number.isFinite(n)) || box[2] < 1 || box[3] < 1 || box[2] > 5000 || box[3] > 5000) return null;
  const d = v.d.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 400);
  if (!d.length || d.some((x) => !PATH_RE.test(x)) || d.reduce((s, x) => s + x.length, 0) > MAX_PATH) return null;
  const stroke = v.stroke == null ? null : Number(v.stroke);
  if (stroke != null && !(stroke > 0 && stroke <= 40)) return null;
  return { v: 1, box, d, ...(stroke != null ? { stroke } : {}) };
}

/** The PNG with the vector written into it (before IEND), or the PNG unchanged when either is unusable. @param {Uint8Array} png @param {any} vector */
export function pngWithVector(png, vector) {
  const v = tidyVector(vector);
  if (!isPng(png) || !v) return png;
  const out = withoutVector(png);
  const data = latin1(`${KEY}\u0000${JSON.stringify(v)}`);
  const type = latin1('tEXt');
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length); chunk.set(type, 4); chunk.set(data, 8);
  const body = new Uint8Array(4 + data.length); body.set(type, 0); body.set(data, 4);
  dv.setUint32(8 + data.length, crc32(body));
  // IEND is the last 12 bytes of a PNG.
  const end = out.length - 12;
  const res = new Uint8Array(out.length + chunk.length);
  res.set(out.subarray(0, end), 0); res.set(chunk, end); res.set(out.subarray(end), end + chunk.length);
  return res;
}

/** The PNG without our chunk (so writing twice never keeps two). @param {Uint8Array} png */
function withoutVector(png) {
  const parts = [png.subarray(0, 8)];
  for (let i = 8; i + 12 <= png.length;) {
    const len = u32(png, i), end = i + 12 + len;
    if (end > png.length) return png;
    const type = String.fromCharCode(png[i + 4], png[i + 5], png[i + 6], png[i + 7]);
    const mine = type === 'tEXt' && String.fromCharCode(...png.subarray(i + 8, i + 8 + Math.min(len, KEY.length + 1))) === `${KEY}\u0000`;
    if (!mine) parts.push(png.subarray(i, end));
    i = end;
  }
  const n = parts.reduce((s, p) => s + p.length, 0), res = new Uint8Array(n);
  let at = 0; for (const p of parts) { res.set(p, at); at += p.length; }
  return res;
}

/** The vector kept in a signature PNG, checked; null when there is none or it fails a check. @param {Uint8Array | null | undefined} png */
export function vectorOfPng(png) {
  if (!isPng(png)) return null;
  for (let i = 8; i + 12 <= png.length;) {
    const len = u32(png, i), end = i + 12 + len;
    if (end > png.length) return null;
    const type = String.fromCharCode(png[i + 4], png[i + 5], png[i + 6], png[i + 7]);
    if (type === 'tEXt' && len > KEY.length + 1) {
      const data = png.subarray(i + 8, i + 8 + len);
      let text = ''; for (let k = 0; k < data.length; k++) text += String.fromCharCode(data[k]);
      if (text.startsWith(`${KEY}\u0000`)) {
        if (crc32(png.subarray(i + 4, i + 8 + len)) !== u32(png, i + 8 + len)) return null;
        try { return tidyVector(JSON.parse(text.slice(KEY.length + 1))); } catch { return null; }
      }
    }
    if (type === 'IEND') break;
    i = end;
  }
  return null;
}

/** data:image/png;base64 ↔ bytes, for the browser and Node alike. */
export function pngBytesOf(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!m) return null;
  const bin = atob(m[1]); const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}
export function pngDataUrl(bytes) {
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(s)}`;
}
