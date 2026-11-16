import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

// UI-DIALOGS (owner, 8 Nov 2026: "the 'app.vitalsos.ai says / New folder name' browser prompt is ugly"): the browser's
// own prompt, confirm and alert never come back. Use useConfirm(), usePrompt() and toast() from app/kit/dialogs.tsx.
// app/lib/no-browser-dialogs.test.mjs reads every source file for the same thing.
const DIALOGS = "Use the app's own dialogs instead: useConfirm(), usePrompt() or toast() from app/kit/dialogs.tsx.";
const OWNERS = ["window", "globalThis", "self", "top", "parent"];
const noBrowserDialogs = {
  "no-restricted-globals": ["error", ...["prompt", "confirm", "alert"].map((name) => ({ name, message: DIALOGS }))],
  "no-restricted-properties": ["error", ...OWNERS.flatMap((object) => ["prompt", "confirm", "alert"].map((property) => ({ object, property, message: DIALOGS })))],
};

export default defineConfig([
  ...nextVitals,
  globalIgnores([".next/**", "next-env.d.ts", "*.tsbuildinfo", "**/*.d.mts"]),
  { files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"], rules: noBrowserDialogs },
]);
