// This runs only after all required hosted build and acceptance jobs succeed.
import {readFile,readdir,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {parseManifest} from '../../../packages/companion/src/updates.js';
const repo='Estate-Autopilots/pulse-companion',gh=(...a)=>execFileSync('gh',a,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const version=process.env.RELEASE_VERSION,commit=process.env.GITHUB_SHA,runId=process.env.GITHUB_RUN_ID,channel=process.env.RELEASE_CHANNEL??'test';
if(!/^\d+\.\d+\.\d+$/.test(version??'')||!/^\d+$/.test(runId??'')||!/^[a-f0-9]{40}$/.test(commit??''))throw Error('Missing release provenance');
if(!['test','stable'].includes(channel))throw Error('Unknown channel');
if(process.env.GITHUB_REF!=='refs/heads/main'||process.env.GITHUB_REPOSITORY!==repo)throw Error('Only reviewed public main publishes');
const tag=`companion-v${version}-${commit.slice(0,7)}`,base=`https://github.com/${repo}/releases/download/${tag}/`;
const files=[];async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else files.push(p);}}await walk('artifacts');
await mkdir('release',{recursive:true});
const manifest={version,channel,notes:process.env.RELEASE_NOTES?.trim().slice(0,2000)||'Pulse reliability and companion improvements.',pub_date:new Date().toISOString(),builtAt:new Date().toISOString(),commit,runId,buildUrl:`https://github.com/${repo}/actions/runs/${runId}`,signed:false,updaterSigned:true,signing:{windows:'OS distribution unsigned; updater signed',macos:'stable self-signed Pulse identity; not notarised; updater signed',android:'persistent Pulse test signing key',chrome:'unpacked; Web Store package prepared',ios:'TestFlight requires Apple access'},platforms:{},files:[]};
async function asset(source,name){await copyFile(source,join('release',name));return name;}
async function download(source,name,platform,kind){const bytes=await readFile(source);await asset(source,name);manifest.files.push({name,platform,kind,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),url:base+name});}
const one=fn=>{const found=files.filter(fn);if(found.length!==1)throw Error(`Expected one matching artifact, got ${found.length}`);return found[0];};
for(const [match,suffix,platform,kind] of [[p=>p.endsWith('.dmg'),'mac-universal.dmg','macos','dmg'],[p=>p.endsWith('.exe'),'windows-setup.exe','windows','exe'],[p=>p.endsWith('.msi'),'windows.msi','windows','msi'],[p=>p.endsWith('.apk'),'android.apk','android','apk'],[p=>basename(p)==='pulse-chrome.zip','chrome.zip','chrome','zip'],[p=>basename(p)==='pulse-ios-simulator.zip','ios-simulator.zip','ios','simulator'],[p=>basename(p)==='pulse-ios-device-unsigned.zip','ios-device-unsigned.zip','ios','device-unsigned']])await download(one(match),`Pulse-${version}-${suffix}`,platform,kind);
for(const [platform,match,output] of [['darwin',p=>p.endsWith('.app.tar.gz'),`Pulse-${version}.app.tar.gz`],['windows',p=>p.endsWith('.exe'),`Pulse-${version}-windows-setup.exe`]]){
 const source=one(match);const signature=(await readFile(one(p=>p===source+'.sig'),'utf8')).trim();await asset(source,output);await asset(source+'.sig',output+'.sig');
 const entry={url:base+output,signature};
 if(platform==='darwin'){manifest.platforms['darwin-aarch64']=entry;manifest.platforms['darwin-x86_64']=entry;}
 else {manifest.platforms['windows-x86_64']=entry;manifest.platforms['windows-x86_64-nsis']=entry;}
}
// MSI users keep the MSI installer type; the updater handles elevation if required.
const msi=one(p=>p.endsWith('.msi'));manifest.platforms['windows-x86_64-msi']={url:base+`Pulse-${version}-windows.msi`,signature:(await readFile(one(p=>p===msi+'.sig'),'utf8')).trim()};await asset(msi+'.sig',`Pulse-${version}-windows.msi.sig`);
const store=one(p=>basename(p)==='pulse-chrome-web-store.zip');await asset(store,`Pulse-${version}-chrome-web-store.zip`);
parseManifest(manifest,channel);
await writeFile('release/latest.json',JSON.stringify(manifest,null,2)+'\n');
const sums=[];for(const f of await readdir('release'))sums.push(`${createHash('sha256').update(await readFile(join('release',f))).digest('hex')}  ${f}`);await writeFile('release/SHA256SUMS.txt',sums.sort().join('\n')+'\n');
await writeFile('release-notes.md',`${manifest.notes}\n\nTest channel. Desktop updater signatures are independent of Windows/macOS distribution signing. iPhone installation needs Apple/TestFlight access.\n`);
const args=['release','create',tag,'--repo',repo,'--target',commit,'--title',`Pulse Companion ${version}`,'--notes-file','release-notes.md'];if(channel==='test')args.push('--prerelease');gh(...args,...(await readdir('release')).map(f=>join('release',f)));
// Advance the channel only after every immutable asset was uploaded successfully.
const pointer=`companion-${channel}`;
try{gh('release','view',pointer,'-R',repo);}catch{gh('release','create',pointer,'-R',repo,'--target',commit,'--title',`Pulse ${channel} update channel`,'--notes','Latest verified companion build in this channel.','--prerelease');}
gh('release','upload',pointer,'release/latest.json','-R',repo,'--clobber');
console.log(JSON.stringify({version,tag,channel,commit,runId}));
