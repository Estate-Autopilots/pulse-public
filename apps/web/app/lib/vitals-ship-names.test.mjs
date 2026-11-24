// VITALS-SHIP (24 Nov 2026, seen on production after batch 1): on app.vitalsos.ai the sidebar search and the Settings →
// Work rules heading still named the old product. They name the product of the address now (useProductName).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const repo = (rel) => readFileSync(new URL(`../../../../${rel}`, import.meta.url), "utf8");

test("the shell's search, offline note and sign-out name the product of the address", () => {
  const shell = repo("packages/ui-shell/src/shell.tsx");
  assert.match(shell, /placeholder=\{`Search \$\{productName\}…`\} aria-label=\{`Search \$\{productName\}`\}/);
  assert.match(shell, /aria-label=\{`Search \$\{productName\}`\}>/, "the search dialog's name too");
  assert.match(shell, /`You're offline\. \$\{productName\} will reconnect when a network is available\.`/);
  assert.match(shell, /function SearchPalette[^\n]*\n\s*const router = useRouter\(\); const productName = useProductName\(\);/);
  for (const said of ['"Search Pulse…"', 'aria-label="Search Pulse"', "Pulse will reconnect"]) assert.ok(!shell.includes(said), said);
  const menu = repo("packages/ui-shell/src/profile-menu.tsx");
  assert.match(menu, />Sign out of \{productName\}</);
  assert.doesNotMatch(menu, /Sign out of Pulse/);
});

test("Settings → Work rules: \"How Vitals OS names your work\" on Vitals OS", () => {
  const src = read("tasks/work-two.tsx");
  assert.match(src, /<h2 id="model-title">How \{product\} names your work<\/h2>/);
  assert.match(src, /export function WorkModel\([^\n]*\n\s*const router = useRouter\(\); const product = useProductName\(\);/);
});

test("What's new cards name the product of the address (\"Learn Vitals OS\"), and leave other words alone", async () => {
  const { namedFor, WHATS_NEW } = await import("./whats-new.mjs");
  const learn = WHATS_NEW.find((i) => i.id === "learn");
  assert.equal(namedFor("Vitals OS")(learn).title, "Learn Vitals OS");
  assert.equal(namedFor("Pulse")(learn), learn, "on Pulse's own addresses the card is as written");
  assert.equal(namedFor(undefined)(learn), learn);
  const all = WHATS_NEW.map(namedFor("Vitals OS"));
  assert.ok(all.every((i) => !/\bPulse\b/.test(i.title + i.text)), "no card says Pulse on Vitals OS");
  assert.deepEqual(all.map((i) => i.href), WHATS_NEW.map((i) => i.href), "links and order unchanged");
  assert.match(read("lib/whats-new-server.ts"), /\.map\(namedFor\(product\)\);/);
  assert.match(read("whats-new/page.tsx"), /whatsNewItems\(me\.data, platformBrand\(requestHost\(await headers\(\)\)\)\?\.product\)/);
  assert.match(read("dashboard/page.tsx"), /whatsNewItems\(viewer, product\)/);
});

test("Settings on a phone: an opened section's slide-in never makes the page wider than the screen", () => {
  const css = read("settings/frame.module.css");
  const phone = css.slice(css.indexOf("@media (max-width: 759.98px)"), css.indexOf("@keyframes settings-push"));
  assert.match(phone, /\.frame\[data-open="detail"\] \.detail \{ animation: settings-push/, "the slide-in is still there (else drop this rule)");
  assert.match(phone, /\.frame\[data-open="detail"\] \{ overflow-x: clip; \}/, "clip, not hidden: no scroll box, sticky keeps working");
  assert.match(css, /@keyframes settings-push \{ from \{ opacity: \.4; transform: translateX\(28px\); \}/);
});
