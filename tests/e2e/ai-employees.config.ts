import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Affected-route verification without a full production build. Playwright owns and stops both local servers. Turbopack
// like the build: webpack's CSS modules reject the chats page's existing `:global(:root[...])` rule.
const servers = base.webServer ? Array.isArray(base.webServer) ? base.webServer : [base.webServer] : [];
export default defineConfig({
  ...base, testMatch: "ai-employees.spec.ts", fullyParallel: false, workers: 1, retries: 0,
  webServer: servers.map((server) => server.command.includes("next start") ? {
    ...server,
    command: server.command.slice(server.command.lastIndexOf("corepack pnpm")).replace("next start", "next dev"),
  } : server),
});
