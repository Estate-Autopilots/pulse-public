// PEOPLE-CONTACTS (owner, 11 Oct 2026): the maths behind the photo and logo cropper (app/image-crop.tsx), kept pure so
// it is unit-tested: where a JPEG says "turn me" (EXIF orientation), how far the picture may move and shrink so it
// always fills the frame, and which part of the original ends up in the saved image.
//
// Geometry: the frame (W × H) sits in the middle of the stage. The picture (iw × ih, already upright) is drawn centred
// on (x, y) relative to the frame's centre, turned by `angle` degrees and scaled by `scale`. It must cover the frame:
// every corner of the frame, seen from the picture, lies inside the picture.

/** EXIF orientation (1–8) of a JPEG's bytes, or 1 when there is none or it is not a JPEG. */
export function exifOrientation(buffer) {
  const v = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset ?? 0, buffer.byteLength);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let at = 2;
  while (at + 4 <= v.byteLength) {
    const marker = v.getUint16(at);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda || marker === 0xffd9) return 1;   // start of scan: no more metadata
    const length = v.getUint16(at + 2);
    if (length < 2) return 1;
    if (marker === 0xffe1 && at + 10 <= v.byteLength && v.getUint32(at + 4) === 0x45786966 && v.getUint16(at + 8) === 0) {   // "Exif\0\0"
      const tiff = at + 10;
      if (tiff + 8 > v.byteLength) return 1;
      const little = v.getUint16(tiff) === 0x4949;
      if (!little && v.getUint16(tiff) !== 0x4d4d) return 1;
      const ifd = tiff + v.getUint32(tiff + 4, little);
      if (ifd + 2 > v.byteLength) return 1;
      const entries = v.getUint16(ifd, little);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > v.byteLength) return 1;
        if (v.getUint16(entry, little) === 0x0112) {
          const o = v.getUint16(entry + 8, little);
          return o >= 1 && o <= 8 ? o : 1;
        }
      }
      return 1;
    }
    at += 2 + length;
  }
  return 1;
}

/** A JPEG with an EXIF orientation added right after its start marker (the browser probe and the tests use it). */
export function withOrientation(jpeg, orientation) {
  const src = new Uint8Array(jpeg instanceof ArrayBuffer ? jpeg : jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength));
  const app1 = [0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  const out = new Uint8Array(src.length + app1.length);
  out.set(src.subarray(0, 2)); out.set(app1, 2); out.set(src.subarray(2), 2 + app1.length);
  return out;
}

/** The canvas transform that draws a raw (sensor-order) image of w × h upright, and the upright size.
 *  `matrix` is [a, b, c, d, e, f] for CanvasRenderingContext2D.setTransform. */
export function orient(orientation, w, h) {
  const swap = orientation >= 5;
  const size = swap ? { width: h, height: w } : { width: w, height: h };
  const m = {
    1: [1, 0, 0, 1, 0, 0], 2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h], 4: [1, 0, 0, -1, 0, h],
    5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, h, 0], 7: [0, -1, -1, 0, h, w], 8: [0, -1, 1, 0, 0, w],
  }[orientation] ?? [1, 0, 0, 1, 0, 0];
  return { ...size, matrix: m };
}

const rad = (deg) => (deg * Math.PI) / 180;

/** The smallest scale at which the turned picture still covers the frame. */
export function minScale(frame, image, angle) {
  const c = Math.abs(Math.cos(rad(angle))), s = Math.abs(Math.sin(rad(angle)));
  return Math.max((frame.w * c + frame.h * s) / image.w, (frame.w * s + frame.h * c) / image.h);
}

/** Move and scale back into range: scale at least `minScale` and at most `max` × that; the frame stays covered. */
export function clampView(view, frame, image, max = 8) {
  const least = minScale(frame, image, view.angle);
  const scale = Math.min(Math.max(view.scale, least), least * max);
  const a = rad(view.angle), cos = Math.cos(a), sin = Math.sin(a);
  // The picture's centre as seen along its own axes (the frame turned the other way).
  const u = cos * view.x + sin * view.y, w = -sin * view.x + cos * view.y;
  const c = Math.abs(cos), s = Math.abs(sin);
  const ex = Math.max(0, (image.w * scale) / 2 - (frame.w * c + frame.h * s) / 2);
  const ey = Math.max(0, (image.h * scale) / 2 - (frame.w * s + frame.h * c) / 2);
  const cu = Math.min(Math.max(u, -ex), ex), cw = Math.min(Math.max(w, -ey), ey);
  return { ...view, scale, x: cos * cu - sin * cw, y: sin * cu + cos * cw };
}

/** Whether the view already covers the frame (within half a pixel). */
export function covers(view, frame, image) {
  const c = clampView(view, frame, image, Infinity);
  return Math.abs(c.x - view.x) < 0.5 && Math.abs(c.y - view.y) < 0.5 && view.scale >= minScale(frame, image, view.angle) - 1e-6;
}

/** Zoom by `factor` keeping the stage point `at` (relative to the frame's centre) still under the finger or cursor. */
export function zoomAt(view, factor, at = { x: 0, y: 0 }) {
  return { ...view, scale: view.scale * factor, x: at.x + (view.x - at.x) * factor, y: at.y + (view.y - at.y) * factor };
}

/** Where a frame point lands in the upright picture's pixels (for tests and the saved image's bounds). */
export function framePointToImage(view, image, point) {
  const a = rad(view.angle), dx = point.x - view.x, dy = point.y - view.y;
  const lx = (Math.cos(a) * dx + Math.sin(a) * dy) / view.scale, ly = (-Math.sin(a) * dx + Math.cos(a) * dy) / view.scale;
  return { x: lx + image.w / 2, y: ly + image.h / 2 };
}

/** The saved image's size: `long` pixels on its long side, never more than the picture really has (no upscaling
 *  beyond 1.5×, which only adds blur), and at least `least`. */
export function outputSize(frame, view, aspect, long = 1024, least = 256) {
  const real = frame.w / view.scale;   // picture pixels across the frame
  const wide = Math.round(Math.max(least, Math.min(long, real * 1.5)));
  return aspect >= 1 ? { width: wide, height: Math.max(1, Math.round(wide / aspect)) } : { width: Math.max(1, Math.round(wide * aspect)), height: wide };
}

/** A step in a gentle spring towards `to` (critically damped, frame-rate independent). Returns the next value and speed. */
export function spring(from, to, velocity, dt, stiffness = 260) {
  const w = Math.sqrt(stiffness), x = from - to, e = Math.exp(-w * dt);
  const next = to + (x + (velocity + w * x) * dt) * e;
  const speed = (velocity - (velocity + w * x) * w * dt) * e;
  return { value: next, velocity: speed };
}
