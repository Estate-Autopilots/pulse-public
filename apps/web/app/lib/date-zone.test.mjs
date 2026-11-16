// MODULES-1024: a client component that prints a date or time without naming the zone renders it in the server's zone
// (UTC) and again in the browser's (IST): React refuses the page ("Hydration failed") and the person sees "Something
// glitched" (Hiring's interview time, the AI employee tab). Every such call names its zone and a fixed locale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP = new URL("..", import.meta.url).pathname;
// CHAT-V3 owns the chat screens; these are theirs to fix (listed so new ones elsewhere still fail).
const KNOWN = new Set(["chats/task-card.tsx", "chats/conversation.tsx", "chats/workspace/needs.tsx", "chats/voice.tsx", "chats/history.tsx"]);
const CALL = /(toLocale(?:Date|Time)?String|Intl\.DateTimeFormat)\(([^()]*(?:\([^()]*\))?[^()]*)\)/g;

function* files(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== "node_modules" && !f.startsWith(".")) yield* files(p); }
    else if (/\.tsx?$/.test(f)) yield p;
  }
}

test("client components format dates and times in a named zone", () => {
  const bad = [];
  for (const f of files(APP)) {
    const rel = relative(APP, f);
    if (KNOWN.has(rel)) continue;
    const src = readFileSync(f, "utf8");
    if (!/^\s*["']use client["']/m.test(src.slice(0, 400))) continue;
    for (const m of src.matchAll(CALL)) {
      const args = m[2];
      if (args.includes("timeZone") || !args.trim()) continue;
      if (m[1] === "toLocaleString" && !/(day|month|hour|weekday|year|minute)\s*:/.test(args)) continue;
      bad.push(`${rel}:${src.slice(0, m.index).split("\n").length}: ${m[0].slice(0, 90)}`);
    }
  }
  assert.deepEqual(bad, [], "add timeZone (and a fixed locale) to these calls");
});
