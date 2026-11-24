// SPEED-4 (owner, 18 Nov 2026: "make the slowest real actions fast"): a Start or Pause on My day (p90 1.7 s for real people
// on production, 3 days) waited for three round trips in a row: the action, the day (GET tasks/my-day), and only once the
// day had arrived the streaks (GET tasks/my-day/streaks, the last request in 16 of 16 such taps). The streaks are now read
// beside the day, in the same reload; they are still read when My day opens and after every read of the day.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("../my-day/my-day.tsx", import.meta.url), "utf8");

test("My day reads the streaks beside the day, not after it", () => {
  const reload = src.slice(src.indexOf("const reload = useCallback("), src.indexOf("// Coming back to the tab"));
  assert.match(reload, /await Promise\.all\(\[fetch\("\/api\/v0\/tasks\/my-day", \{ cache: "no-store" \}\), readStreaks\(\)\]\)/);
  assert.match(reload, /if \(s\) setStreaks\(s\);/);
  // no effect waits for the day's data to change before asking for the streaks
  assert.doesNotMatch(src, /\}, \[data\]\);/);
  assert.equal((src.match(/\/api\/v0\/tasks\/my-day\/streaks/g) ?? []).length, 1, "one place reads the streaks");
  // and they are read when My day opens
  assert.match(src, /useEffect\(\(\) => \{ let live = true; void readStreaks\(\)\.then\(\(x\) => \{ if \(live && x\) setStreaks\(x\); \}\); return \(\) => \{ live = false; \}; \}, \[\]\);/);
});
