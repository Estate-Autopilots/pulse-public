// TELEMETRY: the web app's version on every telemetry row (trends by version). PULSE_RELEASE when the release sets it,
// else the Next build id, else (next dev, the owner's workbench) the checkout's commit, read at most every 5 minutes.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let cached: { value: string; at: number } | undefined;

export function telemetryRelease(): string {
  const dev = process.env.NODE_ENV === "development";
  if (cached && (!dev || Date.now() - cached.at < 300_000)) return cached.value;
  const value = read(dev);
  cached = { value, at: Date.now() };
  return value;
}

function read(dev: boolean): string {
  const release = process.env.PULSE_RELEASE?.trim();
  if (release && /^[A-Za-z0-9._+-]{1,60}$/.test(release)) return release;
  if (!dev) {
    try {
      const id = readFileSync(join(process.cwd(), process.env.NEXT_DIST_DIR ?? ".next", "BUILD_ID"), "utf8").trim();
      if (/^[A-Za-z0-9_-]{1,40}$/.test(id)) return `build-${id.slice(0, 20)}`;
    } catch { /* no build id */ }
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (/^[0-9a-f]{7,12}$/.test(sha)) return `dev-${sha}`;
  } catch { /* no git here */ }
  return "dev";
}
