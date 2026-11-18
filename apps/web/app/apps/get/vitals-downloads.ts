import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// PULSE-APPS (owner, 6 Nov 2026): Vitals OS installs come from Pulse's own downloads directory, never a store or a
// GitHub release. Production containers see only PULSE_DESKTOP_DOWNLOADS_DIR (read-only), so everything lives under it:
//   <dir>/latest.json + <dir>/<version>-<sha7>/<file>   Windows, written by tools/desktop-publish/publish.mjs
//   <dir>/vitals-os/android/latest.json + its .apk      Android, written by tools/vitals-os/publish-android.mjs

export type VitalsFile = { platform: "android" | "windows"; kind: "apk" | "exe" | "msi"; name: string; version: string; size: number; sha256: string; builtAt: string; path: string };

const ANDROID_NAME = /^VitalsOS-(\d+\.\d+\.\d+)-android\.apk$/;
// Only the Vitals OS desktop app (the publisher names files after the product); an older Pulse build is not offered.
const WINDOWS_NAME = /^VitalsOS-(\d+\.\d+\.\d+)-windows(?:-setup\.exe|\.msi)$/;
const HASH = /^[a-f0-9]{64}$/;
const RELEASE_DIR = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?-[a-f0-9]{7}$/;

export const downloadsRoot = () => process.env.PULSE_DESKTOP_DOWNLOADS_DIR ?? "/home/eadev/pulse-downloads/desktop";

const readJson = async (path: string): Promise<Record<string, unknown> | null> => {
  try { const text = await readFile(path, "utf8"); return text.length > 20000 ? null : JSON.parse(text); } catch { return null; }
};

/** The file on disk must still be the one its manifest names (size); a missing or changed file is not offered. */
async function present(file: VitalsFile): Promise<VitalsFile | null> {
  try { const info = await stat(file.path); return info.isFile() && info.size === file.size ? file : null; } catch { return null; }
}

async function android(root: string): Promise<VitalsFile | null> {
  const m = await readJson(join(root, "vitals-os", "android", "latest.json"));
  const name = String(m?.name ?? ""), version = ANDROID_NAME.exec(name)?.[1];
  if (!m || !version || m.version !== version || !Number.isSafeInteger(m.size) || !HASH.test(String(m.sha256)) || !Number.isFinite(Date.parse(String(m.builtAt)))) return null;
  return present({ platform: "android", kind: "apk", name, version, size: m.size as number, sha256: String(m.sha256), builtAt: String(m.builtAt), path: join(root, "vitals-os", "android", name) });
}

async function windows(root: string): Promise<VitalsFile[]> {
  const m = await readJson(join(root, "latest.json"));
  const version = String(m?.version ?? ""), commit = String(m?.commit ?? "");
  if (!m || !Array.isArray(m.files) || !/^[a-f0-9]{40}$/.test(commit)) return [];
  const dir = `${version}-${commit.slice(0, 7)}`;
  if (!RELEASE_DIR.test(dir)) return [];
  const files = (m.files as { name?: unknown; size?: unknown; sha256?: unknown }[]).flatMap((f): VitalsFile[] => {
    const name = String(f.name ?? "");
    if (WINDOWS_NAME.exec(name)?.[1] !== version || !Number.isSafeInteger(f.size) || !HASH.test(String(f.sha256))) return [];
    return [{ platform: "windows", kind: name.endsWith(".msi") ? "msi" : "exe", name, version, size: f.size as number, sha256: String(f.sha256), builtAt: String(m.builtAt ?? ""), path: join(root, dir, name) }];
  });
  return (await Promise.all(files.map(present))).filter((f): f is VitalsFile => !!f);
}

/** Every Vitals OS file that is published and still on disk. */
export async function vitalsDownloads(): Promise<VitalsFile[]> {
  const root = downloadsRoot();
  const [phone, computer] = await Promise.all([android(root), windows(root)]);
  return [...(phone ? [phone] : []), ...computer];
}
