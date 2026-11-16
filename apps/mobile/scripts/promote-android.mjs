// After the owner's go-ahead only: offer an approved phone-app pre-release on the test channel (latest.json, the
// Android channel since desktops moved to latest-desktop.json). The installed Expo 1.0.0 app then updates to it: same
// package and key, higher versionCode. latest-desktop.json is never touched, so no desktop sees an update.
// Another address (PULSE_ORIGIN) promotes only its own host-suffixed release, into its own latest-<host>.json on the
// same channel; latest.json and latest-desktop.json are then neither read nor written (EST-1955).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newer, parseManifest } from '../../../packages/companion/src/updates.js';
import { validateOrigin, DEFAULT_ORIGIN } from './configure-origin.mjs';

const repo = 'Estate-Autopilots/pulse-companion', channel = 'test';
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const configuredOrigin = validateOrigin(process.env.PULSE_ORIGIN);
const origin = configuredOrigin === DEFAULT_ORIGIN ? '' : configuredOrigin;
const host = origin ? new URL(origin).hostname : '';
// The same names publish-prerelease.mjs gives each address's release and download entry.
const suffix = origin ? createHash('sha256').update(origin).digest('hex').slice(0, 8) : '';
const entryName = origin ? `android-${host}-entry.json` : 'android-channel-entry.json';
const tag = process.env.PROMOTE_TAG ?? '';
if (!new RegExp(`^companion-v\\d+\\.\\d+\\.\\d+-[a-f0-9]{7}${suffix}$`).test(tag)) throw Error(`Name a published phone pre-release tag built for ${origin || DEFAULT_ORIGIN}`);
if (process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_REPOSITORY !== repo) throw Error('Only public main promotes');
const dir = await mkdtemp(join(tmpdir(), 'pulse-promote-'));
gh('release', 'download', tag, '-R', repo, '-p', entryName, '-p', '*-android.apk', '-D', dir);
const entry = JSON.parse(await readFile(join(dir, entryName), 'utf8'));
if ((entry.origin ?? '') !== origin) throw Error('The release was built for another address');
const bytes = await readFile(join(dir, entry.name));
if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw Error('The pre-release APK does not match its channel entry');
if (!entry.url.endsWith(`/releases/download/${tag}/${entry.name}`)) throw Error('Entry points outside its own release');
const phoneVersion = entry.name.match(/^Pulse-(\d+\.\d+\.\d+)-android\.apk$/)[1];
const notes = 'The new Pulse phone app: the full Pulse, with notifications, Pulse links that open in the app, and check-in on Today. Sign in once with your Pulse username and password.';
let manifest, manifestName;
if (origin) {
  // Only this address's APK: its installs never see EA's build, and EA's never see this one.
  const release = JSON.parse(gh('release', 'view', tag, '-R', repo, '--json', 'targetCommitish,createdAt,body'));
  const runId = release.body?.match(/\/actions\/runs\/(\d+)\s*$/m)?.[1];
  if (!/^[a-f0-9]{40}$/.test(release.targetCommitish) || !tag.endsWith(`-${release.targetCommitish.slice(0, 7)}${suffix}`) || !runId || !Number.isFinite(Date.parse(release.createdAt))) throw Error('Missing release provenance');
  manifestName = `latest-${host}.json`;
  manifest = { version: phoneVersion, channel, notes, pub_date: release.createdAt, builtAt: release.createdAt, commit: release.targetCommitish, runId,
    buildUrl: `https://github.com/${repo}/actions/runs/${runId}`, signing: { android: 'durable Pulse signing key' }, platforms: {}, files: [entry] };
} else {
  manifestName = 'latest.json';
  manifest = JSON.parse(gh('release', 'download', `companion-${channel}`, '-R', repo, '-p', 'latest.json', '-O', '-'));
  parseManifest(manifest, channel);
  // Desktop apps read latest-desktop.json (R20b), so latest.json is the phone channel and may take the phone's version.
  // Without that split, raising the version would offer desktops their own build again: refuse instead.
  let desktopSplit = true;
  try { gh('release', 'download', `companion-${channel}`, '-R', repo, '-p', 'latest-desktop.json', '-O', '-'); } catch { desktopSplit = false; }
  if (desktopSplit) {
    // Installed Expo 1.0.0 apps compare this version with their own before they read the Android entry.
    if (newer(phoneVersion, manifest.version)) manifest.version = phoneVersion;
  } else if (!newer(manifest.version, '1.0.0')) {
    throw Error(`The test channel is at ${manifest.version} and desktops still read it; publish a desktop-only release (latest-desktop.json) first.`);
  }
  manifest.notes = notes;
  manifest.files = [...manifest.files.filter(f => f.platform !== 'android'), entry];
}
parseManifest(manifest, channel);
await writeFile(join(dir, manifestName), JSON.stringify(manifest, null, 2) + '\n');
gh('release', 'upload', `companion-${channel}`, join(dir, manifestName), '-R', repo, '--clobber');
console.log(JSON.stringify({ promoted: tag, channel, manifest: manifestName, channelVersion: manifest.version, apk: entry.name, sha256: entry.sha256, versionCode: entry.versionCode, ...(origin ? { origin } : {}) }));
