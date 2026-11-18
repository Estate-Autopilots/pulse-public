import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Targeted local check without building every route; the normal CI config runs the same spec on its build.
const servers = base.webServer ? Array.isArray(base.webServer) ? base.webServer : [base.webServer] : [];
export default defineConfig({
  ...base, testMatch: "startup-interactivity.spec.ts", fullyParallel: false, workers: 1,
  timeout: 180_000, expect: { timeout: 20_000 },
  webServer: servers.map((server) => server.command.includes("mock-editors-api") ? server : {
    ...server,
    command: server.command.slice(server.command.lastIndexOf("corepack pnpm")).replace("next start", "next dev"),
    env: { ...server.env, NEXT_DIST_DIR: ".next" },
  }),
});
