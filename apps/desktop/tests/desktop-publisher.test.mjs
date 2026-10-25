import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyAndPublish } from "../../../tools/desktop-publish/publish.mjs";

const commit = "b".repeat(40);
const builtAt = "2026-10-05T12:00:00.000Z";

test("hosted desktop publication creates a normal release and preserves the Android pointer", {
  skip: process.platform === "win32" && "The publisher runs on Ubuntu; its gh fixture is a POSIX executable",
}, async (t) => {
  const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || os.tmpdir(), "pulse-desktop-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["artifacts", "bin", "apps/desktop"]) await mkdir(path.join(root, dir), { recursive: true });
  const version = "1.0.2";
  await writeFile(path.join(root, "apps/desktop/package.json"), JSON.stringify({ version }));
  await writeFile(path.join(root, "apps/desktop/WHATS_NEW.md"), "Synthetic release notes.");
  for (const name of ["setup.exe", "setup.msi", "app.dmg", "app.app.tar.gz"]) {
    await writeFile(path.join(root, "artifacts", name), "synthetic installer");
    if (!name.endsWith(".dmg")) await writeFile(path.join(root, "artifacts", name + ".sig"), "synthetic signature");
  }
  await writeFile(path.join(root, "bin/gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
if (args[1] === 'download') console.log('{"android":"unchanged"}');
`, { mode: 0o755 });
  const script = fileURLToPath(new URL("../scripts/publish-desktop-release.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [script], { cwd: root, encoding: "utf8", env: {
    ...process.env, PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
    GITHUB_SHA: commit, GITHUB_RUN_ID: "123", GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "Estate-Autopilots/pulse-companion",
  } });
  const tag = `companion-v${version}-${commit.slice(0, 7)}`;
  assert.equal(output.trim(), `https://github.com/Estate-Autopilots/pulse-companion/releases/tag/${tag}`);
  const calls = (await readFile(path.join(root, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const creates = calls.filter(args => args[1] === "create");
  assert.equal(creates.length, 1, "no pointer is created or reflagged");
  assert.equal(creates[0][2], tag);
  assert.equal(creates[0][creates[0].indexOf("--title") + 1], `Pulse Desktop ${version}`);
  assert.ok(!creates[0].includes("--prerelease"));
  assert.ok(!calls.some(args => args[1] === "edit"), "existing pointer release flags are preserved");
  assert.deepEqual(calls.slice(1).map(args => args.slice(1, 3)), [
    ["download", "companion-test"], ["upload", "companion-test"], ["download", "companion-test"],
  ]);
  assert.ok(calls[2].includes("release/latest-desktop.json"));
  assert.ok(calls[2].includes("--clobber"));
  assert.deepEqual(calls[1], calls[3], "the Android manifest is read before and after the desktop upload");
  assert.equal(await readFile(path.join(root, "release/latest-desktop.json"), "utf8"), await readFile(path.join(root, "release/latest.json"), "utf8"));
});

test("publisher verifies CI hashes before atomically selecting the build", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse-desktop-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = path.join(root, "artifact");
  const bundle = path.join(artifact, "nsis");
  const downloads = path.join(root, "downloads");
  await mkdir(bundle, { recursive: true });
  const bytes = Buffer.from("synthetic installer payload");
  const name = "Pulse-setup.exe";
  await writeFile(path.join(bundle, name), bytes);
  const manifest = { version: "0.1.0", commit, builtAt, files: [{ name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] };
  await writeFile(path.join(artifact, "pulse-desktop-manifest.json"), JSON.stringify(manifest));

  const result = await verifyAndPublish({ artifactDirectory: artifact, downloadsDirectory: downloads, expectedCommit: commit });
  assert.equal(result.releaseName, "0.1.0-bbbbbbb");
  assert.deepEqual(JSON.parse(await readFile(path.join(downloads, "latest.json"), "utf8")), manifest);
  const release = path.join(downloads, result.releaseName);
  assert.equal((await readdir(release)).includes(name), true);
  // POSIX publication permissions are meaningful on the VPS; Windows stat exposes synthetic mode bits.
  if (process.platform !== 'win32') {
    assert.equal((await stat(downloads)).mode & 0o777, 0o755);
    assert.equal((await stat(release)).mode & 0o777, 0o755);
    assert.equal((await stat(path.join(release, name))).mode & 0o777, 0o644);
    assert.equal((await stat(path.join(downloads, 'latest.json'))).mode & 0o777, 0o644);
  }

  await writeFile(path.join(bundle, name), "tampered installer payload");
  await assert.rejects(verifyAndPublish({ artifactDirectory: artifact, downloadsDirectory: downloads, expectedCommit: commit }), /verification failed/);
  assert.equal(JSON.parse(await readFile(path.join(downloads, "latest.json"), "utf8")).commit, commit);
});

test("publisher rejects a manifest whose commit or installer name does not match the run", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse-desktop-invalid-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { version: "0.1.0", commit: "c".repeat(40), builtAt, files: [{ name: "../setup.exe", size: 1, sha256: "a".repeat(64) }] };
  await writeFile(path.join(root, "pulse-desktop-manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyAndPublish({ artifactDirectory: root, downloadsDirectory: path.join(root, "downloads"), expectedCommit: commit }), /identity is invalid/);
});
