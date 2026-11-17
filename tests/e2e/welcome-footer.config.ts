import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// BUG-ONBOARD: /welcome against a synthetic first run (welcome-footer-api.mjs) and one managed web server; run through
// ea-heavy on the VPS.
const servers = base.webServer ? Array.isArray(base.webServer) ? base.webServer : [base.webServer] : [];
process.env.PULSE_WELCOME_FOOTER_CONTRACT = "1";
export default defineConfig({
  ...base, testMatch: "welcome-footer.spec.ts", fullyParallel: false, workers: 1, retries: 0,
  timeout: 120_000, expect: { timeout: 15_000 },
  webServer: servers.map((server) => server.command.includes("mock-editors-api") ? {
    ...server, command: "node tests/e2e/welcome-footer-api.mjs",
  } : {
    ...server,
    command: server.command.slice(server.command.lastIndexOf("corepack pnpm")).replace("next start", "next dev"),
    env: { ...server.env, NEXT_DIST_DIR: ".next-welcome-footer" },
  }),
});
