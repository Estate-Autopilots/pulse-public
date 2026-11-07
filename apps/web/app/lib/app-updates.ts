import {createHash} from 'node:crypto';
import {requestHost} from './host-mode.mjs';
import {parseManifest,channel,releaseURL,type UpdateManifest} from '../../../../packages/companion/src/updates.js';
// Match the phone build's DEFAULT_ORIGIN (apps/mobile/scripts/configure-origin.mjs).
const DEFAULT_ORIGIN='https://pulse.estateautopilots.com';
export type PublishedUpdate = UpdateManifest & {commit:string;runId:string;builtAt:string;buildUrl:string;signing:Record<string,string>};
export const updateSurface=(request:Request):'desktop'|'companion'=>/^tauri-plugin-updater\//.test(request.headers.get('user-agent')??'')?'desktop':'companion';
// Host selects the install, including company addresses on a shared server. Do not use client Origin headers.
export const updateOrigin=(request:Request):string=>`https://${requestHost(request.headers)??new URL(request.url).host}`;
/** The install's own address for Get the apps: the host the page was opened on, else PULSE_PUBLIC_URL (EST-1256). */
export const installOrigin=(headers:{get(name:string):string|null}):string|null=>{
 const host=requestHost(headers);if(host)return `https://${host}`;
 try{return new URL(process.env.PULSE_PUBLIC_URL??'').origin;}catch{return null;}
};
// An address's phone release tag: seven commit characters, plus the address's eight-character hash unless it is EA's.
const ownRelease=(origin:string)=>new RegExp(`^/Estate-Autopilots/pulse-companion/releases/download/companion-v\\d+\\.\\d+\\.\\d+-[a-f0-9]{7}${origin===DEFAULT_ORIGIN?'':createHash('sha256').update(origin).digest('hex').slice(0,8)}/[A-Za-z0-9_.-]+\\.apk$`);
/** Only installed-app discovery passes an origin; download pages retain the complete catalog. */
export async function publishedUpdate(selected='test', surface:'companion'|'desktop'='companion', origin?:string):Promise<PublishedUpdate|null>{
 const chosen=channel(selected);
 try{
  const base=`https://github.com/Estate-Autopilots/pulse-companion/releases/download/companion-${chosen}/`;
  // Own-address phone discovery never reads EA's shared manifest, including when its asset is missing.
  const asset=surface==='desktop'?'latest-desktop.json':origin&&origin!==DEFAULT_ORIGIN?`latest-${new URL(origin).hostname}.json`:'latest.json';
  let response=await fetch(base+asset,{next:{revalidate:60},signal:AbortSignal.timeout(10000),headers:{Accept:'application/json'}});
  // Channels without a desktop-only release still offer the last shared desktop build.
  if(surface==='desktop'&&response.status===404)response=await fetch(base+'latest.json',{next:{revalidate:60},signal:AbortSignal.timeout(10000),headers:{Accept:'application/json'}});
  if(!response.ok)return null;
  const text=await response.text();if(text.length>100000)throw Error('Oversized manifest');
  const parsed=JSON.parse(text);parseManifest(parsed,chosen);
  if(!/^[a-f0-9]{40}$/.test(parsed.commit)||!/^\d+$/.test(String(parsed.runId))||!Number.isFinite(Date.parse(parsed.builtAt)))throw Error('Invalid release provenance');
  if(surface==='companion'&&origin){
   const release=ownRelease(origin);
   if(parsed.files.some((file:UpdateManifest['files'][number])=>file.platform==='android'&&!release.test(new URL(file.url).pathname)))return null;
  }
  return parsed;
 }catch{return null;}
}

/** The newest phone app for Get the apps (the companion-phone download pointer, written by the phone workflow).
 *  This is not the update channel: installed apps update only from companion-test after an explicit promote.
 *  Android opens one address, so each install offers only the APK built for its own origin: EA's shared entry on EA's
 *  address, android-<host>-entry.json for its own origin anywhere else, and nothing when that is missing (EST-1256). */
export async function publishedPhone(platform:'android'|'ios'='android',origin?:string|null):Promise<Omit<UpdateManifest['files'][number],'platform'>&{platform:'android'|'ios';versionCode?:number;origin?:string}|null>{
 try{
  if(platform==='android'&&!origin)return null;
  const own=platform==='android'&&origin!==DEFAULT_ORIGIN;
  const file=platform==='ios'?'ios-simulator-entry.json':own?`android-${new URL(origin!).hostname}-entry.json`:'android-channel-entry.json';
  const response=await fetch(`https://github.com/Estate-Autopilots/pulse-companion/releases/download/companion-phone/${file}`,{next:{revalidate:300},signal:AbortSignal.timeout(10000),headers:{Accept:'application/json'}});
  if(!response.ok)return null;
  const text=await response.text();if(text.length>4000)throw Error('Oversized entry');
  const entry=JSON.parse(text);
  const name=platform==='android'?/^Pulse-\d+\.\d+\.\d+-android\.apk$/:/^Pulse-\d+\.\d+\.\d+-ios-simulator\.zip$/;
  if(entry?.platform!==platform||entry.kind!==(platform==='android'?'apk':'simulator')||!name.test(entry.name)||!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<1)throw Error('Invalid phone entry');
  releaseURL(entry.url);
  if(own&&(entry.origin!==origin||!ownRelease(origin!).test(new URL(entry.url).pathname)))throw Error('Phone entry for another address');
  return entry;
 }catch{return null;}
}
