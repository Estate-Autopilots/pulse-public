// CONNECT: a QR code for a client link, drawn here (no library): byte mode, error correction L, versions 1–10 (up to
// 271 bytes), mask 0. Follows the QR Code Model 2 standard (ISO/IEC 18004) as in Nayuki's reference generator.
const ECC = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const BLOCKS = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
const rawModules = (v: number) => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; };
const dataCodewords = (v: number) => Math.floor(rawModules(v) / 8) - ECC[v] * BLOCKS[v];
const mul = (x: number, y: number) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; };
function divisor(degree: number) {
  const r = new Array<number>(degree).fill(0); r[degree - 1] = 1; let root = 1;
  for (let i = 0; i < degree; i++) { for (let j = 0; j < r.length; j++) { r[j] = mul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; } root = mul(root, 0x02); }
  return r;
}
function remainder(data: number[], div: number[]) {
  const r = div.map(() => 0);
  for (const b of data) { const f = b ^ (r.shift() as number); r.push(0); div.forEach((c, i) => { r[i] ^= mul(c, f); }); }
  return r;
}

/** The modules (true = dark) of the QR code for `text`, or null when it is too long. */
export function qrModules(text: string): boolean[][] | null {
  const bytes = Array.from(new TextEncoder().encode(text));
  let v = 1; for (; v <= 10; v++) if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(v) * 8) break;
  if (v > 10) return null;
  const bits: number[] = []; const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(4, 4); push(bytes.length, v < 10 ? 8 : 16); bytes.forEach((b) => push(b, 8));
  const cap = dataCodewords(v) * 8;
  push(0, Math.min(4, cap - bits.length)); push(0, (8 - bits.length % 8) % 8);
  for (let p = 0xec; bits.length < cap; p ^= 0xec ^ 0x11) push(p, 8);
  const data: number[] = []; for (let i = 0; i < bits.length; i += 8) { let x = 0; for (let j = 0; j < 8; j++) x = (x << 1) | bits[i + j]; data.push(x); }
  const nb = BLOCKS[v], ecl = ECC[v], raw = Math.floor(rawModules(v) / 8), nShort = nb - raw % nb, shortLen = Math.floor(raw / nb), div = divisor(ecl);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nb; i++) { const dat = data.slice(k, k + shortLen - ecl + (i < nShort ? 0 : 1)); k += dat.length; const ec = remainder(dat, div); if (i < nShort) dat.push(0); blocks.push(dat.concat(ec)); }
  const all: number[] = []; for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ecl || j >= nShort) all.push(b[i]); });

  const size = v * 4 + 17;
  const m = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { m[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
    if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
  }
  if (v > 1) {
    const n = Math.floor(v / 7) + 2, step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2, pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    pos.forEach((a, i) => pos.forEach((b, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
  }
  const format = () => {
    const d = (1 << 3) | 0; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const f = ((d << 10) | r) ^ 0x5412, bit = (i: number) => ((f >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format();
  if (v >= 7) {
    let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (v << 12) | r;
    for (let i = 0; i < 18; i++) { const dark = ((b >>> i) & 1) !== 0, a = size - 11 + i % 3, c = Math.floor(i / 3); set(a, c, dark); set(c, a, dark); }
  }
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fn[y][x] && i < all.length * 8) { m[y][x] = ((all[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
    }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && (x + y) % 2 === 0) m[y][x] = !m[y][x];
  format();
  return m;
}

export function Qr({ text, label, size = 168 }: { text: string; label: string; size?: number }) {
  const m = qrModules(text);
  if (!m) return null;
  const n = m.length + 8;
  let d = ""; m.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  return <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" style={{ background: "#fff", borderRadius: 8, flex: "none" }}>
    <path d={d} fill="#000" /></svg>;
}
