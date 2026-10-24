import {publishedPhone,publishedUpdate} from "../lib/app-updates";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The published Pulse app builds (written by tools/companion-publish/publish.mjs from a GitHub Actions run). */
export type AppFile = { name: string; platform: "windows" | "macos" | "android" | "chrome" | "ios"; kind: string; size: number; sha256: string; url?:string };
export type AppDownloads = { version: string; commit: string; runId: string; builtAt: string; signed: boolean; notes?:string; updaterSigned?:boolean; files: AppFile[] };
export const FILE_NAME = /^(?:Pulse-\d+\.\d+\.\d+-(?:mac-universal\.dmg|windows-setup\.exe|windows\.msi|android\.apk|chrome\.zip|ios-(?:simulator|device-unsigned)\.zip)|pulse-companion-(windows|macos|android|chrome|ios-(?:simulator|device-unsigned))-\d+\.\d+\.\d+-[a-f0-9]{12}\.(apk|exe|msi|dmg|zip))$/;

export const downloadsDir = () => process.env.PULSE_COMPANION_DOWNLOADS_DIR ?? (process.env.PULSE_DESKTOP_DOWNLOADS_DIR ? join(process.env.PULSE_DESKTOP_DOWNLOADS_DIR,"companion") : "/home/eadev/pulse-downloads/companion");

/** `origin` is the install's own address (installOrigin): Android offers only the APK built for it. */
export async function readDownloads(origin: string | null): Promise<AppDownloads | null> {
  try {
    const [update,desktop,phone,ios]=await Promise.all([publishedUpdate('test'),publishedUpdate('test','desktop'),publishedPhone('android',origin),publishedPhone('ios')]);
    // Computers from the desktop release, Chrome and iPhone from the shared manifest, Android from the phone app's own
    // download pointer for this address: the retired Expo build and another address's app are never offered.
    const desk=(desktop??update)?.files.filter(f=>f.platform==='windows'||f.platform==='macos')??[];
    if(update)return {...update,version:desktop?.version??update.version,signed:false,updaterSigned:true,files:[...desk,...update.files.filter(f=>f.platform==='chrome'),...(phone?[phone]:[]),...(ios?[ios]:[])].filter(f=>FILE_NAME.test(f.name)) as AppFile[]};
    const m = JSON.parse(await readFile(join(downloadsDir(), "latest.json"), "utf8")) as AppDownloads;
    if (!Array.isArray(m.files)) return null;
    return { ...m, files: [...m.files.filter((f) => !['android','ios'].includes(f.platform) && FILE_NAME.test(f.name) && Number.isFinite(f.size) && /^[a-f0-9]{64}$/.test(f.sha256)),...(phone?[phone]:[]),...(ios?[ios]:[])] };
  } catch { return null; }
}
