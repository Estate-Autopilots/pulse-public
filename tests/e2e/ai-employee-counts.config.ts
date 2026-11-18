import { execFileSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

const ports = new Set<number>();
function port() {
  let p: number;
  do { p = Number(execFileSync(process.execPath, ["-e", "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"], { encoding: "utf8" }).trim()); } while (ports.has(p));
  ports.add(p); return p;
}
// Workers reload this config: keep their base URL pointed at the parent's managed servers.
const [shellPort, apiPort, webPort]: number[] = process.env.PULSE_AI_COUNTS_PORTS
  ? JSON.parse(process.env.PULSE_AI_COUNTS_PORTS) : [port(), port(), port()];
process.env.PULSE_AI_COUNTS_PORTS = JSON.stringify([shellPort, apiPort, webPort]);
const baseURL = `http://127.0.0.1:${webPort}`;
process.env.PLAYWRIGHT_TEST_BASE_URL = baseURL;
process.env.PULSE_AI_COUNTS_CONTRACT = "1";

// Run through ea-heavy. Playwright owns all three temporary servers and stops them after the checks.
export default defineConfig({
  testDir: ".", testMatch: "ai-employee-counts.spec.ts", fullyParallel: false, workers: 1,
  timeout: 90_000, expect: { timeout: 15_000 }, reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL, headless: true, reducedMotion: "reduce", extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": "admin@northwind-on.example" } },
  webServer: [
    { command: "node tests/e2e/mock-editors-api.mjs", cwd: "../..", port: shellPort, env: { PORT: String(shellPort) }, reuseExistingServer: false },
    { command: "node tests/e2e/ai-employee-counts-api.mjs", cwd: "../..", port: apiPort, env: { PORT: String(apiPort), COUNTS_SHELL_API: `http://127.0.0.1:${shellPort}` }, reuseExistingServer: false },
    { command: `corepack pnpm --dir apps/web exec next dev --hostname 127.0.0.1 --port ${webPort}`, cwd: "../..", port: webPort, env: { PULSE_API_URL: `http://127.0.0.1:${apiPort}`, NEXT_DIST_DIR: ".next-est1738-e2e" }, reuseExistingServer: false, timeout: 120_000 },
  ],
});
