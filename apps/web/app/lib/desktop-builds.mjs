import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { isPulseAdminEmail } from "./admin-access.mjs";

export const STAFF_NOTICE_VERSION = "2026-11-staff-v2";
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

export function canDownloadDesktopBuild(email, acknowledgedVersion, admins) {
  return isPulseAdminEmail(email, admins) && acknowledgedVersion === STAFF_NOTICE_VERSION;
}

export async function loadLatestWindowsBuild(directory) {
  if (!directory) throw new Error("Desktop build storage is not configured");
  const root = path.resolve(directory);
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(root, "latest.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") throw Object.assign(new Error("No build published yet"), { code: "BUILD_NOT_PUBLISHED" });
    throw error;
  }
  if (!versionPattern.test(manifest.version ?? "") || !/^[a-f\d]{40}$/i.test(manifest.commit ?? "") ||
      !Number.isFinite(Date.parse(manifest.builtAt ?? "")) || new Date(manifest.builtAt).toISOString() !== manifest.builtAt ||
      !Array.isArray(manifest.files)) throw new Error("Desktop build metadata is invalid");

  const releaseDirectory = path.join(root, `${manifest.version}-${manifest.commit.slice(0, 7).toLowerCase()}`);
  const releaseManifest = JSON.parse(await readFile(path.join(releaseDirectory, "pulse-desktop-manifest.json"), "utf8"));
  if (JSON.stringify(releaseManifest) !== JSON.stringify(manifest)) throw new Error("Published build metadata does not match latest.json");

  const installer = manifest.files.find((file) => file.name?.toLowerCase().endsWith(".exe"));
  if (!installer || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/i.test(installer.name ?? "") ||
      !Number.isSafeInteger(installer.size) || installer.size <= 0 || !/^[a-f\d]{64}$/i.test(installer.sha256 ?? "")) {
    throw new Error("Windows installer metadata is invalid");
  }

  const filePath = path.join(releaseDirectory, installer.name);
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== installer.size) {
    throw new Error("Windows installer size does not match its metadata");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  if (hash.digest("hex") !== installer.sha256.toLowerCase()) throw new Error("Windows installer SHA-256 does not match its metadata");

  return {
    version: manifest.version,
    commit: manifest.commit.toLowerCase(),
    buildDate: manifest.builtAt,
    fileName: installer.name,
    sizeBytes: installer.size,
    sha256: installer.sha256.toLowerCase(),
    filePath,
  };
}
