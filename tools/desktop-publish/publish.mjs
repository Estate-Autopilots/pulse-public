import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const manifestName = "pulse-desktop-manifest.json";
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const fileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:exe|msi)$/i;
const hashPattern = /^[a-f\d]{64}$/i;

export function validateManifest(value, expectedCommit) {
  const commit = String(expectedCommit ?? "").toLowerCase();
  if (!value || !versionPattern.test(value.version ?? "") || !/^[a-f\d]{40}$/.test(commit) ||
      String(value.commit ?? "").toLowerCase() !== commit || !Array.isArray(value.files) || value.files.length === 0) {
    throw new Error("Installer manifest identity is invalid");
  }
  const builtAt = value.builtAt;
  const time = Date.parse(builtAt ?? "");
  if (!Number.isFinite(time) || new Date(time).toISOString() !== builtAt) throw new Error("Installer manifest build date is invalid");
  const names = new Set();
  for (const file of value.files) {
    if (!fileNamePattern.test(file.name ?? "") || names.has(file.name.toLowerCase()) ||
        !Number.isSafeInteger(file.size) || file.size <= 0 || !hashPattern.test(file.sha256 ?? "")) {
      throw new Error("Installer manifest file entry is invalid");
    }
    names.add(file.name.toLowerCase());
  }
  if (!value.files.some((file) => file.name.toLowerCase().endsWith(".exe"))) throw new Error("Manifest has no Windows installer");
  return { version: value.version, commit, builtAt, files: value.files.map(({ name, size, sha256 }) => ({ name, size, sha256: sha256.toLowerCase() })) };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function findNamedFiles(directory, name) {
  const matches = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.name === name && entry.isFile()) matches.push(candidate);
    }
  }
  await walk(directory);
  return matches;
}

export async function verifyAndPublish({ artifactDirectory, downloadsDirectory, expectedCommit, keep = 3 }) {
  const manifests = await findNamedFiles(artifactDirectory, manifestName);
  const downloadedManifestPath = manifests[0];
  if (manifests.length === 0) throw new Error("No installer manifest in selected main artifact");
  if (manifests.length !== 1) throw new Error("Downloaded artifact contains multiple installer manifests");
  const manifest = validateManifest(JSON.parse(await readFile(downloadedManifestPath, "utf8")), expectedCommit);
  await mkdir(downloadsDirectory, { recursive: true, mode: 0o755 });
  const rootStat = await lstat(downloadsDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Downloads root must be a real directory");
  await chmodTreeDirectory(downloadsDirectory);

  const releaseName = `${manifest.version}-${manifest.commit.slice(0, 7)}`;
  const releasePath = path.join(downloadsDirectory, releaseName);
  const currentPath = path.join(downloadsDirectory, ".incoming-" + process.pid);
  await rm(currentPath, { recursive: true, force: true });
  await mkdir(currentPath, { mode: 0o755 });
  try {
    for (const file of manifest.files) {
      const candidates = await findNamedFiles(artifactDirectory, file.name);
      if (candidates.length !== 1) throw new Error(`Artifact must contain exactly one ${file.name}`);
      const sourceStat = await lstat(candidates[0]);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== file.size ||
          await sha256File(candidates[0]) !== file.sha256) throw new Error(`Artifact verification failed for ${file.name}`);
      const targetPath = path.join(currentPath, file.name);
      await copyFile(candidates[0], targetPath);
      await chmod(targetPath, 0o644);
    }
    await writeFile(path.join(currentPath, manifestName), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
    await chmod(currentPath, 0o755);
    try {
      const existing = JSON.parse(await readFile(path.join(releasePath, manifestName), "utf8"));
      if (JSON.stringify(validateManifest(existing, manifest.commit)) !== JSON.stringify(manifest)) {
        throw new Error("Existing release directory has different metadata");
      }
      for (const file of manifest.files) {
        const existingFile = path.join(releasePath, file.name);
        const existingStat = await lstat(existingFile);
        if (!existingStat.isFile() || existingStat.isSymbolicLink() || existingStat.size !== file.size ||
            await sha256File(existingFile) !== file.sha256) throw new Error(`Existing published file failed verification: ${file.name}`);
      }
      await rm(currentPath, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await rename(currentPath, releasePath);
    }
    const latestTemp = path.join(downloadsDirectory, `.latest-${process.pid}.tmp`);
    await writeFile(latestTemp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
    await rename(latestTemp, path.join(downloadsDirectory, "latest.json"));
    await pruneOldReleases(downloadsDirectory, keep, releaseName);
  } catch (error) {
    await rm(currentPath, { recursive: true, force: true });
    throw error;
  }
  return { releaseName, manifest };
}

async function chmodTreeDirectory(directory) {
  await chmod(directory, 0o755);
}

async function pruneOldReleases(root, keep, currentName) {
  const candidates = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[\d.]+(?:[-+][\w.-]+)?-[a-f\d]{7}$/i.test(entry.name)) continue;
    let builtAt = 0;
    try { builtAt = Date.parse(JSON.parse(await readFile(path.join(root, entry.name, manifestName), "utf8")).builtAt) || 0; }
    catch { builtAt = 0; }
    candidates.push({ name: entry.name, builtAt });
  }
  candidates.sort((a, b) => b.builtAt - a.builtAt);
  const retained = new Set(candidates.slice(0, keep).map((candidate) => candidate.name));
  retained.add(currentName);
  for (const candidate of candidates) {
    if (!retained.has(candidate.name)) await rm(path.join(root, candidate.name), { recursive: true, force: true });
  }
}

function runGh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export async function main() {
  const repo = process.env.PULSE_DESKTOP_GITHUB_REPO ?? "Estate-Autopilots/pulse";
  const workflow = process.env.PULSE_DESKTOP_WORKFLOW ?? "desktop-windows.yml";
  const downloadsDirectory = process.env.PULSE_DESKTOP_DOWNLOADS_DIR ?? path.join(process.env.HOME, "pulse-downloads/desktop");
  const keep = Number(process.env.PULSE_DESKTOP_KEEP ?? "3");
  if (!Number.isInteger(keep) || keep < 1) throw new Error("PULSE_DESKTOP_KEEP must be a positive integer");
  const runs = JSON.parse(runGh(["run", "list", "-R", repo, "--workflow", workflow, "--branch", "main", "--status", "success", "--limit", "1", "--json", "databaseId,headSha"]));
  const latest = runs[0];
  if (!latest) {
    process.stdout.write("No successful Windows build is published on main yet.\n");
    return;
  }
  const root = path.resolve(downloadsDirectory);
  await mkdir(root, { recursive: true, mode: 0o755 });
  const work = await mkdtemp(path.join(root, ".work-"));
  try {
    const artifactDirectory = path.join(work, "artifact");
    await mkdir(artifactDirectory);
    runGh(["run", "download", String(latest.databaseId), "-R", repo, "--name", `pulse-desktop-windows-${latest.headSha}`, "--dir", artifactDirectory]);
    try {
      const published = await verifyAndPublish({ artifactDirectory, downloadsDirectory: root, expectedCommit: latest.headSha, keep });
      process.stdout.write(`Published Windows build ${published.manifest.version}-${latest.headSha.slice(0, 7)}.\n`);
    } catch (error) {
      if (error.message === "No installer manifest in selected main artifact") {
        process.stdout.write("The latest successful main artifact predates the manifest; no build was published.\n");
        return;
      }
      throw error;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Desktop publisher refused artifact: ${error.message}\n`);
    process.exitCode = 1;
  });
}
