// SPEED-5 (owner, 18 Nov 2026): on production two requests the screen does not need ended many screen changes: marking
// a page's "new" dots seen (POST whats-new/seen: last in 92 of 1,004, ~0.4 s after the rest) and Work's picker lists
// (GET work/options: last in 65). They now wait until the screen in progress has settled (afterSettled), and the
// pickers' lists come at once when the person reaches for a picker. How Insights measures a screen is unchanged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("afterSettled runs work once the screen in progress has settled, or at once when none is", () => {
  const t = src("lib/telemetry.mjs");
  assert.match(t, /export function afterSettled\(fn, maxMs = 4000\) \{/);
  assert.match(t, /if \(!active\) \{ setTimeout\(run, 0\); return; \}/);
  assert.match(t, /settled\.push\(run\); setTimeout\(run, maxMs\);/);                 // never waits past maxMs
  const finish = t.slice(t.indexOf("  function finish(it, cut) {"));
  assert.match(finish.slice(0, 300), /if \(!active && settled\.length\) \{ const now = settled\.splice\(0\); setTimeout\(\(\) => \{ for \(const run of now\) run\(\); \}, 0\); \}/);
  assert.match(t, /const run = \(\) => \{ if \(ran\) return; ran = true;/);         // once, whichever comes first
  assert.match(t, /me\.whenSettled = whenSettled;/);
  // telemetry off (or outside the sample): at once
  assert.match(t, /if \(current\?\.whenSettled\) \{ try \{ current\.whenSettled\(fn, maxMs\); return; \}[^\n]*\n  setTimeout\(fn, 0\);/);
});

test("a page's new dots are marked seen after the page settles; Work's pickers read their lists then or when reached for", () => {
  const dots = src("new-dots-host.tsx");
  assert.match(dots, /afterSettled\(\(\) => void \(async \(\) => \{\n\s+try \{\n\s+const r = await fetch\("\/api\/v0\/whats-new\/seen"/);
  const scope = src("tasks/views/scope-bar.tsx");
  assert.match(scope, /useEffect\(\(\) => \{ let on = true; afterSettled\(\(\) => \{ if \(on\) setLists\(true\); \}\); return \(\) => \{ on = false; \}; \}, \[\]\);/);
  assert.match(scope, /const \{ data \} = useWorkOptions\(lists\);/);
  assert.match(scope, /onPointerDownCapture=\{\(\) => setLists\(true\)\} onFocusCapture=\{\(\) => setLists\(true\)\}/);
});
