// Publishes the phone app as a public release after every hosted build and acceptance job passed.
// It never touches an update channel: the test channel's Android entry moves only through promote-android.mjs,
// after the owner's go-ahead. The tag keeps the companion-vX.Y.Z-sha form because installed Expo 1.0.0 apps trust
// only that release-URL shape when they later update to this app.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { validateOrigin, DEFAULT_ORIGIN } from './configure-origin.mjs';

const repo = 'Estate-Autopilots/pulse-companion';
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const version = process.env.RELEASE_VERSION, commit = process.env.GITHUB_SHA, runId = process.env.GITHUB_RUN_ID;
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '') || !/^\d+$/.test(runId ?? '')) throw Error('Missing release provenance');
if (process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_REPOSITORY !== repo) throw Error('Only reviewed public main publishes');
const configuredOrigin = validateOrigin(process.env.PULSE_ORIGIN);
const origin = configuredOrigin === DEFAULT_ORIGIN ? '' : configuredOrigin;
const host = origin ? new URL(origin).hostname : '';
const suffix = origin ? createHash('sha256').update(origin).digest('hex').slice(0, 8) : '';
const tag = `companion-v${version}-${commit.slice(0, 7)}${suffix}`, base = `https://github.com/${repo}/releases/download/${tag}/`;
const entryName = origin ? `android-${host}-entry.json` : 'android-channel-entry.json';
const [major, minor, patch] = version.split('.').map(Number), versionCode = major * 1000000 + minor * 1000 + patch;

const files = [];
async function walk(dir) { for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) await walk(p); else files.push(p); } }
await walk('artifacts');
const one = name => { const found = files.filter(p => basename(p) === name); if (found.length !== 1) throw Error(`Expected one ${name}, found ${found.length}`); return found[0]; };
await mkdir('release', { recursive: true });
const assets = [];
for (const name of [`Pulse-${version}-android.apk`, ...(!origin ? [`Pulse-${version}-ios-simulator.zip`] : [])]) {
  const source = one(name), bytes = await readFile(source);
  await copyFile(source, join('release', name));
  assets.push({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const apk = assets[0];
// The exact entry promote-android.mjs places into the test channel after the go-ahead.
await writeFile(join('release', entryName), JSON.stringify({ name: apk.name, platform: 'android', kind: 'apk', size: apk.size, sha256: apk.sha256, url: base + apk.name, versionCode, ...(origin ? { origin } : {}) }, null, 2) + '\n');
if (!origin) {
  const ios = assets[1];
  await writeFile('release/ios-simulator-entry.json', JSON.stringify({ name: ios.name, platform: 'ios', kind: 'simulator', size: ios.size, sha256: ios.sha256, url: base + ios.name }, null, 2) + '\n');
}
const sums = [];
for (const f of (await readdir('release')).sort()) sums.push(`${createHash('sha256').update(await readFile(join('release', f))).digest('hex')}  ${f}`);
await writeFile('release/SHA256SUMS.txt', sums.join('\n') + '\n');
await writeFile('release-notes.md', [
  `Pulse for Android ${version} — the Pulse web app in a native shell.`,
  '',
  `- Android APK: \`${apk.name}\`, versionCode ${versionCode}, SHA-256 \`${apk.sha256}\`. Signed with the same Pulse key as the Expo app, so it installs over 0.3.5/1.0.0 and keeps the app's place on the phone.`,
  origin ? `- Install address: ${origin} (Android only).` : `- iPhone Simulator app: \`Pulse-${version}-ios-simulator.zip\` (no Apple account; not installable on a real iPhone).`,
  '- Sign in once with your Pulse username and password; the phone then appears in Settings → Devices.',
  '- Not offered by the in-app updater: the test channel still points at the earlier app until this build is approved.',
  '',
  `Build: https://github.com/${repo}/actions/runs/${runId}`,
].join('\n') + '\n');
gh('release', 'create', tag, '--repo', repo, '--target', commit, ...(origin ? ['--latest=false'] : []), '--title', `Pulse for Android ${version} (${host || 'phone app'})`, '--notes-file', 'release-notes.md',
  ...(await readdir('release')).map(f => join('release', f)));
// Get the apps offers the newest phone app from this download pointer. It is not an update channel: installed apps
// read companion-test, which only promote-android.mjs changes.
const pointer = 'companion-phone';
try { gh('release', 'view', pointer, '-R', repo); } catch {
  gh('release', 'create', pointer, '-R', repo, '--target', commit, '--prerelease', '--title', 'Pulse phone app download',
    '--notes', 'Points Get the apps at the newest phone app release. Installed apps update only from the companion-test channel.');
}
gh('release', 'upload', pointer, join('release', entryName), ...(!origin ? ['release/ios-simulator-entry.json'] : []), '-R', repo, '--clobber');
console.log(JSON.stringify({ tag, url: `https://github.com/${repo}/releases/tag/${tag}`, versionCode, apkSha256: apk.sha256, downloadPointer: pointer, entryName, ...(origin ? { origin } : {}) }));
