// A small QR code encoder for install links (onboarding: "scan to install the phone app"). Byte mode, error
// correction level M, versions 1-10 (up to 213 bytes), after Project Nayuki's reference algorithm (ISO/IEC 18004).
// Returns the module matrix; qrSvg() draws it with the standard four-module quiet zone.

const TOTAL = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];          // codewords per version
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];                          // level M
const EC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];                    // EC codewords per block, level M
const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const mul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 0xff; };
function divisor(degree) {
  const r = Array(degree).fill(0); r[degree - 1] = 1; let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = mul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = mul(root, 2);
  }
  return r;
}
function remainder(data, div) {
  const r = div.map(() => 0);
  for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= mul(c, f); }); }
  return r;
}

/** The QR matrix (true = dark) for `text` (UTF-8). Throws when it does not fit version 10. */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  let version = 1;
  for (; version <= 10; version++) {
    const capacity = (TOTAL[version] - EC[version] * BLOCKS[version]) * 8;
    if (4 + (version < 10 ? 8 : 16) + bytes.length * 8 <= capacity) break;
  }
  if (version > 10) throw new Error("Too long for a QR code here");
  const dataCodewords = TOTAL[version] - EC[version] * BLOCKS[version];
  // Segment: byte mode (0100), length, data; terminator; pad to bytes; pad codewords 0xEC 0x11.
  const bits = [];
  const put = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(4, 4); put(bytes.length, version < 10 ? 8 : 16); for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataCodewords * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < dataCodewords * 8; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // Error correction per block, then interleave.
  const blocks = BLOCKS[version], ec = EC[version], total = TOTAL[version];
  const short = blocks - (total % blocks), shortLen = Math.floor(total / blocks), div = divisor(ec), parts = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - ec + (i < short ? 0 : 1)); k += dat.length;
    const e = remainder(dat, div); if (i < short) dat.push(0);
    parts.push(dat.concat(e));
  }
  const codewords = [];
  for (let i = 0; i < parts[0].length; i++) parts.forEach((p, j) => { if (i !== shortLen - ec || j >= short) codewords.push(p[i]); });

  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => Array(size).fill(false));
  const fn = Array.from({ length: size }, () => Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy)); if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const align = ALIGN[version], last = align.length - 1;
  for (let i = 0; i <= last; i++) for (let j = 0; j <= last; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const format = (mask) => {
    const value = (0 << 3) | mask; let r = value;           // level M = 00
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const f = ((value << 10) | r) ^ 0x5412, bit = (i) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  if (version >= 7) {
    let r = version; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const v = (version << 12) | r;
    for (let i = 0; i < 18; i++) { const dark = ((v >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, dark); set(b, a, dark); }
  }
  // Data, zig-zag from the bottom right, two columns at a time, skipping the vertical timing column.
  let n = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y][x] && n < codewords.length * 8) { m[y][x] = ((codewords[n >>> 3] >>> (7 - (n & 7))) & 1) === 1; n++; }
    }
  }
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const apply = (k) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[k](x, y)) m[y][x] = !m[y][x]; };
  // Choose the mask with the lowest penalty (runs, 2x2 blocks, balance). Any mask decodes; this only helps scanners.
  const penalty = () => {
    let p = 0, dark = 0;
    for (let a = 0; a < size; a++) for (const row of [true, false]) {
      let run = 1;
      for (let b = 1; b <= size; b++) {
        const same = b < size && (row ? m[a][b] === m[a][b - 1] : m[b][a] === m[b - 1][a]);
        if (same) run++; else { if (run >= 5) p += run - 2; run = 1; }
      }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3; }
    for (const row of m) for (const c of row) if (c) dark++;
    return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  };
  let best = 0, score = Infinity;
  for (let k = 0; k < 8; k++) { apply(k); format(k); const s = penalty(); if (s < score) { score = s; best = k; } apply(k); }
  apply(best); format(best);
  return m;
}

/** An SVG of the QR code (dark modules in currentColor) for `text`, `px` wide. */
export function qrSvg(text, px = 168, label = "QR code") {
  const m = qrMatrix(text), size = m.length + 8;
  let d = "";
  m.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${px}" height="${px}" role="img" aria-label="${label.replace(/"/g, "&quot;")}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
