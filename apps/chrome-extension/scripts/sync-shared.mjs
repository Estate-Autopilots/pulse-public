// The extension is loaded unpacked (no build step), so it carries a copy of the shared companion core in shared/.
// node scripts/sync-shared.mjs          copy packages/companion/src → shared/
// node scripts/sync-shared.mjs --check  fail if the copy is out of date (CI)
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const src = fileURLToPath(new URL('../../../packages/companion/src/', import.meta.url));
const dest = fileURLToPath(new URL('../shared/', import.meta.url));
const check = process.argv.includes('--check');
await mkdir(dest, { recursive: true });
const files = (await readdir(src)).filter((f) => /\.(js|css)$/.test(f));
let stale = [];
for (const f of files) {
  const want = await readFile(src + f, 'utf8');
  const have = await readFile(dest + f, 'utf8').catch(() => null);
  if (have === want) continue;
  if (check) stale.push(f); else await writeFile(dest + f, want);
}
const extra = (await readdir(dest)).filter((f) => !files.includes(f));
if (check && (stale.length || extra.length)) { console.error(`shared/ is out of date: ${[...stale, ...extra].join(', ')}. Run node scripts/sync-shared.mjs`); process.exit(1); }
console.log(check ? 'shared/ matches packages/companion' : `copied ${files.length} files to shared/`);
