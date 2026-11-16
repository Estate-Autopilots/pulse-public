import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const installerKinds = new Map([
  ["nsis", ".exe"],
  ["msi", ".msi"],
]);

export async function inspectInstaller(filePath) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error("Installer is not a file: " + filePath);

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);

  return { size: fileStat.size, sha256: hash.digest("hex") };
}

export async function verifyInstaller(filePath, expected) {
  const actual = await inspectInstaller(filePath);
  return actual.size === expected.size && actual.sha256 === expected.sha256;
}

export async function createBuildManifest({ directory, version, commit, builtAt }) {
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version ?? "")) {
    throw new Error("Build version must be a semantic version");
  }
  if (!/^[a-f\d]{7,40}$/i.test(commit ?? "")) {
    throw new Error("Build commit must be a hexadecimal Git commit");
  }
  if (!Number.isFinite(Date.parse(builtAt ?? ""))) {
    throw new Error("Build date must be a valid ISO timestamp");
  }

  const files = [];
  for (const [kind, extension] of installerKinds) {
    const folder = path.join(directory, kind);
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== extension) continue;
      const filePath = path.join(folder, entry.name);
      const metadata = await inspectInstaller(filePath);
      files.push({ name: entry.name, ...metadata });
    }
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  if (files.length === 0) throw new Error("No NSIS or MSI installers were found");

  return {
    version,
    commit: commit.toLowerCase(),
    builtAt: new Date(builtAt).toISOString(),
    files,
  };
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function main() {
  const root = path.resolve(option("--root", process.cwd()));
  const configPath = path.resolve(root, option("--config", "apps/desktop/src-tauri/tauri.conf.json"));
  const bundleDirectory = path.resolve(root, option("--directory", "apps/desktop/src-tauri/target/release/bundle"));
  const outputPath = path.resolve(root, option("--output", path.join(bundleDirectory, "pulse-desktop-manifest.json")));
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const commit = process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const builtAt = process.env.PULSE_DESKTOP_BUILT_AT ?? process.env.PULSE_DESKTOP_BUILD_DATE ?? new Date().toISOString();
  const manifest = await createBuildManifest({ directory: bundleDirectory, version: config.version, commit, builtAt });
  await writeFile(outputPath, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write("Wrote build metadata for " + manifest.files.length + " installers to " + outputPath + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
}
