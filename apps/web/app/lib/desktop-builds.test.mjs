import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canDownloadDesktopBuild, loadLatestWindowsBuild, STAFF_NOTICE_VERSION } from "./desktop-builds.mjs";
import { isPulseAdminEmail } from "./admin-access.mjs";

async function createPublishedBuild(root, installerBytes = Buffer.from("synthetic Windows installer")) {
  const version = "0.1.0";
  const commit = "a".repeat(40);
  const builtAt = "2026-10-05T12:00:00.000Z";
  const release = path.join(root, `${version}-${commit.slice(0, 7)}`);
  await mkdir(release);
  await writeFile(path.join(release, "Pulse-setup.exe"), installerBytes);
  const manifest = {
    version, commit, builtAt,
    files: [{ name: "Pulse-setup.exe", size: installerBytes.length, sha256: createHash("sha256").update(installerBytes).digest("hex") }],
  };
  const serialized = JSON.stringify(manifest);
  await writeFile(path.join(release, "pulse-desktop-manifest.json"), serialized);
  await writeFile(path.join(root, "latest.json"), serialized);
  return manifest;
}

test("latest build metadata is tied to the published installer size and SHA-256", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse-desktop-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await createPublishedBuild(root);
  const build = await loadLatestWindowsBuild(root);
  assert.equal(build.version, manifest.version);
  assert.equal(build.commit, manifest.commit);
  assert.equal(build.buildDate, manifest.builtAt);
  assert.equal(build.sizeBytes, manifest.files[0].size);
  assert.equal(build.sha256, manifest.files[0].sha256);

  await writeFile(build.filePath, "Xynthetic Windows installer");
  await assert.rejects(loadLatestWindowsBuild(root), /SHA-256/);
});

test("installer access requires an organisation admin and exact notice v2 acknowledgement", () => {
  const admins = ["admin@example.test"];
  assert.equal(isPulseAdminEmail("ADMIN@example.test", admins), true);
  assert.equal(isPulseAdminEmail("member@example.test", admins), false);
  assert.equal(canDownloadDesktopBuild("admin@example.test", STAFF_NOTICE_VERSION, admins), true);
  assert.equal(canDownloadDesktopBuild("admin@example.test", null, admins), false);
  assert.equal(canDownloadDesktopBuild("admin@example.test", "old-notice", admins), false);
  assert.equal(canDownloadDesktopBuild("member@example.test", STAFF_NOTICE_VERSION, admins), false);
});

test("unsafe metadata, mismatched latest pointer and missing storage are rejected", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse-desktop-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createPublishedBuild(root);
  const manifestPath = path.join(root, "latest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files[0].name = "../setup.exe";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(root, `${manifest.version}-${manifest.commit.slice(0, 7)}`, "pulse-desktop-manifest.json"), JSON.stringify(manifest));
  await assert.rejects(loadLatestWindowsBuild(root), /installer metadata/);
  const empty = await mkdtemp(path.join(os.tmpdir(), "pulse-desktop-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  await assert.rejects(loadLatestWindowsBuild(empty), { code: "BUILD_NOT_PUBLISHED" });
  await assert.rejects(loadLatestWindowsBuild(undefined), /storage is not configured/);
});
