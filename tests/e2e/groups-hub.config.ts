import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// GROUPS-2: the groups hub against a live Pulse (the demo company on pulse-dev): no local servers, one worker.
export default defineConfig({ ...base, testMatch: "groups-hub.spec.ts", fullyParallel: false, workers: 1, retries: 0, webServer: undefined, timeout: 240_000, expect: { timeout: 15_000 } });
