import { execFileSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

function findAvailablePort(excluded?: number): number {
  let port: number;
  do {
    port = Number(execFileSync(
      process.execPath,
      [
        "-e",
        "const net = require('node:net'); const server = net.createServer(); server.listen(0, '127.0.0.1', () => { console.log(server.address().port); server.close(); });",
      ],
      { encoding: "utf8" },
    ).trim());
  } while (port === excluded);
  return port;
}

const externalBaseUrl = process.env.PULSE_BASE_URL?.trim();
const managedServerPort = externalBaseUrl ? undefined : findAvailablePort();
const mockApiPort = externalBaseUrl ? undefined : findAvailablePort(managedServerPort);
const managedServerUrl = managedServerPort ? `http://127.0.0.1:${managedServerPort}` : undefined;
const testBaseUrl = externalBaseUrl || managedServerUrl;
if (testBaseUrl) process.env.PLAYWRIGHT_TEST_BASE_URL = testBaseUrl;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  // Two workers on GitHub-hosted runners (owner CPU rule); one on this VPS (Ops rule).
  workers: process.env.GITHUB_ACTIONS ? 2 : 1,
  // OPS-2: under CI a failed test runs once more; passing then it is reported as flaky (tools/ci.sh's summary through
  // flaky-reporter.mjs), failing twice it fails the run as before.
  retries: process.env.PULSE_CI === "1" ? 1 : 0,
  reporter: process.env.PULSE_CI_FLAKY_FILE ? [["list"], ["./flaky-reporter.mjs"]] : "list",
  // Live Next dev streams pages while other workbenches share the API and database.
  timeout: process.env.PULSE_REAL_SMOKE ? 60_000 : 30_000,
  expect: { timeout: process.env.PULSE_REAL_SMOKE ? 15_000 : 5_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: testBaseUrl,
    headless: true,
  },
  ...(managedServerPort
    ? {
        webServer: [
          {
            command: "node tests/e2e/mock-editors-api.mjs",
            cwd: "../..",
            port: mockApiPort,
            env: { PORT: String(mockApiPort) },
            reuseExistingServer: false,
          },
          {
            // tools/ci.sh builds the web app as its own step first (PULSE_WEB_BUILT=1): here only the start, which the
            // 240 s limit fits; a run on its own still builds.
            command: `${process.env.PULSE_WEB_BUILT === "1" ? "" : "corepack pnpm --dir apps/web exec next build && "}corepack pnpm --dir apps/web exec next start --hostname 127.0.0.1 --port ${managedServerPort}`,
            cwd: "../..",
            port: managedServerPort,
            env: { PULSE_API_URL: `http://127.0.0.1:${mockApiPort}` },
            reuseExistingServer: false,
            timeout: 240_000,
          },
        ],
      }
    : {}),
});
