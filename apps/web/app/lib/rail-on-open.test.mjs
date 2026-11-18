// SPEED-4 (owner, 18 Nov 2026: "make the slowest real actions fast"): the insights drawer draws nothing while closed, yet
// read its insights on every screen change; on production that read was the last request of 298 of 1,004 screen changes
// by real people (3 days), 230 ms after everything else had arrived. It now reads when the drawer opens (and on a data
// change while open), and the first HTML's boot call no longer reads it for every page load.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const here = new URL("../", import.meta.url);
const src = (path) => readFileSync(new URL(path, here), "utf8");

test("the insights drawer reads only while it is open", () => {
  const rail = src("intelligence/rail.tsx");
  // closed, it draws nothing
  assert.match(rail, /if\(!open\|\|typeof document==='undefined'\)return null;/);
  // read when it opens
  assert.match(rail, /useEffect\(\(\)=>\{if\(!open\)return;const abort=new AbortController\(\);queueMicrotask\(\(\)=>void load\(abort\.signal\)\);return\(\)=>abort\.abort\(\);\},\[open,load\]\);/);
  // a data change reads again only while open; the brief tick keeps its own minute
  assert.match(rail, /const changed=\(\)=>\{if\(openNow\.current\)void load\(abort\.signal\);void tick\(\);\};/);
  // nothing else starts the read when the page (or a new screen) mounts the rail
  assert.equal((rail.match(/void load\(abort\.signal\)/g) ?? []).length, 2);
  assert.equal((rail.match(/queueMicrotask\(\(\)=>void load\(/g) ?? []).length, 1, "only the drawer's opening starts the read");
});

test("the boot call does not read the insights rail for every page load", () => {
  const layout = src("layout.tsx");
  assert.match(layout, /<BootStart keys=\{shellBootKeys\([^)]*\)\} rail=\{false\} \/>/);
});
