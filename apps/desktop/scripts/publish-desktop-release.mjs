// Hosted desktop-only publication. The shared Android latest.json is never overwritten.
import { readFile, readdir, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseManifest } from '../../../packages/companion/src/updates.js';
const repo = 'Estate-Autopilots/pulse-companion';
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const version = JSON.parse(await readFile('apps/desktop/package.json', 'utf8')).version;
const commit = process.env.GITHUB_SHA, runId = process.env.GITHUB_RUN_ID;
if (process.env.GITHUB_REPOSITORY !== repo || process.env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(commit ?? '') || !/^\d+$/.test(runId ?? '')) throw Error('Missing reviewed hosted release provenance');
const tag = `companion-v${version}-${commit.slice(0, 7)}`, base = `https://github.com/${repo}/releases/download/${tag}/`;
const manifest = { version, channel: 'test', notes: (await readFile('apps/desktop/WHATS_NEW.md', 'utf8')).trim(), pub_date: new Date().toISOString(), builtAt: new Date().toISOString(), commit, runId, buildUrl: `https://github.com/${repo}/actions/runs/${runId}`, updaterSigned: true, signed: false, signing: { windows: 'OS distribution unsigned; updater signed', macos: 'stable self-signed Pulse identity; not notarised; updater signed' }, platforms: {}, files: [] };
const sources = [];
async function walk(dir) { for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) await walk(p); else sources.push(p); } }
await walk('artifacts'); await mkdir('release', { recursive: true });
const one = predicate => { const found = sources.filter(predicate); if (found.length !== 1) throw Error(`Expected one artifact, found ${found.length}`); return found[0]; };
async function bundle(suffix, name, platform, kind, targets = []) {
  const source = one(p => p.endsWith(suffix)); const bytes = await readFile(source);
  await copyFile(source, join('release', name));
  manifest.files.push({ name, platform, kind, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: base + name });
  if (targets.length) {
    const signature = (await readFile(one(p => p === source + '.sig'), 'utf8')).trim();
    if (!signature) throw Error('Missing updater signature');
    await copyFile(source + '.sig', join('release', name + '.sig'));
    for (const target of targets) manifest.platforms[target] = { url: base + name, signature };
  }
}
await bundle('.exe', `Pulse-${version}-windows-setup.exe`, 'windows', 'exe', ['windows-x86_64', 'windows-x86_64-nsis']);
await bundle('.msi', `Pulse-${version}-windows.msi`, 'windows', 'msi', ['windows-x86_64-msi']);
await bundle('.dmg', `Pulse-${version}-mac-universal.dmg`, 'macos', 'dmg');
await bundle('.app.tar.gz', `Pulse-${version}.app.tar.gz`, 'macos', 'updater', ['darwin-aarch64', 'darwin-x86_64']);
parseManifest(manifest);
await writeFile('release/latest.json', JSON.stringify(manifest, null, 2) + '\n');
const sums = []; for (const f of await readdir('release')) sums.push(`${createHash('sha256').update(await readFile(join('release', f))).digest('hex')}  ${f}`);
await writeFile('release/SHA256SUMS.txt', sums.sort().join('\n') + '\n');
await writeFile('release-notes.md', `${manifest.notes}\n\nDesktop-only release. Android remains on its existing channel and version. Desktop updater bundles are signed; Windows distribution signing and macOS notarisation remain separate.\n`);
gh('release', 'create', tag, '-R', repo, '--target', commit, '--title', `Pulse Desktop ${version}`, '--notes-file', 'release-notes.md', ...(await readdir('release')).map(f => join('release', f)));
await copyFile('release/latest.json', 'release/latest-desktop.json');
// Prove the original Android channel manifest stayed byte-identical across publication.
const androidBefore = gh('release', 'download', 'companion-test', '-R', repo, '--pattern', 'latest.json', '--output', '-');
gh('release', 'upload', 'companion-test', 'release/latest-desktop.json', '-R', repo, '--clobber');
const androidAfter = gh('release', 'download', 'companion-test', '-R', repo, '--pattern', 'latest.json', '--output', '-');
if (androidBefore !== androidAfter) throw Error('Android channel changed during desktop publication');
console.log(`https://github.com/${repo}/releases/tag/${tag}`);
