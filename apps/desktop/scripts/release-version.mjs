import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const requested=process.argv[2];
const checked=v=>{if(!/^\d+\.\d+\.\d+$/.test(v))throw Error('Invalid release version');return v;};
let version=checked(requested|| (await read('apps/desktop/package.json')).version);
if(!requested){
 const releases=JSON.parse(execFileSync('gh',['api','repos/Estate-Autopilots/pulse-companion/releases?per_page=100'],{encoding:'utf8'}));
 // Earlier unsigned test installers do not count as an updater baseline. The first signed release starts at the reviewed baseline version.
 const published=releases.filter(r=>!r.draft&&r.assets?.some(a=>a.name==='latest.json')&&/^companion-v\d+\.\d+\.\d+-[a-f0-9]+$/.test(r.tag_name)).map(r=>r.tag_name.match(/^companion-v(\d+\.\d+\.\d+)-/)[1]).sort((a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];}).at(-1);
 if(published){const a=version.split('.').map(Number),b=published.split('.').map(Number);if(a[0]<b[0]||a[0]===b[0]&&(a[1]<b[1]||a[1]===b[1]&&a[2]<=b[2]))version=`${b[0]}.${b[1]}.${b[2]+1}`;}
}
for(const p of ['package.json','apps/desktop/package.json','apps/mobile/package.json','packages/companion/package.json','apps/chrome-extension/manifest.json']){const value=await read(p);value.version=version;await writeFile(p,JSON.stringify(value,null,2)+'\n');}
const mobile=await read('apps/mobile/app.json');mobile.expo.version=version;const v=version.split('.').map(Number),code=v[0]*1000000+v[1]*1000+v[2];mobile.expo.android.versionCode=code;mobile.expo.ios.buildNumber=String(code);await writeFile('apps/mobile/app.json',JSON.stringify(mobile,null,2)+'\n');
const conf=await read('apps/desktop/src-tauri/tauri.conf.json');conf.version=version;await writeFile('apps/desktop/src-tauri/tauri.conf.json',JSON.stringify(conf,null,2)+'\n');
const cargo='apps/desktop/src-tauri/Cargo.toml';await writeFile(cargo,(await readFile(cargo,'utf8')).replace(/^(version = ")\d+\.\d+\.\d+("$)/m,`$1${version}$2`));
console.log(version);
