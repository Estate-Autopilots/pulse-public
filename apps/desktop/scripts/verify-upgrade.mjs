// Hosted Windows/macOS acceptance of immutable released builds. Never use staff accounts.
import {execFileSync,spawn} from 'node:child_process';
import {readFile,mkdir,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const [fromTag,toTag,scenario="upgrade"]=process.argv.slice(2);
if(!["upgrade","rollback"].includes(scenario))throw Error("Unknown acceptance scenario");for(const tag of [fromTag,toTag])if(!/^companion-v\d+\.\d+\.\d+-[a-f0-9]+$/.test(tag??''))throw Error('Use exact immutable release tags');
const repo='Estate-Autopilots/pulse-companion',dir=resolve('upgrade-proof');await mkdir(dir,{recursive:true});
const gh=(...args)=>execFileSync('gh',args,{stdio:'inherit'});
gh('release','download',fromTag,'-R',repo,'--pattern',process.platform==='win32'?'*-windows-setup.exe':'*-mac-universal.dmg','--dir',dir);
gh('release','download',toTag,'-R',repo,'--pattern','latest.json','--dir',dir);
const manifest=JSON.parse(await readFile(join(dir,'latest.json'),'utf8'));
const previous=fromTag.match(/^companion-v(\d+\.\d+\.\d+)-/)[1];
if(manifest.version!==toTag.match(/^companion-v(\d+\.\d+\.\d+)-/)[1])throw Error('Release tag/manifest mismatch');
let exe;
if(process.platform==='win32'){
 const destination=join(process.env.LOCALAPPDATA,'PulseUpgradeAcceptance');
 execFileSync(join(dir,`Pulse-${previous}-windows-setup.exe`),['/S',`/D=${destination}`],{stdio:'inherit'});
 exe=join(destination,'pulse-desktop.exe');
}else if(process.platform==='darwin'){
 const mount=join(dir,'mount'),apps=join(dir,'Applications');await mkdir(mount,{recursive:true});await mkdir(apps,{recursive:true});
 execFileSync('hdiutil',['attach',join(dir,`Pulse-${previous}-mac-universal.dmg`),'-readonly','-nobrowse','-mountpoint',mount]);
 execFileSync('ditto',[join(mount,'Pulse.app'),join(apps,'Pulse.app')]);execFileSync('hdiutil',['detach',mount]);exe=join(apps,'Pulse.app','Contents','MacOS','pulse-desktop');
}else throw Error('Native updater acceptance requires Windows/macOS');
const probe=join(dir,'installed-version.txt');
async function waitFile(file,expect,timeout=180000){
 const start=Date.now(),end=start+timeout;let shot=0;
 while(Date.now()<end){
  try{const text=await readFile(file,'utf8');if(expect(text))return text;}catch{}
  if(file.endsWith('healthy.json')||file.endsWith('rolled-back.json')){
   let failure;try{failure=JSON.parse(await readFile(join(dir,'error.json'),'utf8'));}catch{}
   if(failure)throw Error(`Native updater rejected the upgrade: ${failure.error}`);
   // Retain the runner's actual UI while a new app is starting, including any OS permission prompt.
   if(process.platform==='darwin'&&Date.now()-start>=(shot+1)*30000&&shot<6){
    shot++;try{execFileSync('screencapture',['-x',join(dir,`startup-${shot}.png`)],{stdio:'ignore',timeout:10000});}catch{}
   }
   if(file.endsWith('healthy.json')){
    let recovered;try{recovered=JSON.parse(await readFile(join(dir,'rolled-back.json'),'utf8'));}catch{}
    if(recovered)throw Error(`The target failed to become healthy and restored ${recovered.version} after ${recovered.attempts} starts`);
   }
  }
  await new Promise(r=>setTimeout(r,1000));
 }
 throw Error(`Receipt not ready: ${file}`);
}
spawn(exe,['--pulse-version-file',probe],{stdio:'ignore'});await waitFile(probe,s=>s===previous);
const url=`https://github.com/${repo}/releases/download/${toTag}/latest.json`;
const nativeLog=await open(join(dir,'native-process.log'),'a');
spawn(exe,['--updater-acceptance',url],{env:{...process.env,PULSE_UPDATER_ACCEPTANCE_DIR:dir,PULSE_UPDATER_ACCEPTANCE_FAIL_VERSION:scenario==="rollback"?manifest.version:""},stdio:['ignore',nativeLog.fd,nativeLog.fd]});
await nativeLog.close();
const receiptName=scenario==='rollback'?'rolled-back.json':'healthy.json';
const expected=scenario==='rollback'?previous:manifest.version;
const receipt=JSON.parse(await waitFile(join(dir,receiptName),s=>JSON.parse(s).version===expected,600000));
const checked=JSON.parse(await readFile(join(dir,'detected.json'),'utf8')),verified=JSON.parse(await readFile(join(dir,'verified.json'),'utf8'));
if(checked.previous!==previous||checked.target!==manifest.version||verified.target!==manifest.version||!verified.signatureVerified||!verified.tamperedBundleRejected||receipt.stage!==(scenario==='rollback'?'rolled-back':'healthy')||scenario==='rollback'&&receipt.attempts!==2)throw Error('Update acceptance incomplete');
// The runner's synthetic app process can now stop; downloaded release files are retained as evidence.
if(Number.isInteger(receipt.processId))process.kill(receipt.processId);
console.log(JSON.stringify({previous,target:manifest.version,finalVersion:receipt.version,scenario,failedAttempts:receipt.attempts,installed:true,detected:true,signatureVerified:true,restarted:true,webviewHealthy:true}));
