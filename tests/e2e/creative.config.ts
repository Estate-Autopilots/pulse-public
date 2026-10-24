import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Compile only the Creative routes; Playwright owns and cleans up both synthetic services.
export default defineConfig({ ...base, testMatch: "creative-polish.spec.ts", workers: 1, timeout: 90_000,
  webServer: Array.isArray(base.webServer) ? base.webServer.map((server) => ({ ...server,
    command: server.command.replace(/^.*corepack pnpm --dir apps\/web exec next start/, "corepack pnpm --dir apps/web exec next dev --disable-source-maps"),
    env: { ...server.env, PULSE_CREATIVE: "1", NEXT_DIST_DIR: ".next/creative-polish" },
  })) : base.webServer,
});
