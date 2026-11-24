// AI-AGENTS-3 (owner, 17 Nov 2026: "a simple guided flow with a QR code so a person scans and has their own bot
// connected in seconds"): a QR code for a link from the `qrcode` package (MIT, a widely used, maintained encoder;
// THIRD_PARTY.md), drawn as one SVG path so the browser needs no canvas and nothing is set as raw HTML.
// qr-code.test.mjs paints what this draws into pixels and reads it back with an independent decoder (jsQR), so a
// phone's camera gets the same link. (lib/qr.mjs, PRESENCE-ONBOARD's own encoder for install links, is unchanged.)
import QRCode from "qrcode";

/** The white margin a scanner needs around the code, in modules (the QR standard asks for 4). */
export const QUIET = 4;

/** The code's modules: `size` per side (without the margin) and whether the module at column x, row y is dark. */
export function qrModules(text) {
  const q = QRCode.create(String(text), { errorCorrectionLevel: "M" });
  const size = q.modules.size;
  return { size, dark: (x, y) => Boolean(q.modules.get(y, x)) };
}

/** One SVG path for the dark modules, in a square of `n` units (the code plus the margin on every side). */
export function qrPath(text) {
  const m = qrModules(text), n = m.size + QUIET * 2;
  let d = "";
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.dark(x, y)) continue;
      // a run of dark modules in a row becomes one rectangle (a shorter path)
      let w = 1;
      while (x + w < m.size && m.dark(x + w, y)) w++;
      d += `M${x + QUIET} ${y + QUIET}h${w}v1h-${w}z`;
      x += w - 1;
    }
  }
  return { d, n };
}
