import { defineConfig } from "@playwright/test";
import base from "./task-capture.config";
export default defineConfig({ ...base, testMatch: "waiting-chain.spec.ts", workers: 1, fullyParallel: false,
  // A guarded cold dev compilation precedes browser assertions; assertion timeouts stay unchanged.
  timeout: 180_000 });
