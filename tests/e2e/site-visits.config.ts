import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
const servers = base.webServer ? Array.isArray(base.webServer) ? base.webServer : [base.webServer] : [];
export default defineConfig({
  ...base, testMatch: "site-visits.spec.ts", fullyParallel: false, workers: 1, retries: 0,
  timeout: 90_000, expect: { timeout: 15_000 },
  webServer: servers.map(server => server.command.includes("next start") ? { ...server,
    command: server.command.slice(server.command.lastIndexOf("corepack pnpm")).replace("next start", "next dev"),
    env: { ...server.env, NEXT_DIST_DIR: ".next-visits-review" },
  } : server),
});
