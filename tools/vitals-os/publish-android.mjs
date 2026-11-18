#!/usr/bin/env node
// PULSE-APPS (owner, 6 Nov 2026): put the signed Vitals OS Android app in Pulse's OWN downloads directory (never a store
// or a GitHub release). The APK is built and signed with the durable Pulse key on the public client repository's hosted
// runners (mobile.yml on main or an isolated validation branch, which builds and signs but never publishes). This takes
// that run's artifact only when the same jobs the release workflow requires passed (android, android-acceptance,
// android-gps-photo), re-checks the runner's aapt2/apksigner output, independently reads the signer certificate from the
// APK Signature Scheme v2/v3 block, and writes <downloads>/vitals-os/android/{VitalsOS-<version>-android.apk,latest.json}.
//   node tools/vitals-os/publish-android.mjs [--run <id>]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE = "com.pulse.work.mobile";
// The durable Pulse signing certificate (the Expo app's; apps/mobile/tests/shell.test.mjs PULSE_SIGNING_SHA256).
export const SIGNER_SHA256 = "7fb7e080fe49b5f285cbd436c500167575d5f1e6f862e7fbbebb3bec6d0989e6";
const REQUIRED_JOBS = ["android", "android-acceptance", "android-gps-photo"];
const MIN_VERSION = process.env.VITALS_ANDROID_MIN_VERSION ?? "1.2.0";

/** SHA-256 of each signer certificate in the APK's v2 (0x7109871a) or v3 (0xf05368c0) signature block. */
export function signerDigests(apk) {
  const eocd = apk.lastIndexOf(Buffer.from("PK\x05\x06", "latin1"));
  if (eocd < 0) throw new Error("Not a ZIP file");
  const cd = apk.readUInt32LE(eocd + 16);
  if (apk.subarray(cd - 16, cd).toString("latin1") !== "APK Sig Block 42") throw new Error("No APK signing block");
  const size = Number(apk.readBigUInt64LE(cd - 24));
  const lp = (buf, o) => { const n = buf.readUInt32LE(o); return [buf.subarray(o + 4, o + 4 + n), o + 4 + n]; };
  const out = new Set();
  for (let pos = cd - size - 8 + 8; pos < cd - 24;) {
    const n = Number(apk.readBigUInt64LE(pos)), id = apk.readUInt32LE(pos + 8), value = apk.subarray(pos + 12, pos + 8 + n);
    pos += 8 + n;
    if (id !== 0x7109871a && id !== 0xf05368c0) continue;
    const [signers] = lp(value, 0);
    for (let o = 0; o < signers.length;) {
      let signer; [signer, o] = lp(signers, o);
      const [signed] = lp(signer, 0);
      const [, p] = lp(signed, 0); const [certs] = lp(signed, p);
      for (let q = 0; q < certs.length;) { let cert; [cert, q] = lp(certs, q); out.add(createHash("sha256").update(cert).digest("hex")); }
    }
  }
  return [...out];
}

/** The runner's own checks, as written into the artifact by mobile.yml, must name this package, version and key. */
export function checkRunnerEvidence({ badging, signature, version }) {
  const [a, b, c] = version.split(".").map(Number), code = a * 1000000 + b * 1000 + c;
  if (!badging.includes(`package: name='${PACKAGE}' versionCode='${code}' versionName='${version}'`)) throw new Error("aapt2 badging does not match the package and version");
  if (!/Verified using v2 scheme \(APK Signature Scheme v2\): true/.test(signature)) throw new Error("apksigner did not verify the v2 signature");
  if (!signature.toLowerCase().includes(`certificate sha-256 digest: ${SIGNER_SHA256}`)) throw new Error("apksigner names another signing certificate");
  return code;
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function chooseRun(repo, branches, requested) {
  const runs = requested ? [JSON.parse(gh(["run", "view", requested, "-R", repo, "--json", "databaseId,headSha,headBranch,updatedAt,createdAt"]))]
    : branches.flatMap((branch) => JSON.parse(gh(["run", "list", "-R", repo, "--workflow", "mobile.yml", "--branch", branch, "--limit", "10", "--json", "databaseId,headSha,headBranch,updatedAt,createdAt,status"])).filter((r) => r.status === "completed"))
      .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
  for (const run of runs) {
    if (!branches.includes(run.headBranch)) continue;
    const jobs = JSON.parse(gh(["api", `repos/${repo}/actions/runs/${run.databaseId}/jobs?per_page=100`, "--jq", ".jobs"]));
    const ok = REQUIRED_JOBS.every((name) => jobs.some((j) => j.name === name && j.conclusion === "success"));
    if (ok) return run;
    if (requested) throw new Error(`Run ${requested} did not pass ${REQUIRED_JOBS.join(", ")}`);
  }
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  const repo = process.env.VITALS_ANDROID_REPO ?? "Estate-Autopilots/pulse-companion";
  const branches = (process.env.VITALS_ANDROID_BRANCHES ?? "main,validation/mobile-shell").split(",").map((s) => s.trim()).filter(Boolean);
  const root = path.join(process.env.PULSE_DESKTOP_DOWNLOADS_DIR ?? path.join(process.env.HOME, "pulse-downloads/desktop"), "vitals-os", "android");
  const requested = argv[argv.indexOf("--run") + 1] && argv.includes("--run") ? argv[argv.indexOf("--run") + 1] : null;
  const run = chooseRun(repo, branches, requested);
  if (!run) { process.stdout.write("No phone build has passed the release checks yet; nothing published.\n"); return; }
  await mkdir(root, { recursive: true, mode: 0o755 }); await chmod(root, 0o755);
  try { if (JSON.parse(await readFile(path.join(root, "latest.json"), "utf8")).commit === run.headSha) { process.stdout.write(`Run ${run.databaseId} is already published.\n`); return; } } catch { /* first publication */ }
  const work = await mkdtemp(path.join(root, ".work-"));
  try {
    gh(["run", "download", String(run.databaseId), "-R", repo, "--name", `phone-android-${run.headSha}`, "--dir", work]);
    const apks = (await readdir(work)).filter((n) => /^Pulse-\d+\.\d+\.\d+-android\.apk$/.test(n));
    if (apks.length !== 1) throw new Error("Artifact must hold exactly one Pulse-<version>-android.apk");
    const version = apks[0].match(/^Pulse-(\d+\.\d+\.\d+)-/)[1];
    // Only the rebranded app is Vitals OS: an older Pulse shell (another name, another address) is never offered as it.
    const [minA, minB, minC] = MIN_VERSION.split(".").map(Number), [vA, vB, vC] = version.split(".").map(Number);
    if (vA * 1e6 + vB * 1e3 + vC < minA * 1e6 + minB * 1e3 + minC) {
      process.stdout.write(`The newest phone build that passed the checks is Pulse ${version}, which predates Vitals OS ${MIN_VERSION}; nothing published.
`);
      return;
    }
    const versionCode = checkRunnerEvidence({ badging: await readFile(path.join(work, "apk-badging.txt"), "utf8"), signature: await readFile(path.join(work, "apk-signature.txt"), "utf8"), version });
    const apk = await readFile(path.join(work, apks[0]));
    const signers = signerDigests(apk);
    if (signers.length !== 1 || signers[0] !== SIGNER_SHA256) throw new Error("The APK is not signed with the durable Pulse key");
    const name = `VitalsOS-${version}-android.apk`, entry = {
      product: "Vitals OS", platform: "android", kind: "apk", package: PACKAGE, name, version, versionCode, size: apk.length, sha256: sha256(apk),
      signerSha256: SIGNER_SHA256, commit: run.headSha, runId: String(run.databaseId), branch: run.headBranch, builtAt: new Date(run.updatedAt).toISOString(),
      buildUrl: `https://github.com/${repo}/actions/runs/${run.databaseId}`,
    };
    const incoming = path.join(root, `.${name}.${process.pid}`);
    await copyFile(path.join(work, apks[0]), incoming); await chmod(incoming, 0o644);
    if ((await stat(incoming)).size !== entry.size || sha256(await readFile(incoming)) !== entry.sha256) throw new Error("Copy verification failed");
    await rename(incoming, path.join(root, name));
    const tmp = path.join(root, `.latest-${process.pid}.json`);
    await writeFile(tmp, JSON.stringify(entry, null, 2) + "\n", { mode: 0o644 }); await rename(tmp, path.join(root, "latest.json"));
    // Keep this build and the one before it.
    const older = (await readdir(root)).filter((n) => /^VitalsOS-\d+\.\d+\.\d+-android\.apk$/.test(n) && n !== name);
    const byTime = await Promise.all(older.map(async (n) => ({ n, t: (await stat(path.join(root, n))).mtimeMs })));
    for (const { n } of byTime.sort((x, y) => y.t - x.t).slice(1)) await rm(path.join(root, n), { force: true });
    process.stdout.write(`Published ${name} (${entry.size} bytes, sha256 ${entry.sha256}) from run ${run.databaseId}.\n`);
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`Vitals OS Android publisher refused the build: ${error.message}\n`); process.exitCode = 1; });
}
