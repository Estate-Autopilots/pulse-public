// Packs the unpacked extension into a ZIP for "Load unpacked" (and later the Web Store). No dependencies:
// a small ZIP writer with deflate from node:zlib.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] ?? 'pulse-chrome.zip';
const SKIP = new Set(['scripts', 'test', 'node_modules', 'package.json', 'README.md', 'STORE.md']);
async function walk(dir) {
  const files = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...await walk(p)); else if (/\.(js|html|css|json|png)$/.test(e.name)) files.push(p);
  }
  return files.sort();
}
const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const parts = [], central = [];
let offset = 0;
for (const file of await walk(root)) {
  const name = Buffer.from(relative(root, file).split('\\').join('/'));
  const data = await readFile(file), packed = deflateRawSync(data, { level: 9 }), crc = crc32(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0x00210000, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
  parts.push(local, name, packed);
  const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0, 8); dir.writeUInt16LE(8, 10);
  dir.writeUInt32LE(0x00210000, 12); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
  central.push(dir, name);
  offset += 30 + name.length + packed.length;
}
const cd = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
await writeFile(out, Buffer.concat([...parts, cd, end]));
console.log(`${out}: ${central.length / 2} files, ${(await stat(out)).size} bytes`);
