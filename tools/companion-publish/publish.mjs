// Publishes one successful "Pulse Companion builds" run to Settings → Devices → Get the apps.
//   node tools/companion-publish/publish.mjs RUN_ID [DESTINATION]
// Downloads the run's artifacts with gh, renames them pulse-companion-<platform>-<version>-<sha12>.<ext>, hashes
// them and swaps latest.json atomically. Screenshots from the runners go to DESTINATION/screens-<sha12>/.
import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {verifySimulatorAcceptance, simulatorBuiltButScreenTestFailed, simulatorUIJobFailed} from './acceptance.mjs';

const args = process.argv.slice(2);
const runId = args[0], destination = args[1] && !args[1].startsWith('--') ? args[1] : '/home/eadev/pulse-downloads/companion';
let acceptanceId = args.find(a => a.startsWith('--simulator-acceptance='))?.split('=')[1];
if (!/^\d+$/.test(runId ?? '')) throw Error('Usage: publish.mjs RUN_ID [DESTINATION]');
if (acceptanceId && !/^\d+$/.test(acceptanceId)) throw Error('Invalid simulator acceptance run');
const repo = 'Estate-Autopilots/pulse-companion';
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const run = JSON.parse(gh('api', `repos/${repo}/actions/runs/${runId}`));
if (run.name !== 'Pulse Companion builds' || run.head_branch !== 'main') throw Error('Only public Pulse Companion builds from main are published');
const jobs = JSON.parse(gh('api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=50`)).jobs;
if (!acceptanceId && jobs.some(j => j.name.startsWith('ios-screens'))) acceptanceId = runId;
const build = jobs.filter((j) => /^(desktop|android|chrome|ios-simulator|ios-device|ios-screens)\b/.test(j.name));
if (!build.length || build.some((j) => j.conclusion !== 'success' && !(acceptanceId && (simulatorBuiltButScreenTestFailed(j) || simulatorUIJobFailed(j))))) throw Error(`Build jobs did not all succeed: ${build.map((j) => `${j.name}=${j.conclusion}`).join(', ')}`);
let acceptedRun = null;
if (acceptanceId) {
  acceptedRun = JSON.parse(gh('api', `repos/${repo}/actions/runs/${acceptanceId}`));
  if (acceptedRun.name !== (acceptanceId === runId ? 'Pulse Companion builds' : 'Verify built iPhone simulator') || acceptedRun.head_branch !== 'main' || acceptedRun.conclusion !== 'success') throw Error('Simulator UI acceptance did not succeed on public main');
}
const commit = run.head_sha, short = commit.slice(0, 12);
const version = JSON.parse(Buffer.from(JSON.parse(gh('api', `repos/${repo}/contents/apps/desktop/package.json?ref=${commit}`)).content, 'base64').toString()).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Unexpected version');
const artifacts = JSON.parse(gh('api', `repos/${repo}/actions/runs/${runId}/artifacts?per_page=50`)).artifacts.filter((a) => !a.expired);
const want = [`companion-desktop-windows-${commit}`, `companion-desktop-macos-${commit}`, `companion-android-${commit}`, `companion-chrome-${commit}`, `companion-ios-simulator-${commit}`, `companion-ios-device-${commit}`];
for (const name of want) if (!artifacts.some((a) => a.name === name)) throw Error(`Missing artifact ${name}`);

await mkdir(destination, { recursive: true });
const temporary = path.join(destination, `.build-${short}`);
await rm(temporary, { recursive: true, force: true });
for (const a of artifacts.filter((x) => want.includes(x.name) || x.name.startsWith('companion-screens-') && !(acceptanceId && x.name.startsWith('companion-screens-ios-')))) gh('run', 'download', runId, '-R', repo, '--name', a.name, '--dir', path.join(temporary, a.name));
let acceptance = null;
if (acceptanceId) {
  const proofDir = path.join(temporary,'simulator-acceptance');
  gh('run','download',acceptanceId,'-R',repo,'--name',`ios-simulator-diagnostics-${acceptanceId}`,'--dir',proofDir);
  acceptance = JSON.parse(await readFile(path.join(proofDir,'acceptance.json'),'utf8'));
  const archiveSha256 = createHash('sha256').update(await readFile(path.join(temporary,`companion-ios-simulator-${commit}`,'pulse-ios-simulator.zip'))).digest('hex');
  verifySimulatorAcceptance(acceptance,{runId,commit,archiveSha256});
}

const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const source = path.join(dir, entry.name);
    if (entry.isDirectory()) { await walk(source); continue; }
    const ext = path.extname(entry.name).toLowerCase().slice(1);
    if (source.includes('companion-screens-') || source.includes('simulator-acceptance')) {
      if (ext !== 'png') continue;
      await mkdir(path.join(destination, `screens-${short}`), { recursive: true });
      await copyFile(source, path.join(destination, `screens-${short}`, entry.name));
      continue;
    }
    if (!['apk', 'exe', 'msi', 'dmg', 'zip'].includes(ext)) continue;
    const iosKind = source.includes('companion-ios-simulator-') ? 'simulator' : source.includes('companion-ios-device-') ? 'device-unsigned' : null;
    const platform = iosKind ? 'ios' : ext === 'zip' ? 'chrome' : ext === 'apk' ? 'android' : ext === 'dmg' ? 'macos' : 'windows';
    const name = `pulse-companion-${platform}${iosKind ? `-${iosKind}` : ''}-${version}-${short}.${ext}`;
    if (files.some((f) => f.name === name)) throw Error(`Two ${ext} files in the run`);
    const data = await readFile(source);
    await copyFile(source, path.join(destination, name));
    files.push({ name, platform, kind: iosKind ?? ext, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
}
await walk(temporary);
for (const p of ['windows', 'macos', 'android', 'chrome', 'ios']) if (!files.some((f) => f.platform === p)) throw Error(`No ${p} build in the run`);
const manifest = { version, commit, runId, repository: repo, buildUrl: run.html_url, builtAt: run.updated_at, signed: false, signing: { windows: 'unsigned', macos: 'unsigned, not notarised', android: 'generated Expo debug/test key', ios: 'simulator ad-hoc; device unsigned, Apple signing required', chrome: 'unpacked' }, files };
if (acceptedRun) manifest.simulatorAcceptance = {runId:acceptanceId,buildUrl:acceptedRun.html_url,archiveSha256:acceptance.archiveSha256,signatureUnchanged:true};
await writeFile(path.join(destination, `checksums-${short}.txt`), files.map(f => `${f.sha256}  ${f.name}`).sort().join('\n') + '\n');
const serialized=JSON.stringify(manifest,null,2);
// Use the existing read-only desktop downloads mount; no extra container or infrastructure exposure.
const mirror=process.env.PULSE_COMPANION_MIRROR_DIR ?? (destination==='/home/eadev/pulse-downloads/companion'?'/home/eadev/pulse-downloads/desktop/companion':null);
if(mirror){
  await mkdir(mirror,{recursive:true});
  for(const file of files){
    const source=path.join(destination,file.name),target=path.join(mirror,file.name);
    try{await link(source,target);}catch(error){
      if(error.code==='EXDEV')await copyFile(source,target);
      else if(error.code==='EEXIST'){if(createHash('sha256').update(await readFile(target)).digest('hex')!==file.sha256)throw Error('Mounted download checksum mismatch');}
      else throw error;
    }
  }
  await writeFile(path.join(mirror,'latest.new'),serialized);await rename(path.join(mirror,'latest.new'),path.join(mirror,'latest.json'));
}
await writeFile(path.join(destination, 'latest.new'), serialized);
await rename(path.join(destination, 'latest.new'), path.join(destination, 'latest.json'));
await rm(temporary, { recursive: true, force: true });
console.log(JSON.stringify(manifest, null, 2));
