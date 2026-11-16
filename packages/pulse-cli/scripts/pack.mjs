#!/usr/bin/env node
// CLI: dist/pulse-cli.tgz, an npm-style package tarball of the built CLI (no dependencies, nothing published). Pulse
// serves it at /downloads/pulse-cli.tgz, so `npm install -g <that address>` or `npx <that address>` installs `pulse`.
// Deterministic: fixed file order, times and owners, so the same source gives the same bytes.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const MTIME = 1_798_761_600; // 2027-01-01T00:00:00Z: any fixed time

/** One ustar entry: a 512-byte header, then the file padded to 512 bytes. */
export function tarEntry(name, data, mode = 0o644) {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar path too long: ${name}`);
  const header = Buffer.alloc(512);
  const put = (text, offset, length) => header.write(text, offset, length, 'utf8');
  const octal = (n, length) => n.toString(8).padStart(length - 1, '0') + '\0';
  const fields = [[name, 0, 100], [octal(mode, 8), 100, 8], [octal(0, 8), 108, 8], [octal(0, 8), 116, 8], [octal(data.length, 12), 124, 12],
    [octal(MTIME, 12), 136, 12], ['        ', 148, 8], ['0', 156, 1], ['ustar\0', 257, 6], ['00', 263, 2]];
  for (const [text, offset, length] of fields) put(text, offset, length);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad]);
}

export function tarball(files) {
  return gzipSync(Buffer.concat([...files.map(f => tarEntry(f.name, f.data, f.mode)), Buffer.alloc(1024)]), { level: 9 });
}

if (process.argv[1]?.endsWith('pack.mjs')) {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  // The installed package: the bin and its files only (no workspace scripts or dev tools).
  const manifest = { name: 'pulse-cli', version: pkg.version, description: pkg.description, type: 'module', engines: pkg.engines,
    bin: pkg.bin, files: pkg.files, license: 'UNLICENSED' };
  const dist = readdirSync(new URL('dist/', root)).filter(f => f.endsWith('.js')).sort();
  const files = [
    { name: 'package/package.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
    { name: 'package/README.md', data: readFileSync(new URL('README.md', root)) },
    ...dist.map(f => ({ name: `package/dist/${f}`, data: readFileSync(new URL(`dist/${f}`, root)), mode: f === 'cli.js' ? 0o755 : 0o644 })),
  ];
  const out = tarball(files);
  writeFileSync(new URL('dist/pulse-cli.tgz', root), out);
  console.log(`dist/pulse-cli.tgz: ${files.length} files, ${out.length} bytes`);
}
