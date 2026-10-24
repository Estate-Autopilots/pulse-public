import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBuildManifest, inspectInstaller, verifyInstaller } from "../scripts/create-build-metadata.mjs";

const builtAt = "2026-10-05T12:00:00.000Z";
const commit = "a".repeat(40);

test("manifest records build identity and hashes each Windows installer", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-build-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "nsis"));
  await mkdir(path.join(directory, "msi"));
  const exe = Buffer.from("synthetic NSIS installer");
  const msi = Buffer.from("synthetic MSI installer");
  await writeFile(path.join(directory, "nsis", "Pulse_0.1.0_x64-setup.exe"), exe);
  await writeFile(path.join(directory, "msi", "Pulse_0.1.0_x64_en-US.msi"), msi);
  await writeFile(path.join(directory, "nsis", "README.txt"), "not an installer");

  const manifest = await createBuildManifest({ directory, version: "0.1.0", commit, builtAt });

  assert.deepEqual(
    { version: manifest.version, commit: manifest.commit, builtAt: manifest.builtAt },
    { version: "0.1.0", commit, builtAt },
  );
  assert.equal(manifest.files.length, 2);
  assert.deepEqual(
    manifest.files.map(({ name }) => name),
    ["Pulse_0.1.0_x64_en-US.msi", "Pulse_0.1.0_x64-setup.exe"],
  );
  const nsis = manifest.files.find((file) => file.name.endsWith(".exe"));
  assert.equal(nsis.size, exe.length);
  assert.equal(await verifyInstaller(path.join(directory, "nsis", nsis.name), nsis), true);
});

test("installer verification rejects size or hash mismatches", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-build-verify-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installer = path.join(directory, "Pulse-setup.exe");
  await writeFile(installer, "synthetic installer bytes");
  const expected = await inspectInstaller(installer);

  assert.equal(await verifyInstaller(installer, expected), true);
  assert.equal(await verifyInstaller(installer, { ...expected, sha256: "0".repeat(64) }), false);
  assert.equal(await verifyInstaller(installer, { ...expected, size: expected.size + 1 }), false);
});

test("manifest rejects malformed provenance and empty installer directories", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-build-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(createBuildManifest({ directory, version: "latest", commit, builtAt }), /semantic version/);
  await assert.rejects(createBuildManifest({ directory, version: "0.1.0", commit: "not-a-commit", builtAt }), /Git commit/);
  await assert.rejects(createBuildManifest({ directory, version: "0.1.0", commit, builtAt: "yesterday" }), /ISO timestamp/);
  await assert.rejects(createBuildManifest({ directory, version: "0.1.0", commit, builtAt }), /No NSIS or MSI installers/);
});
